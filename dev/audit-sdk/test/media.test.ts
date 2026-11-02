import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMPRESS_OVER, findFfmpeg, fpsFor, INLINE_MAX, kindOf, prepare, probe, refusal } from '../src/media.ts';
import { makeMp4 } from './helpers/mp4.ts';
import { tempDir } from './helpers/tmp.ts';

function file(name: string, data: Buffer | string): string {
  const at = path.join(tempDir('media-'), name);
  fs.writeFileSync(at, data);
  return at;
}

test('duration and the picture as shown come from the MP4 header, wherever the movie box is', async () => {
  assert.deepEqual(await probe(file('a.mp4', makeMp4({ seconds: 10.77, width: 1080, height: 1920 }))), { duration: 10.77, width: 1080, height: 1920 });
  assert.deepEqual(await probe(file('b.mp4', makeMp4({ seconds: 37.61, width: 1920, height: 1080, moovFirst: true, version1: true }))), { duration: 37.61, width: 1920, height: 1080 });
  // A phone video stored on its side, rotated by the matrix: shown upright.
  assert.deepEqual(await probe(file('c.mov', makeMp4({ seconds: 6.25, width: 1920, height: 1080, rotated: true }))), { duration: 6.25, width: 1080, height: 1920 });
  assert.deepEqual(await probe(file('d.mp4', 'not a video at all')), {});
  assert.deepEqual(await probe(file('e.mp4', makeMp4({ seconds: 5, width: 720, height: 1280 }).subarray(0, 60))), {}, 'a cut-off file says nothing');
});

test('short videos are looked at with more frames a second, long ones with Gemini\'s own one', () => {
  assert.equal(fpsFor(6), 4);
  assert.equal(fpsFor(40), 4);
  assert.equal(fpsFor(53), 3);
  assert.equal(fpsFor(80), 2);
  assert.equal(fpsFor(300), 1);
  assert.equal(fpsFor(undefined), 2);
});

test('only videos and images are material; GIFs and other files are refused with the reason', () => {
  assert.equal(refusal('GOFCN1_竖版.MP4'), null);
  assert.equal(refusal('海报.jpeg'), null);
  assert.match(refusal('动图.gif')!, /GIF/);
  assert.match(refusal('脚本.docx')!, /不是视频或图片/);
  assert.equal(kindOf('a.mov'), 'video');
  assert.equal(kindOf('a.webp'), 'image');
  assert.equal(kindOf('a.txt'), undefined);
});

test('without ffmpeg a video goes as it is, an MKV is refused, and a video over the inline limit is refused with its size', async () => {
  const scratch = tempDir('scratch-');
  const small = await prepare(file('竖版.mp4', makeMp4({ seconds: 30, width: 1080, height: 1920 })), scratch, undefined);
  assert.equal(small.compressed, false);
  assert.equal(small.orientation, '竖版');
  assert.equal(small.fps, 4);
  assert.equal(small.mime, 'video/mp4');
  assert.equal((await prepare(file('横版.mov', makeMp4({ seconds: 90, width: 1920, height: 1080 })), scratch, undefined)).mime, 'video/mov');
  await assert.rejects(prepare(file('a.mkv', 'x'), scratch, undefined), /转成 MP4/);
  const big = file('big.mp4', '');
  fs.truncateSync(big, INLINE_MAX + 1);
  await assert.rejects(prepare(big, scratch, undefined), /视频太大（150 MB）/);
  await assert.rejects(prepare(file('empty.mp4', ''), scratch, undefined), /空的/);
});

const ffmpeg = await findFfmpeg();

test('a big video is compressed to 720p with ffmpeg when the computer has it', { skip: !ffmpeg && 'no ffmpeg on this computer' }, async () => {
  const scratch = tempDir('scratch-');
  const source = path.join(tempDir('media-'), '竖版原片.mp4');
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', source], { windowsHide: true });
  // Padded past the size at which a video is compressed (the demuxer stops at the end of the movie).
  fs.truncateSync(source, COMPRESS_OVER + 1024);
  const done = await prepare(source, scratch, ffmpeg);
  assert.equal(done.compressed, true);
  assert.ok(done.file.startsWith(scratch), 'the copy is in the scratch folder, never next to the original');
  assert.equal(done.mime, 'video/mp4');
  assert.equal(done.orientation, '竖版');
  assert.ok(done.sent < 2 * 1024 * 1024);
  assert.deepEqual({ ...(await probe(done.file)), duration: undefined }, { duration: undefined, width: 720, height: 1280 });
});

test('when compressing fails, a video in a format Gemini takes goes as it is, with a warning', async () => {
  const big = file('big.mp4', makeMp4({ seconds: 20, width: 1080, height: 1920, moovFirst: true }));
  fs.truncateSync(big, COMPRESS_OVER + 1024);
  const done = await prepare(big, tempDir('scratch-'), path.join(tempDir('bin-'), 'no-such-ffmpeg.exe'));
  assert.equal(done.compressed, false);
  assert.equal(done.file, big);
  assert.match(done.warning!, /压缩失败/);
});
