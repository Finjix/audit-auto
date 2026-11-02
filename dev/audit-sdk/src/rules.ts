import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Turn } from './config.ts';
import { Blocked, need } from './errors.ts';
import { GatewayDown, type Model } from './gemini.ts';
import { explainLark, type FeishuMessage, type Lark } from './lark.ts';
import { fixedSpec, projectOf, PROJECTS, type Project } from './projects.ts';
import { chunks, day, entriesOf, entryOf, renderChunk, stamp, type Entry, type EntryContext } from './transcript.ts';

/*
 * The dynamic spec: review rules that come out of a project's review groups. Someone @-mentions the bot in a group with
 * 「监听本群更新审片规范」 (watch); from then on the group's messages are read (the history once, then every hour what is new, see
 * lark-agent.json) and Gemini turns the rulings in them into changes of the project's dynamic spec: add, update or remove a rule. Each
 * rule keeps the messages it rests on. The reviews of the project apply it together with the fixed spec.
 *
 * Kept in the shared folder (<LARK_AGENT_SHARED_DIR>/audit-auto), the same for every user:
 *   groups.json      the groups listened to: project, from when, how far they have been read
 *   rules/<P>.json   the dynamic spec of project P, and rules/<P>.md, the same for people
 *   names.json       members' display names, looked up once
 *   lock             one writer at a time (a user's watch and the hourly sync)
 */

/** The parts of a spec a rule belongs to: the sections of the fixed specs. */
export const CATEGORIES = ['红线', '字幕和口播', '画面和界面', '和游戏对得上', '按素材类型', '命名', '成片质量', '其他'];
const TYPES = /素材类型|3D|玩法|解说|迭代|真人|实拍|AI|明星|KOL/i;
const DAY = 24 * 60 * 60_000;
/** How far back the first reading of a group goes unless the user says. */
export const HISTORY_DAYS = 180;
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const PICTURE_MAX = 8 * 1024 * 1024;
/** Pictures one model call carries at most, in bytes (the request goes inline). */
const PICTURES_BYTES = 16 * 1024 * 1024;
/** A thread (topic) is read for new replies until it has had none for this long. */
const THREAD_DAYS = 14;
/** Messages from before a reading that its replies point to, looked up at most per reading. */
const PARENTS_MAX = 50;
/** Readings in a row the model may fail on the same chunk before the chunk is skipped. */
const STUCK_TRIES = 3;

export interface Source { chat: string; message: string; at: number; by?: string }
export interface Rule { id: string; category: string; rule: string; fix?: string; example?: string; sources: Source[]; created: number; updated: number }
export interface Removed extends Rule { removed: number; reason: string; by: 'chat' | 'user' }
export interface Book { version: 1; project: string; next: number; rules: Rule[]; removed: Removed[]; updated: number }
export interface Group {
  chat: string; project: string;
  /** Messages before this are not read. */
  since: number;
  /** The time of the newest message read, and the ids of the messages at exactly that time (Feishu's time filter is in seconds). */
  cursor: number; cursorIds: string[];
  watchedBy?: string; watchedAt: number; lastSync?: number; lastError?: string;
  /** Messages read so far. */
  read: number;
  /** A reading that stopped at its limit: the rest is read at the next sync. */
  pending?: boolean;
  /**
   * Threads (topics) read for new replies, with the time of the newest reply read in each: Feishu lists a thread's replies only in the
   * thread, not in the chat. A thread is followed from its first message until THREAD_DAYS without a reply.
   */
  threads?: Record<string, number>;
  /** A chunk the model keeps failing on (a picture it refuses, say): where the reading stands and how many readings failed there. */
  stuck?: { cursor: number; tries: number; reason: string };
  /** Chunks skipped after STUCK_TRIES failed readings, so that the group goes on being read (the newest 20). */
  skipped?: { from: string; to: string; reason: string }[];
}
interface Groups { version: 1; groups: Group[] }

// ---- files

const bookFile = (shared: string, project: string) => path.join(shared, 'rules', `${project}.json`);
const groupsFile = (shared: string) => path.join(shared, 'groups.json');
const namesFile = (shared: string) => path.join(shared, 'names.json');

function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T; } catch {
    throw new Blocked(`动态规范的数据文件坏了（${path.basename(file)}），请联系管理员`);
  }
}

/** Written whole or not at all: a reader never sees half a file. */
function writeAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}

export function loadBook(shared: string, project: string): Book {
  return readJson<Book>(bookFile(shared, project), { version: 1, project, next: 1, rules: [], removed: [], updated: 0 });
}
export function saveBook(shared: string, book: Book) {
  writeAtomic(bookFile(shared, book.project), `${JSON.stringify(book, null, 2)}\n`);
  writeAtomic(bookFile(shared, book.project).replace(/\.json$/, '.md'), renderBook(book));
}
const loadGroups = (shared: string) => readJson<Groups>(groupsFile(shared), { version: 1, groups: [] });
const saveGroups = (shared: string, groups: Groups) => writeAtomic(groupsFile(shared), `${JSON.stringify(groups, null, 2)}\n`);

/** Busy: another process is changing the dynamic spec. */
export class Busy extends Blocked {}

/** The lock's content when its holder died or went silent (no heartbeat for 10 minutes), else nothing. */
function staleLock(file: string): string | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try {
    const { pid, at } = JSON.parse(text) as { pid: number; at: number };
    if (Date.now() - at > 10 * 60_000) return text;
    try { process.kill(pid, 0); return undefined; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? text : undefined; }
  } catch {
    // Being written this very moment, or left empty by a process that died before writing it.
    try { return Date.now() - fs.statSync(file).mtimeMs > 30_000 ? text : undefined; } catch { return undefined; }
  }
}

/**
 * Moves a dead holder's lock out of the way. Of several waiters that found it stale only one moves it; one that moved a lock another
 * waiter had just taken (not the stale one it saw) puts it back.
 */
function takeOver(file: string, seen: string) {
  const aside = `${file}.${randomUUID()}.stale`;
  try { fs.renameSync(file, aside); } catch { return; }
  let moved = '';
  try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* unreadable: treated as not the one seen */ }
  if (moved !== seen) { try { fs.linkSync(aside, file); } catch { /* a lock is there again */ } }
  fs.rmSync(aside, { force: true });
}

/** Runs `fn` as the only writer of the shared folder, waiting up to `waitMs` for another; a holder that died or went silent is ignored. */
export async function withLock<T>(shared: string, fn: () => Promise<T>, waitMs = 5 * 60_000): Promise<T> {
  const file = path.join(shared, 'lock');
  fs.mkdirSync(shared, { recursive: true });
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  const mine = () => JSON.stringify({ pid: process.pid, token, at: Date.now() });
  const ours = () => { try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string }).token === token; } catch { return false; } };
  for (;;) {
    try { fs.writeFileSync(file, mine(), { flag: 'wx' }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = staleLock(file);
      if (stale !== undefined) { takeOver(file, stale); continue; }
      if (Date.now() >= deadline) throw new Busy('动态规范正在更新（另一个任务正在读群消息），过几分钟再试');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  // The heartbeat and the release touch the lock only while it is still this run's.
  const beat = setInterval(() => { if (ours()) { try { fs.writeFileSync(file, mine()); } catch { /* the next beat tries again */ } } }, 60_000);
  beat.unref();
  try { return await fn(); } finally {
    clearInterval(beat);
    if (ours()) fs.rmSync(file, { force: true });
  }
}

// ---- the spec as text

const sourcesText = (sources: Source[]) => {
  const named = [...new Set(sources.map(s => `${day(s.at)}${s.by ? ` ${s.by}` : ''}`))];
  return named.length > 3 ? `${named.slice(-3).join('、')} 等 ${sources.length} 条消息` : named.join('、');
};

/** The dynamic spec for the model: one line a rule, with its id (the review cites it, the next sync changes it by it). */
export function promptRules(book: Book): string {
  return book.rules.map(r => `- ${r.id}〔${r.category}〕${r.rule}${r.fix ? ` 怎么改：${r.fix}` : ''}${r.example ? ` 例：${r.example}` : ''}（${day(r.updated)}）`).join('\n');
}

/** The dynamic spec for people. */
export function renderBook(book: Book): string {
  const lines = [
    `# ${book.project} 动态审片规范`, '',
    '从审核群的聊天记录自动整理：机器人每小时读一次群里的新消息，有新的审核结论就更新这里。审片时和固定规范一起用；说法和固定规范不一样的，以这里为准（这里更新）。', '',
    `更新于 ${book.updated ? stamp(book.updated) : '—'} · 共 ${book.rules.length} 条`,
  ];
  if (!book.rules.length) lines.push('', '（还没有整理出规范）');
  for (const category of CATEGORIES) {
    const rules = book.rules.filter(r => (CATEGORIES.includes(r.category) ? r.category : '其他') === category);
    if (!rules.length) continue;
    lines.push('', `## ${category}`);
    for (const r of rules) {
      lines.push('', `**${r.id}** ${r.rule}`);
      if (r.fix) lines.push(`- 怎么改：${r.fix}`);
      if (r.example) lines.push(`- 例：${r.example}`);
      lines.push(`- 依据：${sourcesText(r.sources)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---- turning messages into changes

export interface Operation { op: 'add' | 'update' | 'remove'; id?: string; category?: string; rule?: string; fix?: string; example?: string; reason?: string; messages: number[] }
export interface Changes { added: string[]; updated: string[]; removed: string[] }

/** The JSON the model answers with (described in the prompt: see gemini.ts for why there is no response schema). */
export const DISTILL_SHAPE = '{"operations": [{"op": "add|update|remove", "id": "D<n>", "category": "…", "rule": "…", "fix": "…", "example": "…", "reason": "…", "messages": [1, 2]}]}';

export function distillSystem(project: Project, fixed: string, current: string, today: string): string {
  return [
    `You keep the dynamic review spec of the mobile game ${project.name}: rules for its advertising material that come out of its review group's chat, on top of its fixed spec (the review standard). Read the new messages from the group and say how the dynamic spec changes. Today is ${today} (China time).`,
    '',
    '# What counts as a rule',
    `A rule says what the project's ad material may or may not contain, or how it has to be made, to pass review: a platform's rejection and its reason, a reviewer's ruling ("X 不能用", "Y 可以用了", "Z 要写成 W"), a new requirement, a correction or withdrawal of an earlier rule, a number or wording made precise. Leave out everything else: chatter, thanks, scheduling, who does what, where files are uploaded or delivered, questions nobody answered, and decisions about one particular material that set no rule for others.`,
    `Weigh the messages: a platform's rejection or the ruling of whoever reviews counts; a guess or a question does not, until someone answers it. A reply belongs to the message it answers: a question and its answer make one ruling. Pictures (attached after the transcript, labelled with their message number) count as messages: a screenshot of a rejection notice gives its reason.`,
    '',
    '# Operations',
    'Go through the messages in order and give one operation for every ruling in them; several rulings in one message are several operations.',
    '- add: a rule the dynamic spec does not have yet. When the fixed spec already says exactly the same, add nothing; when the chat goes further (stricter or looser, a word or picture the fixed spec does not list, a new replacement wording, a fresh rejection that shows how the rule is applied), add it and say in the rule which fixed rule it extends.',
    '- update: the chat changes or sharpens a rule of the dynamic spec: give its id and the whole rule as it now stands.',
    '- remove: the chat withdraws a rule of the dynamic spec, or a newer one replaces it: give its id and why.',
    `A rule is one sentence in Simplified Chinese, concrete enough to check a material against: what is not allowed or what is required, with the exact words or the kind of picture (keep the chat's own wording for forbidden words). Put what to do instead in fix and an example from the chat in example, not in the rule; keep each of them short. When something takes effect from a date, say so. Start a rule with 【红线】 when the chat treats it as a red line (account penalties, legal or public-opinion risk). Every operation lists the numbers (#n) of the messages it rests on.`,
    'Most messages change nothing; when none of these do, return no operations.',
    '',
    '# Answer',
    'Answer with JSON only, in this shape:',
    DISTILL_SHAPE,
    `- id: for update and remove, the id of a rule in the dynamic spec below. A rule added in this same answer and then changed again by a later message needs no update: add it as it finally stands.`,
    `- category: one of ${CATEGORIES.join(', ')} (the sections of the spec).`,
    '- Leave out the fields an operation does not need.',
    '',
    '# Fixed spec',
    fixed || '(none yet)',
    '',
    '# Dynamic spec now',
    current || '(empty)',
  ].join('\n');
}

const clean = (value: unknown, max = 500) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const squash = (value: string) => value.replace(/[\s，。、；：！？,.;:!?「」“”"'（）()【】]/g, '');

/** The operations in the model's answer: {"operations": [...]}, or the bare list (JSON mode does not hold the model to the shape). */
export function operationsOf(data: unknown): Operation[] {
  const list = Array.isArray(data) ? data : (data as { operations?: unknown })?.operations;
  return (Array.isArray(list) ? list : []).filter(o => o && typeof o === 'object').map(o => o as Record<string, unknown>)
    .filter(o => o.op === 'add' || o.op === 'update' || o.op === 'remove')
    .map(o => ({
      op: o.op as Operation['op'], ...(typeof o.id === 'string' ? { id: o.id.trim().toUpperCase() } : {}),
      ...(['category', 'rule', 'fix', 'example', 'reason'] as const).reduce((acc, key) => clean(o[key]) ? { ...acc, [key]: clean(o[key]) } : acc, {}),
      // A number as the model may write it: 3, "3", "#3", or a picture label "3-1".
      messages: (Array.isArray(o.messages) ? o.messages : []).map(m => Number(/\d+/.exec(String(m))?.[0])).filter(Number.isInteger),
    }));
}

const merge = (a: Source[], b: Source[]) => [...a, ...b.filter(s => !a.some(x => x.message === s.message))].slice(-10);
/** A category as the spec names it; the material types (真人实拍, AI 类 …) are 按素材类型. */
export function categoryOf(value: string | undefined): string {
  if (!value) return '其他';
  const found = CATEGORIES.find(c => value.includes(c));
  return found ?? (TYPES.test(value) ? '按素材类型' : /字幕|口播|文案/.test(value) ? '字幕和口播' : /画面|界面|UI/i.test(value) ? '画面和界面' : '其他');
}

/** Applies the model's operations to the spec. One that names no message of this chunk, or a rule that does not exist, is not taken. */
export function apply(book: Book, operations: Operation[], refs: Map<number, Source>, now: number): Changes {
  const changes: Changes = { added: [], updated: [], removed: [] };
  // An answer may give a rule it adds an id of its own and change it further down: that id stands for the rule's real one.
  const given = new Map<string, string>();
  const idOf = (id: string | undefined) => id ? given.get(id) ?? id : undefined;
  for (const op of operations) {
    const sources = [...new Set(op.messages)].map(n => refs.get(n)).filter((s): s is Source => !!s);
    if (!sources.length) continue;
    if (op.op === 'add') {
      if (!op.rule) continue;
      const same = book.rules.find(r => squash(r.rule) === squash(op.rule!));
      if (same) {
        same.sources = merge(same.sources, sources);
        same.updated = now;
        if (!changes.updated.includes(same.id) && !changes.added.includes(same.id)) changes.updated.push(same.id);
        if (op.id) given.set(op.id, same.id);
        continue;
      }
      const rule: Rule = { id: `D${book.next++}`, category: categoryOf(op.category), rule: op.rule, ...(op.fix ? { fix: op.fix } : {}),
        ...(op.example ? { example: op.example } : {}), sources, created: now, updated: now };
      if (op.id && !book.rules.some(r => r.id === op.id)) given.set(op.id, rule.id);
      book.rules.push(rule);
      changes.added.push(rule.id);
    } else if (op.op === 'update') {
      const target = book.rules.find(r => r.id === idOf(op.id));
      if (!target) continue;
      if (op.rule) target.rule = op.rule;
      if (op.category) target.category = categoryOf(op.category);
      if (op.fix) target.fix = op.fix;
      if (op.example) target.example = op.example;
      target.sources = merge(target.sources, sources);
      target.updated = now;
      if (!changes.updated.includes(target.id) && !changes.added.includes(target.id)) changes.updated.push(target.id);
    } else {
      const at = book.rules.findIndex(r => r.id === idOf(op.id));
      if (at < 0) continue;
      const [gone] = book.rules.splice(at, 1);
      book.removed.push({ ...gone!, sources: merge(gone!.sources, sources), removed: now, reason: op.reason || '群里撤回或被新规则取代', by: 'chat' });
      changes.removed.push(gone!.id);
    }
  }
  book.removed = book.removed.slice(-200);
  if (changes.added.length || changes.updated.length || changes.removed.length) book.updated = now;
  return changes;
}

// ---- reading a group

export interface RulesContext {
  lark: Lark; model: Model;
  /** The plugin's folder (fixed specs) and the shared folder. */
  root: string; shared: string;
  log: (line: string) => void;
  now?: () => number;
  /** How many model calls one sync of one group makes at most; the rest waits for the next sync. */
  maxChunks?: number;
  /** No model call is started after this moment (the job is ended after 30 minutes; a user waits for a watch): the rest waits. */
  deadline?: number;
}

export interface GroupSync extends Changes { chat: string; project: string; read: number; considered: number; pending: boolean; error?: string }

const time = (m: FeishuMessage) => Number(m.create_time);
const fromUser = (m: FeishuMessage) => m.sender?.sender_type === 'user' && m.sender.id ? m.sender.id : undefined;

/** The entries with, before the first reply to each, the earlier message it answers (looked up because it was read before). */
function withParents(entries: Entry[], parents: Map<string, FeishuMessage>, ctx: EntryContext): Entry[] {
  const out: Entry[] = [];
  const shown = new Set<string>();
  for (const entry of entries) {
    const parent = entry.reply ? parents.get(entry.reply) : undefined;
    if (parent && !shown.has(parent.message_id)) {
      shown.add(parent.message_id);
      const earlier = entryOf(parent, ctx);
      if (earlier) out.push({ ...earlier, earlier: true });
    }
    out.push(entry);
  }
  return out;
}

/**
 * Reads what is new in a group (its chat, and the threads it follows) and applies it to its project's dynamic spec, chunk by chunk;
 * after each chunk the spec and the group's progress are saved (`persist`), so a failure loses nothing that was done. Never throws: a
 * failure is the result's `error`.
 */
export async function syncGroup(group: Group, ctx: RulesContext, persist: () => void): Promise<GroupSync> {
  const now = ctx.now?.() ?? Date.now();
  const result: GroupSync = { chat: group.chat, project: group.project, read: 0, considered: 0, added: [], updated: [], removed: [], pending: false };
  const names = readJson<Record<string, string>>(namesFile(ctx.shared), {});
  const raw: FeishuMessage[] = [];
  // The messages read that the group's progress has moved past (what a stopped or failed reading did not finish is read again).
  let covered = 0;
  const threads = group.threads ??= {};
  try {
    const project = projectOf(group.project);
    const from = Math.max(group.since, group.cursor);
    const already = (m: FeishuMessage) => time(m) === group.cursor && group.cursorIds.includes(m.message_id);
    for await (const message of ctx.lark.history(group.chat, Math.floor(from / 1000), Math.ceil(now / 1000))) {
      if (time(message) >= from && !already(message)) raw.push(message);
    }
    // Thread replies are listed only in their thread: every thread followed is asked for what came after the newest reply read in it.
    for (const message of raw) if (message.thread_id && !(message.thread_id in threads)) threads[message.thread_id] = time(message);
    const seen = new Set(raw.map(m => m.message_id));
    const unread = new Set<string>();
    for (const [thread, newest] of Object.entries(threads)) {
      try {
        for (const message of await ctx.lark.thread(thread)) {
          if (time(message) > newest && time(message) <= now && !seen.has(message.message_id)) { seen.add(message.message_id); raw.push(message); }
        }
      } catch (error) {
        // Not read: it stays where it was and is asked again next time.
        unread.add(thread);
        ctx.log(`话题读取失败，下次再读：${explainLark(error)}`);
      }
    }
    raw.sort((a, b) => time(a) - time(b));
    if (!raw.length) return result;

    const carried = new Map<string, FeishuMessage[]>();
    for (const message of raw.filter(m => m.msg_type === 'merge_forward')) {
      try { carried.set(message.message_id, await ctx.lark.message(message.message_id)); } catch { /* shown as a forward without its content */ }
    }
    // A reply to a message from an earlier reading needs that message to make sense (「以后这种都不行」).
    const parents = new Map<string, FeishuMessage>();
    for (const id of [...new Set(raw.map(m => m.parent_id).filter((p): p is string => !!p && !seen.has(p)))].slice(0, PARENTS_MAX)) {
      try {
        const parent = (await ctx.lark.message(id)).find(m => m.message_id === id);
        if (parent) parents.set(id, parent);
      } catch { /* shown as a reply to an earlier message */ }
    }
    const people = new Set([...raw, ...[...carried.values()].flat(), ...parents.values()].map(fromUser).filter((id): id is string => !!id));
    for (const id of people) {
      // A name that cannot be looked up now (no permission yet, say) is asked again next time.
      if (!names[id]) {
        const name = await ctx.lark.userName(id);
        if (name) names[id] = name;
      }
    }
    const entryContext: EntryContext = { appId: ctx.lark.appId, name: id => names[id] || `成员${id.slice(-4)}`, forwarded: carried };
    const bot = new Set([...parents.values()].filter(m => m.sender?.sender_type === 'app' && m.sender.id === ctx.lark.appId).map(m => m.message_id));
    const entries = withParents(entriesOf(raw, entryContext), parents, entryContext);
    result.considered = entries.filter(e => !e.earlier).length;

    const all = chunks(entries);
    const limit = ctx.maxChunks ?? 40;
    const fixed = fixedSpec(ctx.root, project).text;
    const book = loadBook(ctx.shared, project.id);
    const earlier = new Map<string, string>();
    const ask = async (part: Entry[], pictures: boolean) => {
      const fresh = part.filter(e => !e.earlier).length;
      const head = `New messages from the review group (${fresh})${fresh < part.length ? `, with ${part.length - fresh} earlier ones they reply to (marked 之前的消息)` : ''}`;
      const parts: Part[] = [{ text: `${head}:\n\n${renderChunk(part, earlier, bot)}` }];
      let bytes = 0;
      for (const [i, entry] of part.entries()) {
        for (const [j, key] of (pictures ? entry.pictures : []).entries()) {
          const picture = await ctx.lark.picture(entry.id, key);
          if (!picture || !PICTURE_TYPES.has(picture.mime) || picture.data.length > PICTURE_MAX || bytes + picture.data.length > PICTURES_BYTES) continue;
          bytes += picture.data.length;
          parts.push({ text: `[图片 #${i + 1}-${j + 1}]` }, { inlineData: { mimeType: picture.mime, data: picture.data.toString('base64') } });
        }
      }
      return ctx.model.json({ system: distillSystem(project, fixed, promptRules(book), day(now)), parts, maxOutputTokens: 16_384 });
    };
    const done = (part: Entry[]) => {
      const fresh = part.filter(e => !e.earlier);
      advance(group, fresh);
      for (const entry of fresh) if (entry.thread && !unread.has(entry.thread)) threads[entry.thread] = Math.max(threads[entry.thread] ?? 0, entry.at);
      covered = raw.filter(m => time(m) <= group.cursor).length;
      for (const entry of part) earlier.set(entry.id, entry.text);
      persist();
    };
    let calls = 0;
    for (const [k, part] of all.entries()) {
      if (calls >= limit || (ctx.deadline !== undefined && Date.now() > ctx.deadline)) { result.pending = true; break; }
      calls++;
      if (all.length > 1) ctx.log(`整理 ${project.id} 动态规范：第 ${k + 1}/${all.length} 段（${part.length} 条消息）`);
      let reply;
      try {
        reply = await ask(part, true);
      } catch (error) {
        // A gateway that is down, busy or silent is tried again next time, as it is. Anything else may be this chunk itself: once more
        // without its pictures, and a chunk that fails reading after reading is skipped, so that the group does not stop for good.
        if (!(error instanceof Blocked) || error instanceof GatewayDown) throw error;
        let last: Blocked = error;
        if (part.some(e => e.pictures.length)) {
          try { reply = await ask(part, false); } catch (again) {
            if (!(again instanceof Blocked) || again instanceof GatewayDown) throw again;
            last = again;
          }
        }
        if (!reply) {
          const tries = group.stuck?.cursor === group.cursor ? group.stuck.tries + 1 : 1;
          if (tries < STUCK_TRIES) { group.stuck = { cursor: group.cursor, tries, reason: last.message }; throw last; }
          group.skipped = [...(group.skipped ?? []), { from: stamp(part[0]!.at), to: stamp(part.at(-1)!.at), reason: last.message }].slice(-20);
          delete group.stuck;
          ctx.log(`有一段消息整理了 ${STUCK_TRIES} 次都失败，已跳过：${last.message}`);
          done(part);
          continue;
        }
      }
      delete group.stuck;
      const refs = new Map(part.map((e, i) => [i + 1, { chat: group.chat, message: e.id, at: e.at, by: e.by } satisfies Source]));
      const changes = apply(book, operationsOf(reply.data), refs, now);
      result.added.push(...changes.added);
      result.updated.push(...changes.updated.filter(id => !result.updated.includes(id)));
      result.removed.push(...changes.removed);
      saveBook(ctx.shared, book);
      done(part);
    }
    if (!result.pending) {
      // Everything read, including what was left out (the bot's own messages, stickers): the next sync starts after the newest.
      advance(group, raw.map(m => ({ id: m.message_id, at: time(m) })));
      for (const message of raw) if (message.thread_id && !unread.has(message.thread_id)) threads[message.thread_id] = Math.max(threads[message.thread_id] ?? 0, time(message));
      covered = raw.length;
    }
    group.pending = result.pending;
    return result;
  } catch (error) {
    result.error = error instanceof Blocked ? error.message : explainLark(error);
    return result;
  } finally {
    for (const [thread, newest] of Object.entries(threads)) if (newest < now - THREAD_DAYS * DAY) delete threads[thread];
    result.read = covered;
    group.read += covered;
    try { writeAtomic(namesFile(ctx.shared), `${JSON.stringify(names)}\n`); } catch { /* names are looked up again next time */ }
  }
}

function advance(group: Group, read: Pick<Entry, 'id' | 'at'>[]) {
  const newest = read.reduce((max, e) => Math.max(max, e.at), group.cursor);
  if (newest > group.cursor) group.cursorIds = [];
  group.cursorIds = [...new Set([...group.cursorIds, ...read.filter(e => e.at === newest).map(e => e.id)])];
  group.cursor = newest;
}

// ---- commands

const summary = (r: GroupSync) => ({ project: r.project, read: r.read, considered: r.considered, added: r.added.length, updated: r.updated.length,
  removed: r.removed.length, pending: r.pending, ...(r.error ? { error: r.error } : {}) });
/** How long a user's watch reads before answering (the rest is read by the hourly sync), and how long the hourly sync reads (the job is ended at 30). */
const WATCH_MINUTES = 15;
const SYNC_MINUTES = 20;

/** Starts listening to the turn's group for `project` (or reads it again from an earlier date), and reads its history right away. */
export async function watch(project: Project, since: number | undefined, turn: Turn, ctx: RulesContext): Promise<Record<string, unknown>> {
  need(turn.chat, '不知道这条消息来自哪个群：请在审核群里 @机器人 再说一次');
  need(turn.chatType !== 'p2p', '要在审核群里开始：把机器人拉进审核群，在群里 @机器人 说「监听本群更新审片规范」');
  need(turn.chatType === 'group', '看不出这里是不是群聊：请在审核群里 @机器人 再说一次');
  const now = ctx.now?.() ?? Date.now();
  const start = since ?? now - HISTORY_DAYS * DAY;
  need(start < now, '开始日期不能晚于今天');
  return withLock(ctx.shared, async () => {
    const groups = loadGroups(ctx.shared);
    let group = groups.groups.find(g => g.chat === turn.chat);
    need(!group || group.project === project.id, `本群已经在给 ${group?.project} 整理动态规范；要改成 ${project.id}，先说「停止监听本群」，再重新开始`);
    const before = !!group;
    if (!group) {
      group = { chat: turn.chat!, project: project.id, since: start, cursor: 0, cursorIds: [], ...(turn.user ? { watchedBy: turn.user } : {}), watchedAt: now, read: 0 };
      groups.groups.push(group);
    } else if (since !== undefined && start < group.since) {
      // An earlier start: read again from there (the model sees the rules it made already, and the same rule is not added twice).
      Object.assign(group, { since: start, cursor: 0, cursorIds: [] });
    }
    saveGroups(ctx.shared, groups);
    const synced = await syncGroup(group, { ...ctx, deadline: ctx.deadline ?? Date.now() + WATCH_MINUTES * 60_000 }, () => saveGroups(ctx.shared, groups));
    Object.assign(group, { lastSync: now, lastError: synced.error });
    if (!synced.error) delete group.lastError;
    saveGroups(ctx.shared, groups);
    return { status: 'watching', ...summary(synced), project: project.id, already: before, since: day(group.since), rules: loadBook(ctx.shared, project.id).rules.length };
  });
}

export async function unwatch(turn: Turn, ctx: Pick<RulesContext, 'shared'>): Promise<Record<string, unknown>> {
  need(turn.chat, '不知道这条消息来自哪个群：请在要停止的群里 @机器人 再说一次');
  return withLock(ctx.shared, async () => {
    const groups = loadGroups(ctx.shared);
    const at = groups.groups.findIndex(g => g.chat === turn.chat);
    need(at >= 0, '本群没有在监听');
    const [group] = groups.groups.splice(at, 1);
    saveGroups(ctx.shared, groups);
    return { status: 'stopped', project: group!.project, rules: loadBook(ctx.shared, group!.project).rules.length };
  });
}

/** Reads what is new in every group listened to (or in one), the hourly job. `waitMs` 0: give up at once when another holds the lock. */
export async function syncAll(ctx: RulesContext, options: { chat?: string; waitMs?: number } = {}): Promise<Record<string, unknown>> {
  return withLock(ctx.shared, async () => {
    const groups = loadGroups(ctx.shared);
    // The group read longest ago goes first: when time runs out, the others are first the next time.
    const targets = groups.groups.filter(g => !options.chat || g.chat === options.chat).sort((a, b) => (a.lastSync ?? 0) - (b.lastSync ?? 0));
    need(!options.chat || targets.length, '本群没有在监听：先 @机器人 说「监听本群更新审片规范」');
    const deadline = ctx.deadline ?? Date.now() + SYNC_MINUTES * 60_000;
    const results: Record<string, unknown>[] = [];
    for (const group of targets) {
      const synced = await syncGroup(group, { ...ctx, deadline }, () => saveGroups(ctx.shared, groups));
      group.lastSync = ctx.now?.() ?? Date.now();
      if (synced.error) group.lastError = synced.error; else delete group.lastError;
      saveGroups(ctx.shared, groups);
      results.push({ chat: group.chat, ...(group.chat === options.chat ? { here: true } : {}), ...summary(synced) });
    }
    // Every group failing is a failure (the host logs the job as failed); some failing is in their `error`.
    const failed = results.length > 0 && results.every(r => r.error);
    return { status: failed ? 'failed' : 'synced', groups: results, rules: Object.fromEntries(Object.keys(PROJECTS).map(p => [p, loadBook(ctx.shared, p).rules.length])) };
  }, options.waitMs ?? 0);
}

export function status(shared: string, turn: Turn): Record<string, unknown> {
  const groups = loadGroups(shared).groups;
  return {
    status: 'ok',
    here: turn.chat ? groups.find(g => g.chat === turn.chat)?.project ?? null : null,
    groups: groups.map(g => ({ chat: g.chat, ...(g.chat === turn.chat ? { here: true } : {}), project: g.project, since: day(g.since), watched: stamp(g.watchedAt),
      last_sync: g.lastSync ? stamp(g.lastSync) : null, read: g.read, pending: !!g.pending, ...(g.lastError ? { error: g.lastError } : {}),
      ...(g.skipped?.length ? { skipped: g.skipped } : {}) })),
    rules: Object.fromEntries(Object.keys(PROJECTS).map(p => [p, loadBook(shared, p).rules.length])),
  };
}

/** A free name next to `file`: report.md, report (2).md, … */
function freeName(file: string): string {
  const ext = path.extname(file), stem = file.slice(0, file.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? file : `${stem} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * The project's dynamic spec as Markdown: a file for the user (`output`, next to which a free name is taken when it exists), or, without
 * one, in the answer itself, for reading it without leaving a file in the workspace (the host sends new files there to the user).
 */
export function show(shared: string, project: Project, output?: string): Record<string, unknown> {
  const book = loadBook(shared, project.id);
  const facts = { project: project.id, rules: book.rules.length, updated: book.updated ? stamp(book.updated) : null };
  if (!output) return { status: 'ok', ...facts, markdown: renderBook(book) };
  const file = freeName(path.resolve(output));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderBook(book), { encoding: 'utf8', flag: 'wx' });
  return { status: 'saved', ...facts, file };
}

/** Takes rules out of the dynamic spec at a user's request (they stay on record, with who and when). */
export async function removeRules(project: Project, ids: string[], turn: Turn, ctx: Pick<RulesContext, 'shared' | 'now'>): Promise<Record<string, unknown>> {
  const wanted = [...new Set(ids.map(id => id.trim().toUpperCase()).filter(Boolean))];
  need(wanted.length, '要删哪几条？给出规范编号（如 D3）');
  return withLock(ctx.shared, async () => {
    const book = loadBook(ctx.shared, project.id);
    const missing = wanted.filter(id => !book.rules.some(r => r.id === id));
    need(!missing.length, `${project.id} 的动态规范里没有 ${missing.join('、')}`);
    const now = ctx.now?.() ?? Date.now();
    const removed = wanted.map(id => {
      const [gone] = book.rules.splice(book.rules.findIndex(r => r.id === id), 1);
      book.removed.push({ ...gone!, removed: now, reason: `用户删除${turn.user ? `（${turn.user}）` : ''}`, by: 'user' });
      return { id: gone!.id, rule: gone!.rule };
    });
    book.updated = now;
    saveBook(ctx.shared, book);
    return { status: 'removed', project: project.id, removed, rules: book.rules.length };
  });
}

