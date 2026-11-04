import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { Blocked } from '../src/errors.ts';
import { FakeLark, FakeModel } from './helpers/fakes.ts';
import { tempDir } from './helpers/tmp.ts';

test('doctor checks the specs, the gateway, the Feishu app, the shared folder, ffmpeg and the groups, and says which fails', async () => {
  const env = { LARK_AGENT_SHARED_DIR: tempDir('host-'), AUDIT_AUTO_GEMINI_KEY: 'k' };
  const healthy = await main(['doctor'], { env, model: new FakeModel(() => ({ ok: true })), lark: new FakeLark(), ffmpeg: null });
  assert.equal(healthy.code, 0);
  assert.deepEqual((healthy.result.checks as { check: string; ok: boolean }[]).map(c => [c.check, c.ok]),
    [['fixed_specs', true], ['ai_gateway', true], ['feishu_app', true], ['shared_folder', true], ['ffmpeg', true], ['groups', true]]);
  const lark = new FakeLark();
  lark.failWith = new Blocked('飞书应用凭证无效（错误码 10003），请联系管理员');
  const sick = await main(['doctor'], { env, model: new FakeModel(() => new Blocked('AI 网关不接受这个 key（HTTP 401），请联系管理员')), lark, ffmpeg: null });
  assert.equal(sick.code, 2);
  assert.equal(sick.result.status, 'problems');
  const failed = (sick.result.checks as { check: string; ok: boolean; detail?: string }[]).filter(c => !c.ok);
  assert.deepEqual(failed.map(c => [c.check, c.detail]), [['ai_gateway', 'AI 网关不接受这个 key（HTTP 401），请联系管理员'], ['feishu_app', '飞书应用凭证无效（错误码 10003），请联系管理员']]);
});

test('info tells what is configured, never the key', async () => {
  const shared = tempDir('host-');
  const { result, code } = await main(['info'], { env: { LARK_AGENT_SHARED_DIR: shared, AUDIT_AUTO_GEMINI_KEY: 'sk-secret-key' } });
  assert.equal(code, 0);
  assert.equal(result.model, 'gemini-3.8-flash (thinking medium) @ https://lumos.diandian.info/winky/gemini/v1');
  assert.equal(result.shared, path.join(path.resolve(shared), 'audit-auto'));
  assert.deepEqual(result.projects, [{ id: 'GOF', fixed_spec: true, dynamic_rules: 0 }, { id: 'GOT', fixed_spec: true, dynamic_rules: 0 }]);
  assert.doesNotMatch(JSON.stringify(result), /sk-secret-key/);
});
