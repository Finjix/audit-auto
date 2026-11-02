import type { JsonRequest, Model } from '../../src/gemini.ts';
import type { FeishuMessage, Lark, Picture } from '../../src/lark.ts';

/** A model that answers from a script and remembers what it was asked. */
export class FakeModel implements Model {
  name = 'fake-gemini';
  calls: JsonRequest[] = [];
  answer: (request: JsonRequest, n: number) => unknown | Promise<unknown>;
  constructor(answer: (request: JsonRequest, n: number) => unknown | Promise<unknown>) { this.answer = answer; }
  async json(request: JsonRequest) {
    this.calls.push(request);
    const data = await this.answer(request, this.calls.length);
    if (data instanceof Error) throw data;
    return { data, usage: { input: 1, output: 1, thoughts: 0 }, ms: 1, attempts: 1 };
  }
}

/** The text parts of a request, joined. */
export const textOf = (request: JsonRequest) => request.parts.map(p => p.text ?? '').join('\n');

let counter = 0;
/** A group message the way Feishu's message list returns it. */
export function message(at: number, content: unknown, extra: Partial<FeishuMessage> & { from?: string; type?: string } = {}): FeishuMessage {
  const { from = 'ou_alice', type = 'text', ...rest } = extra;
  return {
    message_id: `om_${++counter}`, msg_type: type, create_time: String(at),
    sender: from.startsWith('cli_') ? { id: from, id_type: 'app_id', sender_type: 'app' } : { id: from, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify(content) }, ...rest,
  };
}

/** A group: its messages (the list grows as a test adds to it), what each call asked for, members' names. */
export class FakeLark implements Lark {
  appId = 'cli_bot';
  messages: FeishuMessage[] = [];
  threads = new Map<string, FeishuMessage[]>();
  forwards = new Map<string, FeishuMessage[]>();
  pictures = new Map<string, Picture>();
  names: Record<string, string> = { ou_alice: '王审核', ou_bob: '李剪辑' };
  asked: { chat: string; start: number; end: number }[] = [];
  failWith?: Error;

  async *history(chat: string, start: number, end: number) {
    this.asked.push({ chat, start, end });
    if (this.failWith) throw this.failWith;
    for (const m of this.messages) {
      const seconds = Math.floor(Number(m.create_time) / 1000);
      if (seconds >= start && seconds <= end) yield m;
    }
  }
  async thread(thread: string) { return this.threads.get(thread) ?? []; }
  /** A message by id: a forward with what it carries, or any message of the group (a reply's parent from an earlier reading). */
  async message(id: string) { return this.forwards.get(id) ?? [...this.messages, ...[...this.threads.values()].flat()].filter(m => m.message_id === id); }
  async picture(_message: string, key: string) { return this.pictures.get(key); }
  async userName(openId: string) { return this.names[openId]; }
  async verify() { if (this.failWith) throw this.failWith; }
}
