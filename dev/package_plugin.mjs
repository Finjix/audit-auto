#!/usr/bin/env node
// Checks the layout of plugins/audit-auto and packs it into a ZIP with a SHA-256 file. No network, no installs.
//
//   node dev/package_plugin.mjs --check
//   node dev/package_plugin.mjs --output dev/dist/audit-auto.zip
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'audit-auto');
const SKILLS = ['gof-audit', 'got-audit', 'dynamic-rules'];
const MARKETPLACE = path.join(ROOT, '.agents', 'plugins', 'marketplace.json');
const FORBIDDEN_PARTS = new Set(['__pycache__', 'node_modules', '.state', '.git', '.codex', 'browser-profile']);
const FORBIDDEN_NAMES = new Set(['auth.json', 'login.json', 'app.json', '.env', 'config.toml', 'groups.json', 'names.json', 'lock']);
const FORBIDDEN_EXTENSIONS = ['.py', '.pyc', '.pyd', '.dll', '.exe', '.png', '.mp4', '.mov', '.zip', '.tmp'];
const REQUIRED_FILES = [
  'plugin.json', 'lark-agent.json', 'server/dist/audit.mjs', 'skills/gof-audit/references/rules.md', 'skills/got-audit/references/rules.md',
  ...SKILLS.flatMap(skill => [`skills/${skill}/SKILL.md`, `skills/${skill}/agents/openai.yaml`]),
];

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

export function problems() {
  const found = [];
  for (const name of REQUIRED_FILES) if (!fs.statSync(path.join(PLUGIN, name), { throwIfNoEntry: false })?.isFile()) found.push(`missing ${name}`);
  try {
    const manifest = readJson(path.join(PLUGIN, 'plugin.json'));
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name ?? '')) found.push('plugin.json: name must be kebab-case');
    if (!manifest.version || !manifest.description) found.push('plugin.json: version and description are required');
    // Without $schema, Codex reports "missing plugin.json" for a root plugin.json.
    if (typeof manifest.$schema !== 'string' || !manifest.$schema.startsWith('https://agent-plugins.org/schemas/')) found.push('plugin.json: needs the Agent Plugins $schema');
    const entries = (readJson(MARKETPLACE).plugins ?? []).filter(p => p.name === manifest.name);
    if (entries.length !== 1 || entries[0].source?.path !== './plugins/audit-auto') found.push('marketplace.json does not point at plugins/audit-auto');
    // lark-agent runs the hourly rules sync from lark-agent.json (see its src/jobs.ts).
    const jobs = readJson(path.join(PLUGIN, 'lark-agent.json')).jobs ?? [];
    const sync = jobs.find(j => j.name === 'rules-sync');
    if (!sync || !Number.isInteger(sync.everyMinutes) || sync.everyMinutes < 5 || sync.command !== 'node' || sync.args?.[0] !== '${PLUGIN_ROOT}/server/dist/audit.mjs') found.push('lark-agent.json: rules-sync must run node ${PLUGIN_ROOT}/server/dist/audit.mjs every 5 minutes or more');
  } catch (error) {
    found.push(`plugin.json / marketplace.json unreadable: ${error.message}`);
  }
  for (const name of SKILLS) {
    const skill = path.join(PLUGIN, 'skills', name, 'SKILL.md');
    const text = fs.existsSync(skill) ? fs.readFileSync(skill, 'utf8').replace(/\r\n/g, '\n') : '';
    if (!new RegExp(`^---\\nname: ${name}\\ndescription: `).test(text)) found.push(`${name}/SKILL.md: front matter must start with name: ${name} and a description`);
  }
  if (fs.existsSync(PLUGIN)) {
    for (const file of walk(PLUGIN)) {
      const rel = path.relative(PLUGIN, file).split(path.sep);
      const name = rel[rel.length - 1];
      if (rel.some(part => FORBIDDEN_PARTS.has(part)) || FORBIDDEN_NAMES.has(name) || FORBIDDEN_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext))) {
        found.push(`must not ship: ${rel.join('/')}`);
      }
    }
  }
  return found;
}

function crc32(data) {
  return zlib.crc32(data) >>> 0;
}

/** A deterministic zip: sorted entries, fixed timestamps, deflate. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const time = 0; // 00:00:00
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  for (const [name, data] of entries) {
    const body = zlib.deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x031e, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10); entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function pack(output) {
  const file = path.resolve(output);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`${file} exists; choose a new file name`);
  const entries = walk(PLUGIN).map(f => [`audit-auto/${path.relative(PLUGIN, f).split(path.sep).join('/')}`, fs.readFileSync(f)]);
  const archive = zip(entries);
  fs.writeFileSync(file, archive, { flag: 'wx' });
  const digest = createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
  console.log(`${file}\nsha256 ${digest}\n${(archive.length / 1024 / 1024).toFixed(2)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  if (check === (output !== undefined) || (args.includes('--output') && !output)) {
    console.error('usage: node dev/package_plugin.mjs --check | --output <new .zip>');
    process.exit(2);
  }
  const found = problems();
  for (const line of found) console.log(`problem: ${line}`);
  if (found.length) process.exit(1);
  if (check) console.log('plugin layout ok');
  else pack(output);
}
