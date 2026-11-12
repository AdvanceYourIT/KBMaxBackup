import { timestampForFolder } from './lib/backup.js';
import { CATEGORIES } from './lib/categories.js';
import { deliverLocal } from './lib/destinations-local.js';
import { detectEnvironment } from './lib/environments.js';
import { applyImport, planImport } from './lib/importer.js';
import { loadEnvironmentOverrides } from './lib/settings.js';
import { ZipWriter } from './lib/zip.js';
import { createZipSink } from './lib/zip-sink.js';
import { readZipEntries } from './lib/zip-reader.js';
import { checkAccess } from './lib/access.js';

window.__kbReady = true;

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const host = params.get('host') ?? '';
const types = CATEGORIES.filter((category) => category.write);

const $ = (id) => document.getElementById(id);
const badge = $('envBadge');
const typeSelect = $('typeSelect');
const fileInput = $('fileInput');
const analyseButton = $('analyseButton');
const analyseStatus = $('analyseStatus');
const planPanel = $('planPanel');
const planBody = $('planBody');
const applyPanel = $('applyPanel');
const applySummary = $('applySummary');
const confirmField = $('confirmField');
const confirmLabel = $('confirmLabel');
const confirmInput = $('confirmInput');
const progress = $('progress');
const applyButton = $('applyButton');
const cancelButton = $('cancelButton');
const applyStatus = $('applyStatus');
const logEl = $('log');

const MAX_LOG_LINES = 1000;
let environment = null;
let plan = [];
let controller = null;

function log(message, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = `${new Date().toLocaleTimeString('en-GB')}  ${message}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function selectedCategory() {
  return types.find((category) => category.key === typeSelect.value);
}

async function collectItems(category) {
  const items = [];
  for (const file of fileInput.files) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const entries = await readZipEntries(file);
      for (const entry of entries) {
        const segments = entry.path.split('/');
        if (entry.path.toLowerCase().endsWith('.json') && segments.includes(category.folder)) {
          items.push({ name: `${file.name}: ${entry.path}`, text: await entry.readText() });
        }
      }
    } else {
      items.push({ name: file.name, text: await file.text() });
    }
  }
  return items;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderPlan() {
  planBody.replaceChildren(...plan.map((entry) => {
    const row = document.createElement('tr');
    const issues = document.createElement('td');
    issues.className = 'issues';
    for (const message of entry.errors) {
      const div = document.createElement('div');
      div.className = 'st-error';
      div.textContent = message;
      issues.append(div);
    }
    for (const message of entry.warnings) {
      const div = document.createElement('div');
      div.className = 'warn';
      div.textContent = `Warning: ${message}`;
      issues.append(div);
    }
    const info = entry.action === 'update' && entry.changed ? `Changes: ${entry.changed.join(', ')}` : entry.action === 'create' ? 'New record' : '';
    if (info) {
      const div = document.createElement('div');
      div.textContent = info;
      issues.append(div);
    }
    row.append(cell(entry.file), cell(entry.id ?? '-'), cell(entry.action, `st-${entry.action}`), issues);
    return row;
  }));
  planPanel.hidden = false;
}

function updateApplyState() {
  const updates = plan.filter((entry) => entry.action === 'update' || entry.action === 'create').length;
  const needsConfirm = environment.key !== 'dev';
  confirmField.hidden = !needsConfirm || updates === 0;
  const confirmed = !needsConfirm || confirmInput.value.trim().toLowerCase() === environment.host;
  applyButton.disabled = updates === 0 || !confirmed;
}

async function analyse() {
  const category = selectedCategory();
  analyseButton.disabled = true;
  applyPanel.hidden = true;
  planPanel.hidden = true;
  analyseStatus.textContent = 'Reading files...';
  controller = new AbortController();

  try {
    const items = await collectItems(category);
    if (items.length === 0) {
      analyseStatus.textContent = 'No matching JSON files found. For a ZIP, the folder of this type must be present.';
      return;
    }
    log(`Analysing ${items.length} file(s) for ${category.label} on ${environment.host} (read-only)...`);
    plan = await planImport({
      tabId,
      baseUrl: environment.baseUrl,
      category,
      items,
      signal: controller.signal,
      onProgress: ({ done, total }) => { analyseStatus.textContent = `Checking ${done} / ${total}...`; },
    });

    const count = (action) => plan.filter((entry) => entry.action === action).length;
    analyseStatus.textContent = `${count('create')} to create, ${count('update')} to update, ${count('unchanged')} unchanged, ${count('error')} with errors.`;
    log(`Analysis done: ${analyseStatus.textContent}`);
    renderPlan();

    const updates = count('update');
    const creates = count('create');
    applySummary.textContent = updates + creates > 0
      ? `In ${environment.label} (${environment.host}): ${creates} record(s) will be created and ${updates} overwritten. Files with errors are skipped.${category.write.note ? ` ${category.write.note}` : ''}`
      : 'Nothing to apply.';
    confirmLabel.textContent = `This is ${environment.label}. Type the host name (${environment.host}) to confirm.`;
    confirmInput.value = '';
    applyPanel.hidden = false;
    updateApplyState();
  } catch (error) {
    analyseStatus.textContent = error.name === 'AbortError' ? 'Cancelled.' : `Failed: ${error.message}`;
    log(analyseStatus.textContent, true);
  } finally {
    analyseButton.disabled = false;
  }
}

async function apply() {
  const category = selectedCategory();
  applyButton.disabled = true;
  const access = await checkAccess({ tabId, baseUrl: environment.baseUrl });
  if (!access.allowed) {
    applyStatus.textContent = access.reason;
    applyStatus.className = 'error';
    log(access.reason, true);
    return;
  }
  analyseButton.disabled = true;
  cancelButton.hidden = false;
  progress.hidden = false;
  progress.value = 0;
  controller = new AbortController();

  const folderName = `KBMax_${environment.short}_import_${timestampForFolder()}`;
  const filename = `${folderName}.zip`;
  const sink = await createZipSink(filename);
  const zip = new ZipWriter(sink);
  let results = [];
  let cancelled = false;

  try {
    log(`Applying to ${environment.host}. Previous versions and the results are saved to ${filename}.`);
    results = await applyImport({
      tabId,
      baseUrl: environment.baseUrl,
      category,
      plan,
      snapshot: (path, data) => zip.add(`${folderName}/${path}`, data),
      signal: controller.signal,
      onLog: log,
      onProgress: ({ done, total }) => {
        progress.value = Math.round((done / total) * 100);
        applyStatus.textContent = `${done} / ${total}`;
      },
    });
  } catch (error) {
    cancelled = error.name === 'AbortError';
    log(cancelled ? 'Cancelled by user. Records already written stay written.' : `Error: ${error.message}`, true);
  }

  const count = (status) => results.filter((result) => result.status === status).length;
  const written = count('updated') + count('created') + count('created-partial');
  const failed = count('failed');
  try {
    if (written > 0) {
      await zip.add(`${folderName}/import-results.json`, JSON.stringify(results, null, 2));
      await zip.finish();
      deliverLocal({ blob: await sink.getBlob(), filename });
      log(`Snapshot and results downloaded: ${filename}`);
    } else {
      await sink.abort();
    }
  } catch (error) {
    log(`Could not create the snapshot ZIP: ${error.message}`, true);
  }

  const adjusted = results.filter((result) => result.serverChanged.length > 0).length;
  const partial = count('created-partial');
  applyStatus.textContent = `${count('created') + partial} created, ${count('updated')} updated, ${failed} failed${partial ? `, ${partial} created but not fully saved (see log)` : ''}${adjusted ? `, ${adjusted} stored differently by the server (see log)` : ''}${cancelled ? ', cancelled' : ''}.`;
  applyStatus.className = failed > 0 || partial > 0 || cancelled ? 'error' : 'ok';
  cancelButton.hidden = true;
  analyseButton.disabled = false;
}

async function main() {
  environment = detectEnvironment(`https://${host}/`, await loadEnvironmentOverrides());
  if (!environment || !Number.isInteger(tabId)) {
    $('writeNotice').textContent = 'Invalid import request. Start it again from the extension icon.';
    $('writeNotice').className = 'notice prod';
    analyseButton.disabled = true;
    return;
  }

  badge.className = `badge ${environment.key}`;
  badge.textContent = environment.short;
  document.title = `KBMax Import ${environment.short}`;
  if (environment.key !== 'dev') {
    $('writeNotice').className = 'notice prod';
    $('writeNotice').textContent = `This is ${environment.label}. ${$('writeNotice').textContent} You will have to type the host name before anything is written.`;
  }

  const access = await checkAccess({ tabId, baseUrl: environment.baseUrl });
  if (!access.allowed) {
    $('writeNotice').className = 'notice prod';
    $('writeNotice').textContent = access.reason;
    analyseButton.disabled = true;
    typeSelect.disabled = true;
    fileInput.disabled = true;
    log(access.reason, true);
    return;
  }
  log(`Signed in as ${access.user.displayName} (${access.roles.join(', ')}).`);

  types.forEach((category) => typeSelect.add(new Option(category.label, category.key)));
  analyseButton.addEventListener('click', analyse);
  applyButton.addEventListener('click', apply);
  cancelButton.addEventListener('click', () => controller?.abort());
  confirmInput.addEventListener('input', updateApplyState);
  typeSelect.addEventListener('change', () => { applyPanel.hidden = true; planPanel.hidden = true; plan = []; });
  fileInput.addEventListener('change', () => { applyPanel.hidden = true; planPanel.hidden = true; plan = []; });
}

main();
