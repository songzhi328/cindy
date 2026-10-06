/**
 * hook-control/telegramProgressCarrier.ts
 * ---------------------------------------------------------------------------
 * 官方 Telegram 一轮的**进度消息**: 双方协商 `telegram-progress-ops-v1` 后由本端
 * 渲染、经 `msg.op`(`purpose: 'turn-progress'`)驱动, 服务端只执行(lane 授权、
 * 全局限速、调 Bot API), 不再拿 turn.progress 渲染 —— turn.progress 仍由
 * dispatcher 照发, 服务端靠它续 lease。
 *
 * **不另写一套进度逻辑**: 生命周期(惰性占位、1.5s 尾沿节流、首帧 send 后续 edit、
 * 单帧上限、NO_REPLY 不落地、失败等下一窗口)直接复用个人 bot 的
 * `startTelegramProgressCarrier`(@cindy/im streamingText); 渲染用同一个
 * `markdownToTelegramHtml`; HTML 被拒回落、not modified、429 退避用同一组
 * `outboundPolicy` 判据。本模块只做一件事: 把 `TelegramProgressDeps` 的 send / edit
 * 落到 msg.op 上, 并把 `msg.op.result` 映射回与 Bot API 错误同形的错误。
 *
 * 幂等: 首帧 `send` 的 opId 由 requestId 派生, 只在拿到定案回执后换号。发不出去 /
 * 回执超时 / 断线 / OUTCOME_UNKNOWN 这类"不知道服务端执行没执行"的情形, 下一窗口
 * **原样**重发那一次 send(同 opId 同正文; 服务端按 opId + 内容指纹去重, 返回首次
 * 结果), 不会多建一条进度消息(Telegram 无发送端幂等键); 对账成功后再补一次 edit。
 *
 * 首帧带 `silent: true`(disable_notification), 与服务端旧进度消息一致; 回复引用与
 * topic 仍由服务端按这一轮的策略决定(不传 replyToMessageId)。
 */

import {
  makeMessageOp,
  MESSAGE_OP_ERROR_BINDING_REVOKED,
  MESSAGE_OP_ERROR_MESSAGE_NOT_OWNED,
  MESSAGE_OP_ERROR_OUTCOME_UNKNOWN,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_RATE_LIMITED,
  MESSAGE_OP_ERROR_UNSUPPORTED_PARAMETERS,
  type HookMessage,
  type MessageOpAction,
  type MessageOpResultPayload,
} from '@cindy/slack-hook-protocol';
import {
  callWithTelegramRateLimitRetry,
  editTelegramHtmlWithFallback,
  markdownToTelegramHtml,
  sendTelegramHtmlWithFallback,
  startTelegramProgressCarrier,
  type TelegramProgressCarrier,
  type TelegramProgressDeps,
} from '@cindy/im';

/** 等 msg.op.result 的时限; 过时按"回执未知"处理(send 下一窗口原 opId 重发)。 */
export const TELEGRAM_PROGRESS_OP_RESULT_TIMEOUT_MS = 30_000;

const PROGRESS_OP_MARKER = ':progress:';

/** 这条回执属于某一轮的进度操作吗(opId 由本模块派生)。 */
export function isTelegramProgressOpId(opId: string): boolean {
  return opId.includes(PROGRESS_OP_MARKER);
}

type SendFn = (m: HookMessage) => boolean;

/**
 * msg.op 请求/回执配对。dispatcher 持有一份, 所有轮次共用: 回执按 opId 路由回
 * 等待方; 发不出去、超时、连接断开都以 null(回执未知)收口, 绝不悬挂。
 */
export interface MsgOpResultRouter {
  request(
    connectionId: string,
    send: SendFn,
    message: HookMessage,
    opId: string,
    timeoutMs?: number,
  ): Promise<MessageOpResultPayload | null>;
  /** 回执入口; 有人在等这个 opId 返回 true。 */
  settle(payload: MessageOpResultPayload): boolean;
  /** 连接断开: 该连接上在等的回执不会再来。 */
  failConnection(connectionId: string): void;
  /** 账号切换 / dispose。 */
  failAll(): void;
}

export function createMsgOpResultRouter(): MsgOpResultRouter {
  const waiters = new Map<
    string,
    { connectionId: string; settle: (r: MessageOpResultPayload | null) => void }
  >();
  return {
    request(connectionId, send, message, opId, timeoutMs = TELEGRAM_PROGRESS_OP_RESULT_TIMEOUT_MS) {
      return new Promise((resolve) => {
        // 同一 opId 的旧等待方(幂等重发)以"未知"让位: 回执只会来一次, 归最新的等待方。
        waiters.get(opId)?.settle(null);
        const timer = setTimeout(() => settle(null), timeoutMs);
        timer.unref?.();
        const settle = (result: MessageOpResultPayload | null): void => {
          clearTimeout(timer);
          if (waiters.get(opId)?.settle === settle) waiters.delete(opId);
          resolve(result);
        };
        waiters.set(opId, { connectionId, settle });
        let transmitted = false;
        try {
          transmitted = send(message);
        } catch {
          transmitted = false;
        }
        if (!transmitted) settle(null);
      });
    },
    settle(payload) {
      const waiter = waiters.get(payload.opId);
      if (!waiter) return false;
      waiter.settle(payload);
      return true;
    },
    failConnection(connectionId) {
      for (const waiter of [...waiters.values()]) {
        if (waiter.connectionId === connectionId) waiter.settle(null);
      }
    },
    failAll() {
      for (const waiter of [...waiters.values()]) waiter.settle(null);
    },
  };
}

/**
 * msg.op 失败映射成与 Bot API `TelegramApiError` 同形的错误, 让 outboundPolicy 的
 * 判据原样生效: `errorCode` = Telegram 原生 error_code(服务端透传), `message` 含
 * Telegram 原文。回执未知时**不带** errorCode —— 那时不能判断 Telegram 是否已接收。
 */
export class TelegramMsgOpError extends Error {
  readonly name = 'TelegramMsgOpError';
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfterSec?: number,
    /** 服务端自己判定的结构化拒绝码(未调 Bot API)。 */
    readonly serverCode?: string,
  ) {
    super(message);
  }
}

/**
 * 服务端拒绝码里"本轮进度别再发了"的那几种: 进度不归本端 / 契约错误 / 消息不归属 /
 * 绑定已撤。其余明确失败(IDEMPOTENCY_CONFLICT / CAPACITY_REACHED / PERSIST_FAILED /
 * 不认识的码)只让这一帧失败, 下一窗口换 opId 再试。
 */
const STOP_CODES: ReadonlySet<string> = new Set([
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_UNSUPPORTED_PARAMETERS,
  MESSAGE_OP_ERROR_MESSAGE_NOT_OWNED,
  MESSAGE_OP_ERROR_BINDING_REVOKED,
]);

function errorFromResult(result: MessageOpResultPayload): TelegramMsgOpError {
  // 服务端限速队列的拒收(RATE_LIMITED + retryAfterMs)与渠道 429 同一处理。
  const rateLimited =
    result.errorCode === MESSAGE_OP_ERROR_RATE_LIMITED || typeof result.retryAfterMs === 'number';
  const errorCode =
    typeof result.channelErrorCode === 'number'
      ? result.channelErrorCode
      : rateLimited
        ? 429
        : undefined;
  const retryAfterSec =
    typeof result.retryAfterMs === 'number' ? result.retryAfterMs / 1000 : undefined;
  return new TelegramMsgOpError(
    `telegram msg.op ${result.opId} failed: ${errorCode ?? ''} ${result.error ?? result.errorCode ?? 'unknown'}`.trim(),
    errorCode,
    retryAfterSec,
    result.errorCode ?? undefined,
  );
}

export interface OfficialTelegramProgressCarrierDeps {
  connectionId: string;
  requestId: string;
  externalKey: string;
  /** 该连接**当前**的发送函数; 断线时 undefined。每次出站现取, 不缓存旧 socket。 */
  getSend: () => SendFn | undefined;
  router: MsgOpResultRouter;
  log: { info(msg: string): void; warn(msg: string): void };
  resultTimeoutMs?: number;
}

export interface OfficialTelegramProgressCarrier {
  /** 交一帧最新快照(markdown), 按个人 bot 同一节流出站。 */
  update(markdown: string): void;
  /**
   * 终稿栅栏: 立即冲刷最新帧后永久停止。冲刷在同步阶段就把 msg.op 交给连接(管道
   * 空闲时), 所以它在 wire 上排在随后的 turn.end 之前; 管道正忙则这一帧放弃 ——
   * 终稿随后由服务端发布, 不为一帧过程态推迟 turn.end。
   */
  finish(): void;
  /** 撤销 / 断线隔离 / 换账号: 永久停止, 不冲刷。幂等。 */
  close(): void;
}

/** 一轮的官方进度载体: msg.op 版 TelegramProgressDeps + 个人 bot 同一生命周期。 */
export function createOfficialTelegramProgressCarrier(
  deps: OfficialTelegramProgressCarrierDeps,
): OfficialTelegramProgressCarrier {
  const { connectionId, requestId, externalKey, router, log } = deps;
  let closed = false;
  /** 服务端说这一轮的进度不归本端(私聊草稿 / 已收口), 或回执违约 —— 本轮不再出站。 */
  let unavailable = false;
  let sendSeq = 0;
  let editSeq = 0;
  const abort = new AbortController();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (abort.signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done(): void {
        abort.signal.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      abort.signal.addEventListener('abort', done, { once: true });
    });
  const isLive = (): boolean => !closed && !unavailable;

  /**
   * 回执未知的首帧 send(发不出去 / 超时 / 断线 / OUTCOME_UNKNOWN)。服务端按 opId +
   * 内容指纹去重, 所以下一次 send 必须**原样**重发它(同 opId 同正文)对账, 不能
   * 沿用 opId 换正文(会回 IDEMPOTENCY_CONFLICT), 也不能换 opId(可能多建一条)。
   */
  let unresolvedSend: { opId: string; action: MessageOpAction } | null = null;
  /** 最近一次 send 是在原样重发更早的帧(显示的不是本次要发的内容)。 */
  let lastSendReplayed = false;

  async function perform(requested: MessageOpAction): Promise<MessageOpResultPayload> {
    if (!isLive()) throw new TelegramMsgOpError('telegram progress carrier is closed');
    const send = deps.getSend();
    if (!send) throw new TelegramMsgOpError('telegram progress carrier is offline');
    let opId: string;
    let action = requested;
    if (requested.kind === 'send') {
      if (unresolvedSend !== null) {
        ({ opId, action } = unresolvedSend);
        lastSendReplayed = action.kind === 'send' && action.text !== requested.text;
      } else {
        opId = `${requestId}${PROGRESS_OP_MARKER}send:${sendSeq}`;
        unresolvedSend = { opId, action };
        lastSendReplayed = false;
      }
    } else {
      opId = `${requestId}${PROGRESS_OP_MARKER}edit:${++editSeq}`;
    }
    const result = await router.request(
      connectionId,
      send,
      makeMessageOp({
        opId,
        requestId,
        scope: { externalKey },
        purpose: 'turn-progress',
        action,
      }),
      opId,
      deps.resultTimeoutMs,
    );
    // 回执未知: send 保持 unresolvedSend, 下一窗口原样重发对账。
    if (result === null || result.errorCode === MESSAGE_OP_ERROR_OUTCOME_UNKNOWN) {
      throw new TelegramMsgOpError(`telegram msg.op ${opId} outcome unknown`);
    }
    // 其余回执都是定案: 同号重发只会拿回同一结果, send 换号。
    if (action.kind === 'send') {
      unresolvedSend = null;
      if (!result.ok) sendSeq += 1;
    }
    if (result.ok) return result;
    if (
      result.errorCode !== null &&
      result.errorCode !== undefined &&
      STOP_CODES.has(result.errorCode)
    ) {
      unavailable = true;
      log.info(
        `telegram progress ops stopped for ${requestId} (${result.errorCode}); leaving progress to the server`,
      );
    }
    throw errorFromResult(result);
  }

  const progressDeps: TelegramProgressDeps = {
    async send(markdown) {
      const { html } = markdownToTelegramHtml(markdown);
      const result = await sendTelegramHtmlWithFallback(html, markdown, (text, parseHtml) =>
        callWithTelegramRateLimitRetry(
          () => perform({ kind: 'send', text, tier: parseHtml ? 'html' : 'plain', silent: true }),
          { sleep, isLive },
        ),
      );
      const messageId = result.messageId ?? result.messageIds?.[0] ?? null;
      if (messageId === null) {
        // 违约回执: 没有 messageId 就无法 edit, 再 send 只会多建消息。本轮停手。
        unavailable = true;
        log.warn(`telegram progress send for ${requestId} succeeded without a messageId; stopping`);
        throw new TelegramMsgOpError('telegram progress send returned no messageId');
      }
      // 对账拿回的是更早那一帧: 尽力补一次 edit 到本帧, 失败交给下一窗口。
      if (lastSendReplayed) {
        lastSendReplayed = false;
        await progressDeps.edit(messageId, markdown).catch(() => undefined);
      }
      return messageId;
    },
    async edit(messageId, markdown) {
      const { html } = markdownToTelegramHtml(markdown);
      await editTelegramHtmlWithFallback(html, async (text, parseHtml) => {
        await callWithTelegramRateLimitRetry(
          () => perform({ kind: 'edit', messageId, text, tier: parseHtml ? 'html' : 'plain' }),
          { sleep, isLive },
        );
      });
    },
  };
  const carrier: TelegramProgressCarrier = startTelegramProgressCarrier(progressDeps);

  const close = (): void => {
    if (closed) return;
    closed = true;
    abort.abort();
    carrier.close();
  };

  return {
    update(markdown) {
      if (!isLive()) return;
      carrier.replace(markdown);
    },
    finish() {
      if (closed) return;
      if (isLive()) void carrier.flush();
      close();
    },
    close,
  };
}
