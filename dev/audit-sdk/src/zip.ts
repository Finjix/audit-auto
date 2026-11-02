import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { Blocked, need } from './errors.ts';

/*
 * The zip a user sends instead of a folder (Feishu does not let a bot download a folder). Material zips are large, so entries are
 * streamed from the file to disk, never held in memory; zip64, stored and deflated entries and the name encodings zips are made with in
 * practice (UTF-8, or GBK from Chinese Windows tools, without the UTF-8 flag) are understood, and every entry is checked against its size
 * and CRC-32. (The reader is requirement-auto's src/gof/unzip.ts; unpacking differs: folders inside the zip are kept as part of the name,
 * since materials often come as 横版/ and 竖版/.)
 */

export interface ZipEntry { name: string; flags: number; method: number; crc: number; csize: number; usize: number; offset: number; directory: boolean }

const MAX_DIRECTORY = 64 * 1024 * 1024;

async function readAt(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

const big = (buffer: Buffer, at: number): number => {
  const value = buffer.readBigUInt64LE(at);
  need(value <= BigInt(Number.MAX_SAFE_INTEGER), '压缩包过大');
  return Number(value);
};

/** A name as the zip means it: flagged UTF-8, the Info-ZIP Unicode path, plain UTF-8, else GBK (zips made by Chinese Windows tools). */
function decodeName(raw: Buffer, flags: number, unicode: string | undefined): string {
  if (flags & 0x800) return raw.toString('utf8');
  if (unicode !== undefined) return unicode;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return new TextDecoder('gbk').decode(raw); }
}

/** The entries of a zip, from its central directory. */
export async function listZip(file: string): Promise<ZipEntry[]> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    need(eocd >= 0, '不是有效的 zip 压缩包');
    let count = tail.readUInt16LE(eocd + 10);
    let dirSize = tail.readUInt32LE(eocd + 12);
    let dirStart = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) {
      // zip64: the locator just before the end record points at the zip64 end record.
      need(eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50, 'zip64 压缩包结构损坏');
      const record = await readAt(handle, big(tail, eocd - 20 + 8), 56);
      need(record.length === 56 && record.readUInt32LE(0) === 0x06064b50, 'zip64 压缩包结构损坏');
      count = big(record, 32); dirSize = big(record, 40); dirStart = big(record, 48);
    }
    need(dirSize <= MAX_DIRECTORY && dirStart + dirSize <= size, '压缩包目录损坏或过大');
    const dir = await readAt(handle, dirStart, dirSize);
    const entries: ZipEntry[] = [];
    let pos = 0;
    for (let n = 0; n < count; n++) {
      need(pos + 46 <= dir.length && dir.readUInt32LE(pos) === 0x02014b50, '压缩包目录损坏');
      const flags = dir.readUInt16LE(pos + 8);
      const method = dir.readUInt16LE(pos + 10);
      const crc = dir.readUInt32LE(pos + 16);
      let csize = dir.readUInt32LE(pos + 20);
      let usize = dir.readUInt32LE(pos + 24);
      const nameLength = dir.readUInt16LE(pos + 28);
      const extraLength = dir.readUInt16LE(pos + 30);
      const commentLength = dir.readUInt16LE(pos + 32);
      let offset = dir.readUInt32LE(pos + 42);
      const raw = dir.subarray(pos + 46, pos + 46 + nameLength);
      let unicode: string | undefined;
      for (let e = pos + 46 + nameLength; e + 4 <= pos + 46 + nameLength + extraLength;) {
        const id = dir.readUInt16LE(e);
        const length = dir.readUInt16LE(e + 2);
        const body = dir.subarray(e + 4, e + 4 + length);
        if (id === 0x0001) {
          // zip64 sizes and offset, each present only where the 32-bit field is full.
          let at = 0;
          if (usize === 0xffffffff) { usize = big(body, at); at += 8; }
          if (csize === 0xffffffff) { csize = big(body, at); at += 8; }
          if (offset === 0xffffffff) offset = big(body, at);
        } else if (id === 0x7075 && body.length > 5 && body[0] === 1) unicode = body.subarray(5).toString('utf8');
        e += 4 + length;
      }
      const name = decodeName(raw, flags, unicode).replace(/\\/g, '/');
      entries.push({ name, flags, method, crc, csize, usize, offset, directory: name.endsWith('/') });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally { await handle.close(); }
}

/** Streams one entry into a new file and checks its size and CRC-32. */
export async function extractEntry(file: string, entry: ZipEntry, target: string): Promise<void> {
  need((entry.flags & 1) === 0, `压缩包里的文件加了密码，无法读取：${entry.name}`);
  need(entry.method === 0 || entry.method === 8, `压缩包里的文件用了不支持的压缩方式：${entry.name}`);
  const handle = await fs.promises.open(file, 'r');
  let start: number;
  try {
    const local = await readAt(handle, entry.offset, 30);
    need(local.length === 30 && local.readUInt32LE(0) === 0x04034b50, `压缩包条目损坏：${entry.name}`);
    start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally { await handle.close(); }
  let size = 0;
  let crc = 0;
  const count = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; crc = zlib.crc32(chunk, crc); callback(size > entry.usize ? new Blocked(`压缩包条目比记录的大：${entry.name}`) : null, chunk); } });
  const source: Readable = entry.csize === 0 ? Readable.from([]) : fs.createReadStream(file, { start, end: start + entry.csize - 1 });
  try {
    const out = fs.createWriteStream(target, { flags: 'wx' });
    if (entry.method === 8) await pipeline(source, zlib.createInflateRaw(), count, out);
    else await pipeline(source, count, out);
  } catch (error) {
    fs.rmSync(target, { force: true });
    if (error instanceof Blocked) throw error;
    throw new Blocked(`压缩包里的文件解压失败：${entry.name}`);
  }
  if (size !== entry.usize || (crc >>> 0) !== (entry.crc >>> 0)) {
    fs.rmSync(target, { force: true });
    throw new Blocked(`压缩包里的文件已损坏（大小或校验不符）：${entry.name}`);
  }
}

export interface Unpacked { files: { file: string; name: string }[]; skipped: { file: string; reason: string }[] }

const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

/**
 * Unpacks the files of a material zip that `keep` accepts into `dir`, each under a numbered name of its own; `name` is its path inside
 * the zip, which is what the user sees. What is left out is listed with the reason.
 */
export async function unpackZip(file: string, dir: string, keep: (name: string) => string | null, limits = { files: 50, bytes: 10 * 1024 ** 3 }): Promise<Unpacked> {
  const label = (name: string) => `${path.basename(file)} › ${name}`;
  const entries = (await listZip(file)).filter(e => !e.directory && !e.name.startsWith('__MACOSX/') && !JUNK.test(path.posix.basename(e.name)));
  const skipped: Unpacked['skipped'] = [];
  const chosen: ZipEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(Boolean);
    if (entry.name.startsWith('/') || /^[a-z]:/i.test(entry.name) || parts.some(p => p === '..')) { skipped.push({ file: label(entry.name), reason: '路径不安全，没有解压' }); continue; }
    const refused = keep(parts.at(-1)!);
    if (refused) { skipped.push({ file: label(entry.name), reason: refused }); continue; }
    bytes += entry.usize;
    chosen.push(entry);
  }
  need(chosen.length <= limits.files, `压缩包里的素材超过 ${limits.files} 个，请分批发`);
  need(bytes <= limits.bytes, '压缩包解压后太大（超过 10 GB），请分批发');
  fs.mkdirSync(dir, { recursive: true });
  const files: Unpacked['files'] = [];
  for (const [i, entry] of chosen.entries()) {
    const base = path.posix.basename(entry.name).replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
    const target = path.join(dir, `${String(i + 1).padStart(2, '0')}-${base}`);
    await extractEntry(file, entry, target);
    files.push({ file: target, name: label(entry.name) });
  }
  return { files, skipped };
}
