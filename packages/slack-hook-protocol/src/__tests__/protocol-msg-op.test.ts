/**
 * slack-hook-protocol 阶段 20(msg.op 消息操作动词)测试:
 *   1. 六种动作的构造 → 序列化 → 解析 round-trip
 *   2. 幂等键 opId 与授权锚点 scope.externalKey 缺失即拒收
 *   3. msg.op.result 的 messageId 契约(客户端后续 edit/delete/react 的唯一依据)
 *   4. 能力标识常量 msg-op-v1
 *   5. 老端兼容: 不认识 msg.op 的端按未知类型拒收(丢帧不断连语义)
 */

import { describe, it, expect } from 'vitest';

import {
  HOOK_FEATURE_MESSAGE_OPS,
  HOOK_FEATURE_TELEGRAM_PROGRESS_OPS,
  MESSAGE_OP_ERROR_OUTCOME_UNKNOWN,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  makeMessageOp,
  makeMessageOpResult,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type MessageOpAction,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  return parsed.message;
}

const SCOPE = { externalKey: 'telegram:group:bot:−100:111:g1' };

function op(action: MessageOpAction, opId = 'op-1') {
  return makeMessageOp({ opId, requestId: 'req-1', scope: SCOPE, action });
}

describe('msg.op 动词集', () => {
  it('能力标识为 msg-op-v1', () => {
    expect(HOOK_FEATURE_MESSAGE_OPS).toBe('msg-op-v1');
  });

  it('六种动作都能 round-trip 且形态原样保留', () => {
    const actions: MessageOpAction[] = [
      {
        kind: 'send',
        text: '已渲染的最终正文',
        replyToMessageId: '42',
        tier: 'rich',
        buttons: [[{ token: 'cdy:abc', label: '同意' }]],
      },
      { kind: 'edit', messageId: '43', text: '改后的正文', tier: 'html' },
      { kind: 'delete', messageId: '44' },
      { kind: 'react', targetMessageId: '45', emoji: '👍', big: true },
      { kind: 'typing' },
      {
        kind: 'media',
        album: true,
        items: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AAAA' }],
      },
    ];
    for (const action of actions) {
      const parsed = roundTrip(op(action));
      expect(parsed.type).toBe('msg.op');
      expect(parsed.payload).toMatchObject({ opId: 'op-1', scope: SCOPE, action });
    }
  });

  it('react 的空 emoji 是撤销语义, 合法', () => {
    const parsed = roundTrip(op({ kind: 'react', targetMessageId: '46', emoji: '' }));
    expect((parsed.payload as { action: { emoji: string } }).action.emoji).toBe('');
  });

  it('scope 携带 chatId / threadId 一律拒收(寻址权不在客户端)', () => {
    // 目标 chat 必须由服务端从 lane 记录里取。允许客户端指定, 一台被攻陷或有
    // bug 的桌面就能越过自己 lane 的边界往任意聊天发消息。
    for (const extra of [{ chatId: '-100999' }, { threadId: '7' }]) {
      const frame = JSON.parse(serializeHookMessage(op({ kind: 'typing' }))) as Record<
        string,
        unknown
      >;
      Object.assign((frame.payload as { scope: Record<string, unknown> }).scope, extra);
      const parsed = parseHookMessage(JSON.stringify(frame));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('resolves the target from externalKey');
    }
  });

  it('缺 opId 或 scope.externalKey 一律拒收', () => {
    // opId 是断连重发下不产生重复消息的唯一依据(Telegram 无发送端幂等键),
    // externalKey 是多租户授权锚点 —— 两者都不能让服务端"尽力而为"地猜。
    const base = op({ kind: 'typing' });
    const noOpId = JSON.parse(serializeHookMessage(base)) as Record<string, unknown>;
    (noOpId.payload as Record<string, unknown>).opId = '';
    expect(parseHookMessage(JSON.stringify(noOpId)).ok).toBe(false);

    const noKey = JSON.parse(serializeHookMessage(base)) as Record<string, unknown>;
    (noKey.payload as { scope: Record<string, unknown> }).scope = {};
    expect(parseHookMessage(JSON.stringify(noKey)).ok).toBe(false);
  });

  it('未知动作类型拒收', () => {
    const base = op({ kind: 'typing' });
    const bad = JSON.parse(serializeHookMessage(base)) as Record<string, unknown>;
    (bad.payload as { action: Record<string, unknown> }).action = { kind: 'teleport' };
    const parsed = parseHookMessage(JSON.stringify(bad));
    expect(parsed.ok).toBe(false);
  });

  it('msg.op.result 带 messageId 与相册全量 id, 并支持 retryAfterMs', () => {
    const ok = roundTrip(
      makeMessageOpResult({ opId: 'op-1', ok: true, messageId: '99', messageIds: ['99', '100'] }),
    );
    expect(ok.payload).toMatchObject({ ok: true, messageId: '99', messageIds: ['99', '100'] });

    const failed = roundTrip(
      makeMessageOpResult({ opId: 'op-2', ok: false, error: 'flood', retryAfterMs: 26_000 }),
    );
    // retry_after 全值透传, 不在协议层设上限 —— 固定 clamp 会让重试落回 flood 窗口。
    expect(failed.payload).toMatchObject({ ok: false, retryAfterMs: 26_000 });
  });

  it('老端按未知类型拒收整帧(丢帧不断连)', () => {
    const frame = JSON.parse(serializeHookMessage(op({ kind: 'typing' }))) as Record<
      string,
      unknown
    >;
    frame.type = 'msg.op.future-verb';
    const parsed = parseHookMessage(JSON.stringify(frame));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('unknown message type');
  });
});

/** 拿一帧合法信封换掉 payload(只让 payload 本身决定解析结果)。 */
function withPayload(message: HookMessage, payload: Record<string, unknown>): string {
  const frame = JSON.parse(serializeHookMessage(message)) as Record<string, unknown>;
  frame.payload = payload;
  return JSON.stringify(frame);
}

describe('telegram-progress-ops-v1: 进度消息由客户端渲染、经 msg.op 驱动', () => {
  it('能力标识与服务端同名', () => {
    expect(HOOK_FEATURE_TELEGRAM_PROGRESS_OPS).toBe('telegram-progress-ops-v1');
  });

  it('purpose=turn-progress 的 send / edit 原样 round-trip', () => {
    for (const action of [
      { kind: 'send', text: '<b>x</b>', tier: 'html', silent: true },
      { kind: 'edit', messageId: '9', text: 'x', tier: 'plain' },
    ] as MessageOpAction[]) {
      const parsed = roundTrip(
        makeMessageOp({ opId: 'req-1:progress:x', requestId: 'req-1', scope: SCOPE, action, purpose: 'turn-progress' }),
      );
      expect(parsed.payload).toMatchObject({ purpose: 'turn-progress', requestId: 'req-1', action });
    }
  });

  it('purpose 缺 requestId、用在非 send/edit、或取未知值一律拒收', () => {
    const cases: Array<Record<string, unknown>> = [
      { opId: 'a', scope: SCOPE, purpose: 'turn-progress', action: { kind: 'send', text: 'x' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'turn-progress', action: { kind: 'delete', messageId: '1' } },
      { opId: 'a', requestId: 'r', scope: SCOPE, purpose: 'final', action: { kind: 'send', text: 'x' } },
    ];
    for (const payload of cases) {
      const parsed = parseHookMessage(withPayload(op({ kind: 'typing' }), payload));
      expect(parsed.ok).toBe(false);
    }
  });

  it('不带 purpose 的 msg.op 与本能力出现前逐字相同(老帧照常解析)', () => {
    const parsed = roundTrip(op({ kind: 'send', text: 'x' }));
    expect((parsed.payload as { purpose?: unknown }).purpose).toBeUndefined();
  });

  it('msg.op.result 的 errorCode / channelErrorCode 可选; 类型错误拒收', () => {
    const channel = roundTrip(
      makeMessageOpResult({ opId: 'o', ok: false, error: "Bad Request: can't parse entities", channelErrorCode: 400 }),
    );
    expect(channel.payload).toMatchObject({ channelErrorCode: 400 });
    const server = roundTrip(
      makeMessageOpResult({ opId: 'o', ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE, channelErrorCode: null }),
    );
    expect(server.payload).toMatchObject({ errorCode: 'PROGRESS_UNAVAILABLE', channelErrorCode: null });
    expect(MESSAGE_OP_ERROR_OUTCOME_UNKNOWN).toBe('OUTCOME_UNKNOWN');
    for (const bad of [{ errorCode: '' }, { errorCode: 3 }, { channelErrorCode: '400' }, { channelErrorCode: 4.5 }]) {
      const parsed = parseHookMessage(
        withPayload(makeMessageOpResult({ opId: 'o', ok: false }), { opId: 'o', ok: false, ...bad }),
      );
      expect(parsed.ok).toBe(false);
    }
  });
});
