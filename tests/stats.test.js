import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, projectDirName } from '../scripts/stats.js';

const CWD = 'C:\\work\\demo';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');
const json = (...args) => JSON.parse(main([...args, '--root', root, '--json']));

test('项目目录名与 Claude Code 规则一致', () => {
  assert.equal(projectDirName(CWD), 'C--work-demo');
});

test('会话统计包含子代理并按 message.id 去重', () => {
  const s = json('session', '--session', 's1', '--cwd', CWD);
  assert.equal(s.files, 2);
  assert.deepEqual(s.rows.map((r) => r.model).sort(), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(s.total.requests, 3);
  // opus: 1000*4 + 2000*8 + 10000*0.2 + 500*20 = 32000；haiku: 1000*0.1 + 1000*0.5 = 600；sonnet: 2000 + 10000 = 12000
  assert.ok(Math.abs(s.total.actual - 44600 / 1e6) < 1e-12);
  // 纯 Opus：32000 + 24000 + 24000
  assert.ok(Math.abs(s.total.baseline - 80000 / 1e6) < 1e-12);
  assert.ok(s.savedPct > 44 && s.savedPct < 45);
});

test('非 Claude 模型不计入合计并单独列出', () => {
  const s = json('all');
  assert.equal(s.total.requests, 3);
  assert.deepEqual(s.unknown, ['gpt-6.1-sol']);
});

test('文本输出含对比结论', () => {
  const text = main(['project', '--cwd', CWD, '--root', root]);
  assert.match(text, /纯 Opus 成本/);
  assert.match(text, /节省 \$0\.0354（44\.3%）/);
});

test('缺少会话 ID 时报错', () => {
  assert.throws(() => main(['session', '--root', root]), /--session/);
});
