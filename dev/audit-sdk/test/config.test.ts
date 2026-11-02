import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gateway, gatewayKey, pluginRoot, scratchRoot, sharedDir, tomlStrings, turnOf } from '../src/config.ts';
import { fixedSpec, projectOf, PROJECTS } from '../src/projects.ts';
import { tempDir } from './helpers/tmp.ts';

/** Codex's config.toml as lark-agent writes it (the key is made up). */
const CONFIG = `model_provider = "lumos"
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"

[marketplaces.lark-agent]
source_type = "local"
source = '\\\\?\\D:\\project\\lark-agent\\plugins'

[plugins."audit-auto@lark-agent"]
enabled = true

[model_providers.other]
base_url = "https://api.example.com/v1"
experimental_bearer_token = "not-this-one"

[model_providers.lumos]
name = "Lumos AI gateway"
base_url = "https://lumos.diandian.info/winky/openai/v1"   # the bot's own model
wire_api = "responses"
experimental_bearer_token = "sk-gateway-\\u00e9"
`;

function codexHome(config: string): string {
  const dir = tempDir('codex-');
  fs.writeFileSync(path.join(dir, 'config.toml'), config);
  return dir;
}

test('tomlStrings reads tables with dotted and quoted names, basic and literal strings, and skips the rest', () => {
  const tables = tomlStrings(CONFIG);
  assert.equal(tables.get('')!.get('model_provider'), 'lumos');
  assert.equal(tables.get('marketplaces.lark-agent')!.get('source'), '\\\\?\\D:\\project\\lark-agent\\plugins');
  assert.equal(tables.get('plugins.audit-auto@lark-agent')!.has('enabled'), false, 'booleans are not strings');
  assert.equal(tables.get('model_providers.lumos')!.get('base_url'), 'https://lumos.diandian.info/winky/openai/v1', 'a comment after the value is not part of it');
  assert.equal(tables.get('model_providers.lumos')!.get('experimental_bearer_token'), 'sk-gateway-é', 'escapes are decoded');
});

test('the gateway key is the one of the AI gateway provider in Codex config, the chosen provider first; AUDIT_AUTO_GEMINI_KEY wins', () => {
  const home = codexHome(CONFIG);
  assert.equal(gatewayKey({ CODEX_HOME: home }), 'sk-gateway-é');
  assert.equal(gatewayKey({ CODEX_HOME: home, AUDIT_AUTO_GEMINI_KEY: 'override' }), 'override');
  // Codex set to another provider: the gateway's is still found.
  assert.equal(gatewayKey({ CODEX_HOME: codexHome(CONFIG.replace('model_provider = "lumos"', 'model_provider = "other"')) }), 'sk-gateway-é');
  assert.throws(() => gatewayKey({ CODEX_HOME: codexHome('model = "x"\n') }), /没有内部 AI 网关/);
  assert.throws(() => gatewayKey({ CODEX_HOME: path.join(home, 'missing') }), /读不到 lark-agent 的 Codex 配置/);
  // Without CODEX_HOME the home folder's .codex is read.
  const user = tempDir('home-');
  fs.mkdirSync(path.join(user, '.codex'));
  fs.writeFileSync(path.join(user, '.codex', 'config.toml'), CONFIG);
  assert.equal(gatewayKey({}, user), 'sk-gateway-é');
});

test('the gateway defaults to gemini-3.8-flash thinking at medium on the Lumos Gemini endpoint; overrides are checked', () => {
  const home = codexHome(CONFIG);
  assert.deepEqual(gateway({ CODEX_HOME: home }), {
    baseUrl: 'https://lumos.diandian.info/winky/gemini', apiVersion: 'v1', model: 'gemini-3.8-flash', thinkingLevel: 'MEDIUM', key: 'sk-gateway-é',
  });
  const custom = gateway({ CODEX_HOME: home, AUDIT_AUTO_GEMINI_MODEL: 'gemini-x', AUDIT_AUTO_GEMINI_THINKING: 'high', AUDIT_AUTO_GEMINI_BASE_URL: 'http://127.0.0.1:9/g/' });
  assert.equal(custom.model, 'gemini-x');
  assert.equal(custom.thinkingLevel, 'HIGH');
  assert.equal(custom.baseUrl, 'http://127.0.0.1:9/g');
  assert.throws(() => gateway({ CODEX_HOME: home, AUDIT_AUTO_GEMINI_THINKING: 'max' }), /只能是/);
});

test('folders and the turn come from the host, with fallbacks for running without it', () => {
  assert.equal(sharedDir({ LARK_AGENT_SHARED_DIR: 'D:\\agent\\shared' }), path.join(path.resolve('D:\\agent\\shared'), 'audit-auto'));
  assert.equal(sharedDir({}, 'C:\\home'), path.join('C:\\home', '.audit-auto', 'shared'));
  assert.equal(scratchRoot({ LARK_AGENT_USER_DIR: 'D:\\agent\\user\\李小明' }), path.join(path.resolve('D:\\agent\\user\\李小明'), 'audit-auto', 'tmp'));
  assert.deepEqual(turnOf({ LARK_AGENT_CHAT_ID: 'oc_1', LARK_AGENT_CHAT_TYPE: 'group', LARK_AGENT_USER_OPEN_ID: 'ou_1' }), { chat: 'oc_1', chatType: 'group', user: 'ou_1' });
  assert.deepEqual(turnOf({ LARK_AGENT_CHAT_ID: ' ' }), {});
});

test('the plugin folder is found from the sources, and both projects have their fixed spec file (GOT a placeholder)', () => {
  const root = pluginRoot({});
  assert.ok(fs.existsSync(path.join(root, 'plugin.json')));
  const gof = fixedSpec(root, PROJECTS.GOF);
  assert.equal(gof.placeholder, false);
  assert.match(gof.text, /^# GOF（无尽冬日）广告素材审片规范/, 'the maintainers\' comment is not given to the model');
  assert.match(gof.text, /上头/);
  assert.match(gof.text, /广告创意仅供参考/);
  const got = fixedSpec(root, PROJECTS.GOT);
  assert.equal(got.placeholder, true);
  assert.equal(got.text, '');
  assert.equal(projectOf(' gof ').id, 'GOF');
  assert.throws(() => projectOf('GOX'), /只有 GOF 和 GOT/);
});
