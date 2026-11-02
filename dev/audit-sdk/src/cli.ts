import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { feishuApp, gateway, pluginRoot, scratchRoot, sharedDir, turnOf } from './config.ts';
import { Blocked, messageOf, need, redact } from './errors.ts';
import { gatewayModel, type Model } from './gemini.ts';
import { botLark, explainLark, LarkError, type Lark } from './lark.ts';
import { findFfmpeg } from './media.ts';
import { fixedSpec, projectOf, PROJECTS } from './projects.ts';
import { review } from './review.ts';
import { Busy, loadBook, removeRules, show, status, syncAll, unwatch, watch, type RulesContext } from './rules.ts';

/*
 * audit.mjs, the plugin's one command line. Progress goes to stderr while it works; the result is one line of JSON on stdout, and the
 * exit code is 0, or 2 when it was refused ({"status":"blocked","reason":…}).
 *
 *   review --project GOF|GOT --file <path> [--file <path>]… [--note <text>]   review videos / images (zips are unpacked)
 *   rules watch --project GOF|GOT [--since YYYY-MM-DD]                         listen to this turn's group, reading its history now
 *   rules unwatch                                                              stop listening to this turn's group
 *   rules sync [--here]                                                        read what is new in every group (or this one); the hourly job
 *   rules status                                                               the groups listened to, rules per project
 *   rules show --project GOF|GOT [--output <file.md>]                          the dynamic spec as Markdown: a file for the user, or in the answer
 *   rules remove --project GOF|GOT --id D<n> [--id D<n>]…                      take rules out of the dynamic spec
 *   doctor | info                                                              is everything in place / what is configured
 */

type Result = Record<string, unknown>;
/** Whom a command serves (the environment the host gave), and the test seams. */
export interface Context {
  env: NodeJS.ProcessEnv;
  model?: Model; lark?: Lark; now?: () => number; log?: (line: string) => void;
  /** null: as if this computer had no ffmpeg. */
  ffmpeg?: string | null;
  home?: string;
}

function parse(args: string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>) {
  try { return parseArgs({ args, options, allowPositionals: false, strict: true }).values; } catch (error) { throw new Blocked(messageOf(error)); }
}

const version = (root: string) => {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')).version ?? ''); } catch { return ''; }
};
const modelOf = (ctx: Context) => ctx.model ?? gatewayModel(gateway(ctx.env, ctx.home));
const larkOf = (ctx: Context) => ctx.lark ?? botLark(feishuApp(ctx.env));
const logOf = (ctx: Context) => ctx.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
const home = (ctx: Context) => ctx.home ?? os.homedir();

function rulesContext(ctx: Context): RulesContext {
  return { lark: larkOf(ctx), model: modelOf(ctx), root: pluginRoot(ctx.env), shared: sharedDir(ctx.env, home(ctx)), log: logOf(ctx), ...(ctx.now ? { now: ctx.now } : {}) };
}

function sinceOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  need(/^\d{4}-\d{2}-\d{2}$/.test(text), '--since 要写成 YYYY-MM-DD，比如 2026-09-01');
  const at = Date.parse(`${text}T00:00:00+08:00`);
  need(Number.isFinite(at), `--since 不是有效的日期：${text}`);
  return at;
}

/** Where the results of a user's reviews are kept for follow-up questions (never the workspace); the newest 30 stay. */
function keepResult(ctx: Context, payload: Result, markdown: string): string | undefined {
  const user = ctx.env.LARK_AGENT_USER_DIR?.trim();
  const dir = user ? path.join(path.resolve(user), 'audit-auto', 'reviews') : path.join(home(ctx), '.audit-auto', 'reviews');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, `${name}.md`), markdown, 'utf8');
    const kept = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - 30))) for (const ext of ['.json', '.md']) fs.rmSync(path.join(dir, old.replace(/\.json$/, ext)), { force: true });
    return path.join(dir, `${name}.md`);
  } catch { return undefined; }
}

/** A scratch folder of this run, gone when it ends; ones left by runs that died are swept after a day. */
function scratchFolder(ctx: Context): string {
  const root = scratchRoot(ctx.env);
  fs.mkdirSync(root, { recursive: true });
  for (const old of fs.readdirSync(root)) {
    const at = path.join(root, old);
    try { if (Date.now() - fs.statSync(at).mtimeMs > 24 * 60 * 60_000) fs.rmSync(at, { recursive: true, force: true }); } catch { /* in use */ }
  }
  return fs.mkdtempSync(path.join(root, 'run-'));
}

async function reviewCommand(args: string[], ctx: Context): Promise<Result> {
  const values = parse(args, { project: { type: 'string' }, file: { type: 'string', multiple: true }, note: { type: 'string' } });
  need(values.project, '缺少 --project（GOF 或 GOT）：先问用户这是哪个项目的素材');
  const project = projectOf(values.project);
  const files = (values.file as string[] | undefined) ?? [];
  need(files.length, '缺少 --file：要审的视频或图片');
  const scratch = scratchFolder(ctx);
  try {
    const outcome = await review(project, files.map(f => path.resolve(f)), typeof values.note === 'string' && values.note.trim() ? values.note.trim() : undefined, {
      model: modelOf(ctx), root: pluginRoot(ctx.env), shared: sharedDir(ctx.env, home(ctx)), scratch,
      ...(ctx.ffmpeg === null ? {} : { ffmpeg: ctx.ffmpeg ?? await findFfmpeg(ctx.env) }), log: logOf(ctx),
    });
    const details: Result = { project: project.id, rules: outcome.rules, files: outcome.results, skipped: outcome.skipped };
    const kept = keepResult(ctx, details, outcome.markdown);
    const reviewed = outcome.results.filter(r => r.status === 'reviewed').length;
    // Codex shortens a long output by leaving out its middle: what the skill needs to find the whole result goes first, the Markdown last.
    return {
      status: reviewed ? 'done' : 'failed', ...(kept ? { result_file: kept } : {}), project: project.id, rules: outcome.rules,
      files: outcome.results.map(r => ({ name: r.name, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.verdict ? { verdict: r.verdict } : {}),
        ...(r.findings ? { issues: r.findings.issues.length } : {}) })),
      ...(outcome.skipped.length ? { skipped: outcome.skipped } : {}),
      markdown: outcome.markdown,
    };
  } finally {
    // A file still held open (Windows) is left to the sweep after a day: the review itself is done.
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* swept later */ }
  }
}

async function rulesCommand(action: string | undefined, args: string[], ctx: Context): Promise<Result> {
  const turn = turnOf(ctx.env);
  const shared = () => sharedDir(ctx.env, home(ctx));
  switch (action) {
    case 'watch': {
      const values = parse(args, { project: { type: 'string' }, since: { type: 'string' } });
      need(values.project, '缺少 --project：先问用户这个群是 GOF 还是 GOT 的审核群');
      return watch(projectOf(values.project), sinceOf(values.since), turn, rulesContext(ctx));
    }
    case 'unwatch': parse(args, {}); return unwatch(turn, { shared: shared() });
    case 'sync': {
      const values = parse(args, { here: { type: 'boolean' } });
      try {
        return await syncAll(rulesContext(ctx), { ...(values.here ? { chat: turn.chat ?? '' } : {}), waitMs: turn.chat ? 5 * 60_000 : 0 });
      } catch (error) {
        // The hourly job finding a user's watch (or the previous run) still at work: nothing is lost, the next run reads on from there.
        if (error instanceof Busy && !turn.chat) return { status: 'busy', reason: error.message };
        throw error;
      }
    }
    case 'status': parse(args, {}); return status(shared(), turn);
    case 'show': {
      const values = parse(args, { project: { type: 'string' }, output: { type: 'string' } });
      need(values.project, '缺少 --project（GOF 或 GOT）');
      return show(shared(), projectOf(values.project), typeof values.output === 'string' && values.output ? values.output : undefined);
    }
    case 'remove': {
      const values = parse(args, { project: { type: 'string' }, id: { type: 'string', multiple: true } });
      need(values.project, '缺少 --project（GOF 或 GOT）');
      return removeRules(projectOf(values.project), (values.id as string[] | undefined) ?? [], turn, { shared: shared(), ...(ctx.now ? { now: ctx.now } : {}) });
    }
    default: throw new Blocked('rules 需要 watch、unwatch、sync、status、show 或 remove');
  }
}

function info(ctx: Context): Result {
  const root = pluginRoot(ctx.env), shared = sharedDir(ctx.env, home(ctx));
  let model: string | undefined, key = false;
  try { const g = gateway(ctx.env, ctx.home); model = `${g.model} (thinking ${g.thinkingLevel.toLowerCase()}) @ ${g.baseUrl}/${g.apiVersion}`; key = true; } catch { /* reported by doctor */ }
  return {
    status: 'ok', plugin: 'audit-auto', version: version(root), node: process.version, model: model ?? null, gateway_key: key, shared,
    projects: Object.values(PROJECTS).map(p => ({ id: p.id, fixed_spec: !fixedSpec(root, p).placeholder, dynamic_rules: loadBook(shared, p.id).rules.length })),
  };
}

async function doctor(ctx: Context): Promise<Result> {
  const checks: { check: string; ok: boolean; detail?: string }[] = [];
  const check = async (name: string, fn: () => Promise<string | undefined> | string | undefined) => {
    try { const detail = await fn(); checks.push({ check: name, ok: true, ...(detail ? { detail } : {}) }); } catch (error) {
      checks.push({ check: name, ok: false, detail: error instanceof Blocked ? error.message : redact(messageOf(error)).slice(0, 300) });
    }
  };
  const root = pluginRoot(ctx.env);
  await check('fixed_specs', () => Object.values(PROJECTS).map(p => `${p.id}: ${fixedSpec(root, p).placeholder ? '占位（只用动态规范）' : '有'}`).join('，'));
  await check('ai_gateway', async () => {
    const model = modelOf(ctx);
    const reply = await model.json({ system: 'Answer with this JSON: {"ok": true}', parts: [{ text: 'ping' }], maxOutputTokens: 2048 });
    need((reply.data as { ok?: unknown })?.ok === true, 'AI 网关的回答不对');
    return `${model.name}，${reply.ms} ms`;
  });
  await check('feishu_app', async () => {
    const lark = larkOf(ctx);
    await lark.verify();
    return lark.appId;
  });
  await check('shared_folder', () => {
    const shared = sharedDir(ctx.env, home(ctx));
    fs.mkdirSync(shared, { recursive: true });
    fs.accessSync(shared, fs.constants.W_OK);
    return shared;
  });
  await check('ffmpeg', async () => (ctx.ffmpeg === null ? undefined : ctx.ffmpeg ?? await findFfmpeg(ctx.env)) ? '有（大视频先压到 720p 再发）' : '没有（视频按原文件发，最大 150 MB）');
  await check('groups', () => {
    const s = status(sharedDir(ctx.env, home(ctx)), {}) as { groups: { error?: string }[] };
    const failing = s.groups.filter(g => g.error);
    need(!failing.length, `有 ${failing.length} 个群上次没读成：${failing[0]?.error}`);
    return `在监听 ${s.groups.length} 个群`;
  });
  const ok = checks.every(c => c.ok);
  return { status: ok ? 'ok' : 'problems', checks };
}

async function run(args: string[], ctx: Context): Promise<Result> {
  const [command, ...rest] = args;
  switch (command) {
    case 'review': return reviewCommand(rest, ctx);
    case 'rules': return rulesCommand(rest[0], rest.slice(1), ctx);
    case 'info': parse(rest, {}); return info(ctx);
    case 'doctor': parse(rest, {}); return doctor(ctx);
    default: throw new Blocked('用法：review | rules <watch|unwatch|sync|status|show|remove> | doctor | info');
  }
}

export async function main(args: string[], ctx: Context = { env: process.env }): Promise<{ result: Result; code: number }> {
  try {
    const result = await run(args, ctx);
    return { result, code: result.status === 'blocked' || result.status === 'failed' || result.status === 'problems' ? 2 : 0 };
  } catch (error) {
    if (error instanceof Blocked) return { result: { status: 'blocked', reason: error.message }, code: 2 };
    return { result: { status: 'blocked', reason: error instanceof LarkError ? explainLark(error) : `出错了：${redact(messageOf(error)).slice(0, 300)}` }, code: 2 };
  }
}
