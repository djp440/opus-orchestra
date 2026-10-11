import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cost, costWith, priceKey } from '../scripts/pricing.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('模型 ID 映射到价格表', () => {
  assert.equal(priceKey('claude-opus-5-5'), 'opus-5.5');
  assert.equal(priceKey('claude-opus-5-5', { speed: 'fast' }), 'opus-5.5-fast');
  assert.equal(priceKey('claude-sonnet-5-5'), 'sonnet-5.5');
  assert.equal(priceKey('claude-haiku-5-5', { input_tokens: 100 }), 'haiku-5.5');
  assert.equal(priceKey('gpt-6.1-sol'), null);
});

test('Haiku 超过 100k prompt 用长上下文价', () => {
  const u = { input_tokens: 1000, cache_read_input_tokens: 100_000 };
  assert.equal(priceKey('claude-haiku-5-5', u), 'haiku-5.5-long');
});

test('按 input / 5m / 1h / 缓存读 / output 分别计价', () => {
  const u = {
    input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_read_input_tokens: 1e6, output_tokens: 1e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
  };
  close(costWith('opus-5.5', u), 4 + 5 + 8 + 0.2 + 20);
  // 缺少 5m/1h 明细时整体按 5m 计
  close(costWith('sonnet-5.5', { cache_creation_input_tokens: 1e6 }), 2.5);
});

test('cost 同时给出实际成本与纯 Opus 基线', () => {
  const c = cost('claude-haiku-5-5', { input_tokens: 1e4, output_tokens: 1e6 });
  close(c.actual, 0.001 + 0.5);
  close(c.baseline, 0.04 + 20);
});
