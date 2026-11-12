import { CATEGORIES } from './lib/categories.js';
import { ENVIRONMENTS, detectEnvironment, hostPatterns, isValidHost } from './lib/environments.js';
import { UPLOADERS } from './lib/destinations.js';
import { checkAccess } from './lib/access.js';
import { detectCurrentRecord } from './lib/currentRecord.js';
import { DESTINATIONS, getDestinationToken, loadDestinationSettings, loadEnvironmentOverrides, saveDestinationSettings, saveEnvironmentOverrides } from './lib/settings.js';

const extensionApi = globalThis.browser ?? globalThis.chrome;
window.__kbReady = true;

const badge = document.getElementById('envBadge');
const notice = document.getElementById('notice');
const categoriesEl = document.getElementById('categories');
const historyEl = document.getElementById('history');
const startButton = document.getElementById('startButton');
const hint = document.getElementById('hint');

function showTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== `tab-${name}`; });
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

function renderCategories(selected) {
  categoriesEl.replaceChildren(
    ...CATEGORIES.map((category) => {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = category.key;
      input.checked = selected.includes(category.key);
      input.addEventListener('change', saveSelection);
      label.append(input, category.label);
      return label;
    }),
  );
}

function getSelection() {
  return [...categoriesEl.querySelectorAll('input:checked')].map((input) => input.value);
}

async function saveSelection() {
  const selection = getSelection();
  startButton.disabled = startButton.dataset.ready !== 'true' || startButton.dataset.allowed !== 'true' || selection.length === 0;
  await extensionApi.storage.local.set({ selectedCategories: selection });
}

function renderHistory(lastBackups) {
  historyEl.replaceChildren(
    ...Object.values(ENVIRONMENTS).map((env) => {
      const row = document.createElement('div');
      const name = document.createElement('span');
      name.className = `badge ${env.key}`;
      name.textContent = env.short;
      const when = document.createElement('span');
      const last = lastBackups?.[env.key];
      when.className = 'muted';
      when.textContent = last ? new Date(last.at).toLocaleString('en-GB') : 'no backup yet';
      row.append(name, when);
      return row;
    }),
  );
}

function field(labelText, control, hintText) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const label = document.createElement('span');
  label.textContent = labelText;
  wrapper.append(label, control);
  if (hintText) {
    const hintEl = document.createElement('span');
    hintEl.className = 'hint';
    hintEl.textContent = hintText;
    wrapper.append(hintEl);
  }
  return wrapper;
}

function textInput(placeholder, type = 'text') {
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder ?? '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function choiceInput(choices) {
  const select = document.createElement('select');
  choices.forEach(([value, label]) => select.add(new Option(label, value)));
  return select;
}

function buildDestinationTab(destinationKey, defaultEnvKey) {
  const destination = DESTINATIONS[destinationKey];
  const panel = document.getElementById(`tab-${destinationKey}`);

  const info = document.createElement('div');
  info.className = 'notice';
  info.textContent = `Without an upload destination a backup is downloaded as a ZIP. When enabled below, it is uploaded to ${destination.label} instead (by default one timestamped folder per backup); if an upload fails, the ZIP is downloaded as a fallback. Setup guides: ${destination.guides.map((g) => `${g}`).join(', ')}.`;

  const box = document.createElement('div');
  box.className = 'panel';
  const title = document.createElement('h2');
  title.textContent = `${destination.label} settings`;

  const envSelect = document.createElement('select');
  Object.values(ENVIRONMENTS).forEach((env) => envSelect.add(new Option(`${env.short} - ${env.label}`, env.key)));
  envSelect.value = defaultEnvKey;

  const inputs = Object.fromEntries(destination.fields.map((f) => [f.key, f.choices ? choiceInput(f.choices) : textInput(f.placeholder)]));
  const tokenInput = textInput('', 'password');
  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'check';
  enabledLabel.append(enabledInput, `Upload backups of this environment to ${destination.label}`);

  const save = document.createElement('button');
  save.textContent = 'Save';
  const testButton = document.createElement('button');
  testButton.textContent = 'Test connection';
  testButton.className = 'secondary';
  const clear = document.createElement('button');
  clear.textContent = 'Remove token';
  clear.className = 'secondary';
  const status = document.createElement('span');
  status.className = 'saveStatus muted';
  const row = document.createElement('div');
  row.className = 'row';
  row.append(save, testButton, clear);

  box.append(
    title,
    field('Environment', envSelect, 'Each environment (DEV / TEST / PROD) has its own destination.'),
    enabledLabel,
    ...destination.fields.map((f) => field(f.label, inputs[f.key], f.hint)),
    field(destination.tokenLabel, tokenInput, 'Stored locally in this browser profile. Leave empty to keep the saved token.'),
    row,
    status,
  );
  panel.append(info, box);

  async function load() {
    const { values, hasToken } = await loadDestinationSettings(destinationKey, envSelect.value);
    destination.fields.forEach((f) => { inputs[f.key].value = values[f.key] ?? f.choices?.[0][0] ?? ''; });
    enabledInput.checked = values.enabled === true;
    tokenInput.value = '';
    tokenInput.placeholder = hasToken ? 'Token saved' : '';
    clear.disabled = !hasToken;
    status.textContent = '';
  }

  envSelect.addEventListener('change', load);

  const collectValues = () => ({
    ...Object.fromEntries(destination.fields.map((f) => [f.key, inputs[f.key].value.trim()])),
    enabled: enabledInput.checked,
  });

  function report(message, isError = false) {
    status.textContent = message;
    status.className = `saveStatus ${isError ? 'error' : 'ok'}`;
  }

  save.addEventListener('click', async () => {
    await saveDestinationSettings(destinationKey, envSelect.value, collectValues(), { token: tokenInput.value.trim() });
    await load();
    report('Saved.');
  });

  clear.addEventListener('click', async () => {
    await saveDestinationSettings(destinationKey, envSelect.value, collectValues(), { clearToken: true });
    await load();
    report('Token removed.');
  });

  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    status.className = 'saveStatus muted';
    status.textContent = 'Testing...';
    try {
      const token = tokenInput.value.trim() || await getDestinationToken(destinationKey, envSelect.value);
      report(await UPLOADERS[destinationKey].test(collectValues(), token));
    } catch (error) {
      report(error.message, true);
    } finally {
      testButton.disabled = false;
    }
  });

  return load();
}

// One open KBMax tab per host (the most recently used one), so a backup can be started from any
// tab - for example right after a previous backup, when the active tab is the progress page.
async function findKbmaxTabs(overrides) {
  const tabs = await extensionApi.tabs.query({ url: hostPatterns(overrides) });
  const targets = new Map();
  for (const tab of tabs) {
    const environment = detectEnvironment(tab.url, overrides);
    if (!environment) continue;
    const current = targets.get(environment.host);
    if (!current || (tab.lastAccessed ?? 0) > (current.tab.lastAccessed ?? 0)) targets.set(environment.host, { tab, environment });
  }
  return targets;
}

function buildHostsTab(overrides, onChange) {
  const list = document.getElementById('overrideList');
  const hostInput = document.getElementById('overrideHost');
  const envSelect = document.getElementById('overrideEnv');
  const status = document.getElementById('overrideStatus');
  Object.values(ENVIRONMENTS).forEach((env) => envSelect.add(new Option(`${env.short} - ${env.label}`, env.key)));

  function report(message, isError = false) {
    status.textContent = message;
    status.className = `saveStatus ${isError ? 'error' : 'ok'}`;
  }

  function render() {
    list.replaceChildren(...overrides.map((override) => {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = `${override.host} = ${ENVIRONMENTS[override.env].short}`;
      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        overrides.splice(overrides.indexOf(override), 1);
        await saveEnvironmentOverrides(overrides);
        render();
        onChange();
      });
      row.append(name, remove);
      return row;
    }));
    if (overrides.length === 0) list.textContent = 'No custom hosts.';
  }

  document.getElementById('overrideAdd').addEventListener('click', async () => {
    const host = hostInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!isValidHost(host)) {
      report('Enter a host name such as cpq.example.com.', true);
      return;
    }
    if (!host.endsWith('.kbmax.com')) {
      const granted = await extensionApi.permissions.request({ origins: [`https://${host}/*`] });
      if (!granted) {
        report('Permission for this host was not granted.', true);
        return;
      }
    }
    const existing = overrides.find((o) => o.host === host);
    if (existing) existing.env = envSelect.value;
    else overrides.push({ host, env: envSelect.value });
    await saveEnvironmentOverrides(overrides);
    hostInput.value = '';
    report('Saved.');
    render();
    onChange();
  });

  render();
}

async function init() {
  const stored = await extensionApi.storage.local.get(['selectedCategories', 'knownCategories', 'lastBackups']);
  const known = stored.knownCategories ?? stored.selectedCategories ?? [];
  const selected = stored.selectedCategories
    ? [...stored.selectedCategories, ...CATEGORIES.filter((c) => c.defaultOn && !known.includes(c.key)).map((c) => c.key)]
    : CATEGORIES.filter((c) => c.defaultOn).map((c) => c.key);
  extensionApi.storage.local.set({ knownCategories: CATEGORIES.map((c) => c.key) });
  renderCategories(selected);
  renderHistory(stored.lastBackups);

  const overrides = await loadEnvironmentOverrides();
  buildHostsTab(overrides, () => {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent = 'Host list changed. Reopen the extension to use it.';
  });

  const targets = await findKbmaxTabs(overrides);
  const [activeTab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
  const activeEnvironment = detectEnvironment(activeTab?.url, overrides);
  const mostRecent = [...targets.values()].sort((a, b) => (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0))[0];
  const defaultHost = activeEnvironment && targets.has(activeEnvironment.host) ? activeEnvironment.host : mostRecent?.environment.host;
  const defaultEnvKey = targets.get(defaultHost)?.environment.key ?? 'dev';

  await Promise.all(Object.keys(DESTINATIONS).map((key) => buildDestinationTab(key, defaultEnvKey)));

  const targetSelect = document.getElementById('targetSelect');
  const targetHint = document.getElementById('targetHint');

  if (targets.size === 0) {
    targetSelect.disabled = true;
    targetSelect.add(new Option('No KBMax tab open', ''));
    notice.hidden = false;
    notice.textContent = 'Open a KBMax page (dev, test or production) in any browser tab to create a backup.';
    return;
  }

  const order = Object.keys(ENVIRONMENTS);
  [...targets.values()]
    .sort((a, b) => order.indexOf(a.environment.key) - order.indexOf(b.environment.key) || a.environment.host.localeCompare(b.environment.host))
    .forEach(({ environment }) => targetSelect.add(new Option(`${environment.short} - ${environment.host}`, environment.host)));
  targetSelect.value = defaultHost;

  const accessCache = new Map();
  async function refreshAccess() {
    const { tab, environment } = targets.get(targetSelect.value);
    const importButton = document.getElementById('importButton');
    startButton.disabled = true;
    importButton.disabled = true;
    document.getElementById('recordButton').disabled = true;
    hint.className = 'muted';
    hint.textContent = 'Checking access...';
    if (!accessCache.has(environment.host)) accessCache.set(environment.host, await checkAccess({ tabId: tab.id, baseUrl: environment.baseUrl }));
    const access = accessCache.get(environment.host);
    if (targetSelect.value !== environment.host) return;
    startButton.disabled = !access.allowed || getSelection().length === 0;
    importButton.disabled = !access.allowed;
    document.getElementById('recordButton').disabled = !access.allowed;
    hint.className = access.allowed ? 'muted' : 'error';
    hint.textContent = access.allowed ? `${access.user.displayName} (${access.roles.join(', ')})` : access.reason;
    startButton.dataset.allowed = access.allowed ? 'true' : 'false';
  }

  let currentRecord = null;
  function updateCurrentRecord() {
    const { tab } = targets.get(targetSelect.value);
    currentRecord = detectCurrentRecord(tab.url);
    document.getElementById('currentRecordPanel').hidden = !currentRecord;
    if (currentRecord) document.getElementById('currentRecordText').textContent = `${currentRecord.category.label} #${currentRecord.id}`;
  }

  document.getElementById('recordButton').addEventListener('click', async () => {
    const { tab, environment } = targets.get(targetSelect.value);
    if (!currentRecord) return;
    const query = new URLSearchParams({ tabId: String(tab.id), host: environment.host, record: `${currentRecord.category.key}:${currentRecord.id}` });
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL(`backup.html?${query}`) });
    window.close();
  });

  function applyTarget() {
    updateCurrentRecord();
    const { environment } = targets.get(targetSelect.value);
    badge.className = `badge ${environment.key}`;
    badge.textContent = environment.short;
    targetHint.textContent = 'Uses the logged-in KBMax tab for this host. You can start a backup at any time, as often as you like.';
    notice.hidden = environment.key !== 'prod';
    notice.className = 'notice prod';
    notice.textContent = 'Production environment: the backup only performs read actions.';
  }

  applyTarget();
  targetSelect.addEventListener('change', () => { applyTarget(); refreshAccess(); });

  startButton.dataset.ready = 'true';
  startButton.dataset.allowed = 'false';
  const diagnoseButton = document.getElementById('diagnoseButton');
  diagnoseButton.disabled = false;
  diagnoseButton.addEventListener('click', async () => {
    const { tab, environment } = targets.get(targetSelect.value);
    const query = new URLSearchParams({ tabId: String(tab.id), host: environment.host });
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL(`diagnose.html?${query}`) });
    window.close();
  });
  const importButton = document.getElementById('importButton');
  importButton.addEventListener('click', async () => {
    const { tab, environment } = targets.get(targetSelect.value);
    const query = new URLSearchParams({ tabId: String(tab.id), host: environment.host });
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL(`import.html?${query}`) });
    window.close();
  });

  refreshAccess();

  startButton.addEventListener('click', async () => {
    const { tab, environment } = targets.get(targetSelect.value);
    const params = new URLSearchParams({
      tabId: String(tab.id),
      host: environment.host,
      categories: getSelection().join(','),
    });
    await extensionApi.tabs.create({ url: extensionApi.runtime.getURL(`backup.html?${params}`) });
    window.close();
  });
}

init();
