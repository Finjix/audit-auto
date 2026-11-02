import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pluginRoot } from '../src/config.ts';
import { Blocked } from '../src/errors.ts';
import { GatewayDown } from '../src/gemini.ts';
import { LarkError } from '../src/lark.ts';
import { PROJECTS } from '../src/projects.ts';
import { loadBook, show, status, syncAll, watch, withLock } from '../src/rules.ts';
import { FakeLark, FakeModel, message, textOf } from './helpers/fakes.ts';
import { tempDir } from './helpers/tmp.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T08:00:00Z');
const root = pluginRoot({});
const group = { chat: 'oc_review', chatType: 'group', user: 'ou_alice' };
const groupsOf = (shared: string) => JSON.parse(fs.readFileSync(path.join(shared, 'groups.json'), 'utf8')).groups;

function setup() {
  const shared = path.join(tempDir('host-'), 'audit-auto');
  const lark = new FakeLark();
  const model = new FakeModel(() => ({ operations: [] }));
  return { shared, lark, model, ctx: { lark, model, root, shared, log: () => {}, now: () => NOW } };
}

test('a thread is followed: replies that come after its first message was read are read at the next sync; a thread that cannot be read is read later', async () => {
  const { shared, lark, model, ctx } = setup();
  const root = message(NOW - DAY, { text: '这条拒审截图大家看下' }, { thread_id: 'omt_1' });
  lark.messages.push(root);
  lark.threads.set('omt_1', [root, message(NOW - DAY + 60_000, { text: '是因为右下角的箭头' }, { thread_id: 'omt_1', parent_id: root.message_id })]);
  await watch(PROJECTS.GOF, undefined, group, ctx);
  assert.match(textOf(model.calls[0]!), /#1 .*这条拒审截图大家看下\n#2 .*（回复 #1）: 是因为右下角的箭头/);
  assert.equal(groupsOf(shared)[0].threads.omt_1, NOW - DAY + 60_000);

  // An hour later the reviewer answers in the thread: the chat's own list has nothing new, the thread has.
  lark.threads.get('omt_1')!.push(message(NOW + 30 * 60_000, { text: '以后这种箭头都不行' }, { thread_id: 'omt_1', parent_id: root.message_id }));
  const later = { ...ctx, now: () => NOW + 3_600_000 };
  lark.failWith = undefined;
  const failing = lark.thread.bind(lark);
  lark.thread = async () => { throw new LarkError(500, 'busy'); };
  await syncAll(later);
  assert.equal(model.calls.length, 1, 'the thread could not be read: nothing to read');
  assert.equal(groupsOf(shared)[0].threads.omt_1, NOW - DAY + 60_000, 'and it stays where it was');
  lark.thread = failing;
  await syncAll(later);
  assert.equal(model.calls.length, 2);
  assert.match(textOf(model.calls[1]!), /#1 .*王审核（之前的消息）: 这条拒审截图大家看下\n#2 .*（回复 #1）: 以后这种箭头都不行/);
  await syncAll(later);
  assert.equal(model.calls.length, 2, 'read once');
  // Two weeks without a reply: the thread is no longer followed.
  await syncAll({ ...ctx, now: () => NOW + 15 * DAY });
  assert.deepEqual(groupsOf(shared)[0].threads, {});
});

test('a chunk the model keeps refusing goes once more without its pictures, and after three readings it is skipped, so the group goes on', async () => {
  const { shared, lark, ctx } = setup();
  lark.messages.push(message(NOW - DAY, { image_key: 'img_bad' }, { type: 'image' }), message(NOW - DAY + 1000, { text: '这张图被拒了' }));
  lark.pictures.set('img_bad', { data: Buffer.from('x'), mime: 'image/png' });
  const asked: boolean[] = [];
  const model = new FakeModel(request => {
    asked.push(request.parts.some(p => p.inlineData));
    return new Blocked('AI 网关拒绝了这次请求（HTTP 400）：invalid argument');
  });
  const run = { ...ctx, model };
  const first = await watch(PROJECTS.GOF, undefined, group, run);
  assert.match(String(first.error), /HTTP 400/);
  assert.deepEqual(asked, [true, false], 'with the picture, then without');
  assert.deepEqual(groupsOf(shared)[0].stuck.tries, 1);
  await syncAll(run);
  assert.equal(groupsOf(shared)[0].stuck.tries, 2);
  const third = await syncAll(run);
  assert.equal((third.groups as { error?: string }[])[0]!.error, undefined, 'skipped on the third reading');
  const after = groupsOf(shared)[0];
  assert.equal(after.stuck, undefined);
  assert.equal(after.skipped.length, 1);
  assert.match(after.skipped[0].reason, /HTTP 400/);
  assert.equal(after.cursor, NOW - DAY + 1000, 'read past it');
  const listed = (status(shared, { chat: 'oc_review' }).groups as { here?: boolean; skipped?: unknown[] }[])[0]!;
  assert.equal(listed.here, true, 'the current chat is marked, so the skill can say 本群 without showing ids');
  assert.equal(listed.skipped!.length, 1);

  // A gateway that is down does not count: the chunk is tried again, as it is, however often.
  const { shared: shared2, lark: lark2, ctx: ctx2 } = setup();
  lark2.messages.push(message(NOW - DAY, { text: '「搞钱」不能写' }));
  const down = new FakeModel(() => new GatewayDown('AI 网关暂时不可用（HTTP 503），稍后再试'));
  for (let i = 0; i < 4; i++) await (i ? syncAll({ ...ctx2, model: down }) : watch(PROJECTS.GOF, undefined, group, { ...ctx2, model: down }));
  assert.equal(groupsOf(shared2)[0].stuck, undefined);
  assert.equal(groupsOf(shared2)[0].skipped, undefined);
  assert.equal(groupsOf(shared2)[0].cursor, 0);
  assert.equal(down.calls.length, 4, 'one call a reading: no picture to leave out');
});

test('the hourly sync reads the group read longest ago first, stops starting calls when its time is up, and fails when every group fails', async () => {
  const { shared, lark, model, ctx } = setup();
  lark.messages.push(message(NOW - DAY, { text: '「上头」不能写' }));
  await watch(PROJECTS.GOF, undefined, group, ctx);
  await watch(PROJECTS.GOT, undefined, { ...group, chat: 'oc_other' }, ctx);
  const groups = JSON.parse(fs.readFileSync(path.join(shared, 'groups.json'), 'utf8'));
  groups.groups[0].lastSync = NOW; groups.groups[1].lastSync = NOW - DAY;
  fs.writeFileSync(path.join(shared, 'groups.json'), JSON.stringify(groups));
  lark.messages.push(message(NOW + 1000, { text: '「赚米」也不行' }));
  const asked: string[] = [];
  lark.history = (async function* (this: FakeLark, chat: string) { asked.push(chat); for (const m of this.messages) if (Number(m.create_time) >= NOW) yield m; }).bind(lark);
  const late = await syncAll({ ...ctx, now: () => NOW + 2000, deadline: Date.now() - 1 });
  assert.deepEqual(asked, ['oc_other', 'oc_review']);
  assert.deepEqual((late.groups as { pending: boolean }[]).map(g => g.pending), [true, true], 'out of time: nothing started, all left for next time');
  assert.equal(model.calls.length, 2, 'only the two watches');

  lark.history = async function* () { throw new LarkError(230002, 'bot not in chat'); };
  const broken = await syncAll(ctx);
  assert.equal(broken.status, 'failed');
});

test('the lock is released and kept alive only by its holder; a dead holder\'s lock is taken over once', async () => {
  const { shared } = setup();
  fs.mkdirSync(shared, { recursive: true });
  const file = path.join(shared, 'lock');
  await withLock(shared, async () => {
    // Somebody (wrongly) replaced the lock meanwhile: releasing must not delete theirs.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'theirs', at: Date.now() }));
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'theirs');
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999_999, token: 'dead', at: Date.now() }));
  const order: string[] = [];
  await Promise.all([1, 2].map(n => withLock(shared, async () => {
    order.push(`in ${n}`);
    await new Promise(r => setTimeout(r, 50));
    order.push(`out ${n}`);
  }, 10_000)));
  assert.deepEqual(order.length, 4);
  assert.ok(order[0]!.startsWith('in') && order[1]!.startsWith('out') && order[2]!.startsWith('in'), `one at a time: ${order.join(', ')}`);
  assert.equal(fs.existsSync(file), false);
});

test('the dynamic spec can be read without leaving a file behind', () => {
  const { shared } = setup();
  const answer = show(shared, PROJECTS.GOT);
  assert.equal(answer.status, 'ok');
  assert.match(String(answer.markdown), /^# GOT 动态审片规范[\s\S]*还没有整理出规范/);
  assert.equal(fs.existsSync(path.join(shared, 'rules')), false);
  assert.equal(loadBook(shared, 'GOT').rules.length, 0);
});
