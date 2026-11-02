import test from 'node:test';
import assert from 'node:assert/strict';
import { chunks, contentOf, entriesOf, renderChunk, stamp, type Entry } from '../src/transcript.ts';
import { message } from './helpers/fakes.ts';

const AT = Date.parse('2026-10-30T06:05:00Z'); // 14:05 in China
const names: Record<string, string> = { ou_alice: '王审核', ou_bob: '李剪辑' };
const ctx = (forwarded = new Map()) => ({ appId: 'cli_bot', name: (id: string) => names[id] ?? `成员${id.slice(-4)}`, forwarded });

test('what a message says: text with its mentions, rich text in either shape, pictures, files, cards', () => {
  assert.deepEqual(contentOf(message(AT, { text: '@_user_1 这条被拒了 @_all' }, { mentions: [{ key: '@_user_1', name: '李剪辑' }] })), { text: '@李剪辑 这条被拒了 @所有人', pictures: [] });
  const post = { title: '拒审', content: [[{ tag: 'text', text: '巨量说' }, { tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' 上头不能用' }], [{ tag: 'img', image_key: 'img_1' }]] };
  assert.deepEqual(contentOf(message(AT, post, { type: 'post', mentions: [{ key: '@_user_1', name: '王审核' }] })), { text: '拒审\n巨量说@王审核 上头不能用', pictures: ['img_1'] });
  assert.deepEqual(contentOf(message(AT, { zh_cn: post }, { type: 'post' })).pictures, ['img_1'], 'a post under a language key');
  assert.deepEqual(contentOf(message(AT, { image_key: 'img_2' }, { type: 'image' })), { text: '', pictures: ['img_2'] });
  assert.equal(contentOf(message(AT, { file_key: 'f', file_name: '拒审截图.zip' }, { type: 'file' })).text, '[文件：拒审截图.zip]');
  assert.equal(contentOf(message(AT, { title: '素材审核结果', elements: [[{ tag: 'text', text: '拒绝：含防沉迷词' }]] }, { type: 'interactive' })).text, '素材审核结果 拒绝：含防沉迷词');
  assert.equal(contentOf(message(AT, {}, { type: 'sticker' })).text, '');
  assert.equal(contentOf({ ...message(AT, {}), body: { content: 'not json' } }).text, '');
});

test('the bot\'s own messages, system notices, recalled and empty messages are left out; forwarded messages follow their forward', () => {
  const forward = message(AT + 3000, { content: 'Merged and Forwarded Message' }, { type: 'merge_forward' });
  const inner = [
    { ...message(AT - 86_400_000, { text: '这条被字节拒了：「赚米」' }, { from: 'ou_carol' }), upper_message_id: forward.message_id },
    { ...message(AT - 86_000_000, { text: 'unrelated' }), upper_message_id: 'om_other' },
  ];
  const list = [
    message(AT, { text: '「上头」不能用了' }),
    message(AT + 1000, { text: '审片结果……' }, { from: 'cli_bot', type: 'interactive' }),
    message(AT + 1500, { text: '审核通知：已拒绝' }, { from: 'cli_other' }),
    message(AT + 2000, {}, { type: 'system' }),
    { ...message(AT + 2500, { text: '撤回了' }), deleted: true },
    message(AT + 2600, {}, { type: 'sticker' }),
    forward,
    message(AT + 4000, { text: '收到' }, { from: 'ou_bob', parent_id: 'om_x' }),
  ];
  const entries = entriesOf(list, ctx(new Map([[forward.message_id, [forward, ...inner]]])));
  assert.deepEqual(entries.map(e => [e.by, e.text, e.forwarded ?? false]), [
    ['王审核', '「上头」不能用了', false],
    ['机器人', '审核通知：已拒绝', false],
    ['王审核', '[转发了一段聊天记录：]', false],
    ['成员arol', '这条被字节拒了：「赚米」', true],
    ['李剪辑', '收到', false],
  ]);
  assert.equal(entries.at(-1)!.reply, 'om_x');
});

test('the transcript numbers messages, says which one a reply answers and labels pictures, in China time', () => {
  const entries: Entry[] = [
    { id: 'a', at: AT, by: '王审核', text: '这条被拒了', pictures: ['img_1', 'img_2'] },
    { id: 'b', at: AT + 60_000, by: '李剪辑', text: '为啥', pictures: [], reply: 'a' },
    { id: 'c', at: AT + 120_000, by: '王审核', text: '见上', pictures: [], reply: 'old' },
    { id: 'd', at: AT + 180_000, by: '王审核', text: '再说一次', pictures: [], reply: 'gone' },
    { id: 'e', at: AT + 240_000, by: '成员', text: '转来的', pictures: [], forwarded: true },
  ];
  assert.equal(renderChunk(entries, new Map([['old', '昨天说的：BOSS 要写成怪']])), [
    '#1 [2026-10-30 14:05] 王审核: 这条被拒了 [图片 #1-1] [图片 #1-2]',
    '#2 [2026-10-30 14:06] 李剪辑（回复 #1）: 为啥',
    '#3 [2026-10-30 14:07] 王审核（回复：「昨天说的：BOSS 要写成怪」）: 见上',
    '#4 [2026-10-30 14:08] 王审核（回复更早的消息）: 再说一次',
    '    ↳ #5 [2026-10-30 14:09] 成员: 转来的',
  ].join('\n'));
  assert.equal(stamp(Date.parse('2026-11-02T16:30:00Z')), '2026-11-03 00:30');
});

test('chunks hold bounded text and pictures, and never split a forward from what it carries', () => {
  const entry = (id: string, size: number, pictures = 0, forwarded = false): Entry => ({ id, at: AT, by: 'x', text: 'x'.repeat(size), pictures: Array(pictures).fill('k'), ...(forwarded ? { forwarded } : {}) });
  const parts = chunks([entry('1', 500), entry('2', 500), entry('3', 500, 0), entry('4', 500, 0, true), entry('5', 10, 3), entry('6', 10, 2)], 1200, 4);
  assert.deepEqual(parts.map(p => p.map(e => e.id)), [['1', '2'], ['3', '4', '5'], ['6']]);
  assert.deepEqual(chunks([]), []);
});
