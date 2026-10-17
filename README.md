# opus-orchestra

一个 Claude Code 插件。用命令开启"主控 + Opus/Sonnet/Haiku 分级派工"模式（质量/均衡/成本三档），只读任务用双审交叉验证，并统计 token 消耗、估算美元成本，与"全部用 Opus"做对比。

## 功能

- **`/orchestra`**：不带参数时打开档位滑块（关闭 / 成本 / 均衡 / 质量），竖直排列（质量在上、关闭在下），`↑` `↓` 移动并实时预览说明，`Enter` 确认，`Esc` 取消；选中后立即生效并弹出提示。
- **`/orchestra on|off|status|quality|balanced|cost`**：开关模式并切换档位（全局生效，跨会话保持）。传档位名等于"切换到该档并开启"；`on` 沿用上次的档位（默认均衡）；`status` 显示当前档位、主线程模型、推理强度和交叉验证的模型组合。开启后：
  - 主线程的每次模型请求都强制使用该档位的主线程模型（即使会话用其他 `--model` 启动），子代理的请求不受影响；
  - 每次提问时给主控注入该档位的派工规则；低层模型返回 `BLOCKED` 或验收不通过时逐级升级；极小的任务直接做。
- **三档模式**：

  | 档位 | 主线程模型 | 派工倾向 | 推理强度 | 交叉验证组合 |
  |---|---|---|---|---|
  | 质量（quality） | Opus | 实现、修复、测试、文档都派 `opus-expert`；大量机械性工作才用 `sonnet-worker`；不用 `haiku-worker` | 自动比当前设置高一档 | Opus + Opus |
  | 均衡（balanced，默认） | Opus | 机械任务 `haiku-worker`，常规开发 `sonnet-worker`，失败后升级到 `opus-expert` | 沿用当前设置 | Sonnet + Opus |
  | 成本（cost） | Sonnet | 机械任务 `haiku-worker`，常规开发 `sonnet-worker`（或自己做），设计、规划、疑难排障直接派 `opus-expert` | 沿用当前设置 | Haiku + Sonnet |

- **交叉验证**：只读任务（构思、方案设计、找 bug、代码审查、根因分析），且不是一两步就能回答的，主控会在同一条消息里并行派两个 `opus-orchestra:reviewer`，通过 Agent 的 `model` 参数按档位指定模型。两者拿到相同的问题，但被指定不同的审查视角，互不传递结论。主控汇总：双方一致的结论直接采信；分歧点或只有一方提出的发现，由主控亲自读源码核实（成本模式可派 `sonnet-worker` 核实）；最终输出注明每条结论是"共识"还是"已核实"。
- **`/orchestra-stats [session|project|all]`**：从本地 transcript（含子代理）汇总每个模型的请求数、输入、缓存写、缓存读、输出、实际成本，以及同样 token 全按 Opus 5.5 计价的成本和节省比例。默认统计当前会话。
- 两个命令都由插件直接回答，**不经过模型，不消耗 token**。

## 四个子代理

| 代理 | 模型 | 适用任务 |
|---|---|---|
| `opus-orchestra:haiku-worker` | Haiku | 按明确指令查找/汇总、批量改名或格式化、照抄现有模式的小改动、运行命令整理输出 |
| `opus-orchestra:sonnet-worker` | Sonnet | 按规格实现、一般 bug 修复、写测试、代码审查、文档 |
| `opus-orchestra:opus-expert` | Opus | 质量模式下的主力；成本模式下负责设计、规划和疑难排障；均衡模式下是升级通道 |
| `opus-orchestra:reviewer` | 由主控按档位指定 | 只读交叉审查者（不给 Edit/Write）：按指定视角独立给出结论，每个发现附 `path:line` 证据和置信度 |

它们都按统一格式汇报（执行类为 `STATUS / SUMMARY / FILES_CHANGED / VERIFICATION / BLOCKERS / NOTES`，`reviewer` 为 `STATUS / CONCLUSION / FINDINGS / UNCERTAIN / NOTES`），方便主控验收、汇总和决定是否升级。

## 推理强度（effort）

"auto"在 Claude Code 里的意思是"不固定，使用模型默认值"。本插件的子代理定义**不写 `effort` 字段**，派工规则也要求主控调用 Agent 工具时不传 `effort`，所以子代理默认就是 auto。主会话如果之前固定过推理强度，`/orchestra status` 会提示你执行 `/effort auto`（若设置了 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量，还需要移除它）。

**质量档会自动提高一档**：插件在 `turn.step` 里改写每个请求的 `effort`（主线程和子代理都生效），按 `low → medium → high → xhigh → max` 上调一级，`max` 保持不变。均衡和成本档不改写。

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
