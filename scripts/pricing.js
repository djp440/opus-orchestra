// 价格表（美元 / 百万 token），来源：https://platform.claude.com/docs/en/about-claude/pricing
// 字段：input 基础输入、w5m 5 分钟缓存写入、w1h 1 小时缓存写入、read 缓存读取、output 输出。

export const PRICES = {
  'opus-5.5': { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 },
  // fast 模式官方只给出 input 8 / output 40；缓存价按同一 2 倍系数估算。
  'opus-5.5-fast': { input: 8, w5m: 10, w1h: 16, read: 0.4, output: 40 },
  'sonnet-5.5': { input: 2, w5m: 2.5, w1h: 4, read: 0.1, output: 10 },
  'haiku-5.5': { input: 0.1, w5m: 0.125, w1h: 0.2, read: 0.01, output: 0.5 },
  'haiku-5.5-long': { input: 0.5, w5m: 0.625, w1h: 1, read: 0.05, output: 2.5 },
};

// 对比基线：同样的 token 全部交给 Opus 5.5（标准速度）计价。
export const BASELINE = 'opus-5.5';

// Haiku 5.5 单次请求 prompt（input + 缓存写 + 缓存读）超过该值时按长上下文价计费。
export const HAIKU_LONG_THRESHOLD = 100_000;

/** 把模型 ID 归一成价格表键（其他版本按同系列 5.5 价估算）；未知模型返回 null。 */
export function priceKey(model, usage = {}) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return usage.speed === 'fast' ? 'opus-5.5-fast' : 'opus-5.5';
  if (m.includes('sonnet')) return 'sonnet-5.5';
  if (m.includes('haiku')) {
    return promptTokens(usage) > HAIKU_LONG_THRESHOLD ? 'haiku-5.5-long' : 'haiku-5.5';
  }
  return null;
}

/** 单次请求的 prompt 总量。 */
export function promptTokens(u = {}) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

/** 把缓存写入拆成 5m / 1h；缺少明细时全部按 5m 计。 */
export function splitCacheWrite(u = {}) {
  const total = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    return { w5m: cc.ephemeral_5m_input_tokens || 0, w1h: cc.ephemeral_1h_input_tokens || 0 };
  }
  return { w5m: total, w1h: 0 };
}

/** 按指定价格表键计算一次请求的美元成本。 */
export function costWith(key, u = {}) {
  const p = PRICES[key];
  if (!p) return 0;
  const { w5m, w1h } = splitCacheWrite(u);
  return (
    (u.input_tokens || 0) * p.input +
    w5m * p.w5m +
    w1h * p.w1h +
    (u.cache_read_input_tokens || 0) * p.read +
    (u.output_tokens || 0) * p.output
  ) / 1e6;
}

/** 实际成本与纯 Opus 基线成本。未知模型实际成本记 0（并由调用方标注）。 */
export function cost(model, usage = {}) {
  const key = priceKey(model, usage);
  return { key, actual: key ? costWith(key, usage) : 0, baseline: costWith(BASELINE, usage) };
}
