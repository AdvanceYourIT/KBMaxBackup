// Minimal ZIP reader (stored + deflate, ZIP64) for restoring from a backup ZIP. Entries are read
// lazily from the File, so large archives are never loaded into memory as a whole.

const decoder = new TextDecoder();

async function bytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function findEnd(file) {
  const tailStart = Math.max(0, file.size - (0xffff + 22));
  const tail = await bytes(file, tailStart, file.size);
  const view = new DataView(tail.buffer);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    let count = view.getUint16(i + 10, true);
    let size = view.getUint32(i + 12, true);
    let offset = view.getUint32(i + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locatorAt = tailStart + i - 20;
      const locator = new DataView((await bytes(file, locatorAt, locatorAt + 20)).buffer);
      if (locator.getUint32(0, true) !== 0x07064b50) throw new Error('Corrupt ZIP64 archive.');
      const record = new DataView((await bytes(file, Number(locator.getBigUint64(8, true)), Number(locator.getBigUint64(8, true)) + 56)).buffer);
      count = Number(record.getBigUint64(32, true));
      size = Number(record.getBigUint64(40, true));
      offset = Number(record.getBigUint64(48, true));
    }
    return { count, size, offset };
  }
  throw new Error('This is not a valid ZIP file.');
}

// Returns [{ path, readText() }] for every file entry.
export async function readZipEntries(file) {
  const { count, size, offset } = await findEnd(file);
  const directory = await bytes(file, offset, offset + size);
  const view = new DataView(directory.buffer);
  const entries = [];
  let pos = 0;

  for (let n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory.');
    const method = view.getUint16(pos + 10, true);
    let compressedSize = view.getUint32(pos + 20, true);
    let uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    let localOffset = view.getUint32(pos + 42, true);
    const path = decoder.decode(directory.subarray(pos + 46, pos + 46 + nameLength));

    let extra = pos + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let at = extra + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(view.getBigUint64(at, true)); at += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(view.getBigUint64(at, true)); at += 8; }
        if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(at, true));
      }
      extra += 4 + length;
    }

    if (!path.endsWith('/')) {
      entries.push({
        path,
        size: uncompressedSize,
        async readText() {
          const local = new DataView((await bytes(file, localOffset, localOffset + 30)).buffer);
          const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
          const raw = await bytes(file, dataStart, dataStart + compressedSize);
          if (method === 0) return decoder.decode(raw);
          if (method === 8) return decoder.decode(await inflateRaw(raw));
          throw new Error(`Unsupported compression method ${method} for ${path}.`);
        },
      });
    }
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
