// opus-orchestra：Opus 主控 + Sonnet/Haiku 分级派工模式（Claude Code mods 入口）。
// 运行在 mods 沙箱里（没有 Node API），统计交给 scripts/stats.js 子进程。

export const OPUS_MODEL = 'claude-opus-5-5';
export const STORE_KEY = 'enabled';

export const RULES = `[opus-orchestra 模式已开启] 你是 Opus 主控，目标是在保证质量的前提下尽量节省成本：
1. 你只负责理解需求、拆分任务、关键决策、整合结果和验收；能交给便宜模型的工作不要自己做。
2. 机械任务（按明确指令搜索/汇总、批量修改、格式化、照抄现有模式的小改动、运行命令整理输出）→ Agent 工具 subagent_type "opus-orchestra:haiku-worker"。
3. 需要理解上下文的常规任务（按规格实现、一般 bug 修复、写测试、代码审查、文档）→ "opus-orchestra:sonnet-worker"。
4. 升级：worker 返回 STATUS: BLOCKED / PARTIAL，或验收不通过 → Haiku 的任务升级给 sonnet-worker；Sonnet 仍失败 → "opus-orchestra:opus-expert" 或由你亲自处理。升级时附上前一层的汇报和已尝试的方法。
5. 极小的任务（一两个工具调用就能完成）直接自己做，派工开销反而更高。
6. 派工 prompt 写清目标、允许修改的文件、验收命令；彼此独立的任务并行派发。
7. 调用 Agent 工具时不要传 model 或 effort 参数：模型由代理定义决定，推理强度保持 auto（模型默认）。`;

const HELP = `用法：
/orchestra on      开启：主线程强制 Opus，按难度派工给 Haiku / Sonnet
/orchestra off     关闭
/orchestra status  查看状态（默认）
/orchestra-stats [session|project|all]  统计 token 与成本，并与纯 Opus 对比（默认 session）`;

// 读开关失败时按关闭处理，不阻断提问和模型请求。
const isOn = ($) => $.store.get(STORE_KEY).then((v) => v === true, () => false);

/** 主线程（无 agentId）且模式开启时，把非 Opus 请求改成 Opus。 */
export function pickModel(on, e) {
  if (!on || e.agentId || /opus/i.test(e.model)) return e.model;
  return OPUS_MODEL;
}

async function effortNote($) {
  const env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL');
  const settings = await $.settings.read().catch(() => ({}));
  const level = env || settings.effortLevel;
  if (!level || level === 'auto') return '推理强度：auto（模型默认）';
  return `推理强度：当前固定为 ${level}${env ? '（环境变量 CLAUDE_CODE_EFFORT_LEVEL）' : '（settings.effortLevel）'}；要用 auto 请执行 /effort auto${env ? ' 并移除该环境变量' : ''}`;
}

async function status($) {
  const on = await isOn($);
  return [
    `opus-orchestra：${on ? '已开启' : '已关闭'}`,
    on ? `主线程模型：强制 ${OPUS_MODEL}（子代理按各自定义：haiku-worker / sonnet-worker / opus-expert）` : `当前会话模型：${await $.session.model()}`,
    await effortNote($),
  ].join('\n');
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
    await $.command.register({ name: 'orchestra', description: 'opus-orchestra：开启/关闭 Opus 主控分级派工模式', argumentHint: 'on|off|status' });
    await $.command.register({ name: 'orchestra-stats', description: 'opus-orchestra：token 与成本统计（对比纯 Opus）', argumentHint: 'session|project|all' });
    return next(e);
  });

  on('command.run', { command: 'orchestra' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === 'on' || arg === 'off') await $.store.set(STORE_KEY, arg === 'on');
    else if (arg && arg !== 'status') return { text: `未知参数：${arg}\n${HELP}` };
    return { text: await status($) };
  });

  on('command.run', { command: 'orchestra-stats' }, async ($, e) => ({ text: await stats($, e.args) }));

  on('prompt.submit', async ($, e, next) => {
    const enabled = await isOn($);
    return next(enabled ? { ...e, context: [...(e.context ?? []), RULES] } : e);
  });

  on('turn.step', async function* ($, e, next) {
    const model = pickModel(await isOn($), e);
    return yield* next(model === e.model ? e : { ...e, model });
  });
};
