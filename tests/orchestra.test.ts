// claude plugin test . —— 覆盖开关命令、主线程强制 Opus、子代理不改、派工规则注入。
import { describe, expect, mock, test } from 'claude-code/testing';

const PRESENTATION = { layout: 'main', columns: 80 };
const ORIGIN = { kind: 'composer' };

function world(on, store = {}, env = {}) {
  mock.store(on, store);
  mock.env(on, env);
  on('settings.read', () => ({ value: {} }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  const sent: string[] = [];
  on('turn.step', async function* ($, e) {
    sent.push(e.model);
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  return sent;
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
});
