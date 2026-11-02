import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuApp } from '../src/config.ts';
import { botLark, explainLark, LarkError } from '../src/lark.ts';

const APP = { id: 'cli_bot', secret: 'secret-value-1', base: 'https://open.feishu.test/open-apis' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** A Feishu that answers by path; it counts token requests. */
function feishu(routes: Record<string, (url: URL, n: number) => Response>) {
  const asked: URL[] = [];
  let tokens = 0;
  const counts = new Map<string, number>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
      tokens++;
      assert.deepEqual(JSON.parse(String(init?.body)), { app_id: 'cli_bot', app_secret: 'secret-value-1' });
      return json({ code: 0, tenant_access_token: `t-${tokens}`, expire: 7200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer t-${tokens}`);
    asked.push(url);
    const route = Object.keys(routes).find(p => url.pathname.endsWith(p));
    assert.ok(route, `unexpected ${url.pathname}`);
    const n = (counts.get(route) ?? 0) + 1;
    counts.set(route, n);
    return routes[route]!(url, n);
  }) as typeof globalThis.fetch;
  return { fetch, asked, tokens: () => tokens };
}

test('the history is read page by page, oldest first, within the seconds asked for, with one token', async () => {
  const api = feishu({
    '/im/v1/messages': (_url, n) => n === 1
      ? json({ code: 0, data: { items: [{ message_id: 'om_1' }, { message_id: 'om_2' }], has_more: true, page_token: 'p2' } })
      : json({ code: 0, data: { items: [{ message_id: 'om_3' }], has_more: false } }),
  });
  const lark = botLark(APP, api.fetch, async () => {});
  const ids: string[] = [];
  for await (const m of lark.history('oc_review', 100, 200)) ids.push(m.message_id);
  assert.deepEqual(ids, ['om_1', 'om_2', 'om_3']);
  const first = Object.fromEntries(api.asked[0]!.searchParams);
  assert.deepEqual(first, { container_id_type: 'chat', container_id: 'oc_review', start_time: '100', end_time: '200', sort_type: 'ByCreateTimeAsc', page_size: '50' });
  assert.equal(api.asked[1]!.searchParams.get('page_token'), 'p2');
  assert.equal(api.tokens(), 1);
});

test('an expired token is renewed, rate limits waited out, and refusals become reasons the user or the administrator can act on', async () => {
  const api = feishu({
    '/im/v1/messages': (_url, n) => n === 1 ? json({ code: 99991663, msg: 'token expired' }) : n === 2 ? json({ code: 99991400, msg: 'too many' }, 429)
      : json({ code: 0, data: { items: [], has_more: false } }),
    '/contact/v3/users/ou_1': () => json({ code: 0, data: { user: { name: '王审核' } } }),
    '/contact/v3/users/ou_2': () => json({ code: 41050, msg: 'no permission' }),
  });
  const lark = botLark(APP, api.fetch, async () => {});
  for await (const _ of lark.history('oc_1', 0, 1)) { /* nothing */ }
  assert.equal(api.tokens(), 2);
  assert.equal(await lark.userName('ou_1'), '王审核');
  assert.equal(await lark.userName('ou_2'), undefined, 'a name that cannot be looked up is just not known');

  const denied = feishu({ '/im/v1/messages': () => json({ code: 99991672, msg: 'Access denied', error: { permission_violations: [{ subject: 'im:message.group_msg' }] } }, 400) });
  const error = await (async () => { for await (const _ of botLark(APP, denied.fetch, async () => {}).history('oc_1', 0, 1)) { /* nothing */ } })().catch(e => e);
  assert.ok(error instanceof LarkError);
  assert.equal(explainLark(error), '机器人缺少飞书权限（im:message.group_msg）：请管理员在飞书开放平台给应用开通并发布新版本');
  assert.match(explainLark(new LarkError(230002, 'bot not in chat')), /机器人不在这个群里/);

  const badApp = (async () => json({ code: 10003, msg: 'invalid app' })) as typeof globalThis.fetch;
  await assert.rejects((async () => { for await (const _ of botLark(APP, badApp).history('oc_1', 0, 1)) { /* nothing */ } })(), /飞书应用凭证无效/);
});

test('pictures come back as bytes with their type; a forward is read with what it carries; threads page like the chat', async () => {
  const api = feishu({
    '/resources/img_1': () => new Response(Buffer.from('png-bytes'), { headers: { 'content-type': 'image/png' } }),
    '/resources/img_gone': () => json({ code: 234003, msg: 'resource not found' }, 400),
    '/im/v1/messages/om_fwd': () => json({ code: 0, data: { items: [{ message_id: 'om_fwd' }, { message_id: 'om_in', upper_message_id: 'om_fwd' }] } }),
    '/im/v1/messages': url => json({ code: 0, data: { items: [{ message_id: `reply-in-${url.searchParams.get('container_id')}` }], has_more: false } }),
  });
  const lark = botLark(APP, api.fetch, async () => {});
  const picture = await lark.picture('om_9', 'img_1');
  assert.deepEqual([picture!.mime, picture!.data.toString()], ['image/png', 'png-bytes']);
  assert.equal(api.asked.at(-1)!.searchParams.get('type'), 'image');
  assert.equal(await lark.picture('om_9', 'img_gone'), undefined);
  assert.deepEqual((await lark.message('om_fwd')).map(m => m.message_id), ['om_fwd', 'om_in']);
  assert.deepEqual((await lark.thread('omt_1')).map(m => m.message_id), ['reply-in-omt_1']);
  assert.equal(api.asked.at(-1)!.searchParams.get('container_id_type'), 'thread');
});

test('the app comes from the host\'s environment', () => {
  assert.deepEqual(feishuApp({ FEISHU_APP_ID: 'cli_1', FEISHU_APP_SECRET: 's' }), { id: 'cli_1', secret: 's', base: 'https://open.feishu.cn/open-apis' });
  assert.throws(() => feishuApp({}), /FEISHU_APP_ID/);
});
