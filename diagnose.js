import { detectEnvironment } from './lib/environments.js';
import { loadEnvironmentOverrides } from './lib/settings.js';
import { checkAccess } from './lib/access.js';

window.__kbReady = true;

const extensionApi = globalThis.browser ?? globalThis.chrome;
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const host = params.get('host') ?? '';

const reportEl = document.getElementById('report');
const copyButton = document.getElementById('copyButton');
const statusEl = document.getElementById('status');

const CANDIDATES = ['/api/users/current', '/api/users/me', '/api/users/self', '/api/users/profile', '/api/account', '/api/me', '/api/user', '/api/auth/me', '/api/session', '/api/identity'];
const SEARCH = { fields: ['id'], sortField: 'id', descending: false, skip: 0, take: 1, filters: [], nestedPath: null, nestedFields: [] };
const PROBES = [
  { label: 'GET settings', method: 'GET', url: '/api/settings' },
  ...['users', 'roles', 'admin/products', 'scenes', 'functions', 'globalfunctions', 'builders', 'tables', 'quoteheaders', 'workflows', 'customactions', 'quoteoutputs', 'quotes']
    .map((name) => ({ label: `POST ${name}/search`, method: 'POST', url: `/api/${name}/search`, body: SEARCH })),
];

// Runs inside the KBMax tab. Self-contained; returns plain data only.
async function inspectTab(candidates, probes) {
  const INTERESTING = /^(id|userid|user_id|email|mail|name|username|upn|preferred_username|oid|sub|role|roles|firstname|lastname|displayname|systemrole)$/i;

  function pick(value, depth = 0) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') return value.length > 120 ? `<${value.length} characters>` : value;
    if (typeof value !== 'object') return value;
    if (depth > 3) return undefined;
    if (Array.isArray(value)) return value.slice(0, 5).map((item) => pick(item, depth + 1)).filter((item) => item !== undefined);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (INTERESTING.test(key) || (typeof item === 'object' && item !== null)) {
        const picked = pick(item, depth + 1);
        if (picked !== undefined && !(typeof picked === 'object' && Object.keys(picked).length === 0)) out[key] = picked;
      }
    }
    return out;
  }

  function decodeJwtPayload(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
    } catch {
      return null;
    }
  }

  function scanStorage(storage, label) {
    const entries = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const raw = storage.getItem(key) ?? '';
      const entry = { store: label, key, length: raw.length };
      if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(raw)) {
        entry.jwtClaims = pick(decodeJwtPayload(raw));
      } else {
        try {
          const parsed = JSON.parse(raw);
          entry.fields = pick(parsed);
        } catch {
          if (/@/.test(raw) && raw.length < 200) entry.value = raw;
          else if (raw.length <= 64 && /^[\w.-]+$/.test(raw) && /user|guid|id|name|role/i.test(key) && !/token|secret|key|auth|password/i.test(key)) entry.value = raw;
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  async function call(method, url, body) {
    try {
      const response = await fetch(url, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      const type = json !== null ? 'json' : /^\s*<(!doctype|html)/i.test(text) ? 'html (app fallback page, the endpoint does not exist)' : text ? 'text' : 'empty';
      return { status: response.status, json, type };
    } catch (error) {
      return { status: `network error: ${error.message}`, json: null };
    }
  }

  // Key names (no values) of the first record, to see whether user-scoped calls reveal who is logged in.
  function shape(json) {
    const first = Array.isArray(json) ? json[0] : Array.isArray(json?.items) ? json.items[0] : json;
    return first && typeof first === 'object' ? Object.keys(first).slice(0, 30) : typeof first;
  }

  const result = { page: location.pathname, localStorage: [], sessionStorage: [], cookieNames: [], candidates: [], pageApiCalls: [], userRelatedPageCalls: [], probes: [] };
  try { result.localStorage = scanStorage(localStorage, 'local'); } catch (error) { result.localStorage = [`unavailable: ${error.message}`]; }
  try { result.sessionStorage = scanStorage(sessionStorage, 'session'); } catch (error) { result.sessionStorage = [`unavailable: ${error.message}`]; }
  result.cookieNames = document.cookie.split(';').map((cookie) => cookie.trim().split('=')[0]).filter(Boolean);

  for (const url of candidates) {
    const { status, json, type } = await call('GET', url);
    result.candidates.push({ url, status, type, ...(status === 200 && json ? { fields: pick(json) } : {}) });
  }

  // Calls the page itself made since it loaded (names only, no bodies). The first ones are the
  // start-up calls, which is where the logged-in user normally comes from.
  const entries = performance.getEntriesByType('resource')
    .filter((entry) => (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') && entry.name.startsWith(`${location.origin}/api/`));
  const seen = new Set();
  result.pageApiCalls = [];
  for (const entry of entries) {
    const url = new URL(entry.name);
    const path = url.pathname + url.search;
    if (seen.has(path)) continue;
    seen.add(path);
    result.pageApiCalls.push({ path, status: entry.responseStatus });
    if (result.pageApiCalls.length >= 150) break;
  }

  // Read-only GET on page calls that look user-related, to see what they return.
  result.userRelatedPageCalls = [];
  for (const { path } of result.pageApiCalls.filter((c) => /user|account|current|profile|identity|session|whoami|\/me\b|auth|login|role|permission/i.test(c.path)).slice(0, 15)) {
    const { status, json, type } = await call('GET', path);
    result.userRelatedPageCalls.push({ path, status, type, ...(status === 200 && json ? { fields: pick(json) } : {}) });
  }

  // Calls whose answer depends on who is logged in: only the shape of the answer is reported.
  result.userScopedPageCalls = [];
  for (const { path } of result.pageApiCalls.filter((c) => /notification|approval/i.test(c.path)).slice(0, 4)) {
    const { status, json, type } = await call('GET', path);
    result.userScopedPageCalls.push({ path, status, type, ...(json ? { recordKeys: shape(json), count: Array.isArray(json) ? json.length : undefined } : {}) });
  }
  for (const probe of probes) {
    const { status } = await call(probe.method, probe.url, probe.body);
    result.probes.push({ call: probe.label, status });
  }
  return result;
}

// Runs in the page's own JavaScript world: looks for application variables that hold the user.
function inspectMain() {
  const HINT = /^(email|mail|roles?|username|upn|preferred_username|displayname|firstname|lastname|currentuser)$/i;

  function summarise(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 120 ? `<${value.length} characters>` : value;
    if (typeof value !== 'object') return typeof value === 'function' ? undefined : value;
    if (depth > 2) return '<object>';
    if (Array.isArray(value)) return value.slice(0, 4).map((item) => summarise(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value).slice(0, 12)) {
      try { out[key] = summarise(value[key], depth + 1); } catch { /* getter threw */ }
    }
    return out;
  }

  function search(value, path, depth, hits, seen) {
    if (hits.length >= 30 || depth > 4 || value === null || typeof value !== 'object' || seen.has(value)) return;
    if (value === window || value instanceof Node) return;
    seen.add(value);
    let keys;
    try { keys = Object.keys(value).slice(0, 80); } catch { return; }
    for (const key of keys) {
      let child;
      try { child = value[key]; } catch { continue; }
      if (HINT.test(key) && child !== null && child !== undefined && typeof child !== 'function') hits.push({ path: `${path}.${key}`, value: summarise(child) });
      else search(child, `${path}.${key}`, depth + 1, hits, seen);
    }
  }

  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  document.documentElement.appendChild(frame);
  const standard = new Set(Object.getOwnPropertyNames(frame.contentWindow));
  frame.remove();

  const globals = Object.getOwnPropertyNames(window).filter((name) => !standard.has(name));
  const hits = [];
  const seen = new WeakSet();
  for (const name of globals) {
    let value;
    try { value = window[name]; } catch { continue; }
    if (typeof value === 'object' && value !== null) search(value, name, 0, hits, seen);
  }
  return { globalNames: globals.slice(0, 200), userLikeValues: hits };
}

// Looks at what is already in the page: inline scripts, meta tags and the user menu text.
function inspectDom() {
  const out = { inlineScriptMatches: [], metaTags: [], userMenuTexts: [] };
  const pattern = /(email|currentUser|userName|userInfo|"roles"|userId)["']?\s*[:=]\s*[^,;]{0,80}/gi;
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent ?? '';
    for (const match of text.matchAll(pattern)) {
      out.inlineScriptMatches.push(match[0].slice(0, 140));
      if (out.inlineScriptMatches.length >= 20) break;
    }
  }
  for (const meta of document.querySelectorAll('meta[name]')) {
    out.metaTags.push({ name: meta.getAttribute('name'), content: (meta.getAttribute('content') ?? '').slice(0, 80) });
  }
  const seen = new Set();
  for (const element of document.querySelectorAll('[class*="user" i],[class*="avatar" i],[class*="profile" i],[id*="user" i],[aria-label*="user" i],[title*="user" i]')) {
    for (const text of [element.innerText, element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('alt')]) {
      const value = (text ?? '').replace(/\s+/g, ' ').trim();
      if (value && value.length <= 80 && !seen.has(value)) {
        seen.add(value);
        out.userMenuTexts.push(value);
      }
    }
    if (out.userMenuTexts.length >= 15) break;
  }
  return out;
}

async function run() {
  copyButton.disabled = true;
  reportEl.value = 'Running...';
  statusEl.textContent = '';
  const environment = detectEnvironment(`https://${host}/`, await loadEnvironmentOverrides());
  if (!environment || !Number.isInteger(tabId)) {
    reportEl.value = 'Invalid request. Start it again from the extension icon.';
    return;
  }
  document.getElementById('envBadge').className = `badge ${environment.key}`;
  document.getElementById('envBadge').textContent = environment.short;

  try {
    const [{ result }] = await extensionApi.scripting.executeScript({ target: { tabId }, func: inspectTab, args: [CANDIDATES, PROBES] });
    const [{ result: dom }] = await extensionApi.scripting.executeScript({ target: { tabId }, func: inspectDom });
    let main;
    try {
      [{ result: main }] = await extensionApi.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: inspectMain });
    } catch (error) {
      main = { error: error.message };
    }
    const accessCheck = await checkAccess({ tabId, baseUrl: environment.baseUrl });
    reportEl.value = JSON.stringify({ diagnosticsVersion: 5, accessCheck, host: environment.host, generatedAt: new Date().toISOString(), ...result, dom, appVariables: main }, null, 2);
    copyButton.disabled = false;
  } catch (error) {
    reportEl.value = `Could not inspect the KBMax tab: ${error.message}`;
  }
}

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(reportEl.value);
  statusEl.textContent = 'Copied.';
});
document.getElementById('againButton').addEventListener('click', run);
run();
