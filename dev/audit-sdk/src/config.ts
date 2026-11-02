import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blocked, need } from './errors.ts';

/*
 * What the plugin runs with. Everything comes from the host (lark-agent) through the environment, or has a default here:
 *
 *   CODEX_HOME                   lark-agent's Codex home: its config.toml holds the AI gateway key the plugin shares with the bot
 *   LARK_AGENT_SHARED_DIR        the folder plugins share; this plugin keeps its review groups and dynamic specs in audit-auto/ there
 *   LARK_AGENT_USER_DIR          the user's folder (scratch space goes to audit-auto/tmp in it)
 *   LARK_AGENT_CHAT_ID / _TYPE   the chat of this turn and whether it is a group (listening to a review group needs one)
 *   LARK_AGENT_USER_OPEN_ID      who asked
 *   FEISHU_APP_ID / _SECRET      the bot's Feishu app, to read the review groups' messages as the bot
 *
 * Overrides, for the administrator (lark-agent's .env) and tests: AUDIT_AUTO_GEMINI_KEY, AUDIT_AUTO_GEMINI_BASE_URL,
 * AUDIT_AUTO_GEMINI_API_VERSION, AUDIT_AUTO_GEMINI_MODEL, AUDIT_AUTO_GEMINI_THINKING, AUDIT_AUTO_FEISHU_BASE, AUDIT_AUTO_PLUGIN_ROOT, FFMPEG.
 */

export const PLUGIN = 'audit-auto';
type Env = NodeJS.ProcessEnv;
const text = (env: Env, name: string) => env[name]?.trim() || undefined;

/** Where the plugin is (plugin.json, skills/ with the fixed specs): the bundle runs from server/dist, the sources from dev/audit-sdk/src. */
export function pluginRoot(env: Env = process.env): string {
  const given = text(env, 'AUDIT_AUTO_PLUGIN_ROOT');
  if (given) return path.resolve(given);
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const root of [path.resolve(here, '../..'), path.resolve(here, '../../../plugins/audit-auto')]) {
    if (fs.existsSync(path.join(root, 'plugin.json'))) return root;
  }
  throw new Blocked('找不到插件目录（plugin.json），插件文件不完整，请联系管理员');
}

// ---- the AI gateway

export interface Gateway { baseUrl: string; apiVersion: string; model: string; thinkingLevel: string; key: string }
const GATEWAY_HOST = 'lumos.diandian.info';
const THINKING = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

/**
 * Gemini through the internal AI gateway: https://lumos.diandian.info/winky/gemini/v1/models/<model>:generateContent, with the key the
 * bot's own Codex uses (the gateway takes the same key for every model), gemini-3.8-flash thinking at medium.
 */
export function gateway(env: Env = process.env, home = os.homedir()): Gateway {
  const thinkingLevel = (text(env, 'AUDIT_AUTO_GEMINI_THINKING') ?? 'medium').toUpperCase();
  need(THINKING.has(thinkingLevel), 'AUDIT_AUTO_GEMINI_THINKING 只能是 minimal、low、medium 或 high');
  return {
    baseUrl: (text(env, 'AUDIT_AUTO_GEMINI_BASE_URL') ?? 'https://lumos.diandian.info/winky/gemini').replace(/\/+$/, ''),
    apiVersion: text(env, 'AUDIT_AUTO_GEMINI_API_VERSION') ?? 'v1',
    model: text(env, 'AUDIT_AUTO_GEMINI_MODEL') ?? 'gemini-3.8-flash',
    thinkingLevel, key: gatewayKey(env, home),
  };
}

/**
 * The gateway key: AUDIT_AUTO_GEMINI_KEY, else the bearer token of the gateway's provider in Codex's config.toml (lark-agent sets
 * CODEX_HOME to its own .codex; without a host, ~/.codex). The provider Codex is set to use comes first, then any other on the gateway.
 */
export function gatewayKey(env: Env = process.env, home = os.homedir()): string {
  const given = text(env, 'AUDIT_AUTO_GEMINI_KEY');
  if (given) return given;
  const file = path.join(text(env, 'CODEX_HOME') ?? path.join(home, '.codex'), 'config.toml');
  let toml: string;
  try { toml = fs.readFileSync(file, 'utf8'); } catch { throw new Blocked('找不到 AI 网关的 key：读不到 lark-agent 的 Codex 配置（.codex/config.toml），请联系管理员'); }
  const tables = tomlStrings(toml.charCodeAt(0) === 0xfeff ? toml.slice(1) : toml);
  const chosen = tables.get('')?.get('model_provider');
  const providers = [...tables].filter(([name]) => /^model_providers\.[^.]+$/.test(name));
  const onGateway = (values: Map<string, string>) => {
    try { return new URL(values.get('base_url') ?? '').hostname === GATEWAY_HOST; } catch { return false; }
  };
  const ordered = [...providers.filter(([name]) => name === `model_providers.${chosen}`), ...providers];
  const found = ordered.find(([, values]) => onGateway(values) && values.get('experimental_bearer_token'));
  need(found, '找不到 AI 网关的 key：lark-agent 的 Codex 配置里没有内部 AI 网关的 experimental_bearer_token，请联系管理员');
  return found[1].get('experimental_bearer_token')!;
}

/**
 * The string values of a TOML file, table by table ('' is the top). Only as much TOML as Codex's config.toml needs: tables with dotted
 * or quoted names, and basic or literal one-line strings; everything else is skipped.
 */
export function tomlStrings(toml: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>([['', new Map()]]);
  let current = tables.get('')!;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) { current = new Map(); continue; }
    const header = /^\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      const name = keyPath(header[1]!);
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
      continue;
    }
    const pair = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = stringValue(pair[2]!);
    if (value !== undefined) current.set(keyPath(pair[1]!), value);
  }
  return tables;
}

const keyPath = (key: string) => (key.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.\s]+/g) ?? []).map(part => part.replace(/^["']|["']$/g, '')).join('.');

function stringValue(raw: string): string | undefined {
  const basic = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(raw);
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]!.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))}"`) as string;
    } catch { return undefined; }
  }
  const literal = /^'([^']*)'\s*(?:#.*)?$/.exec(raw);
  return literal ? literal[1] : undefined;
}

// ---- Feishu, chats and folders

export interface App { id: string; secret: string; base: string }

/** The bot's Feishu app, which reads the review groups (the bot is a member of each). */
export function feishuApp(env: Env = process.env): App {
  const id = text(env, 'FEISHU_APP_ID');
  const secret = text(env, 'FEISHU_APP_SECRET');
  need(id && secret, '没有飞书应用的凭证（FEISHU_APP_ID / FEISHU_APP_SECRET，由 lark-agent 提供），请联系管理员');
  return { id, secret, base: (text(env, 'AUDIT_AUTO_FEISHU_BASE') ?? 'https://open.feishu.cn/open-apis').replace(/\/+$/, '') };
}

export interface Turn { chat?: string; chatType?: string; user?: string }
/** The chat this turn's message came from and who sent it; a periodic job has none. */
export const turnOf = (env: Env = process.env): Turn => ({
  ...(text(env, 'LARK_AGENT_CHAT_ID') ? { chat: text(env, 'LARK_AGENT_CHAT_ID') } : {}),
  ...(text(env, 'LARK_AGENT_CHAT_TYPE') ? { chatType: text(env, 'LARK_AGENT_CHAT_TYPE') } : {}),
  ...(text(env, 'LARK_AGENT_USER_OPEN_ID') ? { user: text(env, 'LARK_AGENT_USER_OPEN_ID') } : {}),
});

/** What the plugin keeps for every user alike (the review groups it listens to, their dynamic specs): never cleaned up, never sent. */
export function sharedDir(env: Env = process.env, home = os.homedir()): string {
  const given = text(env, 'LARK_AGENT_SHARED_DIR');
  return given ? path.join(path.resolve(given), PLUGIN) : path.join(home, '.audit-auto', 'shared');
}

/** Scratch space for unpacked zips and compressed videos. Never the workspace: the host sends the user what appears there. */
export function scratchRoot(env: Env = process.env): string {
  const user = text(env, 'LARK_AGENT_USER_DIR');
  return user ? path.join(path.resolve(user), PLUGIN, 'tmp') : path.join(os.tmpdir(), PLUGIN);
}
