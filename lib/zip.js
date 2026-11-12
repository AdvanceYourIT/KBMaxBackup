const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const MAX_32 = 0xffffffff;

// Streaming ZIP writer: every entry is compressed and written to `sink` immediately, so
// memory stays bounded by one entry plus the central directory. Switches to ZIP64 when the
// archive exceeds 4 GB or 65535 entries. `sink` needs write(Uint8Array) and close().
// The limits are only lowered by tests, to exercise the ZIP64 paths with small data.
export class ZipWriter {
  constructor(sink, { date = new Date(), offsetLimit = MAX_32, countLimit = 0xffff } = {}) {
    this.sink = sink;
    this.dos = dosDateTime(date);
    this.offsetLimit = offsetLimit;
    this.countLimit = countLimit;
    this.offset = 0;
    this.count = 0;
    this.central = [];
    this.centralSize = 0;
    this.chain = Promise.resolve();
  }

  // Safe to call concurrently; entries are written one at a time.
  add(path, data) {
    const run = this.chain.then(() => this.#add(path, data));
    this.chain = run.catch(() => {});
    return run;
  }

  async #add(path, data) {
    const name = encoder.encode(path);
    const raw = typeof data === 'string' ? encoder.encode(data) : data;
    if (raw.length >= MAX_32) throw new Error(`File too large for the ZIP: ${path}`);

    let body = raw;
    let method = 0;
    if (raw.length >= 256) {
      const compressed = await deflateRaw(raw);
      if (compressed.length < raw.length) {
        body = compressed;
        method = 8;
      }
    }
    const crc = crc32(raw);
    const { time, day } = this.dos;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);

    const zip64 = this.offset >= this.offsetLimit;
    const extraLength = zip64 ? 12 : 0;
    const entry = new Uint8Array(46 + name.length + extraLength);
    const view = new DataView(entry.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, zip64 ? 45 : 20, true);
    view.setUint16(6, zip64 ? 45 : 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, method, true);
    view.setUint16(12, time, true);
    view.setUint16(14, day, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, body.length, true);
    view.setUint32(24, raw.length, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, extraLength, true);
    view.setUint32(42, zip64 ? MAX_32 : this.offset, true);
    entry.set(name, 46);
    if (zip64) {
      view.setUint16(46 + name.length, 0x0001, true);
      view.setUint16(48 + name.length, 8, true);
      view.setBigUint64(50 + name.length, BigInt(this.offset), true);
    }

    await this.sink.write(new Uint8Array(local.buffer));
    await this.sink.write(name);
    await this.sink.write(body);

    this.central.push(entry);
    this.centralSize += entry.length;
    this.count++;
    this.offset += 30 + name.length + body.length;
  }

  async finish() {
    await this.chain;
    const centralOffset = this.offset;
    for (const entry of this.central) await this.sink.write(entry);
    this.central = [];

    const zip64 = this.count >= this.countLimit || centralOffset >= this.offsetLimit || this.centralSize >= MAX_32;
    if (zip64) {
      const record = new DataView(new ArrayBuffer(56 + 20));
      record.setUint32(0, 0x06064b50, true);
      record.setBigUint64(4, 44n, true);
      record.setUint16(12, 45, true);
      record.setUint16(14, 45, true);
      record.setBigUint64(24, BigInt(this.count), true);
      record.setBigUint64(32, BigInt(this.count), true);
      record.setBigUint64(40, BigInt(this.centralSize), true);
      record.setBigUint64(48, BigInt(centralOffset), true);
      record.setUint32(56, 0x07064b50, true);
      record.setBigUint64(64, BigInt(centralOffset + this.centralSize), true);
      record.setUint32(72, 1, true);
      await this.sink.write(new Uint8Array(record.buffer));
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, zip64 ? 0xffff : this.count, true);
    end.setUint16(10, zip64 ? 0xffff : this.count, true);
    end.setUint32(12, zip64 ? MAX_32 : this.centralSize, true);
    end.setUint32(16, zip64 ? MAX_32 : centralOffset, true);
    await this.sink.write(new Uint8Array(end.buffer));
    await this.sink.close();
  }
}
