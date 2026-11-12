// All calls run inside the KBMax tab itself, so the logged-in user's session is reused
// and no credentials are stored in the extension.
const extensionApi = globalThis.browser ?? globalThis.chrome;

const PAGE_SIZE = 500;
const MAX_PAGES = 400;
const MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Backup cancelled.', 'AbortError');
}

async function fetchInTab(tabId, url, options) {
  let results;
  try {
    results = await extensionApi.scripting.executeScript({
      target: { tabId },
      args: [url, options],
      func: async (requestUrl, requestOptions) => {
        try {
          const response = await fetch(requestUrl, requestOptions);
          const body = await response.text();
          return { ok: response.ok, status: response.status, statusText: response.statusText, body };
        } catch (error) {
          return { networkError: error instanceof Error ? error.message : 'Unknown network error.' };
        }
      },
    });
  } catch (error) {
    throw new Error(`KBMax tab is not reachable (is it still open?): ${error.message}`);
  }

  const result = results?.[0]?.result;
  if (!result) throw new Error('No response from the KBMax tab.');
  if (result.networkError) throw new Error(result.networkError);
  return result;
}

// Writes pass maxAttempts: 1 so a failed request is never repeated automatically.
export async function requestJson({ tabId, url, method = 'GET', payload, signal, maxAttempts = MAX_ATTEMPTS }) {
  const options = { method, credentials: 'include', headers: { Accept: 'application/json' } };
  if (payload !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      const response = await fetchInTab(tabId, url, options);
      const retryable = response.status === 429 || response.status >= 500;
      if (!response.ok && retryable && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      if (!response.ok) {
        const error = new Error(`${method} ${url} -> ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return response.body ? JSON.parse(response.body) : null;
    } catch (error) {
      lastError = error;
      if (error.status || attempt === maxAttempts) throw error;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

export async function checkSession({ tabId, baseUrl, signal }) {
  await requestJson({ tabId, url: `${baseUrl}/api/settings`, signal });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function searchPage({ tabId, baseUrl, category, skip, signal }) {
  const base = { sortField: category.sortField ?? 'id', descending: false, skip, take: PAGE_SIZE };
  if ('searchFields' in category) {
    return asArray(await requestJson({ tabId, url: baseUrl + category.searchApi, method: 'POST', payload: { ...base, fields: category.searchFields }, signal }));
  }
  try {
    return asArray(await requestJson({ tabId, url: baseUrl + category.searchApi, method: 'POST', payload: { ...base, fields: ['id', 'name'] }, signal }));
  } catch (error) {
    if (error.status !== 400) throw error;
    return asArray(await requestJson({ tabId, url: baseUrl + category.searchApi, method: 'POST', payload: { ...base, fields: ['id'] }, signal }));
  }
}

// Lists that are fetched with a GET instead of a search (category.listGet(page) -> url). The answer is an
// array, or { items, totalCount } which is followed page by page.
async function listByGet({ tabId, baseUrl, category, signal }) {
  const records = new Map();

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await requestJson({ tabId, url: baseUrl + category.listGet(page), signal });
    const before = records.size;
    for (const record of asArray(body)) {
      const key = record?.id ?? record?.name;
      if (key !== undefined) records.set(key, record);
    }
    const hasMore = Array.isArray(body?.items) && typeof body.totalCount === 'number' && records.size < body.totalCount;
    if (!hasMore || records.size === before) break;
  }

  return [...records.values()];
}

export async function listAll({ tabId, baseUrl, category, signal }) {
  if (category.listGet) return listByGet({ tabId, baseUrl, category, signal });
  const records = new Map();

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await searchPage({ tabId, baseUrl, category, skip: records.size, signal });
    const before = records.size;
    for (const record of batch) {
      if (record?.id !== undefined) records.set(record.id, record);
    }
    if (batch.length < PAGE_SIZE || records.size === before) break;
  }

  return [...records.values()];
}

export async function getRecord({ tabId, baseUrl, category, id, signal }) {
  try {
    return await requestJson({ tabId, url: baseUrl + category.getApi(id), signal });
  } catch (error) {
    if (error.status === 404 || error.status === 405) return null;
    throw error;
  }
}
