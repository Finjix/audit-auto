import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { pluginRoot } from '../src/config.ts';
import { Blocked } from '../src/errors.ts';
import { LarkError } from '../src/lark.ts';
import { PROJECTS } from '../src/projects.ts';
import { apply, categoryOf, loadBook, operationsOf, renderBook, syncAll, watch, withLock, type Book, type Source } from '../src/rules.ts';
import { FakeLark, FakeModel, message, textOf } from './helpers/fakes.ts';
import { tempDir } from './helpers/tmp.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T08:00:00Z');
const root = pluginRoot({});
const group = { chat: 'oc_review', chatType: 'group', user: 'ou_alice' };

function emptyBook(project = 'GOF'): Book {
  return { version: 1, project, next: 1, rules: [], removed: [], updated: 0 };
}
const refs = new Map<number, Source>([[1, { chat: 'oc_review', message: 'om_a', at: NOW - DAY, by: '王审核' }], [2, { chat: 'oc_review', message: 'om_b', at: NOW, by: '李剪辑' }]]);

test('operations change the spec only when they name a message of the chunk and, for an update or removal, an existing rule', () => {
  const book = emptyBook();
  const first = apply(book, [
    { op: 'add', category: '字幕和口播', rule: '「上头」不能用', fix: '换成「就会」', messages: [1] },
    { op: 'add', category: '乱写', rule: '不出现日本元素的樱花', messages: [2] },
    { op: 'add', rule: '没有依据的规则', messages: [9] },
    { op: 'add', messages: [1] },
    { op: 'update', id: 'D9', rule: '不存在', messages: [1] },
  ], refs, NOW);
  assert.deepEqual(first, { added: ['D1', 'D2'], updated: [], removed: [] });
  assert.equal(book.rules[1]!.category, '其他', 'an unknown category');
  assert.equal(book.updated, NOW);
  // The same rule again (punctuation aside) is the same rule: it gains the message, not a twin.
  const again = apply(book, [{ op: 'add', rule: '“上头”不能用。', messages: [2] }, { op: 'update', id: 'D2', example: '樱花树背景被拒', messages: [2] }], refs, NOW + 1);
  assert.deepEqual(again, { added: [], updated: ['D1', 'D2'], removed: [] });
  assert.deepEqual(book.rules[0]!.sources.map(s => s.message), ['om_a', 'om_b']);
  assert.equal(book.rules[1]!.example, '樱花树背景被拒');
  const removed = apply(book, [{ op: 'remove', id: 'D2', reason: '群里说可以了', messages: [2] }], refs, NOW + 2);
  assert.deepEqual(removed.removed, ['D2']);
  assert.deepEqual(book.rules.map(r => r.id), ['D1']);
  assert.deepEqual([book.removed[0]!.id, book.removed[0]!.reason, book.removed[0]!.by], ['D2', '群里说可以了', 'chat']);
  assert.equal(book.next, 3, 'ids are never reused');
  const md = renderBook(book);
  assert.match(md, /^# GOF 动态审片规范/);
  assert.match(md, /## 字幕和口播\n\n\*\*D1\*\* 「上头」不能用\n- 怎么改：换成「就会」\n- 依据：2026-11-01 王审核、2026-11-02 李剪辑/);
});

test('the model\'s operations are read defensively, in either shape it answers with', () => {
  assert.deepEqual(operationsOf({ operations: [
    { op: 'add', rule: '  多 空 格  ', messages: [1, '2', 'x'] }, { op: 'drop', messages: [1] }, null, { op: 'remove', id: ' d3 ', messages: [] },
  ] }), [{ op: 'add', rule: '多 空 格', messages: [1, 2] }, { op: 'remove', id: 'D3', messages: [] }]);
  assert.deepEqual(operationsOf([{ op: 'add', rule: '裸数组也行', messages: [1] }]), [{ op: 'add', rule: '裸数组也行', messages: [1] }]);
  assert.deepEqual(operationsOf('nonsense'), []);
});

test('an id the answer gives a rule it adds stands for the rule\'s real id further down the same answer', () => {
  const book = emptyBook();
  const changes = apply(book, operationsOf([
    { op: 'add', id: 'logo_end_card', category: '成片质量', rule: '结尾加 3 秒 logo 定版', messages: [1] },
    { op: 'update', id: 'logo_end_card', rule: '结尾加 2 秒 logo 定版', messages: [2] },
    { op: 'add', id: 'D1', category: '真人实拍', rule: '女演员不穿吊带', messages: [2] },
  ]), refs, NOW);
  assert.deepEqual(changes, { added: ['D1', 'D2'], updated: [], removed: [] });
  assert.deepEqual(book.rules.map(r => [r.id, r.category, r.rule]), [['D1', '成片质量', '结尾加 2 秒 logo 定版'], ['D2', '按素材类型', '女演员不穿吊带']]);
  assert.deepEqual([categoryOf('红线 · 侵权'), categoryOf('3D 玩法'), categoryOf('字幕'), categoryOf(undefined), categoryOf('别的')], ['红线', '按素材类型', '字幕和口播', '其他', '其他']);
});

function setup() {
  // As the host lays it out: <LARK_AGENT_SHARED_DIR>/audit-auto.
  const shared = path.join(tempDir('host-'), 'audit-auto');
  const lark = new FakeLark();
  lark.messages.push(
    message(NOW - 400 * DAY, { text: '很久以前：BOSS 可以写' }),
    message(NOW - 3 * DAY, { text: '这条被巨量拒了，理由是「上头」算防沉迷' }),
    message(NOW - 3 * DAY + 60_000, { text: '以后「上头」都别写了' }, { from: 'ou_bob' }),
    message(NOW - 3 * DAY + 90_000, { text: '审片结果：……' }, { from: 'cli_bot', type: 'interactive' }),
    message(NOW - 2 * DAY, { image_key: 'img_reject' }, { type: 'image' }),
  );
  lark.pictures.set('img_reject', { data: Buffer.from('png'), mime: 'image/png' });
  return { shared, lark };
}

test('listening to a group: refused outside a group; the last year is read, rulings become rules, progress is kept', async () => {
  const { shared, lark } = setup();
  const model = new FakeModel(() => ({ operations: [{ op: 'add', category: '字幕和口播', rule: '「上头」算防沉迷，字幕口播都不能写', fix: '换个说法', messages: [1, 2] }] }));
  const ctx = { lark, model, root, shared, log: () => {}, now: () => NOW };
  await assert.rejects(watch(PROJECTS.GOF, undefined, { chat: 'oc_p2p', chatType: 'p2p' }, ctx), /把机器人拉进审核群/);
  await assert.rejects(watch(PROJECTS.GOF, undefined, {}, ctx), /不知道这条消息来自哪个群/);
  await assert.rejects(watch(PROJECTS.GOF, undefined, { chat: 'oc_x' }, ctx), /看不出这里是不是群聊/);

  const result = await watch(PROJECTS.GOF, undefined, group, ctx);
  assert.deepEqual({ ...result }, { status: 'watching', project: 'GOF', read: 4, considered: 3, added: 1, updated: 0, removed: 0, pending: false, already: false, since: '2025-11-02', rules: 1 });
  assert.equal(lark.asked[0]!.start, Math.floor((NOW - 365 * DAY) / 1000));
  assert.equal(model.calls.length, 1);
  const [call] = model.calls;
  const transcript = textOf(call!);
  assert.match(transcript, /#1 \[2026-10-30 16:00\] 王审核: 这条被巨量拒了，理由是「上头」算防沉迷\n#2 \[2026-10-30 16:01\] 李剪辑: 以后「上头」都别写了\n#3 \[2026-10-31 16:00\] 王审核:  \[图片 #3-1\]/);
  assert.doesNotMatch(transcript, /很久以前|审片结果/, 'older than the start, and the bot\'s own message, are not read');
  assert.equal(call!.parts.at(-1)!.inlineData!.mimeType, 'image/png', 'the picture goes with the transcript');
  assert.match(call!.system, /Today is 2026-11-02/);
  assert.match(call!.system, /# Fixed spec\n# GOF（无尽冬日）/);
  assert.match(call!.system, /# Dynamic spec now\nEach rule .*\n\(empty\)/);

  const book = loadBook(shared, 'GOF');
  assert.deepEqual(book.rules.map(r => [r.id, r.rule, r.sources.map(s => s.by)]), [['D1', '「上头」算防沉迷，字幕口播都不能写', ['王审核', '李剪辑']]]);
  assert.match(fs.readFileSync(path.join(shared, 'rules', 'GOF.md'), 'utf8'), /\*\*D1\*\* 「上头」算防沉迷/);
  const saved = JSON.parse(fs.readFileSync(path.join(shared, 'groups.json'), 'utf8')).groups[0];
  assert.equal(saved.cursor, NOW - 2 * DAY, 'read up to the newest message');
  assert.equal(saved.watchedBy, 'ou_alice');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, 'names.json'), 'utf8')), { ou_alice: '王审核', ou_bob: '李剪辑' });

  // Then at the next sync: only what is new is read, and it may change the rules made before.
  lark.messages.push(message(NOW + 60_000, { text: '更正：「上头」在剧情台词里也不行，另外 BOSS 可以写成首领' }, { parent_id: lark.messages[1]!.message_id }));
  model.answer = () => ({ operations: [
    { op: 'update', id: 'D1', rule: '「上头」算防沉迷，字幕、口播、剧情台词都不能写', messages: ['#4', 1] }, { op: 'add', category: '字幕和口播', rule: 'BOSS 写成首领', messages: [4] },
    { op: 'add', rule: '截图里的东西不能用', messages: [3] },
  ] });
  const hourly = await syncAll({ ...ctx, now: () => NOW + 3_600_000 });
  assert.deepEqual(hourly.groups, [{ chat: 'oc_review', project: 'GOF', read: 1, considered: 1, added: 1, updated: 1, removed: 0, pending: false }]);
  const second = textOf(model.calls[1]!);
  // The messages read before come along (the one it replies to among them), so that the new one makes sense; their pictures stay behind.
  assert.match(second, /^New messages from the review group \(1\), with 3 from earlier readings \(marked 之前的消息\):\n\n#1 \[2026-10-30 16:00\] 王审核（之前的消息）: 这条被巨量拒了，理由是「上头」算防沉迷\n#2 \[2026-10-30 16:01\] 李剪辑（之前的消息）: 以后「上头」都别写了\n#3 \[2026-10-31 16:00\] 王审核（之前的消息）: \[图片\]\n#4 \[2026-11-02 16:01\] 王审核（回复 #1）: 更正/);
  assert.doesNotMatch(second, /审片结果/);
  assert.ok(!model.calls[1]!.parts.some(p => p.inlineData), 'no pictures from before');
  // The rules come with the words they rest on.
  assert.match(model.calls[1]!.system, /- D1〔字幕和口播〕「上头」算防沉迷，字幕口播都不能写 怎么改：换个说法（2026-11-02；依据：王审核「这条被巨量拒了，理由是「上头」算防沉迷」；李剪辑「以后「上头」都别写了」）/);
  // An operation that rests only on what was read before is not taken: its ruling is in the spec already.
  assert.deepEqual(loadBook(shared, 'GOF').rules.map(r => r.rule), ['「上头」算防沉迷，字幕、口播、剧情台词都不能写', 'BOSS 写成首领']);
  assert.deepEqual(loadBook(shared, 'GOF').rules[1]!.sources.map(s => s.text), ['更正：「上头」在剧情台词里也不行，另外 BOSS 可以写成首领']);
  // Nothing new: nobody is asked.
  await syncAll({ ...ctx, now: () => NOW + 7_200_000 });
  assert.equal(model.calls.length, 2);

  await assert.rejects(watch(PROJECTS.GOT, undefined, group, ctx), /本群已经在给 GOF 整理动态规范/);
  const again = await watch(PROJECTS.GOF, undefined, group, ctx);
  assert.equal(again.already, true);
});

test('the command line: watch, status, show, remove and unwatch, as the host runs them', async () => {
  const { shared, lark } = setup();
  const model = new FakeModel(() => ({ operations: [
    { op: 'add', category: '字幕和口播', rule: '「上头」不能写', messages: [1] }, { op: 'add', category: '画面和界面', rule: '拒审截图里的箭头不能用', messages: [3] },
  ] }));
  const workspace = tempDir('workspace-');
  const env = { LARK_AGENT_SHARED_DIR: path.dirname(shared), LARK_AGENT_CHAT_ID: 'oc_review', LARK_AGENT_CHAT_TYPE: 'group', LARK_AGENT_USER_OPEN_ID: 'ou_bob' };
  const run = (...args: string[]) => main(args, { env, lark, model, now: () => NOW, log: () => {} });
  assert.equal((await run('rules', 'watch')).result.reason, '缺少 --project：先问用户这个群是 GOF 还是 GOT 的审核群');
  assert.match(String((await run('rules', 'watch', '--project', 'GOF', '--since', '2026/09/01')).result.reason), /YYYY-MM-DD/);
  const watched = await run('rules', 'watch', '--project', 'GOF', '--since', '2026-10-29');
  assert.equal(watched.code, 0);
  assert.equal(watched.result.since, '2026-10-29');
  assert.equal(watched.result.read, 4, 'from the date given, not the last year');

  const status = (await run('rules', 'status')).result;
  assert.equal(status.here, 'GOF');
  assert.deepEqual(status.rules, { GOF: 2, GOT: 0 });

  const shown = await run('rules', 'show', '--project', 'GOF', '--output', path.join(workspace, '动态审片规范-GOF.md'));
  assert.equal(shown.result.file, path.join(workspace, '动态审片规范-GOF.md'));
  const twice = await run('rules', 'show', '--project', 'GOF', '--output', path.join(workspace, '动态审片规范-GOF.md'));
  assert.equal(twice.result.file, path.join(workspace, '动态审片规范-GOF (2).md'), 'an existing file is not overwritten');

  assert.match(String((await run('rules', 'remove', '--project', 'GOF', '--id', 'D7')).result.reason), /没有 D7/);
  const removed = await run('rules', 'remove', '--project', 'GOF', '--id', 'd2');
  assert.deepEqual(removed.result.removed, [{ id: 'D2', rule: '拒审截图里的箭头不能用' }]);
  assert.equal(loadBook(shared, 'GOF').removed[0]!.reason, '用户删除（ou_bob）');

  const stopped = await run('rules', 'unwatch');
  assert.deepEqual(stopped.result, { status: 'stopped', project: 'GOF', rules: 1 });
  assert.match(String((await run('rules', 'unwatch')).result.reason), /本群没有在监听/);
  assert.match(String((await run('rules', 'sync', '--here')).result.reason), /本群没有在监听/);
  assert.match(String((await run('rules', 'nope')).result.reason), /rules 需要/);
});

test('one writer at a time: the daily job gives way to a reading in progress, a dead holder\'s lock is taken over', async () => {
  const { shared, lark } = setup();
  const model = new FakeModel(() => ({ operations: [] }));
  const env = { LARK_AGENT_SHARED_DIR: path.dirname(shared) };
  let inside = false;
  const held = withLock(shared, async () => {
    inside = true;
    const job = await main(['rules', 'sync'], { env, lark, model, log: () => {} });
    assert.deepEqual([job.code, job.result.status], [0, 'busy'], 'the job (no chat) does not wait and does not fail');
    await assert.rejects(syncAll({ lark, model, root, shared, log: () => {} }), /正在更新/);
  });
  await held;
  assert.ok(inside);
  fs.writeFileSync(path.join(shared, 'lock'), JSON.stringify({ pid: 999_999_999, at: Date.now() }));
  const taken = await syncAll({ lark, model, root, shared, log: () => {} });
  assert.equal(taken.status, 'synced');
  assert.equal(fs.existsSync(path.join(shared, 'lock')), false, 'released');
});

test('a long history is read over several syncs, and a failure keeps what was done before it', async () => {
  const { shared, lark } = setup();
  // 70 messages of 2000 characters (as long as one gets): 19 to a model call.
  for (let i = 0; i < 70; i++) lark.messages.push(message(NOW - DAY + i * 60_000, { text: `第 ${i} 条：${'很长的讨论'.repeat(400)}` }));
  const failure = new Blocked('AI 网关暂时不可用（HTTP 503），稍后再试');
  const model = new FakeModel((_, n) => n === 2 ? failure : { operations: [] });
  const ctx = { lark, model, root, shared, log: () => {}, now: () => NOW, maxChunks: 2 };
  const first = await watch(PROJECTS.GOF, undefined, group, ctx);
  assert.equal(first.error, failure.message);
  const after = JSON.parse(fs.readFileSync(path.join(shared, 'groups.json'), 'utf8')).groups[0];
  assert.equal(after.lastError, failure.message);
  const kept = after.cursor;
  assert.equal(kept, NOW - DAY + 18 * 60_000, 'the first chunk (19 long messages) counts, the failed one does not');
  model.answer = () => ({ operations: [] });
  const second = await syncAll(ctx);
  assert.equal((second.groups as { pending: boolean }[])[0]!.pending, true, 'two model calls this time, more to read');
  const third = await syncAll(ctx);
  assert.equal((third.groups as { pending: boolean }[])[0]!.pending, false);
  const done = JSON.parse(fs.readFileSync(path.join(shared, 'groups.json'), 'utf8')).groups[0];
  assert.equal(done.cursor, NOW - DAY + 69 * 60_000);
  assert.equal(done.read, 74, 'every message counted once, however many readings it took');
  assert.equal(done.lastError, undefined);
});

test('a group the bot cannot read says why: a permission for the administrator, or the bot out of the group', async () => {
  const { shared, lark } = setup();
  const model = new FakeModel(() => ({ operations: [] }));
  lark.failWith = new LarkError(99991672, 'Access denied', ['im:message.group_msg']);
  const result = await watch(PROJECTS.GOT, undefined, group, { lark, model, root, shared, log: () => {}, now: () => NOW });
  assert.equal(result.error, '机器人缺少飞书权限（im:message.group_msg）：请管理员在飞书开放平台给应用开通并发布新版本');
  lark.failWith = new LarkError(230002, 'Bot is not in the chat');
  const synced = await syncAll({ lark, model, root, shared, log: () => {} });
  assert.match(String((synced.groups as { error: string }[])[0]!.error), /机器人不在这个群里/);
});
