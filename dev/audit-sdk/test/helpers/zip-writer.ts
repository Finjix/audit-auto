import zlib from 'node:zlib';

/**
 * Writes small zips the way real tools do, for the unpacking tests: deflated or stored entries, names as UTF-8 with the flag or as raw
 * bytes without it (Chinese Windows tools write GBK), zip64 records as big-archive writers produce them, and a wrong CRC on request.
 */
export interface ZipFile { name: string | Buffer; data: Buffer | string; store?: boolean; badCrc?: boolean }

export function makeZip(files: ZipFile[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const name = Buffer.isBuffer(file.name) ? file.name : Buffer.from(file.name, 'utf8');
    const utf8 = !Buffer.isBuffer(file.name) && /[^\x00-\x7f]/.test(file.name);
    const body = file.store ? data : zlib.deflateRawSync(data);
    const crc = (zlib.crc32(data) ^ (file.badCrc ? 1 : 0)) >>> 0;
    const z64 = options.zip64 === true;
    const extra = z64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (z64) {
      extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(body.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(z64 ? 45 : 20, 4); local.writeUInt16LE(utf8 ? 0x800 : 0, 6);
    local.writeUInt16LE(file.store ? 0 : 8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(z64 ? 0xffffffff : body.length, 18); local.writeUInt32LE(z64 ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x031e, 4); entry.writeUInt16LE(z64 ? 45 : 20, 6); entry.writeUInt16LE(utf8 ? 0x800 : 0, 8);
    entry.writeUInt16LE(file.store ? 0 : 8, 10); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(z64 ? 0xffffffff : body.length, 20); entry.writeUInt32LE(z64 ? 0xffffffff : data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt16LE(extra.length, 30); entry.writeUInt32LE(z64 ? 0xffffffff : offset, 42);
    locals.push(local, name, extra, body);
    central.push(entry, name, extra);
    offset += local.length + name.length + extra.length + body.length;
  }
  const directory = Buffer.concat(central);
  const tail: Buffer[] = [];
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24); record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 8); end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, end]);
}
