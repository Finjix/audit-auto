import type { App } from './config.ts';
import { Blocked, messageOf, redact } from './errors.ts';

/*
 * Reading a review group as the bot (the app's tenant token; the bot is a member of the group). That needs the app permission to read
 * all messages of the groups it is in (im:message.group_msg), not only the ones that @-mention it, plus im:message:readonly for pictures
 * and contact:user.base:readonly for names. Only reads: nothing is ever sent from here.
 */

export interface FeishuMessage {
  message_id: string;
  root_id?: string; parent_id?: string; thread_id?: string; upper_message_id?: string;
  msg_type: string;
  /** Milliseconds since the epoch, as a string. */
  create_time: string;
  deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: { key: string; id?: string; name?: string }[];
}

export interface Picture { data: Buffer; mime: string }

export interface Lark {
  /** The bot's app id: the bot's own messages are left out of what is read. */
  appId: string;
  /** The messages of a chat from `start` to `end` (seconds since the epoch), oldest first. */
  history(chat: string, start: number, end: number): AsyncGenerator<FeishuMessage>;
  /** The replies in a thread (topic), oldest first. */
  thread(thread: string): Promise<FeishuMessage[]>;
  /** A message by its id: the message, and for a merged-and-forwarded one the messages it carries (their upper_message_id is its id). */
  message(id: string): Promise<FeishuMessage[]>;
  picture(message: string, key: string): Promise<Picture | undefined>;
  userName(openId: string): Promise<string | undefined>;
  /** Whether Feishu takes the app's credentials (doctor). */
  verify(): Promise<void>;
}

/** An error code Feishu answered with. */
export class LarkError extends Error {
  code: number;
  scopes: string[];
  constructor(code: number, message: string, scopes: string[] = []) {
    super(message);
    this.code = code;
    this.scopes = scopes;
  }
}

const NO_SCOPE = new Set([99991672, 99991679]);
const NOT_IN_CHAT = new Set([230002, 230027, 232011]);
const PAGE = 50;

/** What a failure to read a group means for the user, or for the administrator. */
export function explainLark(error: unknown): string {
  if (error instanceof Blocked) return error.message;
  if (error instanceof LarkError) {
    if (NO_SCOPE.has(error.code)) return `机器人缺少飞书权限${error.scopes.length ? `（${error.scopes.join(' / ')}）` : ''}：请管理员在飞书开放平台给应用开通并发布新版本`;
    if (NOT_IN_CHAT.has(error.code)) return '机器人不在这个群里（可能已被移出群），读不到群消息';
    return `读取飞书消息失败（错误码 ${error.code}）：${error.message.slice(0, 200)}`;
  }
  return `读取群消息失败：${messageOf(error).slice(0, 200)}`;
}

export function botLark(app: App, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Lark {
  let token: { value: string; until: number } | undefined;

  async function tenantToken(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    const response = await fetchImpl(`${app.base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: app.id, app_secret: app.secret }),
    });
    const body = await response.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) throw new Blocked(`飞书应用凭证无效（错误码 ${body.code ?? response.status}），请联系管理员`);
    token = { value: body.tenant_access_token, until: Date.now() + Math.max(60, (body.expire ?? 3600) - 300) * 1000 };
    return token.value;
  }

  /** One GET; an expired token is renewed once, rate limits and network trouble are tried again twice. */
  async function call(path: string, params: Record<string, string | number | undefined> = {}, raw = false): Promise<any> {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const url = `${app.base}${path}${query.size ? `?${query}` : ''}`;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { authorization: `Bearer ${await tenantToken()}` } });
      } catch (error) {
        if (error instanceof Blocked) throw error;
        if (attempt >= 3) throw new Error(redact(messageOf(error), [app.secret]));
        await sleep(2000 * attempt);
        continue;
      }
      const type = response.headers.get('content-type') ?? '';
      if (raw && response.ok && !type.includes('application/json')) return { data: Buffer.from(await response.arrayBuffer()), mime: type.split(';')[0]!.trim() };
      const body = await response.json().catch(() => ({ code: response.status, msg: `HTTP ${response.status}` })) as any;
      if (body.code === 0) return body.data ?? {};
      if ((body.code === 99991663 || body.code === 99991661) && attempt < 3) { token = undefined; continue; }
      if ((body.code === 99991400 || response.status === 429 || response.status >= 500) && attempt < 3) { await sleep(2000 * attempt); continue; }
      const scopes = (body.error?.permission_violations ?? []).map((v: { subject?: string }) => v.subject).filter(Boolean);
      throw new LarkError(Number(body.code ?? response.status), String(body.msg ?? ''), scopes);
    }
  }

  async function* pages(params: Record<string, string | number | undefined>): AsyncGenerator<FeishuMessage> {
    let pageToken: string | undefined;
    do {
      const data = await call('/im/v1/messages', { ...params, sort_type: 'ByCreateTimeAsc', page_size: PAGE, page_token: pageToken });
      for (const item of data.items ?? []) yield item as FeishuMessage;
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
  }

  return {
    appId: app.id,
    history: (chat, start, end) => pages({ container_id_type: 'chat', container_id: chat, start_time: start, end_time: end }),
    async thread(thread) {
      const found: FeishuMessage[] = [];
      for await (const message of pages({ container_id_type: 'thread', container_id: thread })) found.push(message);
      return found;
    },
    async message(id) {
      return ((await call(`/im/v1/messages/${encodeURIComponent(id)}`)).items ?? []) as FeishuMessage[];
    },
    async picture(message, key) {
      try {
        const got = await call(`/im/v1/messages/${encodeURIComponent(message)}/resources/${encodeURIComponent(key)}`, { type: 'image' }, true);
        return Buffer.isBuffer(got?.data) ? got as Picture : undefined;
      } catch { return undefined; }
    },
    async verify() { await tenantToken(); },
    async userName(openId) {
      try { return (await call(`/contact/v3/users/${encodeURIComponent(openId)}`, { user_id_type: 'open_id' })).user?.name || undefined; } catch { return undefined; }
    },
  };
}
