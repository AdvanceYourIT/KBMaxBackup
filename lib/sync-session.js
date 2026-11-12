import { Batcher, UploadError, gitBlobSha1, joinPath, utf8Bytes } from './upload-utils.js';

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
// only because its modifiedDate is the same as the stored one, it is not a change. A file that cannot be read is
// treated as changed, but after `maxUnreadable` of them the upload stops: the host is then throttling or
// unavailable, and the comparison can no longer be trusted. `caseInsensitive` = paths ignore case (Azure DevOps):
// an existing file is found under its own spelling, and new files use the spelling of the folder in the repository.
// `failureNote(pushedChanges)` adds what is already pushed to the error of a failed push.
export function createSyncSession({ root, existing, flush, readExisting, onLog, label, maxFiles, maxBytes, maxFileBytes = Infinity, caseInsensitive = false, maxUnreadable = 5, failureNote = () => '' }) {
  const files = new Map(existing);
  const norm = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const byRecord = new Map();
  for (const path of files.keys()) {
    const key = recordKey(path);
    if (key) byRecord.set(norm(key), [...(byRecord.get(norm(key)) ?? []), path]);
  }
  const lookup = new Map([...files.keys()].map((path) => [norm(path), path]));
  const rootPrefix = norm(`${root}/`);
  const actualRoot = [...files.keys()].find((path) => norm(path).startsWith(rootPrefix))?.slice(0, root.length) ?? root;

  const counts = { added: 0, changed: 0, removed: 0, unchanged: 0, sameDate: 0, skipped: 0, unreadable: 0 };
  let infoFile = null;
  let pushed = 0;
  let compared = 0;
  const batcher = new Batcher({
    maxFiles,
    maxBytes,
    flush: async (batch) => {
      try {
        await flush(batch);
        pushed += batch.length;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        const note = failureNote(pushed);
        if (note) error.message = `${error.message}${/[.!?]$/.test(error.message) ? '' : '.'} ${note}`;
        throw error;
      }
    },
  });
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

  async function queue(file, countIt = true) {
    const wanted = joinPath(actualRoot, file.path.split('/').slice(1).join('/'));
    const path = lookup.get(norm(wanted)) ?? wanted;
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
        if (++compared % 200 === 0) onLog(`${label}: compared ${compared} changed files with the repository so far...`);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        counts.unreadable++;
        onLog(`${label}: could not read ${path} to compare modifiedDate (${error.message}); treating it as changed.`, true);
        if (counts.unreadable >= maxUnreadable) {
          throw new UploadError(`${label} could not read ${counts.unreadable} files from the repository, even after trying again (it may be throttling or unavailable). Nothing more was compared; run the backup again later.${failureNote(pushed) ? ` ${failureNote(pushed)}` : ''}`);
        }
      }
      if (oldText !== null && modifiedDateOf(oldText) === newDate) {
        if (countIt) {
          counts.unchanged++;
          counts.sameDate++;
        }
        return;
      }
    }
    const stale = known === undefined ? (byRecord.get(norm(recordKey(path) ?? '')) ?? []).filter((other) => norm(other) !== norm(path) && files.has(other)) : [];
    if (countIt) counts[known === undefined ? 'added' : 'changed']++;
    files.set(path, 'pending');
    lookup.set(norm(path), path);
    await batcher.add({ path, data: file.data, changeType: known === undefined ? 'add' : 'edit' });
    for (const other of stale) {
      files.delete(other);
      lookup.delete(norm(other));
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
      if (counts.unreadable > 0) onLog(`${label}: ${counts.unreadable} file(s) could not be read for the modifiedDate check and were compared on content.`, true);
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
  for (const change of batch) onLog(`${label}: [${tag[change.changeType]}] ${change.path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? change.path.slice(root.length + 1) : change.path}`);
}
