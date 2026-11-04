import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { pluginRoot } from '../src/config.ts';
import { Blocked } from '../src/errors.ts';
import { PLACEHOLDER, PROJECTS } from '../src/projects.ts';
import { normalize, renderFile, review, reviewSystem, verdictOf, type FileResult } from '../src/review.ts';
import { saveBook, type Book } from '../src/rules.ts';
import { FakeModel, textOf } from './helpers/fakes.ts';
import { makeMp4 } from './helpers/mp4.ts';
import { tempDir } from './helpers/tmp.ts';
import { makeZip } from './helpers/zip-writer.ts';

const root = pluginRoot({});
const ANSWER = {
  summary: '真人口播，演员喊玩无尽冬日。', kind: '真人实拍',
  lines: [{ time: '00:06', source: '台词', text: '三分钟上头' }],
  issues: [
    { level: '要改', time: '00:06–00:07', where: '台词', problem: '「三分钟上头」，上头是防沉迷禁用词', rule: '字幕和口播 · 防沉迷', fix: '换成「三分钟就会」' },
    { level: '红线', time: '00:00–00:03', where: '画面中下（皮带扣）', problem: '露出古驰双 G 标志', rule: '红线 · 侵权', fix: '打码' },
    { level: '需确认', time: '全片', where: '全片画面', problem: '明星林子聪出镜', rule: '明星素材', fix: '投前确认授权' },
    { level: '要改', time: '全片', where: '文件名', problem: '产出方不对', rule: '命名', fix: '改成 DR' },
    { level: '要改', time: '00:01', where: '', problem: '', rule: '', fix: '' },
  ],
};

function video(dir: string, name: string, seconds = 11): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, makeMp4({ seconds, width: 1080, height: 1920 }));
  return file;
}
const context = (model: FakeModel, shared = tempDir('shared-')) => ({ model, root, shared, scratch: tempDir('scratch-'), log: () => {} });

test('the model\'s answer is tidied: empty problems dropped, a file name has no time, the whole material and the name first, then by time', () => {
  const findings = normalize({ ...ANSWER, issues: [...ANSWER.issues, { level: '严重', time: '00:09', where: '字幕', problem: 'x', rule: '', fix: '' }] });
  assert.deepEqual(findings.issues.map(i => [i.level, i.time, i.where]), [
    ['需确认', '全片', '全片画面'], ['要改', '', '文件名'], ['红线', '00:00–00:03', '画面中下（皮带扣）'], ['要改', '00:06–00:07', '台词'], ['要改', '00:09', '字幕'],
  ]);
  assert.deepEqual(normalize(null), { summary: '', kind: '', lines: [], issues: [] });
  assert.deepEqual(normalize({ issues: [{ level: '要改', time: '00:02–00:02、00:12-00:13', where: '台词', problem: 'x', rule: '', fix: '' }] }).issues[0]!.time, '00:02、00:12-00:13');
  assert.equal(verdictOf(findings.issues), '改完再送审');
  assert.equal(verdictOf(findings.issues.filter(i => i.level === '需确认')), '确认后再送审');
  assert.equal(verdictOf([]), '可以送审');
});

test('a reviewed file reads as a table of 级别 / 位置 / 问题 / 怎么改, in time order', () => {
  const findings = normalize(ANSWER);
  const text = renderFile({ name: 'GOFCN1.mp4', status: 'reviewed', media: 'video', duration: 10.77, orientation: '竖版', findings, verdict: verdictOf(findings.issues) });
  assert.equal(text, [
    '**GOFCN1.mp4**（竖版 · 11 秒 · 真人实拍）',
    '真人口播，演员喊玩无尽冬日。',
    '结论：改完再送审（红线 1 · 要改 2 · 需确认 1）',
    '',
    '| 级别 | 位置 | 问题（原文） | 怎么改 |',
    '|---|---|---|---|',
    '| 需确认 | 全片画面 | 明星林子聪出镜〔明星素材〕 | 投前确认授权 |',
    '| 要改 | 文件名 | 产出方不对〔命名〕 | 改成 DR |',
    '| 红线 | 00:00–00:03 画面中下（皮带扣） | 露出古驰双 G 标志〔红线 · 侵权〕 | 打码 |',
    '| 要改 | 00:06–00:07 台词 | 「三分钟上头」，上头是防沉迷禁用词〔字幕和口播 · 防沉迷〕 | 换成「三分钟就会」 |',
  ].join('\n'));
  const clean = renderFile({ name: '海报.png', status: 'reviewed', media: 'image', findings: { summary: '', kind: '其他', lines: [], issues: [] }, verdict: '可以送审' });
  assert.equal(clean, '**海报.png**（图片）\n结论：可以送审，没有发现问题');
  const piped = normalize({ issues: [{ level: '要改', time: '00:01', where: '字幕', problem: '「A|B」', rule: '', fix: '' }] });
  assert.match(renderFile({ name: 'b.mp4', status: 'reviewed', media: 'video', findings: piped, verdict: '改完再送审' }), /\n\| 要改 \| 00:01 字幕 \| 「A\\\|B」 \| — \|$/);
  assert.equal(renderFile({ name: 'a.mp4', status: 'failed', reason: '视频太大' } as FileResult), '**a.mp4**\n没审成：视频太大');
});

test('the system instruction carries the fixed spec and the dynamic spec, the dynamic one said to win', () => {
  const system = reviewSystem(PROJECTS.GOF, '# 固定\n- 不写上头', '- D1〔字幕和口播〕「赚米」不能用');
  assert.match(system, /GOF（无尽冬日）/);
  assert.match(system, /## Fixed spec\n# 固定\n- 不写上头/);
  assert.match(system, /## Dynamic spec\n- D1〔字幕和口播〕「赚米」不能用/);
  assert.match(system, /the dynamic rule wins/);
  assert.match(system, /Chinese ad platforms/);
  assert.match(system, /the section of the fixed spec whose title says 红线/);
  const got = reviewSystem(PROJECTS.GOT, '', '');
  assert.match(got, /no fixed spec yet[\s\S]*No dynamic rules yet/);
  assert.match(got, /not settled yet/);
  assert.doesNotMatch(got, /Chinese ad platforms/, 'GOT material is not said to go to Chinese platforms');
});

test('a GOF review sends each video inline with the GOF spec, at the frame rate its length calls for, and renders every file', async () => {
  const dir = tempDir('input-');
  fs.writeFileSync(path.join(dir, '说明.txt'), 'x');
  const model = new FakeModel(request => textOf(request).includes('坏的') ? new Blocked('AI 网关暂时不可用（HTTP 503），稍后再试') : ANSWER);
  const outcome = await review(PROJECTS.GOF, [video(dir, 'GOFCN1_竖版.mp4'), video(dir, '坏的.mp4', 100), path.join(dir, '说明.txt'), path.join(dir, 'missing.mp4')], '这是真人实拍', context(model));
  assert.equal(model.calls.length, 2);
  // Two at a time: the calls come in whichever order the files are ready.
  const first = model.calls.find(c => textOf(c).includes('GOFCN1'));
  const long = model.calls.find(c => textOf(c).includes('坏的'));
  assert.match(first!.system, /广告创意仅供参考/, 'the fixed spec of GOF');
  assert.equal(first!.parts[0]!.inlineData!.mimeType, 'video/mp4');
  assert.equal(first!.parts[0]!.videoMetadata!.fps, 4);
  assert.equal(long!.parts[0]!.videoMetadata!.fps, 1);
  assert.equal(first!.mediaResolution, 'MEDIA_RESOLUTION_HIGH');
  assert.match(textOf(first!), /File name: GOFCN1_竖版\.mp4[\s\S]*Video: 11 s, 竖版[\s\S]*Notes from the user: 这是真人实拍/);
  assert.deepEqual(outcome.results.map(r => r.status), ['reviewed', 'failed']);
  assert.match(outcome.markdown, /\*\*GOFCN1_竖版\.mp4\*\*（竖版 · 11 秒 · 真人实拍）/);
  assert.match(outcome.markdown, /\*\*坏的\.mp4\*\*\n没审成：AI 网关暂时不可用/);
  assert.match(outcome.markdown, /没有审的文件：\n- 说明\.txt：不是视频或图片，没有审\n- missing\.mp4：找不到这个文件/);
  assert.deepEqual(outcome.rules, { fixed: true, dynamic: 0 });
});

test('GOT is reviewed against its fixed spec and its dynamic spec', async () => {
  const dir = tempDir('input-');
  const shared = tempDir('shared-');
  const model = new FakeModel(() => ANSWER);
  const plain = await review(PROJECTS.GOT, [video(dir, 'got.mp4')], undefined, context(model, shared));
  assert.equal(plain.results[0]!.status, 'reviewed');
  assert.match(model.calls[0]!.system, /## Fixed spec\n# GOT 广告素材审片规范/);
  assert.match(model.calls[0]!.system, /No dynamic rules yet/);
  assert.deepEqual(plain.rules, { fixed: true, dynamic: 0 });
  const book: Book = { version: 1, project: 'GOT', next: 2, removed: [], updated: 1, rules: [
    { id: 'D1', category: '字幕和口播', rule: '「通关」不能写成「通guan」', fix: '写汉字', sources: [{ chat: 'oc_1', message: 'om_1', at: Date.parse('2026-10-30T06:00:00Z') }], created: 1, updated: Date.parse('2026-10-30T06:00:00Z') },
  ] };
  saveBook(shared, book);
  const outcome = await review(PROJECTS.GOT, [video(dir, 'got.mp4')], undefined, context(model, shared));
  assert.match(model.calls[1]!.system, /- D1〔字幕和口播〕「通关」不能写成「通guan」 怎么改：写汉字（2026-10-30）/);
  assert.deepEqual(outcome.rules, { fixed: true, dynamic: 1 });
});

test('a project whose fixed spec is a placeholder uses its dynamic spec alone, and with none the review is refused with what to do', async () => {
  const placeholder = tempDir('plugin-');
  fs.mkdirSync(path.join(placeholder, 'skills', 'got-audit', 'references'), { recursive: true });
  fs.writeFileSync(path.join(placeholder, 'skills', 'got-audit', 'references', 'rules.md'), [PLACEHOLDER, '<!-- 还没定 -->', '', '# GOT 广告素材审片规范', '', '还没有固定规范。', ''].join('\n'));
  const dir = tempDir('input-');
  const shared = tempDir('shared-');
  const model = new FakeModel(() => ANSWER);
  const ctx = () => ({ ...context(model, shared), root: placeholder });
  await assert.rejects(review(PROJECTS.GOT, [video(dir, 'got.mp4')], undefined, ctx()), /监听本群更新审片规范/);
  assert.equal(model.calls.length, 0);
  saveBook(shared, { version: 1, project: 'GOT', next: 2, removed: [], updated: 1, rules: [
    { id: 'D1', category: '字幕和口播', rule: '「通关」不能写成「通guan」', sources: [{ chat: 'oc_1', message: 'om_1', at: 1 }], created: 1, updated: 1 },
  ] });
  const outcome = await review(PROJECTS.GOT, [video(dir, 'got.mp4')], undefined, ctx());
  assert.equal(outcome.results[0]!.status, 'reviewed');
  assert.match(model.calls[0]!.system, /no fixed spec yet/);
  assert.doesNotMatch(model.calls[0]!.system, /还没有固定规范/);
  assert.deepEqual(outcome.rules, { fixed: false, dynamic: 1 });
});

test('a file sent again, which the host saved as "name (2).mp4", is reviewed under the name it was sent with', async () => {
  const dir = tempDir('input-');
  const model = new FakeModel(() => ANSWER);
  const outcome = await review(PROJECTS.GOF, [video(dir, 'GOFCN1_竖版 (2).mp4')], undefined, context(model));
  assert.match(textOf(model.calls[0]!), /File name: GOFCN1_竖版\.mp4\n/);
  assert.equal(outcome.results[0]!.name, 'GOFCN1_竖版.mp4');
});

test('a zip is unpacked into the scratch folder and each material in it reviewed under its path in the zip', async () => {
  const dir = tempDir('input-');
  const zip = path.join(dir, '素材.zip');
  fs.writeFileSync(zip, makeZip([
    { name: '横版/GOFCN2.mp4', data: makeMp4({ seconds: 15, width: 1920, height: 1080 }) },
    { name: '竖版/GOFCN2.mp4', data: makeMp4({ seconds: 15, width: 1080, height: 1920 }) },
    { name: '脚本.docx', data: 'x' },
    { name: '__MACOSX/._GOFCN2.mp4', data: 'x' },
  ]));
  const model = new FakeModel(() => ({ summary: '', kind: '', lines: [], issues: [] }));
  const ctx = context(model);
  const outcome = await review(PROJECTS.GOF, [zip], undefined, ctx);
  assert.deepEqual(outcome.results.map(r => [r.name, r.orientation]), [['素材.zip › 横版/GOFCN2.mp4', '横版'], ['素材.zip › 竖版/GOFCN2.mp4', '竖版']]);
  assert.deepEqual(outcome.skipped, [{ file: '素材.zip › 脚本.docx', reason: '不是视频或图片，没有审' }]);
  assert.ok(fs.readdirSync(ctx.scratch).length > 0, 'unpacked in the scratch folder');
  assert.equal(fs.readdirSync(dir).length, 1, 'nothing written next to the user’s files');
});

test('the command line: review prints the Markdown and keeps the details outside the workspace; mistakes are refused with exit code 2', async () => {
  const user = tempDir('user-');
  const workspace = path.join(user, 'workspace');
  fs.mkdirSync(path.join(workspace, 'input'), { recursive: true });
  const file = video(path.join(workspace, 'input'), 'GOFCN3.mp4');
  const env = { LARK_AGENT_USER_DIR: user, LARK_AGENT_SHARED_DIR: tempDir('shared-') };
  const model = new FakeModel(() => ANSWER);
  const lines: string[] = [];
  const { result, code } = await main(['review', '--project', 'gof', '--file', file], { env, model, ffmpeg: null, log: line => lines.push(line) });
  assert.equal(code, 0);
  assert.equal(result.status, 'done');
  assert.match(String(result.markdown), /^\*\*GOFCN3\.mp4\*\*/);
  assert.deepEqual(result.files, [{ name: 'GOFCN3.mp4', status: 'reviewed', verdict: '改完再送审', issues: 4 }]);
  const kept = String(result.result_file);
  assert.ok(kept.startsWith(path.join(user, 'audit-auto', 'reviews')), kept);
  assert.equal(fs.readFileSync(kept, 'utf8'), result.markdown);
  assert.equal(JSON.parse(fs.readFileSync(kept.replace(/\.md$/, '.json'), 'utf8')).files[0].findings.lines[0].text, '三分钟上头');
  assert.deepEqual(fs.readdirSync(workspace), ['input'], 'nothing new in the workspace: the host would send it to the user');
  assert.deepEqual(fs.readdirSync(path.join(user, 'audit-auto', 'tmp')), [], 'the scratch folder of the run is gone');
  assert.match(lines.join('\n'), /审片 1\/1：GOFCN3\.mp4[\s\S]*完成 1\/1：GOFCN3\.mp4，4 处问题/);
  // A note that starts with a dash is still the note, not an option.
  const dashed = await main(['review', '--project', 'GOF', '--file', file, '--note', '-B 面从 5 秒开始'], { env, model, ffmpeg: null, log: () => {} });
  assert.equal(dashed.code, 0, String(dashed.result.reason));
  assert.match(textOf(model.calls.at(-1)!), /Notes from the user: -B 面从 5 秒开始/);

  for (const [args, reason] of [
    [['review', '--file', file], /缺少 --project/],
    [['review', '--project', 'GOX', '--file', file], /只有 GOF 和 GOT/],
    [['review', '--project', 'GOF'], /缺少 --file/],
    [['review', '--project', 'GOF', '--file', file, '--bogus'], /bogus/],
    [['nonsense'], /用法/],
  ] as const) {
    const refused = await main([...args], { env, model, ffmpeg: null, log: () => {} });
    assert.equal(refused.code, 2, args.join(' '));
    assert.equal(refused.result.status, 'blocked');
    assert.match(String(refused.result.reason), reason);
  }
  const none = await main(['review', '--project', 'GOF', '--file', path.join(user, 'nope.mp4')], { env, model, ffmpeg: null, log: () => {} });
  assert.equal(none.code, 2);
  assert.equal(none.result.status, 'failed');
  assert.match(String(none.result.markdown), /nope\.mp4：找不到这个文件/);
});
