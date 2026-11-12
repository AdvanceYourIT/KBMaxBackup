// Where the ZIP is written while the backup runs.
// Preferred: a file in the extension's private origin file system (on disk, streamed), so a
// large backup never has to fit in memory. Fallback: in-memory parts.

function createMemorySink() {
  let parts = [];
  return {
    kind: 'memory',
    async write(chunk) { parts.push(chunk); },
    async close() {},
    async abort() { parts = []; },
    async getBlob() { return new Blob(parts, { type: 'application/zip' }); },
  };
}

async function removeStaleFiles(root) {
  try {
    for await (const name of root.keys()) {
      if (name.startsWith('KBMax_')) await root.removeEntry(name).catch(() => {});
    }
  } catch {
    // Cleanup is best effort.
  }
}

export async function createZipSink(filename) {
  try {
    if (!navigator.storage?.getDirectory) return createMemorySink();
    const root = await navigator.storage.getDirectory();
    await removeStaleFiles(root);
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    return {
      kind: 'disk',
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      async abort() {
        await writable.abort().catch(() => {});
        await root.removeEntry(filename).catch(() => {});
      },
      getBlob: () => handle.getFile(),
    };
  } catch {
    return createMemorySink();
  }
}
