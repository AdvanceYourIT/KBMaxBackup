import { Batcher, gitBlobSha1, joinPath, utf8Bytes } from './upload-utils.js';

// "<id>_<name>.json" -> "<dir>/<id>". A renamed record keeps its id, so the file under the old name is a leftover.
function recordKey(path) {
  const match = /^(.*)\/(-?\d+)(?:_[^/]*)?\.json$/.exec(path);
  return match ? `${match[1]}/${match[2]}` : null;
}

// KBMax shows some values per user language, so a record can differ in text although nobody changed it.
// The top-level "modifiedDate" of the (pretty-printed) record file tells whether it was really changed.
function modifiedDateOf(text) {
  return /^ {2}"modifiedDate": ("[^"]*"|null)/m.exec(text)?.[1] ?? null;
}

// Incremental upload shared by the git destinations. `existing` maps every path under `root` (no leading
// slash) to its git blob id; a file is only pushed when it is new or its blob id differs. Files arrive as
// <backup folder>/<category>/<file> and land in `root`. `flush(batch)` pushes one batch of
// { changeType: 'add' | 'edit' | 'delete', path, data } and may return a summary of what it did.
// `readExisting(path, blobId)` returns the text of a file already in the repository (or null): when a file differs
// only because its modifiedDate is the same as the stored one, it is not a change.
export function createSyncSession({ root, existing, flush, readExisting, onLog, label, maxFiles, maxBytes, maxFileBytes = Infinity }) {
  const files = new Map(existing);
  const byRecord = new Map();
  for (const path of files.keys()) {
    const key = recordKey(path);
    if (key) byRecord.set(key, [...(byRecord.get(key) ?? []), path]);
  }

  const counts = { added: 0, changed: 0, removed: 0, unchanged: 0, sameDate: 0, skipped: 0 };
  let infoFile = null;
  const batcher = new Batcher({ maxFiles, maxBytes, flush });
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  async function queue(file, countIt = true) {
    const path = joinPath(root, file.path.split('/').slice(1).join('/'));
    const known = files.get(path);
    const bytes = utf8Bytes(file.data);
    if (bytes.length > maxFileBytes) {
      if (countIt) counts.skipped++;
      onLog(`${label}: [skipped] ${path} is ${mb(bytes.length)} MB, more than ${label} accepts in one push (${mb(maxFileBytes)} MB). It is not in the repository.`, true);
      return;
    }
    if (known !== undefined && known === (await gitBlobSha1(bytes))) {
      if (countIt) counts.unchanged++;
      return;
    }
    const newDate = known !== undefined && known !== 'pending' && readExisting ? modifiedDateOf(file.data) : null;
    if (newDate && newDate !== 'null') {
      let oldText = null;
      try {
        oldText = await readExisting(path, known);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        onLog(`${label}: could not read ${path} to compare modifiedDate (${error.message}); comparing the content instead.`, true);
      }
      if (oldText !== null && modifiedDateOf(oldText) === newDate) {
        if (countIt) {
          counts.unchanged++;
          counts.sameDate++;
        }
        return;
      }
    }
    const stale = known === undefined ? (byRecord.get(recordKey(path)) ?? []).filter((other) => other !== path && files.has(other)) : [];
    if (countIt) counts[known === undefined ? 'added' : 'changed']++;
    files.set(path, 'pending');
    await batcher.add({ path, data: file.data, changeType: known === undefined ? 'add' : 'edit' });
    for (const other of stale) {
      files.delete(other);
      counts.removed++;
      await batcher.add({ path: other, data: '', changeType: 'delete' });
    }
  }

  return {
    async add(file) {
      // backup-info.json changes on every run; it is only pushed when something else changed.
      if (file.path.split('/').length === 2 && file.path.endsWith('/backup-info.json')) {
        infoFile = file;
        return;
      }
      await queue(file);
    },
    async finish() {
      if (infoFile && counts.added + counts.changed + counts.removed > 0) await queue(infoFile, false);
      await batcher.finish();
      const total = counts.added + counts.changed + counts.removed;
      onLog(total === 0
        ? `${label}: nothing to push, all ${counts.unchanged} files are unchanged${counts.sameDate ? ` (including ${counts.sameDate} with different content but the same modifiedDate)` : ''}.`
        : `${label}: ${counts.added} new, ${counts.changed} changed, ${counts.removed} removed, ${counts.unchanged} unchanged${counts.sameDate ? ` (including ${counts.sameDate} with different content but the same modifiedDate)` : ''}.`);
      if (counts.skipped > 0) onLog(`${label}: ${counts.skipped} file(s) were too large and skipped (see [skipped] lines above).`, true);
      return counts;
    },
  };
}

export function describeBatch(batch) {
  const tally = (type) => batch.filter((change) => change.changeType === type).length;
  return [`${tally('add')} new`, `${tally('edit')} changed`, tally('delete') ? `${tally('delete')} removed` : null].filter(Boolean).join(', ');
}

// One log line per file of a pushed batch: [new], [changed] or [removed] plus the path inside the sync folder.
export function logBatch(batch, root, label, onLog) {
  const tag = { add: 'new', edit: 'changed', delete: 'removed' };
  for (const change of batch) onLog(`${label}: [${tag[change.changeType]}] ${change.path.startsWith(`${root}/`) ? change.path.slice(root.length + 1) : change.path}`);
}
