import { safeName } from './backup.js';
import { getRecord, listAll, requestJson } from './kbmaxApi.js';

// Fields the server sets itself or derives; they are not compared and not required in a file.
const SERVER_MANAGED = ['createdDate', 'modifiedDate', 'createdBy', 'modifiedBy', 'modifiedByName'];
const DERIVED = ['references', 'dependencies'];

function kind(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function changedKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => !SERVER_MANAGED.includes(key) && !DERIVED.includes(key) && canonical(a[key]) !== canonical(b[key]));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
}

// KBMax omits empty fields, so one record does not show every field. The reference is a merge of the
// first records of the type (the first non-null value of each field wins). Fetched once per analysis.
const SAMPLE_SIZE = 8;
async function sampleRecord(context, category, signal) {
  if (context.template !== undefined) return context.template;
  const { tabId, baseUrl } = context;
  const list = await listAll({ tabId, baseUrl, category, signal });
  const merged = {};
  let found = 0;
  for (const { id } of list.slice(0, SAMPLE_SIZE)) {
    const record = await getRecord({ tabId, baseUrl, category, id, signal });
    if (!record) continue;
    found++;
    for (const [key, value] of Object.entries(record)) {
      if (!(key in merged) || (merged[key] === null && value !== null)) merged[key] = value;
    }
  }
  context.template = found > 0 ? merged : null;
  return context.template;
}

// Compares a file with a reference record: data types always, missing fields only when requireAll.
// `known` = record whose keys count as known fields (default: the reference). KBMax leaves empty fields out,
// so a single record can lack a valid field such as "sku"; callers pass a merge of several records.
function checkFields(entry, body, reference, requireAll, known = reference) {
  for (const key of Object.keys(reference)) {
    if (!(key in body)) {
      if (requireAll && !SERVER_MANAGED.includes(key)) entry.errors.push(`Missing field "${key}" (a PUT replaces the whole record).`);
    } else if (reference[key] !== null && body[key] !== null && kind(reference[key]) !== kind(body[key])) {
      entry.errors.push(`Field "${key}" should be ${kind(reference[key])}, found ${kind(body[key])}.`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!(key in known) && !(key in reference)) entry.warnings.push(`Unknown field "${key}" (not in the existing records).`);
  }
}

function checkActiveFlag(entry, body, category) {
  if (!category.write.activeInConfigurator || !isObject(body.configurator) || typeof body.active !== 'boolean') return;
  const inConfigurator = body.configurator.active ?? true;
  if (inConfigurator !== body.active) {
    entry.warnings.push(`"active" is ${body.active} but configurator.active is ${inConfigurator}${'active' in body.configurator ? '' : ' (absent = true)'}: KBMax takes the configurator's value. Set configurator.active to ${body.active} as well.`);
  }
}

function checkAllowed(entry, body, category) {
  for (const [key, values] of Object.entries(category.write.allowed ?? {})) {
    if (key in body && !values.includes(body[key])) entry.errors.push(`"${key}" must be one of: ${values.join(', ')} (found ${JSON.stringify(body[key])}).`);
  }
}

// The visual editor stores the function declaration inside `blocks`; it has to agree with the record.
function checkBlocks(entry, body) {
  if (typeof body.blocks !== 'string') return;
  let tree;
  try {
    tree = JSON.parse(body.blocks);
  } catch {
    entry.errors.push('"blocks" is not valid JSON.');
    return;
  }
  const declaration = tree?.blocks?.find?.((block) => block?.$type === 'DeclareGlobalFunctionBlock');
  if (!declaration) return;
  if (declaration.parts?.name !== body.name) entry.warnings.push(`"name" is "${body.name}" but the declaration in "blocks" says "${declaration.parts?.name}".`);
  if (declaration.parts?.type !== body.functionType) entry.warnings.push(`"functionType" is "${body.functionType}" but the declaration in "blocks" says "${declaration.parts?.type}".`);
  const declared = (declaration.parts?.func?.parameters ?? []).map((parameter) => parameter.name).join(',');
  const listed = Array.isArray(body.parameters) ? body.parameters.map((parameter) => parameter?.name).join(',') : '';
  if (declared !== listed) entry.warnings.push(`"parameters" (${listed || 'none'}) differ from the declaration in "blocks" (${declared || 'none'}).`);
}

async function planCreate({ entry, body, category, context, signal }) {
  const { create, createFields } = category.write;
  if (!create) {
    entry.errors.push('No "id": creating new records is not supported for this type.');
    return;
  }

  for (const key of category.write.required ?? createFields) {
    if (!(key in body)) entry.errors.push(`Missing field "${key}" (required to create a record).`);
  }
  if ('name' in body && (typeof body.name !== 'string' || body.name.trim() === '')) entry.errors.push('"name" must be a non-empty text.');
  checkAllowed(entry, body, category);

  if (typeof body.name === 'string' && body.name.trim() !== '') {
    context.existing ??= new Map((await listAll({ tabId: context.tabId, baseUrl: context.baseUrl, category, signal })).map((record) => [String(record.name).toLowerCase(), record.id]));
    const key = body.name.toLowerCase();
    if (context.existing.has(key)) {
      const message = `A record named "${body.name}" already exists (id ${context.existing.get(key)}).`;
      (category.write.uniqueName ? entry.errors : entry.warnings).push(message);
    }
    if (context.newNames.has(key)) (category.write.uniqueName ? entry.errors : entry.warnings).push(`Another file in this import also creates "${body.name}".`);
    context.newNames.add(key);
  }

  const template = await sampleRecord(context, category, signal);
  if (template) checkFields(entry, body, template, false);
  checkBlocks(entry, body);
  checkActiveFlag(entry, body, category);
  if (category.write.createOmit?.includes('isDefault') && body.isDefault === true) entry.warnings.push('"isDefault" is ignored when creating: the default quote header is a company setting.');
  if ('blocks' in body && !('js' in body)) entry.warnings.push('No "js": the record will have no compiled code until it is opened and saved in the KBMax editor.');

  if (entry.errors.length === 0) entry.action = 'create';
}

// Dry run: reads and validates every file against KBMax. Writes nothing.
// items: [{ name, text }]. Entry actions: 'create' | 'update' | 'unchanged' | 'error'.
export async function planImport({ tabId, baseUrl, category, items, signal, onProgress }) {
  const plan = [];
  const seenIds = new Set();
  const context = { tabId, baseUrl, newNames: new Set() };

  for (const [index, item] of items.entries()) {
    throwIfAborted(signal);
    const entry = { file: item.name, id: null, name: null, action: 'error', errors: [], warnings: [], current: null, body: null };
    plan.push(entry);
    onProgress?.({ done: index + 1, total: items.length });

    let body;
    try {
      body = JSON.parse(item.text);
    } catch (error) {
      entry.errors.push(`Not valid JSON: ${error.message}`);
      continue;
    }
    if (kind(body) !== 'object') {
      entry.errors.push('The top level must be a JSON object.');
      continue;
    }
    entry.body = body;
    entry.name = body.name ?? null;

    if (body.id === undefined || body.id === null) {
      await planCreate({ entry, body, category, context, signal });
      continue;
    }
    if (!Number.isInteger(body.id) || body.id <= 0) {
      entry.errors.push(`Invalid "id" ${JSON.stringify(body.id)}.`);
      continue;
    }
    entry.id = body.id;
    if (seenIds.has(body.id)) {
      entry.errors.push(`Another file in this import already targets id ${body.id}.`);
      continue;
    }
    seenIds.add(body.id);

    let current;
    try {
      current = await getRecord({ tabId, baseUrl, category, id: body.id, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      entry.errors.push(`Could not read the current record: ${error.message}`);
      continue;
    }
    if (!current) {
      entry.errors.push(`id ${body.id} does not exist in this environment, so it cannot be updated. Remove the "id" to create a new record.`);
      continue;
    }
    entry.current = current;

    checkFields(entry, body, current, true, (await sampleRecord(context, category, signal)) ?? current);
    checkAllowed(entry, body, category);
    checkBlocks(entry, body);
    checkActiveFlag(entry, body, category);

    const changed = changedKeys(body, current);
    if (changed.includes('blocks') && !changed.includes('js') && 'js' in body) entry.warnings.push('"blocks" changed but "js" did not; js may be out of sync.');
    if (changed.includes('js') && !changed.includes('blocks') && 'blocks' in body) entry.warnings.push('"js" changed but "blocks" did not; the visual editor will not match.');
    if (changed.includes('name')) entry.warnings.push(`Renames "${current.name}" to "${body.name}".`);

    const editors = changed.length > 0 ? await getEditors({ tabId, baseUrl, category, id: body.id, signal }) : null;
    if (editors?.length) entry.warnings.push(`Being edited right now: ${describeEditors(editors)}. Applying will be refused until they are done.`);

    if (entry.errors.length > 0) continue;
    entry.action = changed.length > 0 ? 'update' : 'unchanged';
    entry.changed = changed;
  }

  return plan;
}

// Sessions currently editing the record in KBMax ([] = none, null = this type has no lock info).
async function getEditors({ tabId, baseUrl, category, id, signal }) {
  if (!category.write.editLock) return null;
  try {
    const list = await requestJson({ tabId, url: baseUrl + category.write.editLock(id), signal, maxAttempts: 1 });
    return Array.isArray(list) ? list : null;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return null;
  }
}

function describeEditors(editors) {
  return `${editors.length} session(s) are editing it in KBMax (${JSON.stringify(editors[0]).slice(0, 120)})`;
}

// Fields a server adds to the rows it stores (ids, owner, dates). They are not differences when the file lacked them.
const SERVER_ROW_KEYS = new Set(['id', 'idProduct', 'createdDate', 'modifiedDate', 'createdBy', 'modifiedBy', 'modifiedByName']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const brief = (value) => (value === undefined ? '(absent)' : JSON.stringify(value)?.slice(0, 40) ?? '(absent)');

// KBMax rewrites ids inside rule blocks (kbs_...), reformats the JSON text of `blocks` and adds empty
// defaults (skip: [], take: []). These are not differences: ids are dropped and JSON text is parsed first.
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (isObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'id' && typeof item === 'string' && item.startsWith('kbs_')) continue;
      out[key] = normalise(item);
    }
    return out;
  }
  if (typeof value === 'string' && (value[0] === '{' || value[0] === '[')) {
    try {
      return normalise(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value;
}

const isEmptyDefault = (value) => value === null || value === '' || (Array.isArray(value) && value.length === 0);

function diffStored(sent, stored, path, out) {
  if (out.length >= 40 || canonical(sent) === canonical(stored)) return;
  if (Array.isArray(sent) && Array.isArray(stored)) {
    if (sent.length !== stored.length) out.push({ path, sent: `${sent.length} items`, stored: `${stored.length} items` });
    else sent.forEach((item, index) => diffStored(item, stored[index], `${path}[${index}]`, out));
    return;
  }
  if (isObject(sent) && isObject(stored)) {
    for (const key of new Set([...Object.keys(sent), ...Object.keys(stored)])) {
      if (!(key in sent) && (SERVER_ROW_KEYS.has(key) || isEmptyDefault(stored[key]))) continue;
      if (key === 'js' && path.includes('.')) continue; // compiled code the server regenerates
      if (!(key in sent) || !(key in stored)) out.push({ path: `${path}.${key}`, sent: brief(sent[key]), stored: brief(stored[key]) });
      else diffStored(sent[key], stored[key], `${path}.${key}`, out);
    }
    return;
  }
  out.push({ path, sent: brief(sent), stored: brief(stored) });
}

async function readBack({ tabId, baseUrl, category, id, body, result, signal, onLog }) {
  const after = await getRecord({ tabId, baseUrl, category, id, signal });
  result.serverChanged = [];
  result.serverDiff = [];
  if (!after) return;

  for (const key of new Set([...Object.keys(body), ...Object.keys(after)])) {
    if (SERVER_MANAGED.includes(key) || DERIVED.includes(key)) continue;
    const found = [];
    diffStored(normalise(body[key]), normalise(after[key]), key, found);
    if (found.length > 0) {
      result.serverChanged.push(key);
      result.serverDiff.push(...found);
    }
  }
  if (result.serverChanged.length > 0) {
    const shown = result.serverDiff.slice(0, 8).map((d) => `${d.path} (${d.sent} -> ${d.stored})`).join('; ');
    const more = result.serverDiff.length > 8 ? `; and ${result.serverDiff.length - 8} more` : '';
    onLog(`#${id}: the server stored different values: ${shown}${more}`, true);
  }
}

// Applies the 'create' and 'update' entries one at a time. `snapshot(path, data)` receives the
// current record of every update before it is overwritten. Every write is read back and compared.
// Statuses: updated | created | created-partial (created, but the full save failed) | failed.
export async function applyImport({ tabId, baseUrl, category, plan, snapshot, signal, onLog, onProgress }) {
  const todo = plan.filter((entry) => entry.action === 'update' || entry.action === 'create');
  const results = [];

  for (const [index, entry] of todo.entries()) {
    throwIfAborted(signal);
    const result = { file: entry.file, id: entry.id, action: entry.action, status: 'failed', message: '', serverChanged: [] };
    results.push(result);
    const target = { tabId, baseUrl, category, signal };

    try {
      if (entry.action === 'update') {
        const editors = await getEditors({ ...target, id: entry.id });
        if (editors?.length) {
          result.message = `Skipped: ${describeEditors(editors)}.`;
          onLog(`#${entry.id} ${entry.name ?? ''}: ${result.message}`, true);
          onProgress?.({ done: index + 1, total: todo.length });
          continue;
        }
        await snapshot(`${category.folder}/${entry.id}_${safeName(entry.current.name)}.json`, JSON.stringify(entry.current, null, 2));
        await requestJson({ ...target, url: baseUrl + category.write.update(entry.id), method: 'PUT', payload: entry.body, maxAttempts: 1 });
        result.status = 'updated';
        onLog(`#${entry.id} ${entry.name ?? ''}: updated.`);
        await readBack({ ...target, id: entry.id, body: entry.body, result, onLog });
      } else {
        const { createFields, createOmit } = category.write;
        const payload = createFields
          ? Object.fromEntries(createFields.map((key) => [key, entry.body[key]]))
          : Object.fromEntries(Object.entries(entry.body).filter(([key]) => !createOmit.includes(key)));
        const created = await requestJson({ ...target, url: baseUrl + category.write.create, method: 'POST', payload, maxAttempts: 1 });
        if (!Number.isInteger(created?.id)) throw new Error('The server did not return an id for the new record.');
        result.id = created.id;
        result.status = 'created';
        onLog(`${entry.name}: created as id ${created.id}.`);

        const full = { ...entry.body, id: created.id };
        if (category.write.createFields && changedKeys(full, created).length > 0) {
          try {
            await requestJson({ ...target, url: baseUrl + category.write.update(created.id), method: 'PUT', payload: full, maxAttempts: 1 });
            onLog(`#${created.id}: full content saved.`);
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            result.status = 'created-partial';
            result.message = `Created as id ${created.id} with only ${category.write.createFields.join(', ')}; saving the full content failed: ${error.message}`;
            onLog(`#${created.id}: ${result.message}`, true);
          }
        }
        if (result.status === 'created') await readBack({ ...target, id: created.id, body: full, result, onLog });
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      result.message = error.message;
      onLog(`${entry.name ?? entry.file}: ${result.status === 'failed' ? 'FAILED' : 'read-back failed'} - ${error.message}`, true);
    }
    onProgress?.({ done: index + 1, total: todo.length });
  }

  return results;
}
