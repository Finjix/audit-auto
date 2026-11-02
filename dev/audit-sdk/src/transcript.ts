import type { FeishuMessage } from './lark.ts';

/*
 * A review group's messages as the model reads them: one numbered line per message (time, sender, what it says, which message it
 * answers), pictures attached after the transcript with the number of their message. The bot's own messages are left out (its review
 * results are not rulings), and so are system notices, recalled messages and messages with nothing in them (a sticker, say).
 */

export interface Entry {
  id: string; at: number; by: string; text: string;
  /** Image keys of pictures in the message (fetched with the message's own id). */
  pictures: string[];
  /** The message this one replies to. */
  reply?: string;
  /** The thread (topic) it belongs to. */
  thread?: string;
  /** Set on the messages a merged-and-forwarded message carries: they keep their own sender and time. */
  forwarded?: boolean;
  /** A message from before this reading, shown because a new one replies to it. */
  earlier?: boolean;
}

export interface EntryContext {
  appId: string;
  name: (openId: string) => string;
  /** The messages each merge-forward message carries, by its id. */
  forwarded: Map<string, FeishuMessage[]>;
}

const MAX_TEXT = 2000;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

function parse(content: string | undefined): any {
  try { return JSON.parse(content ?? '{}') ?? {}; } catch { return {}; }
}

/** The plain text of a rich-text (post) body: either one language's {title, content} or several of them under language keys. */
function postText(body: any, mention: (key: string) => string): { text: string; pictures: string[] } {
  const post = Array.isArray(body?.content) ? body : Object.values(body ?? {}).find((v: any) => Array.isArray(v?.content)) ?? {};
  const pictures: string[] = [];
  const paragraphs = (post.content as any[] ?? []).map(line => (Array.isArray(line) ? line : []).map((el: any) => {
    switch (el?.tag) {
      case 'text': case 'md': case 'code_block': return String(el.text ?? '');
      case 'a': return String(el.text ?? el.href ?? '');
      case 'at': return `@${el.user_name || mention(String(el.user_id ?? ''))}`;
      case 'img': if (el.image_key) pictures.push(String(el.image_key)); return '';
      case 'media': return '[视频]';
      default: return '';
    }
  }).join(''));
  const text = [post.title ? String(post.title) : '', ...paragraphs].filter(s => s.trim()).join('\n');
  return { text, pictures };
}

/** The words of a card (another bot's notice, say): every text, content and title it holds. */
function cardText(body: any): string {
  const words: string[] = [];
  const walk = (node: any, depth: number) => {
    if (depth > 12 || !node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && (key === 'text' || key === 'content' || key === 'title') && value.trim()) words.push(value.trim());
      else if (typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(body, 0);
  return clip(words.join(' '), 800);
}

/** What a message says and the pictures in it. */
export function contentOf(message: FeishuMessage): { text: string; pictures: string[] } {
  const body = parse(message.body?.content);
  const mention = (key: string) => key === '@_all' ? '所有人' : message.mentions?.find(m => m.key === key)?.name ?? '某人';
  switch (message.msg_type) {
    case 'text': return { text: String(body.text ?? '').replace(/@_user_\d+|@_all/g, key => `@${mention(key)}`), pictures: [] };
    case 'post': return postText(body, mention);
    case 'image': return { text: '', pictures: body.image_key ? [String(body.image_key)] : [] };
    case 'file': return { text: `[文件：${body.file_name ?? ''}]`, pictures: [] };
    case 'media': return { text: `[视频：${body.file_name ?? ''}]`, pictures: [] };
    case 'audio': return { text: '[语音]', pictures: [] };
    case 'interactive': return { text: cardText(body), pictures: [] };
    case 'merge_forward': return { text: '[转发了一段聊天记录：]', pictures: [] };
    default: return { text: '', pictures: [] };
  }
}

/** One message as an entry, or nothing when it is left out. */
export function entryOf(message: FeishuMessage, ctx: EntryContext, forwarded = false): Entry | undefined {
  if (message.deleted || message.msg_type === 'system') return undefined;
  const sender = message.sender ?? {};
  if (sender.sender_type === 'app' && sender.id === ctx.appId) return undefined;
  const { text, pictures } = contentOf(message);
  if (!text.trim() && !pictures.length) return undefined;
  const by = sender.sender_type === 'user' && sender.id ? ctx.name(sender.id) : sender.sender_type === 'app' ? '机器人' : '成员';
  return {
    id: message.message_id, at: Number(message.create_time) || 0, by, text: clip(text.trim(), MAX_TEXT), pictures,
    ...(message.parent_id && !forwarded ? { reply: message.parent_id } : {}), ...(message.thread_id && !forwarded ? { thread: message.thread_id } : {}),
    ...(forwarded ? { forwarded: true } : {}),
  };
}

/** The entries of these messages (oldest first), with what each merged-and-forwarded message carries right after it. */
export function entriesOf(messages: FeishuMessage[], ctx: EntryContext): Entry[] {
  const out: Entry[] = [];
  for (const message of messages) {
    const entry = entryOf(message, ctx);
    if (!entry) continue;
    out.push(entry);
    if (message.msg_type !== 'merge_forward') continue;
    const carried = (ctx.forwarded.get(message.message_id) ?? []).filter(m => m.upper_message_id === message.message_id).slice(0, 100);
    for (const inner of carried) {
      const child = entryOf(inner, ctx, true);
      if (child) out.push(child);
    }
  }
  return out;
}

/**
 * Splits entries into what one model call reads: bounded text and pictures, a forwarded message kept with what it carries and an
 * earlier message with the reply that brought it in.
 */
export function chunks(entries: Entry[], maxChars = 40_000, maxPictures = 24): Entry[][] {
  const out: Entry[][] = [];
  let current: Entry[] = [], chars = 0, pictures = 0;
  for (const entry of entries) {
    const size = entry.text.length + 40;
    if (current.length && !entry.forwarded && !current.at(-1)!.earlier && (chars + size > maxChars || pictures + entry.pictures.length > maxPictures)) {
      out.push(current);
      current = []; chars = 0; pictures = 0;
    }
    current.push(entry);
    chars += size;
    pictures += entry.pictures.length;
  }
  if (current.length) out.push(current);
  return out;
}

const SHANGHAI = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** China time: 2026-11-02 16:05. */
export function stamp(ms: number): string {
  const p = Object.fromEntries(SHANGHAI.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
export const day = (ms: number) => stamp(ms).slice(0, 10);

/**
 * The transcript of one chunk: `#n [time] sender（回复 #k）: text`, the pictures of message n labelled [图片 #n-1] …; `earlier` holds the
 * text of messages before the chunk, for replies to them, and `bot` the bot's own messages, which are not shown but may be replied to.
 */
export function renderChunk(entries: Entry[], earlier: Map<string, string>, bot: Set<string> = new Set()): string {
  const number = new Map(entries.map((e, i) => [e.id, i + 1]));
  return entries.map((entry, i) => {
    const n = i + 1;
    let reply = '';
    if (entry.reply) {
      const k = number.get(entry.reply);
      const before = earlier.get(entry.reply);
      reply = k && k < n ? `（回复 #${k}）` : before ? `（回复：「${clip(before.replace(/\s+/g, ' '), 40)}」）`
        : bot.has(entry.reply) ? '（回复机器人的消息）' : '（回复更早的消息）';
    }
    const pictures = entry.pictures.map((_, j) => ` [图片 #${n}-${j + 1}]`).join('');
    return `${entry.forwarded ? '    ↳ ' : ''}#${n} [${stamp(entry.at)}] ${entry.by}${entry.earlier ? '（之前的消息）' : ''}${reply}: ${entry.text}${pictures}`;
  }).join('\n');
}
