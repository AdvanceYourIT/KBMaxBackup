import { makeFolderName, runBackup, runRecordBackup } from './lib/backup.js';
import { CATEGORIES } from './lib/categories.js';
import { deliverLocal } from './lib/destinations-local.js';
import { UPLOADERS } from './lib/destinations.js';
import { detectEnvironment } from './lib/environments.js';
import { loadEnabledDestinations, loadEnvironmentOverrides } from './lib/settings.js';
import { ZipWriter } from './lib/zip.js';
import { createZipSink } from './lib/zip-sink.js';
import { checkAccess } from './lib/access.js';

const extensionApi = globalThis.browser ?? globalThis.chrome;
window.__kbReady = true;

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const host = params.get('host') ?? '';
const recordParam = (params.get('record') ?? '').split(':');
const record = recordParam.length === 2
  ? { category: CATEGORIES.find((c) => c.key === recordParam[0] && (c.getApi || c.recordApi)), id: Number(recordParam[1]) }
  : null;
const categoryKeys = (params.get('categories') ?? '').split(',').filter((key) => CATEGORIES.some((c) => c.key === key));

const badge = document.getElementById('envBadge');
const stepTitle = document.getElementById('stepTitle');
const progress = document.getElementById('progress');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const cancelButton = document.getElementById('cancelButton');
const downloadButton = document.getElementById('downloadButton');
const againButton = document.getElementById('againButton');
const summaryPanel = document.getElementById('summaryPanel');
const summaryEl = document.getElementById('summary');

const MAX_LOG_LINES = 1000;
const controller = new AbortController();

function log(message, isError = false) {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = `${new Date().toLocaleTimeString('en-GB')}  ${message}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function renderSummary(summary) {
  summaryEl.replaceChildren(
    ...Object.entries(summary.counts).map(([key, count]) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = CATEGORIES.find((c) => c.key === key)?.label ?? key;
      const value = document.createElement('td');
      value.textContent = String(count);
      row.append(name, value);
      return row;
    }),
  );
  summaryPanel.hidden = false;
}

async function recordLastBackup(summary) {
  const { lastBackups = {} } = await extensionApi.storage.local.get('lastBackups');
  lastBackups[summary.environment] = { at: summary.finishedAt, counts: summary.counts, errorCount: summary.errorCount };
  await extensionApi.storage.local.set({ lastBackups });
}

// Starts a streaming upload session per enabled destination. A destination that fails is
// switched off for the rest of the run; it never interrupts the ZIP.
async function startUploads({ environment, folderName }) {
  const destinations = await loadEnabledDestinations(environment.key);
  const uploads = [];

  for (const destination of destinations) {
    const upload = { label: destination.label, session: null, error: null, cancelled: false };
    try {
      upload.session = await UPLOADERS[destination.key].createSession({
        values: destination.values,
        token: destination.token,
        message: `KBMax backup ${environment.short} ${folderName}`,
        syncFolder: `KBMax_${environment.short}`,
        signal: controller.signal,
        onLog: log,
      });
      log(`${destination.label}: upload started.`);
    } catch (error) {
      fail(upload, error);
    }
    uploads.push(upload);
  }

  return uploads;
}

function fail(upload, error) {
  if (error.name === 'AbortError') throw error;
  upload.session = null;
  upload.error = error.message;
  log(`${upload.label}: upload failed - ${error.message}`, true);
}

async function finishUploads(uploads) {
  for (const upload of uploads) {
    if (!upload.session) continue;
    stepTitle.textContent = `Finishing upload to ${upload.label}`;
    try {
      await upload.session.finish();
      log(`${upload.label}: upload complete.`);
    } catch (error) {
      fail(upload, error);
    }
  }
}

async function main() {
  const environment = detectEnvironment(`https://${host}/`, await loadEnvironmentOverrides());
  const validRecord = !params.get('record') || (record?.category && Number.isInteger(record.id) && record.id !== 0);
  if (!environment || !Number.isInteger(tabId) || !validRecord || (!params.get('record') && categoryKeys.length === 0)) {
    stepTitle.textContent = 'Invalid backup request';
    statusEl.textContent = 'Start the backup again from the extension icon.';
    cancelButton.hidden = true;
    return;
  }

  badge.className = `badge ${environment.key}`;
  badge.textContent = environment.short;
  document.title = `KBMax Backup ${environment.short}`;
  stepTitle.textContent = params.get('record') ? `Backup of ${record.category.label} #${record.id}` : `Backup of ${environment.label}`;
  cancelButton.addEventListener('click', () => controller.abort());
  againButton.addEventListener('click', () => location.reload());

  const access = await checkAccess({ tabId, baseUrl: environment.baseUrl });
  if (!access.allowed) {
    stepTitle.textContent = 'Access denied';
    statusEl.textContent = access.reason;
    statusEl.className = 'error';
    cancelButton.hidden = true;
    againButton.hidden = false;
    log(access.reason, true);
    return;
  }
  log(`Signed in as ${access.user.displayName} (${access.roles.join(', ')}).`);

  const folderName = makeFolderName(environment, new Date(), params.get('record') ? `${record.category.folder}-${record.id}` : '');
  const filename = `${folderName}.zip`;
  let sink;

  try {
    sink = await createZipSink(filename);
    log(sink.kind === 'disk'
      ? 'Streaming the ZIP to temporary browser storage (low memory use).'
      : 'Warning: streaming storage is not available; the ZIP is built in memory. Large backups may fail.', sink.kind !== 'disk');

    const zip = new ZipWriter(sink);
    const uploads = await startUploads({ environment, folderName });
    let fileCount = 0;

    const onFileWrite = async (file) => {
      fileCount++;
      await Promise.all([
        zip.add(file.path, file.data),
        ...uploads.filter((upload) => upload.session).map(async (upload) => {
          try {
            await upload.session.add(file);
          } catch (error) {
            fail(upload, error);
          }
        }),
      ]);
    };

    const summary = params.get('record')
      ? await runRecordBackup({ tabId, environment, folderName, category: record.category, id: record.id, signal: controller.signal, onLog: log, onFile: onFileWrite })
      : await runBackup({
      tabId,
      environment,
      folderName,
      categoryKeys,
      signal: controller.signal,
      onLog: log,
      onProgress: ({ categoryIndex, categoryCount, category, done, total }) => {
        const fraction = total === 0 ? 1 : done / total;
        progress.value = Math.round(((categoryIndex + fraction) / categoryCount) * 100);
        statusEl.textContent = `${category.label}: ${done} / ${total}`;
      },
      onFile: onFileWrite,
    });

    log(`Finishing ZIP (${fileCount} files)...`);
    await zip.finish();
    await finishUploads(uploads);

    const blob = await sink.getBlob();
    const deliver = () => deliverLocal({ blob, filename });
    // With an upload destination enabled the backup lives in the repository; the local ZIP is only
    // downloaded when there is no destination or an upload failed (so the backup is never lost).
    const failedUploads = uploads.filter((upload) => upload.error);
    const downloaded = uploads.length === 0 || failedUploads.length > 0;
    if (downloaded) deliver();
    downloadButton.hidden = false;
    downloadButton.addEventListener('click', deliver);
    cancelButton.hidden = true;
    againButton.hidden = false;

    if (!params.get('record')) await recordLastBackup(summary);
    renderSummary(summary);
    progress.value = 100;

    const parts = [];
    if (downloaded) parts.push(summary.errorCount > 0 ? `${filename} downloaded with ${summary.errorCount} error(s) (see _errors.json in the ZIP).` : `${filename} downloaded.`);
    else if (summary.errorCount > 0) parts.push(`${summary.errorCount} record(s) could not be read (see _errors.json in the backup).`);
    uploads.forEach((upload) => parts.push(upload.error ? `Upload to ${upload.label} failed: ${upload.error}` : `Uploaded to ${upload.label}.`));
    stepTitle.textContent = failedUploads.length > 0 ? 'Backup complete, upload failed' : 'Backup complete';
    statusEl.textContent = parts.join(' ');
    statusEl.className = summary.errorCount > 0 || failedUploads.length > 0 ? 'error' : 'ok';
    log(`Done: ${fileCount} files, ${(blob.size / 1024 / 1024).toFixed(1)} MB${downloaded ? `, downloaded as ${filename}` : ' (local ZIP not downloaded; use "Download ZIP" if you want it)'}`);
  } catch (error) {
    await sink?.abort();
    const cancelled = error.name === 'AbortError';
    stepTitle.textContent = cancelled ? 'Backup cancelled' : 'Backup failed';
    statusEl.textContent = cancelled ? 'Nothing was downloaded.' : error.message;
    statusEl.className = cancelled ? 'muted' : 'error';
    cancelButton.hidden = true;
    againButton.hidden = false;
    log(cancelled ? 'Cancelled by user.' : `Error: ${error.message}`, !cancelled);
  }
}

main();
