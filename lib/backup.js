import { CATEGORIES } from './categories.js';
import { checkSession, getRecord, listAll, requestJson } from './kbmaxApi.js';

const CONCURRENCY = 4;

function pad(n) {
  return String(n).padStart(2, '0');
}

export function timestampForFolder(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function safeName(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

async function mapWithConcurrency(items, limit, worker, signal) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

export function makeFolderName(environment, date = new Date(), label = '') {
  return `KBMax_${environment.short}${label ? `_${safeName(label)}` : ''}_${timestampForFolder(date)}`;
}

// Backs up one record (the one open in KBMax): the saved version, as in a full backup.
export async function runRecordBackup({ tabId, environment, folderName, category, id, signal, onLog, onFile }) {
  const startedAt = new Date();
  onLog(`Checking session on ${environment.host}...`);
  await checkSession({ tabId, baseUrl: environment.baseUrl, signal });

  onLog(`${category.label} #${id}: fetching...`);
  const baseUrl = environment.baseUrl;
  let data = await getRecord({ tabId, baseUrl, category: category.getApi ? category : { ...category, getApi: category.recordApi }, id, signal });
  if (!data && !category.getApi) {
    onLog(`${category.label} #${id}: no single-record endpoint, using the search list...`);
    data = (await listAll({ tabId, baseUrl, category, signal })).find((record) => record.id === id) ?? null;
  }
  if (!data) throw new Error(`${category.label} #${id} was not found (404).`);

  const name = safeName(data.name ?? data.role);
  await onFile({ path: `${folderName}/${category.folder}/${id}${name ? `_${name}` : ''}.json`, data: JSON.stringify(data, null, 2) });

  const summary = {
    environment: environment.key,
    environmentLabel: environment.label,
    host: environment.host,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    categories: [category.key],
    record: { category: category.key, id },
    counts: { [category.key]: 1 },
    errorCount: 0,
  };
  await onFile({ path: `${folderName}/backup-info.json`, data: JSON.stringify(summary, null, 2) });
  return summary;
}

// Streams every file to `onFile({ path, data })` as soon as it is fetched (awaited, so slow
// consumers slow the backup down instead of piling up in memory). Returns the summary.
export async function runBackup({ tabId, environment, folderName, categoryKeys, signal, onLog, onProgress, onFile }) {
  const baseUrl = environment.baseUrl;
  const startedAt = new Date();
  const categories = CATEGORIES.filter((category) => categoryKeys.includes(category.key));
  const errors = [];
  const counts = {};

  onLog(`Checking session on ${environment.host}...`);
  await checkSession({ tabId, baseUrl, signal });

  for (const [categoryIndex, category] of categories.entries()) {
    if (signal?.aborted) throw new DOMException('Backup cancelled.', 'AbortError');

    if (category.single) {
      onLog(`${category.label}: fetching...`);
      try {
        const data = await requestJson({ tabId, url: baseUrl + category.single, signal });
        await onFile({ path: `${folderName}/${category.file}`, data: JSON.stringify(data, null, 2) });
        counts[category.key] = 1;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        errors.push({ category: category.key, step: 'get', message: error.message });
        onLog(`${category.label}: failed (${error.message})`, true);
        counts[category.key] = 0;
      }
      onProgress({ categoryIndex, categoryCount: categories.length, category, done: 1, total: 1, finished: true });
      continue;
    }

    onLog(`${category.label}: fetching list...`);
    let records;
    try {
      records = await listAll({ tabId, baseUrl, category, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      errors.push({ category: category.key, step: 'list', message: error.message });
      onLog(`${category.label}: listing failed (${error.message})`, true);
      counts[category.key] = 0;
      continue;
    }

    onLog(`${category.label}: ${records.length} found${category.getApi ? ', fetching details' : ''}...`);
    let done = 0;
    let saved = 0;
    let searchOnly = 0;

    await mapWithConcurrency(records, CONCURRENCY, async (record) => {
      let data = record;
      try {
        const detail = !category.getApi ? record : await getRecord({ tabId, baseUrl, category, id: record.id, signal });
        if (detail) data = detail;
        else searchOnly++;
      } catch (error) {
        if (error.name === 'AbortError') return;
        errors.push({ category: category.key, id: record.id, step: 'get', message: error.message });
        onLog(`${category.label} #${record.id}: ${error.message}`, true);
      }

      const name = safeName(data?.name ?? data?.role ?? record.name ?? record.role);
      await onFile({
        path: `${folderName}/${category.folder}/${record.id}${name ? `_${name}` : ''}.json`,
        data: JSON.stringify(data, null, 2),
      });
      saved++;
      done++;
      onProgress({ categoryIndex, categoryCount: categories.length, category, done, total: records.length });
    }, signal);

    if (signal?.aborted) throw new DOMException('Backup cancelled.', 'AbortError');
    if (searchOnly > 0) {
      const message = `${searchOnly} of ${records.length} records have no detail endpoint (${category.getApi('{id}')} returned 404/405); only the search fields were saved. Check this endpoint in lib/categories.js.`;
      errors.push({ category: category.key, step: 'get', message });
      onLog(`${category.label}: WARNING ${message}`, true);
    }
    counts[category.key] = saved;
    onProgress({ categoryIndex, categoryCount: categories.length, category, done: records.length, total: records.length, finished: true });
  }

  const finishedAt = new Date();
  const summary = {
    environment: environment.key,
    environmentLabel: environment.label,
    host: environment.host,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    categories: categories.map((category) => category.key),
    counts,
    errorCount: errors.length,
  };

  await onFile({ path: `${folderName}/backup-info.json`, data: JSON.stringify(summary, null, 2) });
  if (errors.length > 0) {
    await onFile({ path: `${folderName}/_errors.json`, data: JSON.stringify(errors, null, 2) });
  }

  return summary;
}
