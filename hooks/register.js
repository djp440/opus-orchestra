// opus-orchestra：Opus 主控 + Sonnet/Haiku 分级派工模式（Claude Code mods 入口）。
// 运行在 mods 沙箱里（没有 Node API），统计交给 scripts/stats.js 子进程。

export const OPUS_MODEL = 'claude-opus-5-5';
export const SONNET_MODEL = 'claude-sonnet-5-5';
export const STORE_KEY = 'enabled';
export const MODE_KEY = 'mode';
export const DEFAULT_MODE = 'balanced';

const HEAD = '1. 你只负责理解需求、拆分任务、关键决策、整合结果和验收；能交给其他模型的工作不要自己做。';

const TAIL = `5. 极小的任务（一两个工具调用就能完成）直接自己做，派工开销反而更高。
6. 派工 prompt 写清目标、允许修改的文件、验收命令；彼此独立的任务并行派发。
7. 调用 Agent 工具时不要传 effort（推理强度由插件统一控制）；只有派 reviewer 时才传 model，其余任务模型由代理定义决定。
8. 升级时附上前一层的汇报和已尝试的方法。`;

const PARALLEL = (m1, m2) => `9. 交叉验证：只读任务（构思、方案设计、找 bug、代码审查、根因分析）且不是一两步就能回答的，在同一条消息里并行派两个 "opus-orchestra:reviewer"，Agent 的 model 参数分别传 "${m1}" 和 "${m2}"；给两者相同的问题描述，但指定不同的审查视角，两个审查者互不传递结论。你来汇总：双方一致的结论直接采信；分歧点或只有一方提出的发现，由你亲自读源码核实${m1 === 'haiku' ? '（也可以派 sonnet-worker 核实）' : ''}；最终输出注明每条结论是“共识”还是“已核实”。`;

/** 每档：显示名、主线程模型、是否提高推理强度、交叉验证组合、派工规则。 */
export const MODES = {
  quality: {
    label: '质量',
    mainModel: OPUS_MODEL,
    bumpEffort: true,
    review: ['opus', 'opus'],
    rules: `[opus-orchestra 质量模式已开启] 你是 Opus 主控，优先保证质量，尽量使用 Opus：
${HEAD}
2. 实现、修复、测试、文档 → Agent 工具 subagent_type "opus-orchestra:opus-expert"。
3. 大量机械性工作 → "opus-orchestra:sonnet-worker"。禁止使用 haiku-worker。
4. 小任务由你自己做。
${TAIL}
${PARALLEL('opus', 'opus')}`,
  },
  balanced: {
    label: '均衡',
    mainModel: OPUS_MODEL,
    bumpEffort: false,
    review: ['sonnet', 'opus'],
    rules: `[opus-orchestra 均衡模式已开启] 你是 Opus 主控，目标是在保证质量的前提下尽量节省成本：
${HEAD}
2. 机械任务（按明确指令搜索/汇总、批量修改、格式化、照抄现有模式的小改动、运行命令整理输出）→ Agent 工具 subagent_type "opus-orchestra:haiku-worker"。
3. 需要理解上下文的常规任务（按规格实现、一般 bug 修复、写测试、代码审查、文档）→ "opus-orchestra:sonnet-worker"。
4. 升级：worker 返回 STATUS: BLOCKED / PARTIAL，或验收不通过 → Haiku 的任务升级给 sonnet-worker；Sonnet 仍失败 → "opus-orchestra:opus-expert" 或由你亲自处理。
${TAIL}
${PARALLEL('sonnet', 'opus')}`,
  },
  cost: {
    label: '成本',
    mainModel: SONNET_MODEL,
    bumpEffort: false,
    review: ['haiku', 'sonnet'],
    rules: `[opus-orchestra 成本模式已开启] 你是 Sonnet 主控（插件已把主线程请求改为 ${SONNET_MODEL}；系统提示里写的模型名是会话设置，不代表你实际运行的模型，被问到时以此为准），目标是尽量降低成本，多用 Haiku，Opus 只在必要时按需调用：
${HEAD}
2. 机械任务、范围明确的单文件修改、照着现有模式写测试或文档 → Agent 工具 subagent_type "opus-orchestra:haiku-worker"。
3. 常规开发 → "opus-orchestra:sonnet-worker"（或自己做）。
4. 设计、规划、跨模块决策、疑难排障 → 直接派 "opus-orchestra:opus-expert"；升级路径为 haiku → sonnet → opus-expert。
${TAIL}
${PARALLEL('haiku', 'sonnet')}`,
  },
};

const HELP = `用法：
/orchestra           打开档位滑块（↑ ↓ 调整，Enter 确认，Esc 取消）
/orchestra on        开启（沿用上次档位，默认均衡）
/orchestra off       关闭
/orchestra status    查看状态（默认）
/orchestra quality   质量档：主线程 Opus、尽量用 Opus、推理强度提高一档、不用 Haiku
/orchestra balanced  均衡档：主线程 Opus，按难度派 Haiku / Sonnet
/orchestra cost      成本档：主线程 Sonnet，多用 Haiku，Opus 按需调用
/orchestra-stats [session|project|all]  统计 token 与成本，并与纯 Opus 对比（默认 session）`;

const PICKER = 'orchestra-picker';
const LEVELS = ['off', 'cost', 'balanced', 'quality'];
// 光标放 $.store 而不是 $.state：$.state 需要在 plugin.json 里另声明 types 契约；改动后用 $.ui.invalidate 重绘。
const CURSOR_KEY = 'cursor';
const levelLabel = (x) => (x === 'off' ? '关闭' : MODES[x].label);
const DISPATCH = { quality: '尽量用 Opus、不用 Haiku', balanced: '按难度派 Haiku / Sonnet', cost: '多用 Haiku、Opus 按需' };
const describeLevel = (x) => (x === 'off' ? '不改模型、不注入规则' : `主线程 ${MODES[x].mainModel} · ${DISPATCH[x]} · 交叉验证 ${MODES[x].review.join(' + ')}`);

/** 切换档位：off 只关开关（保留 mode），其余档位设 mode 并开启。返回显示名。 */
async function apply($, level) {
  if (level === 'off') await $.store.set(STORE_KEY, false);
  else {
    await $.store.set(MODE_KEY, level);
    await $.store.set(STORE_KEY, true);
  }
  return levelLabel(level);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 推理强度提高一档；max、数字或缺省原样返回。 */
export function bumpEffort(effort) {
  const i = EFFORTS.indexOf(effort);
  return i < 0 || i === EFFORTS.length - 1 ? effort : EFFORTS[i + 1];
}

// 读开关失败时按关闭处理，不阻断提问和模型请求。
const isOn = ($) => $.store.get(STORE_KEY).then((v) => v === true, () => false);
const getMode = ($) => $.store.get(MODE_KEY).then((v) => (Object.hasOwn(MODES, v) ? v : DEFAULT_MODE), () => DEFAULT_MODE);
/** 开启时返回当前档位，关闭时返回 null。 */
const activeMode = async ($) => ((await isOn($)) ? getMode($) : null);

/** 主线程（无 agentId）且模式开启时，把不属于目标系列的请求改成该档主线程模型。 */
export function pickModel(mode, e) {
  if (!mode || e.agentId) return e.model;
  const main = MODES[mode].mainModel;
  const family = main === OPUS_MODEL ? /opus/i : /sonnet/i;
  return family.test(e.model) ? e.model : main;
}

async function effortNote($, mode) {
  const env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL');
  const settings = await $.settings.read().catch(() => ({}));
  const level = env || settings.effortLevel;
  const bump = mode && MODES[mode].bumpEffort ? '；质量档下插件会在此基础上自动提高一档' : '';
  if (!level || level === 'auto') return `推理强度：auto（模型默认）${bump}`;
  return `推理强度：当前固定为 ${level}${env ? '（环境变量 CLAUDE_CODE_EFFORT_LEVEL）' : '（settings.effortLevel）'}${bump}；要用 auto 请执行 /effort auto${env ? ' 并移除该环境变量' : ''}`;
}

async function status($) {
  const mode = await activeMode($);
  const lines = [`opus-orchestra：${mode ? `已开启（${MODES[mode].label}档）` : '已关闭'}`];
  if (mode) {
    const m = MODES[mode];
    lines.push(`主线程模型：强制 ${m.mainModel}（子代理按各自定义：haiku-worker / sonnet-worker / opus-expert）`);
    lines.push(`交叉验证：两个 reviewer，model 分别为 ${m.review.join(' + ')}`);
  } else lines.push(`当前会话模型：${await $.session.model()}`);
  lines.push(await effortNote($, mode));
  return lines.join('\n');
}

async function stats($, args) {
  const scope = (args.trim().split(/\s+/)[0] || 'session').toLowerCase();
  if (!['session', 'project', 'all'].includes(scope)) return `未知范围：${scope}\n${HELP}`;
  const argv = ['node', `${$.plugin.root}/scripts/stats.js`, scope, '--session', await $.session.id(), '--cwd', await $.session.cwd()];
  const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: 120_000 });
  if (exitCode !== 0) return `统计失败（exit ${exitCode}）：${(stderr || stdout).trim()}`;
  return stdout.trimEnd();
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'orchestra', description: 'opus-orchestra：三档（质量/均衡/成本）分级派工与交叉验证模式', argumentHint: 'on|off|status|quality|balanced|cost' });
    await $.command.register({ name: 'orchestra-stats', description: 'opus-orchestra：token 与成本统计（对比纯 Opus）', argumentHint: 'session|project|all' });
    return next(e);
  });

  on('command.run', { command: 'orchestra' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (!arg) {
      await $.store.set(CURSOR_KEY, (await isOn($)) ? await getMode($) : 'off');
      await $.ui.open({ id: PICKER, title: 'opus-orchestra', focus: true, closeOnEscape: true, holdToasts: true, rows: 10 });
      return {};
    }
    if (Object.hasOwn(MODES, arg) || arg === 'off') await apply($, arg);
    else if (arg === 'on') await $.store.set(STORE_KEY, true);
    else if (arg !== 'status') return { text: `未知参数：${arg}\n${HELP}` };
    return { text: await status($) };
  });

  on('ui.render', { component: 'Pane', requestId: PICKER }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const cursor = await $.store.get(CURSOR_KEY);
    const value = LEVELS.find((x) => x === cursor) ?? 'off';
    // 由强到弱自上而下，↑ 往“更强”走。
    const rows = [...LEVELS].reverse().map((x) => Box({
      flexDirection: 'row',
      children: [
        x === value ? Text({ color: 'cyan', children: '▶ ' }) : Text({ dimColor: true, children: '│ ' }),
        Button({
          key: x,
          label: levelLabel(x),
          plain: true,
          ...(x === value ? { autoFocus: true } : {}),
          onPress: async () => {
            const label = await apply($, x);
            await $.ui.close({ id: PICKER });
            $.ui.toast(`opus-orchestra：${label}`);
          },
        }),
      ],
    }));
    return Box({
      flexDirection: 'column',
      paddingLeft: 2,
      children: [
        Text({ dimColor: true, children: '更强' }),
        ...rows,
        Text({ dimColor: true, children: '更省' }),
        Text({ children: ' ' }),
        Text({ dimColor: true, children: describeLevel(value) }),
        Text({ dimColor: true, children: '↑/↓ 调整 · Enter 确认 · Esc 取消' }),
      ],
    });
  });



  on('ui.focus', { requestId: PICKER }, async ($, e, next) => {
    if (LEVELS.includes(e.element)) {
      await $.store.set(CURSOR_KEY, e.element);
      $.ui.invalidate('ui.render');
    }
    return next(e);
  });

  on('command.run', { command: 'orchestra-stats' }, async ($, e) => ({ text: await stats($, e.args) }));

  on('prompt.submit', async ($, e, next) => {
    const mode = await activeMode($);
    return next(mode ? { ...e, context: [...(e.context ?? []), MODES[mode].rules] } : e);
  });

  on('turn.step', async function* ($, e, next) {
    const mode = await activeMode($);
    const model = pickModel(mode, e);
    const effort = mode && MODES[mode].bumpEffort ? bumpEffort(e.effort) : e.effort;
    return yield* next(model === e.model && effort === e.effort ? e : { ...e, model, effort });
  });
};
