const encoder = new TextEncoder();

export class UploadError extends Error {}

// Busy or throttling servers (HTTP 429, and 5xx for reads) and dropped connections are tried again with a growing
// pause, or the pause the server asks for (Retry-After), instead of failing the whole upload. A write is only
// repeated after a 429: that request was not processed. `retryConfig` is exported so tests can shorten the pauses.
export const retryConfig = { retries: 4, baseDelayMs: 1000, maxDelayMs: 60000, onRetry: null };

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Cancelled.', 'AbortError'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled.', 'AbortError')); }, { once: true });
});

function retryAfterMs(response) {
  const value = response.headers?.get?.('Retry-After');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function httpJson(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const reading = method === 'GET' || method === 'HEAD';
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (reading && attempt < retryConfig.retries) {
        await pause(attempt, null, `network error (${error.message})`, url, signal);
        continue;
      }
      throw new UploadError(`Network error calling ${new URL(url).host}: ${error.message}`);
    }

    const waitMs = retryAfterMs(response);
    // GitHub answers its secondary rate limit with 403 + Retry-After.
    const retryable = response.status === 429 || (response.status === 403 && waitMs !== null) || (reading && [500, 502, 503, 504].includes(response.status));
    if (retryable && attempt < retryConfig.retries) {
      await response.text().catch(() => '');
      await pause(attempt, waitMs, `HTTP ${response.status}`, url, signal);
      continue;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  }
}

async function pause(attempt, serverWaitMs, reason, url, signal) {
  const ms = Math.min(serverWaitMs ?? retryConfig.baseDelayMs * 2 ** attempt, retryConfig.maxDelayMs);
  retryConfig.onRetry?.(`${new URL(url).host} is busy (${reason}); trying again in ${Math.max(1, Math.round(ms / 1000))} s (attempt ${attempt + 2} of ${retryConfig.retries + 1}).`);
  await sleep(ms, signal);
}

export function describeFailure(action, result) {
  const detail = result.json?.message ?? result.text.replace(/\s+/g, ' ').slice(0, 200);
  return new UploadError(`${action} failed (HTTP ${result.status})${detail ? `: ${detail}` : ''}`);
}

export function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').split('/').map((part) => part.trim()).filter(Boolean).join('/');
}

export function joinPath(...parts) {
  return parts.map(normalizePath).filter(Boolean).join('/');
}

// Collects files and hands them to `flush(batch)` whenever a batch is full, one batch at a time.
// add() resolves once the file is accepted (after a flush when it filled the batch), so callers
// that await it never hold more than one batch in memory. A batch never grows past maxBytes
// (a file that does not fit starts a new batch); a file bigger than maxFileBytes is skipped with onSkip(file).
export class Batcher {
  constructor({ maxFiles, maxBytes, maxFileBytes = Infinity, onSkip = () => {}, flush }) {
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.maxFileBytes = maxFileBytes;
    this.onSkip = onSkip;
    this.flushBatch = flush;
    this.pending = [];
    this.bytes = 0;
    this.chain = Promise.resolve();
  }

  add(file) {
    const size = encoder.encode(file.data).length + file.path.length;
    if (size > this.maxFileBytes) {
      this.onSkip(file, size);
      return Promise.resolve();
    }
    const flushed = this.pending.length > 0 && this.bytes + size > this.maxBytes ? this.#flushPending() : Promise.resolve();
    this.pending.push(file);
    this.bytes += size;
    if (this.pending.length < this.maxFiles && this.bytes < this.maxBytes) return flushed;
    return this.#flushPending();
  }

  async finish() {
    await this.#flushPending();
  }

  #flushPending() {
    const batch = this.pending;
    this.pending = [];
    this.bytes = 0;
    this.chain = this.chain.then(() => (batch.length > 0 ? this.flushBatch(batch) : undefined));
    return this.chain;
  }
}

export async function gitBlobSha1(bytes) {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const buffer = new Uint8Array(header.length + bytes.length);
  buffer.set(header, 0);
  buffer.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function utf8Bytes(text) {
  return encoder.encode(text);
}
