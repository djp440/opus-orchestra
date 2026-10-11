# opus-orchestra

一个 Claude Code 插件。用命令开启"Opus 主控 + Sonnet/Haiku 分级派工"的省钱模式，并统计 token 消耗、估算美元成本，与"全部用 Opus"做对比。

## 功能

- **`/orchestra on|off|status`**：开关模式（全局生效，跨会话保持）。开启后：
  - 主线程的每次模型请求都强制使用 `claude-opus-5-5`（即使会话用 `--model sonnet` 启动），子代理的请求不受影响；
  - 每次提问时给 Opus 注入派工规则：机械任务派给 `haiku-worker`，常规开发派给 `sonnet-worker`；低层模型返回 `BLOCKED` 或验收不通过时，逐级升级到 `sonnet-worker` → `opus-expert`（或由 Opus 亲自处理）；极小的任务直接做。
- **`/orchestra-stats [session|project|all]`**：从本地 transcript（含子代理）汇总每个模型的请求数、输入、缓存写、缓存读、输出、实际成本，以及同样 token 全按 Opus 5.5 计价的成本和节省比例。默认统计当前会话。
- 两个命令都由插件直接回答，**不经过模型，不消耗 token**。

## 三个子代理

| 代理 | 模型 | 适用任务 |
|---|---|---|
| `opus-orchestra:haiku-worker` | Haiku | 按明确指令查找/汇总、批量改名或格式化、照抄现有模式的小改动、运行命令整理输出 |
| `opus-orchestra:sonnet-worker` | Sonnet | 按规格实现、一般 bug 修复、写测试、代码审查、文档 |
| `opus-orchestra:opus-expert` | Opus | 升级通道：低层模型失败的疑难问题 |

它们都按统一格式（`STATUS / SUMMARY / FILES_CHANGED / VERIFICATION / BLOCKERS / NOTES`）汇报，方便 Opus 验收和决定是否升级。

## 推理强度（effort）

"auto"在 Claude Code 里的意思是"不固定，使用模型默认值"。本插件的子代理定义**不写 `effort` 字段**，派工规则也要求 Opus 调用 Agent 工具时不传 `effort`，所以子代理默认就是 auto。主会话如果之前固定过推理强度，`/orchestra status` 会提示你执行 `/effort auto`（若设置了 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量，还需要移除它）。

## 安装

需要 Claude Code **2.1.287 或更高版本**（插件用到 mods：`hooks/register.js`）。

```
/plugin marketplace add djp440/opus-orchestra
/plugin install opus-orchestra@opus-orchestra
```

本地开发时也可以直接加载：`claude --plugin-dir /path/to/opus-orchestra`。统计脚本需要本机有 `node`。

## 成本估算口径

- 价格来自 [官方定价页](https://platform.claude.com/docs/en/about-claude/pricing)（$/MTok）：

  | 模型 | 输入 | 5 分钟缓存写 | 1 小时缓存写 | 缓存读 | 输出 |
  |---|---:|---:|---:|---:|---:|
  | Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 |
  | Sonnet 5.5 | 2 | 2.5 | 4 | 0.10 | 10 |
  | Haiku 5.5（单次 prompt ≤100k） | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
  | Haiku 5.5（>100k） | 0.50 | 0.625 | 1 | 0.05 | 2.50 |

- Opus fast 模式按输入 8 / 输出 40 计，缓存价按同一 2 倍系数估算；其他版本的 Opus/Sonnet/Haiku 按同系列 5.5 的价格估算；非 Claude 模型不计入合计，单独列出。
- "纯 Opus 成本"= 把每条请求的同样 token 按 Opus 5.5 标准价重新计价。由于换模型后 token 数本身也会变化，这只是近似对比。
- 这是按 API 标价的估算；订阅套餐的实际账单不同。

## 限制

- mods 只在终端版和桌面版的 Code 标签页中生效；组织策略可能禁用 mods。
- 开关存放在插件的 store 中，对所有加载了本插件的会话同时生效。

## 开发

```
npm test   # node --test 单元测试 + claude plugin test（mod 测试）
claude plugin validate .
```

## 许可

MIT
