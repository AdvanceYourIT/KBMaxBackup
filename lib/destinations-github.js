import { createSyncSession, describeBatch, logBatch } from './sync-session.js';
import { Batcher, UploadError, describeFailure, httpJson, joinPath } from './upload-utils.js';

const API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoPath(values) {
  return `${API}/repos/${encodeURIComponent(values.owner)}/${encodeURIComponent(values.repository)}`;
}

export function validate(values, token) {
  const missing = ['owner', 'repository', 'branch'].filter((key) => !values[key]);
  if (!token) missing.push('token');
  return missing;
}

async function getRepository(values, token, signal) {
  const result = await httpJson(repoPath(values), { headers: headers(token), signal });
  if (result.status === 404) {
    throw new UploadError('Repository not found. Check owner/repository, and that the token has access to this repository (organization tokens may still need approval).');
  }
  if (result.status === 401) throw new UploadError('GitHub rejected the token (expired or invalid).');
  if (!result.ok) throw describeFailure('Reading repository', result);
  if (!result.json.private) {
    throw new UploadError('This repository is public. Backups contain business configuration and may only be uploaded to a private repository.');
  }
  return result.json;
}

async function getBranchCommit(values, token, signal) {
  const result = await httpJson(`${repoPath(values)}/git/ref/heads/${values.branch.split('/').map(encodeURIComponent).join('/')}`, { headers: headers(token), signal });
  if (result.status === 404 || result.status === 409) {
    throw new UploadError(`Branch "${values.branch}" does not exist (or the repository is empty). Create it first with at least one commit.`);
  }
  if (!result.ok) throw describeFailure('Reading branch', result);
  return result.json.object.sha;
}

export async function test(values, token, signal) {
  const missing = validate(values, token);
  if (missing.length > 0) throw new UploadError(`Missing: ${missing.join(', ')}`);

  const repository = await getRepository(values, token, signal);
  await getBranchCommit(values, token, signal);
  return `Connected to ${repository.full_name} (private), branch "${values.branch}" found.`;
}

// Every blob under `root` in the tree of the branch: path -> blob sha. Walks down to the folder first so a
// large repository is not listed as a whole; a truncated recursive answer is followed folder by folder.
async function listExisting({ baseUrl, headers: authHeaders, treeSha, root, signal }) {
  const getTree = async (sha, recursive) => {
    const result = await httpJson(`${baseUrl}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { headers: authHeaders, signal });
    if (!result.ok) throw describeFailure('Reading files', result);
    return result.json;
  };

  let sha = treeSha;
  for (const segment of root.split('/').filter(Boolean)) {
    const entry = (await getTree(sha, false)).tree.find((item) => item.type === 'tree' && item.path === segment);
    if (!entry) return new Map();
    sha = entry.sha;
  }

  const files = new Map();
  const collect = async (folderSha, prefix) => {
    const tree = await getTree(folderSha, true);
    if (!tree.truncated) {
      for (const item of tree.tree) if (item.type === 'blob') files.set(`${prefix}/${item.path}`, item.sha);
      return;
    }
    for (const item of (await getTree(folderSha, false)).tree) {
      if (item.type === 'blob') files.set(`${prefix}/${item.path}`, item.sha);
      else if (item.type === 'tree') await collect(item.sha, `${prefix}/${item.path}`);
    }
  };
  await collect(sha, root);
  return files;
}

// Returns a session { add(file), finish() }. Uses the Git Data API: a tree and a commit per
// batch, chained on top of each other; the branch is moved once, in finish().
export async function createSession({ values, token, message, syncFolder, signal, onLog }) {
  const missing = validate(values, token);
  if (missing.length > 0) throw new UploadError(`Missing: ${missing.join(', ')}`);

  await getRepository(values, token, signal);
  const baseUrl = repoPath(values);
  const authHeaders = headers(token);
  const branchRef = values.branch.split('/').map(encodeURIComponent).join('/');

  let parentSha = await getBranchCommit(values, token, signal);
  const commit = await httpJson(`${baseUrl}/git/commits/${parentSha}`, { headers: authHeaders, signal });
  if (!commit.ok) throw describeFailure('Reading commit', commit);
  let treeSha = commit.json.tree.sha;
  let prepared = 0;
  let part = 0;

  async function moveBranch() {
    if (prepared === 0) return;
    const update = await httpJson(`${baseUrl}/git/refs/heads/${branchRef}`, {
      method: 'PATCH',
      headers: authHeaders,
      signal,
      body: { sha: parentSha, force: false },
    });
    if (!update.ok) throw describeFailure('Updating branch', update);
    onLog(`GitHub: branch "${values.branch}" updated.`);
  }

  if (values.mode === 'sync') {
    // Incremental mode: one fixed folder per environment; only new or changed files are committed.
    const root = joinPath(values.path, syncFolder);
    const existing = await listExisting({ baseUrl, headers: authHeaders, treeSha, root, signal });
    onLog(`GitHub: incremental sync into /${root} (${existing.size} files already there).`);

    const session = createSyncSession({
      root,
      existing,
      readExisting: async (path, sha) => {
        const blob = await httpJson(`${baseUrl}/git/blobs/${sha}`, { headers: authHeaders, signal });
        if (!blob.ok || blob.json?.encoding !== 'base64') return null;
        return new TextDecoder().decode(Uint8Array.from(atob(blob.json.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
      },
      label: 'GitHub',
      onLog,
      maxFiles: 200,
      maxBytes: 4 * 1024 * 1024,
      flush: async (batch) => {
        const summary = describeBatch(batch);
        const tree = await httpJson(`${baseUrl}/git/trees`, {
          method: 'POST',
          headers: authHeaders,
          signal,
          body: {
            base_tree: treeSha,
            tree: batch.map((change) => (change.changeType === 'delete'
              ? { path: change.path, mode: '100644', type: 'blob', sha: null }
              : { path: change.path, mode: '100644', type: 'blob', content: change.data })),
          },
        });
        if (!tree.ok) throw describeFailure('Creating tree', tree);
        const created = await httpJson(`${baseUrl}/git/commits`, {
          method: 'POST',
          headers: authHeaders,
          signal,
          body: { message: `KBMax sync ${syncFolder}: ${summary} (part ${++part})`, tree: tree.json.sha, parents: [parentSha] },
        });
        if (!created.ok) throw describeFailure('Creating commit', created);
        treeSha = tree.json.sha;
        parentSha = created.json.sha;
        prepared += batch.length;
        logBatch(batch, root, 'GitHub', onLog);
        onLog(`GitHub: prepared ${prepared} changes (${summary}), commit ${created.json.sha.slice(0, 7)}`);
      },
    });
    return {
      add: (file) => session.add(file),
      async finish() {
        await session.finish();
        await moveBranch();
      },
    };
  }

  const batcher = new Batcher({
    maxFiles: 200,
    maxBytes: 4 * 1024 * 1024,
    flush: async (batch) => {
      const tree = await httpJson(`${baseUrl}/git/trees`, {
        method: 'POST',
        headers: authHeaders,
        signal,
        body: {
          base_tree: treeSha,
          tree: batch.map((file) => ({ path: joinPath(values.path, file.path), mode: '100644', type: 'blob', content: file.data })),
        },
      });
      if (!tree.ok) throw describeFailure('Creating tree', tree);

      const created = await httpJson(`${baseUrl}/git/commits`, {
        method: 'POST',
        headers: authHeaders,
        signal,
        body: { message: `${message} (part ${++part})`, tree: tree.json.sha, parents: [parentSha] },
      });
      if (!created.ok) throw describeFailure('Creating commit', created);

      treeSha = tree.json.sha;
      parentSha = created.json.sha;
      prepared += batch.length;
      onLog(`GitHub: prepared ${prepared} files`);
    },
  });

  return {
    add: (file) => batcher.add(file),
    async finish() {
      await batcher.finish();
      await moveBranch();
    },
  };
}
