// claude plugin test . —— 覆盖开关命令、三档模式、主线程模型与推理强度改写、派工规则注入。
import { describe, expect, mock, test } from 'claude-code/testing';

const PRESENTATION = { layout: 'main', columns: 80 };
const ORIGIN = { kind: 'composer' };

function world(on, store = {}, env = {}) {
  mock.store(on, store);
  mock.env(on, env);
  on('settings.read', () => ({ value: {} }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  const sent: string[] = [];
  const efforts: unknown[] = [];
  on('turn.step', async function* ($, e) {
    sent.push(e.model);
    efforts.push(e.effort);
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  return Object.assign(sent, { efforts });
}

async function step($, extra = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, ...extra });
  for await (const _ of stream) {
    // 测试底层不产出分块
  }
  return stream.result;
}

const run = ($, args) => $.command.run({ command: 'orchestra', args, origin: ORIGIN, presentation: PRESENTATION });

describe('opus-orchestra', () => {
  test('默认关闭：主线程模型不变', async ($, on) => {
    const sent = world(on);
    await step($);
    expect(sent).toEqual(['claude-sonnet-5-5']);
  });

  test('/orchestra on 后主线程强制 Opus，子代理不改', async ($, on) => {
    const sent = world(on);
    const { text } = await run($, 'on');
    expect(text).toContain('已开启');
    expect(text).toContain('推理强度：auto');
    await step($);
    await step($, { agentId: 'a1', model: 'claude-haiku-5-5' });
    expect(sent).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
  });

  test('/orchestra off 关闭后恢复', async ($, on) => {
    const sent = world(on, { enabled: true });
    const { text } = await run($, 'off');
    expect(text).toContain('已关闭');
    await step($);
    expect(sent).toEqual(['claude-sonnet-5-5']);
  });

  test('开启时注入派工规则', async ($, on) => {
    world(on, { enabled: true });
    const seen: unknown[] = [];
    on('prompt.submit', ($, e) => {
      seen.push(e.context);
      return { text: e.text };
    });
    await $.prompt.submit({ text: 'hi', wait: false, origin: ORIGIN });
    expect(String(seen[0])).toContain('opus-orchestra:haiku-worker');
  });

  test('effort 被固定时提示改回 auto', async ($, on) => {
    world(on, {}, { CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    const { text } = await run($, 'status');
    expect(text).toContain('当前固定为 high');
  });

  test('未知参数给出用法', async ($, on) => {
    world(on);
    const { text } = await run($, 'bogus');
    expect(text).toContain('用法');
  });

  test('默认档位 balanced，on 沿用已存的档位', async ($, on) => {
    world(on, { enabled: true });
    expect((await run($, 'status')).text).toContain('均衡档');
    await run($, 'off');
    await run($, 'cost');
    await run($, 'off');
    const { text } = await run($, 'on');
    expect(text).toContain('成本档');
  });

  test('/orchestra cost 后主线程变 Sonnet，子代理不受影响', async ($, on) => {
    const sent = world(on);
    const { text } = await run($, 'cost');
    expect(text).toContain('成本档');
    expect(text).toContain('haiku + sonnet');
    await step($, { model: 'claude-haiku-5-5' });
    await step($, { agentId: 'a1', model: 'claude-haiku-5-5' });
    await step($, { model: 'claude-opus-5-5' });
    expect(sent).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  test('/orchestra quality 后主线程和子代理 effort 提高一档，max 不变', async ($, on) => {
    const sent = world(on);
    const { text } = await run($, 'quality');
    expect(text).toContain('自动提高一档');
    await step($, { effort: 'high' });
    await step($, { agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'high' });
    await step($, { effort: 'max' });
    await step($);
    expect(sent.efforts).toEqual(['xhigh', 'xhigh', 'max', undefined]);
  });

  test('非质量档不改 effort', async ($, on) => {
    const sent = world(on);
    await run($, 'balanced');
    await step($, { effort: 'high' });
    expect(sent.efforts).toEqual(['high']);
  });

  test('每档规则都含 reviewer 交叉验证，质量档不派 haiku，成本档说明 Sonnet 主控', async ($, on) => {
    world(on);
    const seen: string[] = [];
    on('prompt.submit', ($, e) => {
      seen.push(String(e.context));
      return { text: e.text };
    });
    for (const mode of ['quality', 'balanced', 'cost']) {
      await run($, mode);
      await $.prompt.submit({ text: 'hi', wait: false, origin: ORIGIN });
    }
    const [quality, balanced, cost] = seen;
    for (const rules of seen) expect(rules).toContain('opus-orchestra:reviewer');
    expect(quality).not.toContain('opus-orchestra:haiku-worker');
    expect(quality).toContain('禁止使用 haiku-worker');
    expect(balanced).toContain('opus-orchestra:haiku-worker');
    expect(cost).toContain('Sonnet 主控');
    expect(cost).toContain('opus-orchestra:opus-expert');
  });

  test('/orchestra 不带参数打开滑块面板，不输出文字', async ($, on) => {
    world(on);
    const opened: string[] = [];
    on('ui.open', (_$, e) => {
      opened.push(e.id);
      return { value: { isPlaced: true } };
    });
    const r = await run($, '');
    expect(opened).toEqual(['orchestra-picker']);
    expect(r.text).toBeUndefined();
  });

  const mountPicker = ($) => $.ui.mount({ plugin: 'opus-orchestra', surface: 'terminal', component: 'Pane', props: { title: 'opus-orchestra' }, requestId: 'orchestra-picker' });

  test('滑块有四个档位按钮', async ($, on) => {
    world(on, { enabled: true, mode: 'cost' });
    on('ui.open', () => ({ value: { isPlaced: true } }));
    await run($, '');
    const ui = await mountPicker($);
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4);
    expect((await ui.find({ key: 'cost' }))?.text).toBe('成本');
    expect((await ui.find({ key: 'quality' }))?.text).toBe('质量');
    await ui.unmount();
  });

  test('滑块按下档位后写入 store，off 保留 mode', async ($, on) => {
    world(on);
    on('ui.open', () => ({ value: { isPlaced: true } }));
    on('ui.close', () => ({ value: {} }));
    on('ui.toast', () => ({ value: {} }));
    await run($, '');
    const ui = await mountPicker($);
    await ui.press({ key: 'quality' });
    expect((await run($, 'status')).text).toContain('质量档');
    await ui.press({ key: 'off' });
    const { text } = await run($, 'status');
    expect(text).toContain('已关闭');
    expect((await run($, 'on')).text).toContain('质量档');
  });

  test('焦点移动后说明行跟着变', async ($, on) => {
    world(on);
    on('ui.open', () => ({ value: { isPlaced: true } }));
    on('ui.focus', () => ({ value: {} }));
    await run($, '');
    const ui = await mountPicker($);
    expect(await ui.find({ type: 'Text', text: /不改模型/ })).toBeDefined();
    await $.ui.focus({ component: 'Pane', requestId: 'orchestra-picker', plugin: 'opus-orchestra', element: 'cost', origin: { kind: 'person' } });
    expect(await ui.find({ type: 'Text', text: /claude-sonnet-5-5/ })).toBeDefined();
  });
});
