#!/usr/bin/env node
// 统计 Claude Code transcript 的 token 消耗与美元成本，并与"全部用 Opus"对比。
// 用法：node stats.js [session|project|all] [--session <id>] [--cwd <dir>] [--root <projects 目录>] [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cost, splitCacheWrite } from './pricing.js';

export function projectsRoot(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Claude Code 用来命名项目目录的规则：非字母数字字符替换为 "-"。 */
export function projectDirName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function listJsonl(dir, recursive) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...listJsonl(p, true));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** 某个会话的主 transcript 加上它的子代理 transcript。 */
export function sessionFiles(root, sessionId, cwd) {
  const dirs = [];
  if (cwd) dirs.push(path.join(root, projectDirName(cwd)));
  try {
    for (const d of fs.readdirSync(root)) dirs.push(path.join(root, d));
  } catch {
    // 根目录不存在时返回空
  }
  for (const dir of dirs) {
    const main = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(main)) return [main, ...listJsonl(path.join(dir, sessionId), true)];
  }
  return [];
}

export function scopeFiles({ scope, root, sessionId, cwd }) {
  if (scope === 'all') return listJsonl(root, true);
  if (scope === 'project') return listJsonl(path.join(root, projectDirName(cwd)), true);
  return sessionFiles(root, sessionId, cwd);
}

/** 读取 transcript 中的 assistant 用量，按 message.id 去重（流式分块会重复写入同一条消息）。 */
export function collectUsage(files) {
  const byId = new Map();
  let anon = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = row.message;
      if (row.type !== 'assistant' || !msg || !msg.usage || !msg.model || msg.model === '<synthetic>') continue;
      byId.set(msg.id || `anon-${anon++}`, { model: msg.model, usage: msg.usage });
    }
  }
  return [...byId.values()];
}

export function summarize(records) {
  const rows = new Map();
  const total = { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, actual: 0, baseline: 0 };
  const unknown = new Set();
  for (const { model, usage } of records) {
    const c = cost(model, usage);
    // 非 Claude 模型无从定价，不计入合计，免得拉低对比。
    if (!c.key) {
      unknown.add(model);
      continue;
    }
    const r = rows.get(model) || { model, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, actual: 0, baseline: 0 };
    const { w5m, w1h } = splitCacheWrite(usage);
    for (const t of [r, total]) {
      t.requests += 1;
      t.input += usage.input_tokens || 0;
      t.cacheWrite += w5m + w1h;
      t.cacheRead += usage.cache_read_input_tokens || 0;
      t.output += usage.output_tokens || 0;
      t.actual += c.actual;
      t.baseline += c.baseline;
    }
    rows.set(model, r);
  }
  const list = [...rows.values()].sort((a, b) => b.actual - a.actual);
  const saved = total.baseline - total.actual;
  return { rows: list, total, saved, savedPct: total.baseline > 0 ? (saved / total.baseline) * 100 : 0, unknown: [...unknown] };
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const fmtUsd = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function render(summary, label) {
  const { rows, total, saved, savedPct, unknown } = summary;
  if (!rows.length) return `opus-orchestra 统计（${label}）：没有找到带用量的 assistant 消息。`;
  const head = '| 模型 | 请求 | 输入 | 缓存写 | 缓存读 | 输出 | 实际成本 | 纯 Opus 成本 |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|';
  const line = (r, name) =>
    `| ${name} | ${r.requests} | ${fmtTok(r.input)} | ${fmtTok(r.cacheWrite)} | ${fmtTok(r.cacheRead)} | ${fmtTok(r.output)} | ${fmtUsd(r.actual)} | ${fmtUsd(r.baseline)} |`;
  const out = [`opus-orchestra 统计（${label}）`, '', head, sep, ...rows.map((r) => line(r, r.model)), line(total, '**合计**'), ''];
  out.push(
    saved >= 0
      ? `相比全部使用 Opus 5.5：节省 ${fmtUsd(saved)}（${savedPct.toFixed(1)}%）`
      : `相比全部使用 Opus 5.5：多花 ${fmtUsd(-saved)}（${(-savedPct).toFixed(1)}%，通常因为用了 fast 模式）`,
  );
  out.push('估算依据：官方 API 标价（$/MTok），按 transcript 用量逐条计价；订阅用户的实际账单不同。');
  if (unknown.length) out.push(`未计入（非 Claude 模型，无定价）：${unknown.join(', ')}`);
  return out.join('\n');
}

export function parseArgs(argv) {
  const opts = { scope: 'session', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--session') opts.sessionId = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (['session', 'project', 'all'].includes(a)) opts.scope = a;
    else throw new Error(`未知参数：${a}（可用：session | project | all）`);
  }
  return opts;
}

export function main(argv, env = process.env) {
  const opts = parseArgs(argv);
  const root = opts.root || projectsRoot(env);
  if (opts.scope === 'session' && !opts.sessionId) throw new Error('统计当前会话需要 --session <id>');
  if (opts.scope === 'project' && !opts.cwd) throw new Error('统计当前项目需要 --cwd <dir>');
  const files = scopeFiles({ ...opts, root });
  const summary = summarize(collectUsage(files));
  const label = { session: '当前会话（含子代理）', project: '当前项目全部会话', all: '全部项目' }[opts.scope];
  return opts.json ? JSON.stringify({ files: files.length, ...summary }, null, 2) : render(summary, `${label}，${files.length} 个 transcript`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
