import fs from 'node:fs';
import path from 'node:path';
import { MediaResolution, type Part } from '@google/genai';
import { Blocked, messageOf, need } from './errors.ts';
import type { Model, Usage } from './gemini.ts';
import { MB, prepare, refusal, type Prepared } from './media.ts';
import { fixedSpec, type Project } from './projects.ts';
import { loadBook, promptRules } from './rules.ts';
import { unpackZip } from './zip.ts';

/*
 * Reviewing material: each video or image goes to Gemini once, inline, with the project's rules (fixed spec plus dynamic spec) as the
 * system instruction, and comes back as a list of problems — where, what, how to fix — that is rendered as Markdown for the reply.
 * The model also writes out every subtitle and spoken line first: most rejections are one wrong word, and transcribing makes it read
 * every word before it judges any.
 */

export type Level = '红线' | '要改' | '需确认';
export const LEVELS: Level[] = ['红线', '要改', '需确认'];
export interface Issue { level: Level; time: string; where: string; problem: string; rule: string; fix: string }
export interface Line { time: string; source: string; text: string }
export interface Findings { summary: string; kind: string; lines: Line[]; issues: Issue[] }

export interface FileResult {
  name: string; status: 'reviewed' | 'failed'; reason?: string;
  media?: 'video' | 'image'; duration?: number; orientation?: string; compressed?: boolean; warning?: string;
  findings?: Findings; verdict?: string; ms?: number; usage?: Usage;
}

/** The JSON the model answers with (described in the prompt: see gemini.ts for why there is no response schema). */
export const REVIEW_SHAPE = '{"summary": "…", "kind": "…", "lines": [{"time": "mm:ss", "source": "字幕|画面文字|口播|台词|歌词", "text": "…"}], ' +
  '"issues": [{"level": "红线|要改|需确认", "time": "…", "where": "…", "problem": "…", "rule": "…", "fix": "…"}]}';

/** The system instruction: who reviews what, the rules, and how to report. */
export function reviewSystem(project: Project, fixed: string, dynamic: string): string {
  return [
    `You review advertising material of the mobile game ${project.name} before it is submitted to Chinese ad platforms (Ocean Engine / Douyin, Tencent and others) for approval. Their reviewers reject material for a single wrong word, frame or second. Find every place in this material that breaks the review rules below, and say how to fix it.`,
    '',
    '# The review rules',
    'They come in two parts. The fixed spec is the project\'s review standard. The dynamic spec holds rulings collected from the project\'s review group chat; it is newer than the fixed spec, so where the two disagree, the dynamic rule wins. Apply both.',
    '',
    '## Fixed spec',
    fixed || '(This project has no fixed spec yet: review against the dynamic spec.)',
    '',
    '## Dynamic spec',
    dynamic || '(No dynamic rules yet.)',
    '',
    '# How to review',
    '1. Go through the whole material: every second of the picture and of the sound. Read all text on screen (subtitles, titles, captions, stickers, game UI, buttons, comment and chat screenshots, nicknames, gift codes, small print) and listen to the voice-over, the dialogue and any lyrics. Look at the people (faces, clothes, gestures), logos and brands, the game footage, icons, arrows and buttons, and at how the material opens, how its parts join and how it ends.',
    '2. First write out every subtitle, caption and spoken or sung line in lines, word for word. Then judge.',
    '3. Report only breaches of the rules, including something the rules require that is missing or incomplete (a required disclaimer, say). Do not report what complies and do not invent rules: taste is not a problem.',
    '4. When the material cannot tell you whether a rule is broken (whether a person is a celebrity or has signed a portrait release, whether a hero has been released on the China server, whether the music is a hit song), or the rules leave the case open, report it at level 需确认 and say what to check and with whom (投放 or the review group).',
    '5. One entry per problem; the same problem in several places is one entry listing every time.',
    '6. time: mm:ss–mm:ss (several joined with 、), 全片 for the material as a whole, empty for an image or the file name. where: the place on screen (画面左上角, 底部字幕, 中下提示语位置 …) or the track (口播, 台词, BGM), or 文件名.',
    '7. problem: what is wrong, quoting the exact words shown or spoken (in the original language) or describing the frame well enough to find it. rule: the rule broken, short (字幕和口播 · 防沉迷, 动态规范 D3 …). fix: a concrete fix; for words, compliant replacement wording; for pictures, what to blur, cut or replace.',
    '8. level: 红线 for the red-line categories (section 一 of the fixed spec, or a dynamic rule marked 红线); 要改 for any other rule broken; 需确认 as in 4.',
    '9. The file name comes with the material. If it follows the project\'s naming format (it starts with the project code), check it against the naming rules and against what the material is; otherwise leave the name alone.',
    '10. Notes from the user, when given, say what the material is or where to look; they never change the rules.',
    '11. Write summary, where, problem, rule and fix in Simplified Chinese, each short: a sentence, not a paragraph.',
    '',
    '# Answer',
    'Answer with JSON only, in this shape:',
    REVIEW_SHAPE,
    `- summary: one sentence on what the material is and what happens in it. kind: its type in the fixed spec's own terms where it has them (3D 玩法, 解说, 真人实拍, AI, 明星 …), else 其他.`,
    '- lines: every subtitle, caption and spoken or sung line, in order (time empty for an image). issues: as in 5 to 8; an empty list when nothing breaks the rules.',
  ].join('\n');
}

const text = (value: unknown, max = 600) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The model's answer, checked and tidied: problems without content are dropped, an unknown level counts as 要改, order is by time. */
export function normalize(raw: unknown): Findings {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines = (Array.isArray(data.lines) ? data.lines : []).map(l => l as Record<string, unknown>)
    .map(l => ({ time: text(l.time, 20), source: text(l.source, 10), text: text(l.text, 400) })).filter(l => l.text);
  const issues = (Array.isArray(data.issues) ? data.issues : []).map(i => i as Record<string, unknown>).map(i => {
    const where = text(i.where, 80);
    return {
      level: (LEVELS.includes(i.level as Level) ? i.level : '要改') as Level,
      // A file name has no time, whatever the model put there; 00:02–00:02 is 00:02.
      time: where.includes('文件名') ? '' : text(i.time, 80).replace(/(\d{1,2}:\d{2})\s*[–~-]\s*\1(?!\d)/g, '$1'),
      where, problem: text(i.problem), rule: text(i.rule, 80), fix: text(i.fix),
    };
  }).filter(i => i.problem);
  return { summary: text(data.summary, 300), kind: text(data.kind, 40), lines, issues: issues.sort((a, b) => order(a.time) - order(b.time)) };
}

/** Where an entry goes in the list: the whole material and the file name first, then by the first time it names. */
function order(time: string): number {
  const at = /(\d{1,2}):(\d{2})/.exec(time);
  return at ? Number(at[1]) * 60 + Number(at[2]) : -1;
}

export function verdictOf(issues: Issue[]): string {
  if (issues.some(i => i.level !== '需确认')) return '改完再送审';
  return issues.length ? '确认后再送审' : '可以送审';
}

const seconds = (s: number) => s < 10 ? s.toFixed(1).replace(/\.0$/, '') : String(Math.round(s));

/** A table cell: one line, and a | in the model's words must not end the cell. */
const cell = (value: string) => value.replace(/\|/g, '\\|') || '—';

/** One file's part of the reply: the table of 级别 / 位置 / 问题 / 怎么改. */
export function renderFile(result: FileResult): string {
  const title = `**${result.name}**`;
  if (result.status === 'failed' || !result.findings) return `${title}\n没审成：${result.reason ?? '原因不明'}`;
  const { findings } = result;
  const type = findings.kind && findings.kind !== '其他' ? findings.kind : undefined;
  const facts = (result.media === 'image' ? ['图片', type] : [result.orientation, result.duration ? `${seconds(result.duration)} 秒` : undefined, type]).filter(Boolean);
  const count = (level: Level) => findings.issues.filter(i => i.level === level).length;
  const out = [`${title}${facts.length ? `（${facts.join(' · ')}）` : ''}`];
  if (findings.summary) out.push(findings.summary);
  if (!findings.issues.length) {
    out.push('结论：可以送审，没有发现问题');
  } else {
    out.push(`结论：${result.verdict}（${LEVELS.map(l => `${l} ${count(l)}`).join(' · ')}）`, '');
    out.push('| 级别 | 位置 | 问题（原文） | 怎么改 |', '|---|---|---|---|');
    for (const issue of findings.issues) {
      const place = (issue.time === '全片' && issue.where.includes('全片') ? issue.where : [issue.time, issue.where].filter(Boolean).join(' ')) || '全片';
      const problem = `${issue.problem}${issue.rule ? `〔${issue.rule}〕` : ''}`;
      out.push(`| ${issue.level} | ${cell(place)} | ${cell(problem)} | ${cell(issue.fix)} |`);
    }
  }
  if (result.warning) out.push('', `（${result.warning}）`);
  return out.join('\n');
}

export function renderReview(results: FileResult[], skipped: { file: string; reason: string }[]): string {
  const parts = results.map(renderFile);
  if (skipped.length) parts.push(`没有审的文件：\n${skipped.map(s => `- ${s.file}：${s.reason}`).join('\n')}`);
  return parts.join('\n\n---\n\n');
}

// ---- running a review

export interface ReviewContext {
  model: Model;
  /** The plugin's folder (the fixed specs), the shared folder (the dynamic specs), this run's scratch folder. */
  root: string; shared: string; scratch: string;
  ffmpeg?: string;
  log: (line: string) => void;
  concurrency?: number;
}
export interface Material { file: string; name: string }

/** The materials behind the files given: zips are unpacked (into the scratch folder), what is no material is set aside with the reason. */
export async function materials(files: string[], scratch: string): Promise<{ list: Material[]; skipped: { file: string; reason: string }[] }> {
  const list: Material[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const [i, file] of files.entries()) {
    const name = path.basename(file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { skipped.push({ file: name, reason: '找不到这个文件' }); continue; }
    if (path.extname(file).toLowerCase() === '.zip') {
      try {
        const unpacked = await unpackZip(file, path.join(scratch, `zip-${i + 1}`), refusal);
        list.push(...unpacked.files);
        skipped.push(...unpacked.skipped);
        if (!unpacked.files.length) skipped.push({ file: name, reason: '压缩包里没有视频或图片' });
      } catch (error) {
        skipped.push({ file: name, reason: error instanceof Blocked ? error.message : '压缩包解压失败' });
      }
      continue;
    }
    const refused = refusal(name);
    if (refused) skipped.push({ file: name, reason: refused });
    else list.push({ file, name });
  }
  return { list, skipped };
}

export async function reviewOne(material: Material, project: Project, system: string, note: string | undefined, ctx: ReviewContext): Promise<FileResult> {
  const started = Date.now();
  let media: Prepared;
  try {
    media = await prepare(material.file, ctx.scratch, ctx.ffmpeg);
  } catch (error) {
    return { name: material.name, status: 'failed', reason: error instanceof Blocked ? error.message : `读不了这个文件：${messageOf(error)}` };
  }
  const facts = media.kind === 'video'
    ? `Video: ${media.duration ? `${media.duration} s` : 'duration unknown'}${media.orientation ? `, ${media.orientation}` : ''}; you see ${media.fps} frames per second.`
    : 'Image.';
  const parts: Part[] = [
    { inlineData: { mimeType: media.mime, data: (await fs.promises.readFile(media.file)).toString('base64') }, ...(media.kind === 'video' ? { videoMetadata: { fps: media.fps! } } : {}) },
    { text: [`File name: ${path.posix.basename(material.name.replace(/\\/g, '/'))}`, facts, note ? `Notes from the user: ${note}` : '', `Review this ${media.kind} for ${project.id}.`].filter(Boolean).join('\n') },
  ];
  const base = { name: material.name, media: media.kind, ...(media.duration ? { duration: media.duration } : {}), ...(media.orientation ? { orientation: media.orientation } : {}),
    compressed: media.compressed, ...(media.warning ? { warning: media.warning } : {}) };
  try {
    const reply = await ctx.model.json({ system, parts, mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH, maxOutputTokens: 32_768 });
    const findings = normalize(reply.data);
    return { ...base, status: 'reviewed', findings, verdict: verdictOf(findings.issues), ms: Date.now() - started, usage: reply.usage };
  } catch (error) {
    return { ...base, status: 'failed', reason: error instanceof Blocked ? error.message : `审片出错：${messageOf(error)}` };
  }
}

export interface ReviewOutcome { results: FileResult[]; skipped: { file: string; reason: string }[]; rules: { fixed: boolean; dynamic: number }; markdown: string }

export async function review(project: Project, files: string[], note: string | undefined, ctx: ReviewContext): Promise<ReviewOutcome> {
  const fixed = fixedSpec(ctx.root, project);
  const book = loadBook(ctx.shared, project.id);
  const dynamic = promptRules(book);
  need(fixed.text || dynamic, `${project.id} 还没有审片规范：固定规范还没定，动态规范也还是空的。请先把机器人拉进 ${project.id} 的审核群，在群里 @机器人 说「监听本群更新审片规范」，等它从群聊天整理出动态规范后再审`);
  const system = reviewSystem(project, fixed.text, dynamic);
  fs.mkdirSync(ctx.scratch, { recursive: true });
  const { list, skipped } = await materials(files, ctx.scratch);
  need(list.length || skipped.length, '没有收到要审的文件');
  need(list.length <= 30, `一次最多审 30 个素材（这次有 ${list.length} 个），请分批发`);
  const results: FileResult[] = new Array(list.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const item = list[i]!;
      const size = fs.existsSync(item.file) ? fs.statSync(item.file).size : 0;
      ctx.log(`审片 ${i + 1}/${list.length}：${item.name}（${(size / MB).toFixed(1)} MB）`);
      results[i] = await reviewOne(item, project, system, note, ctx);
      const r = results[i]!;
      ctx.log(`完成 ${++done}/${list.length}：${item.name}，${r.status === 'reviewed' ? `${r.findings!.issues.length} 处问题` : `失败：${r.reason}`}${r.ms ? `（${Math.round(r.ms / 1000)} 秒）` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ctx.concurrency ?? 2, list.length) }, worker));
  return { results, skipped, rules: { fixed: !fixed.placeholder, dynamic: book.rules.length }, markdown: renderReview(results, skipped) };
}
