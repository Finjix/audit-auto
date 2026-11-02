import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { refusal } from '../src/media.ts';
import { unpackZip } from '../src/zip.ts';
import { tempDir } from './helpers/tmp.ts';
import { makeZip } from './helpers/zip-writer.ts';

function zipFile(name: string, data: Buffer): string {
  const file = path.join(tempDir('zip-'), name);
  fs.writeFileSync(file, data);
  return file;
}

test('a material zip unpacks its videos and images at any depth, named by their path in the zip; the rest is listed with the reason', async () => {
  const video = Buffer.alloc(300_000, 7);
  const file = zipFile('素材.zip', makeZip([
    { name: '横版/GOFCN66367_片头.mp4', data: video },
    { name: '竖版/GOFCN66367_片头.mp4', data: video, store: true },
    { name: Buffer.from([0xb7, 0xe2, 0xc3, 0xe6, 0x2e, 0x70, 0x6e, 0x67]), data: 'png' }, // 封面.png in GBK, no UTF-8 flag
    { name: '说明.txt', data: 'txt' },
    { name: '../逃出去.mp4', data: 'x' },
    { name: '.DS_Store', data: 'x' },
    { name: '__MACOSX/._封面.png', data: 'x' },
  ]));
  const dir = path.join(tempDir('scratch-'), 'zip-1');
  const result = await unpackZip(file, dir, refusal);
  assert.deepEqual(result.files.map(f => f.name), ['素材.zip › 横版/GOFCN66367_片头.mp4', '素材.zip › 竖版/GOFCN66367_片头.mp4', '素材.zip › 封面.png']);
  assert.ok(result.files.every(f => path.dirname(f.file) === dir), 'flat, in the folder given');
  assert.ok(fs.readFileSync(result.files[0]!.file).equals(video), 'deflated data comes back exactly');
  assert.deepEqual(result.skipped, [
    { file: '素材.zip › 说明.txt', reason: '不是视频或图片，没有审' },
    { file: '素材.zip › ../逃出去.mp4', reason: '路径不安全，没有解压' },
  ]);
});

test('zip64 archives unpack; a damaged entry or too many materials are refused', async () => {
  const ok = await unpackZip(zipFile('big.zip', makeZip([{ name: 'a.mp4', data: 'aaaa' }], { zip64: true })), path.join(tempDir('s-'), 'z'), refusal);
  assert.equal(ok.files.length, 1);
  await assert.rejects(unpackZip(zipFile('bad.zip', makeZip([{ name: 'a.mp4', data: 'aaaa', badCrc: true }])), path.join(tempDir('s-'), 'z'), refusal), /已损坏/);
  await assert.rejects(unpackZip(zipFile('not.zip', Buffer.from('hello')), path.join(tempDir('s-'), 'z'), refusal), /不是有效的 zip/);
  const many = makeZip(Array.from({ length: 51 }, (_, i) => ({ name: `${i}.mp4`, data: 'x' })));
  await assert.rejects(unpackZip(zipFile('many.zip', many), path.join(tempDir('s-'), 'z'), refusal), /超过 50 个/);
});
