import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaResolution } from '@google/genai';
import { gatewayModel } from '../src/gemini.ts';

const GATEWAY = { baseUrl: 'https://lumos.diandian.info/winky/gemini', apiVersion: 'v1', model: 'gemini-3.8-flash', thinkingLevel: 'MEDIUM', key: 'sk-test-key-123' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (text: string, finishReason = 'STOP') => json({ candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 5 } });

function gateway(replies: (() => Response)[]) {
  const sent: { url: string; headers: Headers; body: any }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    return next();
  }) as typeof globalThis.fetch;
  const waits: number[] = [];
  const model = gatewayModel(GATEWAY, { fetch, delays: [5, 20], sleep: async ms => { waits.push(ms); } });
  return { model, sent, waits };
}

test('a call goes to the gateway\'s generateContent with the key, medium thinking, the schema and no safety filtering', async () => {
  const { model, sent } = gateway([() => answer('{"ok":true}')]);
  const reply = await model.json({ system: 'Review.', parts: [{ inlineData: { mimeType: 'video/mp4', data: 'AAAA' }, videoMetadata: { fps: 4 } }, { text: 'File name: a.mp4' }],
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH });
  assert.deepEqual(reply.data, { ok: true }, 'the thought is not part of the answer');
  assert.deepEqual(reply.usage, { input: 10, output: 2, thoughts: 5 });
  const [call] = sent;
  assert.equal(call!.url, 'https://lumos.diandian.info/winky/gemini/v1/models/gemini-3.8-flash:generateContent');
  assert.equal(call!.headers.get('x-goog-api-key'), 'sk-test-key-123');
  assert.deepEqual(call!.body.systemInstruction.parts, [{ text: 'Review.' }]);
  assert.deepEqual(call!.body.contents[0].parts[0].videoMetadata, { fps: 4 });
  const config = call!.body.generationConfig;
  assert.equal(config.thinkingConfig.thinkingLevel, 'MEDIUM');
  assert.equal(config.responseMimeType, 'application/json');
  assert.equal(config.responseJsonSchema, undefined, 'JSON mode, no schema (see gemini.ts)');
  assert.equal(config.mediaResolution, 'MEDIA_RESOLUTION_HIGH');
  assert.equal(call!.body.safetySettings.length, 4);
  assert.ok(call!.body.safetySettings.every((s: { threshold: string }) => s.threshold === 'OFF'));
});

test('a busy gateway, a broken answer and the network are tried again; the rest is told plainly, without the key', async () => {
  const busy = gateway([() => json({ error: { code: 503, message: 'overloaded' } }, 503), () => answer('{"ok":tru'), () => answer('{"ok":true}')]);
  assert.equal((await busy.model.json({ system: '', parts: [{ text: 'x' }] })).attempts, 3);
  assert.deepEqual(busy.waits, [5, 20]);

  const tired = gateway([() => json({}, 503), () => json({}, 503), () => json({}, 503)]);
  await assert.rejects(tired.model.json({ system: '', parts: [{ text: 'x' }] }), /AI 网关暂时不可用（HTTP 503）/);

  const refused = gateway([() => json({ error: { code: 400, message: 'Request payload size exceeds the limit (key sk-test-key-123)' } }, 400)]);
  const error = await refused.model.json({ system: '', parts: [{ text: 'x' }] }).then(() => new Error('not refused'), (e: Error) => e);
  assert.match(error.message, /AI 网关拒绝了这次请求（HTTP 400）/);
  assert.doesNotMatch(error.message, /sk-test-key-123/);
  assert.equal(refused.sent.length, 1, 'a refusal is not sent again');

  await assert.rejects(gateway([() => json({}, 401)]).model.json({ system: '', parts: [] }), /不接受这个 key/);
  await assert.rejects(gateway([() => json({}, 404)]).model.json({ system: '', parts: [] }), /找不到模型 gemini-3.8-flash/);
  await assert.rejects(gateway([() => answer('', 'PROHIBITED_CONTENT')]).model.json({ system: '', parts: [] }), /安全策略拦下了这次回答/);
  await assert.rejects(gateway([() => json({ promptFeedback: { blockReason: 'OTHER' } })]).model.json({ system: '', parts: [] }), /安全策略拦下了这次请求/);
  await assert.rejects(gateway([() => answer('x', 'MAX_TOKENS'), () => answer('x', 'MAX_TOKENS'), () => answer('x', 'MAX_TOKENS')]).model.json({ system: '', parts: [] }), /没有给出完整的结果/);
  const offline = gateway([() => { throw new TypeError('fetch failed'); }, () => answer('{"ok":true}')]);
  assert.deepEqual((await offline.model.json({ system: '', parts: [] })).data, { ok: true });
  const silent = gateway([() => { throw new DOMException('This operation was aborted', 'AbortError'); }, () => answer('{"ok":true}')]);
  await assert.rejects(silent.model.json({ system: '', parts: [] }), /10 分钟没有回应/);
  assert.equal(silent.sent.length, 1, 'a gateway that did not answer in time is not asked again');
  const fenced = gateway([() => answer('```json\n[{"op": "add"}]\n```')]);
  assert.deepEqual((await fenced.model.json({ system: '', parts: [] })).data, [{ op: 'add' }], 'a fenced answer is taken too');
});
