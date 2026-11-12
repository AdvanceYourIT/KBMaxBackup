const encoder = new TextEncoder();

export class UploadError extends Error {}

export async function httpJson(url, { method = 'GET', headers = {}, body, signal } = {}) {
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
    throw new UploadError(`Network error calling ${new URL(url).host}: ${error.message}`);
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

export function describeFailure(action, result) {
  const detail = result.json?.message ?? result.text.replace(/\s+/g, ' ').slice(0, 200);
  return new UploadError(`${action} failed (HTTP ${result.status})${detail ? `: ${detail}` : ''}`);
}

export function normalizePath(path) {
  return String(path ?? '').split('/').map((part) => part.trim()).filter(Boolean).join('/');
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
