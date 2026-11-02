import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Blocked, need } from './errors.ts';

/*
 * Getting a material file ready to send to Gemini inline (the gateway has no Files API). Gemini samples a video into frames at the fps it
 * is told and scales every frame down, so a 1080p master carries nothing a 720p copy does not: big videos are re-encoded to 720p with
 * ffmpeg when the computer has it (FFMPEG, or ffmpeg on the PATH), which cuts the upload from minutes to seconds. Without ffmpeg a video
 * is sent as it is, up to INLINE_MAX. Duration and orientation are read from the MP4/MOV header itself, so they need no ffmpeg either.
 */

export type Kind = 'video' | 'image';
interface Type { kind: Kind; mime: string; native: boolean }

/** What Gemini takes (native), and video containers it does not take, which ffmpeg turns into MP4 first. */
const TYPES: Record<string, Type> = {
  '.mp4': { kind: 'video', mime: 'video/mp4', native: true }, '.m4v': { kind: 'video', mime: 'video/mp4', native: true },
  '.mov': { kind: 'video', mime: 'video/mov', native: true }, '.webm': { kind: 'video', mime: 'video/webm', native: true },
  '.mpg': { kind: 'video', mime: 'video/mpeg', native: true }, '.mpeg': { kind: 'video', mime: 'video/mpeg', native: true },
  '.avi': { kind: 'video', mime: 'video/avi', native: true }, '.wmv': { kind: 'video', mime: 'video/wmv', native: true },
  '.flv': { kind: 'video', mime: 'video/x-flv', native: true }, '.3gp': { kind: 'video', mime: 'video/3gpp', native: true },
  '.mkv': { kind: 'video', mime: 'video/mp4', native: false }, '.ts': { kind: 'video', mime: 'video/mp4', native: false },
  '.png': { kind: 'image', mime: 'image/png', native: true }, '.jpg': { kind: 'image', mime: 'image/jpeg', native: true },
  '.jpeg': { kind: 'image', mime: 'image/jpeg', native: true }, '.webp': { kind: 'image', mime: 'image/webp', native: true },
  '.heic': { kind: 'image', mime: 'image/heic', native: true }, '.heif': { kind: 'image', mime: 'image/heif', native: true },
};

export const MB = 1024 * 1024;
/** Above this a video is re-encoded when ffmpeg is there (a 68 MB request took 76 s through the gateway, a 15 MB one 8 s). */
export const COMPRESS_OVER = 40 * MB;
/** The most that is sent inline (the gateway took a 112 MB video; the request is a third bigger again as base64). */
export const INLINE_MAX = 150 * MB;
export const IMAGE_MAX = 20 * MB;

/** Why a file is not material that can be reviewed, or null when it is. */
export function refusal(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  if (TYPES[ext]) return null;
  if (ext === '.gif') return 'GIF 动图不支持，请转成视频（MP4）或截成图片再发';
  return '不是视频或图片，没有审';
}
export const kindOf = (name: string): Kind | undefined => TYPES[path.extname(name).toLowerCase()]?.kind;

// ---- what is in an MP4 / MOV

export interface Probe { duration?: number; width?: number; height?: number }
interface Box { type: string; start: number; end: number; body: number }

function boxAt(buffer: Buffer, at: number, limit: number): Box | undefined {
  if (at + 8 > limit) return undefined;
  let size = buffer.readUInt32BE(at);
  const type = buffer.toString('latin1', at + 4, at + 8);
  let body = at + 8;
  if (size === 1) {
    if (at + 16 > limit) return undefined;
    size = Number(buffer.readBigUInt64BE(at + 8));
    body = at + 16;
  } else if (size === 0) size = limit - at;
  if (size < body - at || at + size > limit) return undefined;
  return { type, start: at, end: at + size, body };
}
function children(buffer: Buffer, box: Box, skip = 0): Box[] {
  const found: Box[] = [];
  for (let at = box.body + skip; ;) {
    const child = boxAt(buffer, at, box.end);
    if (!child) return found;
    found.push(child);
    at = child.end;
  }
}
const child = (buffer: Buffer, box: Box | undefined, type: string) => box ? children(buffer, box).find(c => c.type === type) : undefined;

/** Duration and picture size (as shown, rotation applied) from the movie header; nothing when the file is not an MP4/MOV or is damaged. */
export async function probe(file: string): Promise<Probe> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(16);
    let moov: Buffer | undefined;
    for (let at = 0; at + 8 <= size;) {
      const { bytesRead } = await handle.read(head, 0, 16, at);
      if (bytesRead < 8) break;
      let length = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (length === 1 && bytesRead >= 16) length = Number(head.readBigUInt64BE(8));
      else if (length === 0) length = size - at;
      if (length < 8) break;
      if (type === 'moov') {
        if (length > 64 * MB) break;
        moov = Buffer.alloc(length);
        await handle.read(moov, 0, length, at);
        break;
      }
      at += length;
    }
    return moov ? movie(moov) : {};
  } catch { return {}; } finally { await handle.close(); }
}

function movie(buffer: Buffer): Probe {
  const moov = boxAt(buffer, 0, buffer.length);
  if (!moov) return {};
  const out: Probe = {};
  const mvhd = child(buffer, moov, 'mvhd');
  if (mvhd && mvhd.body + 32 <= mvhd.end) {
    const v1 = buffer[mvhd.body] === 1;
    const scale = buffer.readUInt32BE(mvhd.body + (v1 ? 20 : 12));
    const length = v1 ? Number(buffer.readBigUInt64BE(mvhd.body + 24)) : buffer.readUInt32BE(mvhd.body + 16);
    if (scale > 0 && length > 0) out.duration = Math.round((length / scale) * 100) / 100;
  }
  for (const trak of children(buffer, moov).filter(c => c.type === 'trak')) {
    const hdlr = child(buffer, child(buffer, trak, 'mdia'), 'hdlr');
    if (!hdlr || hdlr.body + 12 > hdlr.end || buffer.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
    const tkhd = child(buffer, trak, 'tkhd');
    if (!tkhd) continue;
    const base = tkhd.body + (buffer[tkhd.body] === 1 ? 36 : 24);
    if (base + 60 > tkhd.end) continue;
    const a = buffer.readInt32BE(base + 16), b = buffer.readInt32BE(base + 20);
    const width = Math.round(buffer.readUInt32BE(base + 52) / 65536), height = Math.round(buffer.readUInt32BE(base + 56) / 65536);
    if (!width || !height) continue;
    // A phone video is stored on its side with a 90° or 270° rotation in the matrix (a = 0, b = ±1).
    const turned = a === 0 && b !== 0;
    out.width = turned ? height : width;
    out.height = turned ? width : height;
    break;
  }
  return out;
}

export const orientation = (p: Probe): string | undefined =>
  !p.width || !p.height ? undefined : p.width > p.height ? '横版' : p.width < p.height ? '竖版' : '方版';

/**
 * How many frames a second Gemini looks at: ad cuts and subtitles are short, so short videos get up to 4 (about 160 frames at most,
 * some 280 tokens each at high media resolution), long ones Gemini's own 1.
 */
export function fpsFor(duration: number | undefined): number {
  if (!duration || !Number.isFinite(duration)) return 2;
  return Math.min(4, Math.max(1, Math.floor(160 / duration)));
}

// ---- ffmpeg

/** ffmpeg if this computer has it (FFMPEG, else ffmpeg on the PATH), or nothing. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const candidate = env.FFMPEG?.trim() || 'ffmpeg';
  return new Promise(resolve => {
    const run = spawn(candidate, ['-hide_banner', '-version'], { windowsHide: true, stdio: 'ignore' });
    run.once('error', () => resolve(undefined));
    run.once('close', code => resolve(code === 0 ? candidate : undefined));
  });
}

/** A 720p H.264 copy (the short side at most 720, at most 30 frames a second, AAC sound), streamable from its start. */
export function compress(ffmpeg: string, input: string, output: string, timeoutMs = 10 * 60_000): Promise<void> {
  const scale = "scale='if(gte(iw,ih),-2,min(720,iw))':'if(gte(iw,ih),min(720,ih),-2)'";
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', scale, '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', output];
  return new Promise((resolve, reject) => {
    const run = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    run.stderr!.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString('utf8')).slice(-2000); });
    const timer = setTimeout(() => run.kill(), timeoutMs);
    run.once('error', error => { clearTimeout(timer); reject(error); });
    run.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${errors.trim().split('\n').at(-1) ?? ''}`));
    });
  });
}

// ---- one file, ready to send

export interface Prepared {
  /** What is sent (the original, or the compressed copy in the scratch folder). */
  file: string;
  kind: Kind; mime: string; bytes: number; sent: number;
  duration?: number; orientation?: string; fps?: number;
  compressed: boolean;
  warning?: string;
}

export async function prepare(file: string, scratch: string, ffmpeg: string | undefined): Promise<Prepared> {
  const type = TYPES[path.extname(file).toLowerCase()];
  need(type, refusal(file) ?? '不支持的文件');
  const bytes = (await fs.promises.stat(file)).size;
  need(bytes > 0, '文件是空的');
  const mb = (n: number) => (n / MB).toFixed(n < 10 * MB ? 1 : 0);
  if (type.kind === 'image') {
    need(bytes <= IMAGE_MAX, `图片太大（${mb(bytes)} MB），请压缩到 ${IMAGE_MAX / MB} MB 以内再发`);
    return { file, kind: 'image', mime: type.mime, bytes, sent: bytes, compressed: false };
  }
  const original = await probe(file);
  let sent = file, info = original, warning: string | undefined;
  if (!type.native || bytes > COMPRESS_OVER) {
    if (ffmpeg) {
      // A folder of its own: two files of the same name may be compressed at the same time.
      const output = path.join(fs.mkdtempSync(path.join(scratch, 'c-')), `${path.basename(file, path.extname(file)).slice(0, 60)}-720p.mp4`);
      try {
        await compress(ffmpeg, file, output);
        sent = output;
        const copy = await probe(output);
        info = { ...copy, duration: copy.duration ?? original.duration };
      } catch {
        need(type.native, '这种视频格式需要先转码，但转码失败了：请导出成 MP4 再发');
        warning = '压缩失败，按原文件发送，审得会慢一些';
      }
    } else need(type.native, '这种视频格式（如 MKV）需要先转成 MP4 再发');
  }
  const size = sent === file ? bytes : (await fs.promises.stat(sent)).size;
  if (size > INLINE_MAX) throw new Blocked(`视频太大（${mb(size)} MB），请压缩到 ${INLINE_MAX / MB} MB 以内再发`);
  return {
    file: sent, kind: 'video', mime: sent === file ? type.mime : 'video/mp4', bytes, sent: size,
    ...(info.duration ? { duration: info.duration } : {}),
    ...(orientation(original) ? { orientation: orientation(original) } : {}),
    fps: fpsFor(info.duration), compressed: sent !== file, ...(warning ? { warning } : {}),
  };
}
