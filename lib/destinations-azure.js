import { createSyncSession, describeBatch, logBatch } from './sync-session.js';
import { Batcher, UploadError, describeFailure, httpJson, joinPath, retryConfig, toBase64, utf8Bytes } from './upload-utils.js';

const API_VERSION = '7.1';
// A push is refused above 25 MB. Sync sends base64 (x 4/3) and keeps a batch at 12 MB of content (about 16 MB sent);
// a single file can be up to 16 MB of content (about 21.5 MB sent).
const MAX_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function repoUrl(values) {
  const part = (value) => encodeURIComponent(value);
  return `https://dev.azure.com/${part(values.organization)}/${part(values.project)}/_apis/git/repositories/${part(values.repository)}`;
}

function authHeaders(token) {
  return { Authorization: `Basic ${btoa(`:${token}`)}` };
}

// Azure DevOps answers an invalid PAT with HTTP 203 and an HTML sign-in page.
function assertJson(action, result) {
  if (result.status === 401 || result.status === 203 || (result.ok && result.json === null)) {
    throw new UploadError(`${action} failed: Azure DevOps rejected the token. Check the PAT, its expiry and that it has the "Code (Read & write)" scope for this organization.`);
  }
  if (!result.ok) throw describeFailure(action, result);
}

export function validate(values, token) {
  const missing = ['organization', 'project', 'repository', 'branch']
    .filter((key) => !values[key]).map((key) => key);
  if (!token) missing.push('token');
  return missing;
}

async function getBranchObjectId(values, token, signal) {
  const branch = values.branch;
  const result = await httpJson(`${repoUrl(values)}/refs?filter=${encodeURIComponent(`heads/${branch}`)}&api-version=${API_VERSION}`, { headers: authHeaders(token), signal });
  assertJson('Reading branch', result);
  const ref = result.json?.value?.find((r) => r.name === `refs/heads/${branch}`);
  if (!ref) throw new UploadError(`Branch "${branch}" does not exist in the repository. Create it first (the repository needs at least one commit).`);
  return ref.objectId;
}

export async function test(values, token, signal) {
  const missing = validate(values, token);
  if (missing.length > 0) throw new UploadError(`Missing: ${missing.join(', ')}`);

  const result = await httpJson(`${repoUrl(values)}?api-version=${API_VERSION}`, { headers: authHeaders(token), signal });
  assertJson('Reading repository', result);
  await getBranchObjectId(values, token, signal);
  return `Connected to ${result.json.name}, branch "${values.branch}" found.`;
}

// Every blob under `root` on the branch: path (without the leading slash) -> objectId. A missing folder (first run) is an empty list.
async function listExisting(values, token, root, signal) {
  const query = `scopePath=${encodeURIComponent(`/${root}`)}&recursionLevel=Full&versionDescriptor.version=${encodeURIComponent(values.branch)}&versionDescriptor.versionType=branch&api-version=${API_VERSION}`;
  const result = await httpJson(`${repoUrl(values)}/items?${query}`, { headers: authHeaders(token), signal });
  if (result.status === 404) return new Map();
  assertJson('Reading existing files', result);
  return new Map((result.json?.value ?? []).filter((item) => item.gitObjectType === 'blob').map((item) => [item.path.replace(/^\//, ''), item.objectId]));
}

// Text of one file on the branch, or null when it cannot be read.
async function readFile(values, token, path, signal) {
  const query = `path=${encodeURIComponent(`/${path}`)}&versionDescriptor.version=${encodeURIComponent(values.branch)}&versionDescriptor.versionType=branch&includeContent=true&$format=text&api-version=${API_VERSION}`;
  const result = await httpJson(`${repoUrl(values)}/items?${query}`, { headers: authHeaders(token), signal });
  if (result.status === 404) return null;
  assertJson('Reading a file', result);
  return result.text;
}

// Incremental mode: one fixed folder per environment; only new or changed files are pushed.
async function createSyncAzureSession({ values, token, syncFolder, signal, onLog }) {
  let oldObjectId = await getBranchObjectId(values, token, signal);
  const root = joinPath(values.path, syncFolder);
  const existing = await listExisting(values, token, root, signal);
  onLog(`Azure DevOps: incremental sync into /${root} (${existing.size} files already there).`);

  let part = 0;
  let pushed = 0;
  return createSyncSession({
    root,
    existing,
    caseInsensitive: true, // Azure DevOps paths ignore case: use the spelling that is in the repository
    failureNote: (count) => (count > 0 ? `${count} changes were already pushed in earlier commits; run the backup again to continue.` : 'Nothing was pushed yet.'),
    readExisting: (path) => readFile(values, token, path, signal),
    label: 'Azure DevOps',
    onLog,
    maxFiles: 100,
    maxBytes: MAX_BATCH_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
    flush: async (batch) => {
      const summary = describeBatch(batch);
      const result = await httpJson(`${repoUrl(values)}/pushes?api-version=${API_VERSION}`, {
        method: 'POST',
        headers: authHeaders(token),
        signal,
        body: {
          refUpdates: [{ name: `refs/heads/${values.branch}`, oldObjectId }],
          commits: [{
            comment: `KBMax sync ${syncFolder}: ${summary} (part ${++part})`,
            changes: batch.map((change) => ({
              changeType: change.changeType,
              item: { path: `/${change.path}` },
              ...(change.changeType === 'delete' ? {} : { newContent: { content: toBase64(utf8Bytes(change.data)), contentType: 'base64encoded' } }),
            })),
          }],
        },
      });
      assertJson('Pushing files', result);
      oldObjectId = result.json?.refUpdates?.[0]?.newObjectId ?? oldObjectId;
      pushed += batch.length;
      logBatch(batch, root, 'Azure DevOps', onLog);
      const commitId = result.json?.commits?.[0]?.commitId;
      onLog(`Azure DevOps: pushed ${pushed} changes (${summary})${commitId ? `, commit ${commitId.slice(0, 8)}` : ''}`);
    },
  });
}

// Returns a session { add(file), finish() } that pushes files in batches while the backup runs.
export async function createSession({ values, token, message, syncFolder, signal, onLog }) {
  const missing = validate(values, token);
  if (missing.length > 0) throw new UploadError(`Missing: ${missing.join(', ')}`);
  retryConfig.onRetry = (text) => onLog(`Azure DevOps: ${text}`);
  if (values.mode === 'sync') return createSyncAzureSession({ values, token, syncFolder, signal, onLog });

  let oldObjectId = await getBranchObjectId(values, token, signal);
  let uploaded = 0;
  let part = 0;

  return new Batcher({
    maxFiles: 100,
    maxBytes: 6 * 1024 * 1024,
    maxFileBytes: 12 * 1024 * 1024,
    onSkip: (file, size) => onLog(`Azure DevOps: [skipped] ${file.path} is ${(size / 1024 / 1024).toFixed(1)} MB, more than Azure DevOps accepts in one push. It is not in the repository.`, true),
    flush: async (batch) => {
      const result = await httpJson(`${repoUrl(values)}/pushes?api-version=${API_VERSION}`, {
        method: 'POST',
        headers: authHeaders(token),
        signal,
        body: {
          refUpdates: [{ name: `refs/heads/${values.branch}`, oldObjectId }],
          commits: [{
            comment: `${message} (part ${++part})`,
            changes: batch.map((file) => ({
              changeType: 'add',
              item: { path: `/${joinPath(values.path, file.path)}` },
              newContent: { content: file.data, contentType: 'rawtext' },
            })),
          }],
        },
      });
      assertJson('Pushing files', result);

      oldObjectId = result.json?.refUpdates?.[0]?.newObjectId ?? oldObjectId;
      uploaded += batch.length;
      onLog(`Azure DevOps: pushed ${uploaded} files`);
    },
  });
}
