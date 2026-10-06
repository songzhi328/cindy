/**
 * 官方 Telegram 进度载体: msg.op 版 TelegramProgressDeps + 个人 bot 同一生命周期。
 * 覆盖: 首帧 send / 后续 edit、HTML 被拒回落 plain、not modified 视为成功、429 按
 * retryAfterMs 退避并合并到最新帧、回执未知时 send 原 opId 重发、服务端声明本轮
 * 进度不归客户端时停手、finish 的同步冲刷。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_OP_ERROR_OUTCOME_UNKNOWN,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_RATE_LIMITED,
  type HookMessage,
  type HookMessageOpMessage,
  type MessageOpResultPayload,
} from '@cindy/slack-hook-protocol';

import {
  createMsgOpResultRouter,
  createOfficialTelegramProgressCarrier,
  isTelegramProgressOpId,
} from '../telegramProgressCarrier';

const THROTTLE_MS = 1500;
const log = { info: vi.fn(), warn: vi.fn() };

function harness(opts: { requestId?: string; resultTimeoutMs?: number } = {}) {
  const router = createMsgOpResultRouter();
  const sent: HookMessageOpMessage[] = [];
  let online = true;
  const send = (m: HookMessage): boolean => {
    if (!online) return false;
    sent.push(m as HookMessageOpMessage);
    return true;
  };
  const carrier = createOfficialTelegramProgressCarrier({
    connectionId: 'conn-1',
    requestId: opts.requestId ?? 'req-1',
    externalKey: 'telegram:group:bot:-100:u:g1',
    getSend: () => (online ? send : undefined),
    router,
    log,
    ...(opts.resultTimeoutMs !== undefined ? { resultTimeoutMs: opts.resultTimeoutMs } : {}),
  });
  const last = (): HookMessageOpMessage => sent[sent.length - 1]!;
  const reply = (result: Partial<MessageOpResultPayload> & { ok: boolean }): void => {
    router.settle({ opId: last().payload.opId, ...result });
  };
  return {
    router,
    carrier,
    sent,
    last,
    reply,
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushMicrotasks();
}

beforeEach(() => {
  vi.useFakeTimers();
  log.info.mockClear();
  log.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('官方 Telegram 进度载体(msg.op)', () => {
  it('首帧 send(HTML, purpose=turn-progress), 后续 edit 同一条消息', async () => {
    const h = harness();
    h.carrier.update('**工作中**');
    // 与个人 bot 同一尾沿节流: 窗口结束前不出站。
    expect(h.sent).toHaveLength(0);
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.last().payload).toMatchObject({
      requestId: 'req-1',
      purpose: 'turn-progress',
      scope: { externalKey: 'telegram:group:bot:-100:u:g1' },
      action: { kind: 'send', tier: 'html', text: '<b>工作中</b>' },
    });
    expect(isTelegramProgressOpId(h.last().payload.opId)).toBe(true);
    h.reply({ ok: true, messageId: '901' });
    await flushMicrotasks();

    h.carrier.update('**工作中**\n\n第二步');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.last().payload.action).toMatchObject({ kind: 'edit', messageId: '901', tier: 'html' });
    h.reply({ ok: true });
    await flushMicrotasks();
  });

  it('HTML 被拒(channelErrorCode=400) → 同一帧以 plain 原 markdown 重发, 换新 opId', async () => {
    const h = harness();
    h.carrier.update('坏 <标签');
    await advance(THROTTLE_MS);
    const htmlOp = h.last().payload;
    h.reply({ ok: false, channelErrorCode: 400, error: "Bad Request: can't parse entities" });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(2);
    const plainOp = h.last().payload;
    expect(plainOp.action).toMatchObject({ kind: 'send', tier: 'plain', text: '坏 <标签' });
    expect(plainOp.opId).not.toBe(htmlOp.opId);
    h.reply({ ok: true, messageId: '7' });
    await flushMicrotasks();

    // edit 的 400 回落剥标签纯文本(与个人 editHtml 同一判据)。
    h.carrier.update('**粗体** 后续');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, channelErrorCode: 400, error: "Bad Request: can't parse entities" });
    await flushMicrotasks();
    expect(h.last().payload.action).toMatchObject({
      kind: 'edit',
      messageId: '7',
      tier: 'plain',
      text: '粗体 后续',
    });
  });

  it('message is not modified 视为成功: 不回落、不重试', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: true, messageId: '1' });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS);
    h.reply({
      ok: false,
      channelErrorCode: 400,
      error: 'Bad Request: message is not modified: specified new message content is the same',
    });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(2);
    // 同一帧不会再发(已视为显示成功)。
    await advance(THROTTLE_MS * 3);
    expect(h.sent).toHaveLength(2);
  });

  it('429 按 retryAfterMs 退避, 期间的新帧合并, 窗口后只发最新一帧', async () => {
    const h = harness();
    h.carrier.update('第 1 帧');
    await advance(THROTTLE_MS);
    h.reply({ ok: true, messageId: '1' });
    await flushMicrotasks();

    h.carrier.update('第 2 帧');
    await advance(THROTTLE_MS);
    const limited = h.last().payload;
    h.reply({ ok: false, channelErrorCode: 429, retryAfterMs: 10_000, error: 'Too Many Requests' });
    await flushMicrotasks();
    // 退避期间新帧只进缓冲, 不出站。
    h.carrier.update('第 3 帧');
    await advance(THROTTLE_MS);
    h.carrier.update('第 4 帧');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(2);

    // retry_after 到点: 在途那次按 429 规则重试一次(新 opId), 之后合并发最新帧。
    await advance(10_000);
    expect(h.sent).toHaveLength(3);
    expect(h.last().payload.opId).not.toBe(limited.opId);
    h.reply({ ok: true });
    await flushMicrotasks();
    await advance(THROTTLE_MS);
    const texts = h.sent.map((m) => (m.payload.action as { text?: string }).text);
    expect(texts[texts.length - 1]).toBe('第 4 帧');
    expect(texts).not.toContain('第 3 帧');
  });

  it('回执未知(超时)时首帧 send 原样重发(同 opId 同正文), 对账成功后补 edit 到最新帧', async () => {
    const h = harness({ resultTimeoutMs: 5_000 });
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    const first = h.last().payload;
    await advance(5_000);
    h.carrier.update('A 继续');
    await advance(THROTTLE_MS);
    // 服务端按 opId + 内容指纹去重: 换正文会撞 IDEMPOTENCY_CONFLICT, 所以原样重发。
    expect(h.last().payload).toEqual(first);
    h.reply({ ok: true, messageId: '42' });
    await flushMicrotasks();
    expect(h.last().payload.action).toMatchObject({
      kind: 'edit',
      messageId: '42',
      text: 'A 继续',
    });
  });

  it('OUTCOME_UNKNOWN 与超时同处理: 不换 opId', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    const first = h.last().payload;
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_OUTCOME_UNKNOWN });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS);
    expect(h.last().payload).toEqual(first);
  });

  it('服务端限速拒收(RATE_LIMITED + retryAfterMs)按 429 退避', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_RATE_LIMITED, retryAfterMs: 4_000 });
    await flushMicrotasks();
    await advance(3_000);
    expect(h.sent).toHaveLength(1);
    await advance(1_000);
    expect(h.sent).toHaveLength(2);
    expect(h.last().payload.opId).toBe('req-1:progress:send:1');
  });

  it('发不出去(离线)不占在途槽, 恢复后以原 send opId 重试', async () => {
    const h = harness();
    h.setOnline(false);
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(0);
    h.setOnline(true);
    h.carrier.update('A 继续');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.last().payload.opId).toBe('req-1:progress:send:0');
  });

  it('明确失败后 send 换号, 不拿回同一份失败', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, error: 'boom' });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS);
    expect(h.last().payload.opId).toBe('req-1:progress:send:1');
  });

  it('服务端回 PROGRESS_UNAVAILABLE(私聊草稿 / 已收口) → 本轮不再发任何进度 op', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS * 3);
    expect(h.sent).toHaveLength(1);
  });

  it('NO_REPLY 哨兵(及其流式前缀)不落地 —— 与个人 driver 同一判据', async () => {
    const h = harness();
    h.carrier.update('NO_');
    await advance(THROTTLE_MS);
    h.carrier.update('NO_REPLY');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(0);
  });

  it('finish: 管道空闲时同步交出最新帧(先于随后的 turn.end), 之后永不出站', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: true, messageId: '1' });
    await flushMicrotasks();
    h.carrier.update('最后一帧');
    // 尾沿窗口还没到 —— finish 必须同步冲刷, 不能等定时器。
    h.carrier.finish();
    expect(h.sent).toHaveLength(2);
    expect(h.last().payload.action).toMatchObject({ kind: 'edit', text: '最后一帧' });
    h.carrier.update('迟到');
    await advance(THROTTLE_MS * 3);
    expect(h.sent).toHaveLength(2);
  });

  it('close 不冲刷; 关闭后迟到的 400 也不再回落', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.carrier.close();
    h.reply({ ok: false, channelErrorCode: 400, error: "can't parse entities" });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(1);
  });

  it('不同轮次的 opId 互不相同(按 requestId 派生), 回执不串轮', async () => {
    const a = harness({ requestId: 'req-a' });
    const b = harness({ requestId: 'req-b' });
    a.carrier.update('A');
    b.carrier.update('B');
    await advance(THROTTLE_MS);
    expect(a.last().payload.opId).not.toBe(b.last().payload.opId);
    // b 的回执投到 a 的路由器上: a 不认, 仍在等自己的。
    expect(a.router.settle({ opId: b.last().payload.opId, ok: true, messageId: '2' })).toBe(false);
  });
});

describe('createMsgOpResultRouter', () => {
  it('发送失败 / 断线 / 超时都以 null 收口, 不悬挂', async () => {
    const router = createMsgOpResultRouter();
    const msg = {} as HookMessage;
    await expect(router.request('c', () => false, msg, 'op-a')).resolves.toBeNull();

    const pending = router.request('c', () => true, msg, 'op-b');
    router.failConnection('c');
    await expect(pending).resolves.toBeNull();

    const timed = router.request('c', () => true, msg, 'op-c', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timed).resolves.toBeNull();

    const ok = router.request('c', () => true, msg, 'op-d');
    expect(router.settle({ opId: 'op-d', ok: true })).toBe(true);
    await expect(ok).resolves.toEqual({ opId: 'op-d', ok: true });
    expect(router.settle({ opId: 'op-d', ok: true })).toBe(false);
  });
});
