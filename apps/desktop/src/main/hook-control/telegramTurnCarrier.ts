/**
 * hook-control/telegramTurnCarrier.ts
 * ---------------------------------------------------------------------------
 * 官方 Telegram 一轮的**消息载体**: 进度消息(`telegram-progress-ops-v1`)与成功
 * 终稿(`telegram-final-ops-v1`)由本端渲染、经 msg.op 驱动, 服务端只执行(lane 授权、
 * 全局限速、调 Bot API、登记 route)。
 *
 * **不另写一套逻辑**: 生命周期(惰性占位、1.5s 尾沿节流、首帧 send 后续 edit、单帧
 * 上限、NO_REPLY 不落地、失败等下一窗口)与终稿收口(Rich → HTML → 纯文本、分段、
 * 落地后删过程载体)直接复用个人 bot 的同一个 handle(@cindy/im
 * `startTelegramTurnCarrier`); 渲染用同一个 `markdownToTelegramHtml`; HTML 被拒回落、
 * not modified、429 退避用同一组 `outboundPolicy` 判据。本模块只把
 * `TelegramStreamingDeps` 落到 msg.op 上:
 *   - 过程帧 send / edit / delete → `purpose: 'turn-progress'`(首帧 silent, 与服务端
 *     旧进度消息一致);
 *   - 终稿段 / Rich 终稿 → `purpose: 'turn-final'` + `finalPart`; 私聊首段挂完成特效;
 *   - 附件 → 终稿文字之后的 `media`(连续图片合成相册)。
 * 投递位置(topic、回复引用、owner 私聊改投)仍由服务端按这一轮的策略决定。
 *
 * 幂等: 过程帧首个 send 的 opId 只在拿到定案回执后换号, 回执未知时**原样**重发
 * (服务端按 opId + 内容指纹去重), 对账成功后补一次 edit 到最新帧。终稿段不在本端
 * 重试: 没有完整确认就以 `clientFinal.complete=false` 交回服务端, 服务端删掉已落地的
 * 客户端终稿段并照旧自己发布(见协议 HOOK_FEATURE_TELEGRAM_FINAL_OPS)。
 */

import {
  makeMessageOp,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  type MessageOpAction,
  type MessageOpPurpose,
  type MessageOpResultPayload,
  type TaskAttachment,
} from '@cindy/slack-hook-protocol';
import {
  callWithTelegramRateLimitRetry,
  chunkTelegramSource,
  editTelegramHtmlWithFallback,
  isTelegramBadRequest,
  markdownToTelegramHtml,
  sendTelegramHtmlWithFallback,
  startTelegramTurnCarrier,
  type TelegramStreamingDeps,
} from '@cindy/im';

import {
  abortableSleep,
  isMsgOpOutcomeUnknown,
  isMsgOpStopCode,
  msgOpErrorFromResult,
  TELEGRAM_OP_MARKER,
  TelegramMsgOpError,
  type MsgOpResultRouter,
  type MsgOpSendFn,
} from './telegramMsgOp.js';

/** 私聊成功终稿首段的完成特效(Telegram message_effect_id), 与服务端现行取值一致。 */
export const TELEGRAM_DM_COMPLETION_EFFECT_ID = '5107584321108051014';

/**
 * 服务端单轮附件上限(超出时服务端会发截断 / 超限提示, 那些提示文案在服务端)。
 * 超出任一条就不由本端发布终稿, 整轮交回服务端照旧处理。
 */
export const TELEGRAM_FINAL_ATTACHMENT_LIMITS = {
  maxItems: 10,
  maxItemBytes: 20 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
} as const;

/** 回执未知的 media 段最多原样重发几次(同 opId 同内容, 服务端幂等)。 */
const MEDIA_UNKNOWN_REPLAYS = 2;

const NO_REPLY = 'NO_REPLY';

export interface ClientFinalInput {
  status: 'ok' | 'error' | 'cancelled';
  finalText: string;
  attachments?: readonly TaskAttachment[];
}

/**
 * 这一轮的终稿能不能由本端发布。只覆盖普通成功轮次; 失败 / 取消 / 空正文 / NO_REPLY
 * (ambient 判定在服务端)/ 附件超出服务端单轮上限都交回服务端按 turn.end 照旧处理。
 */
export function isClientFinalEligible(input: ClientFinalInput): boolean {
  if (input.status !== 'ok') return false;
  const text = input.finalText.trim();
  if (text === '' || text === NO_REPLY) return false;
  const attachments = input.attachments ?? [];
  if (attachments.length > TELEGRAM_FINAL_ATTACHMENT_LIMITS.maxItems) return false;
  let total = 0;
  for (const attachment of attachments) {
    const bytes = base64Bytes(attachment.dataBase64);
    if (bytes > TELEGRAM_FINAL_ATTACHMENT_LIMITS.maxItemBytes) return false;
    total += bytes;
  }
  return total <= TELEGRAM_FINAL_ATTACHMENT_LIMITS.maxTotalBytes;
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** 附件按服务端现行规则成组: 连续 2–10 张图片合成相册, 其余逐条。 */
export function groupFinalAttachments(
  attachments: readonly TaskAttachment[],
): Array<{ items: TaskAttachment[]; album: boolean }> {
  const groups: Array<{ items: TaskAttachment[]; album: boolean }> = [];
  let run: TaskAttachment[] = [];
  const flushRun = (): void => {
    for (let i = 0; i < run.length; i += 10) {
      const items = run.slice(i, i + 10);
      groups.push({ items, album: items.length >= 2 });
    }
    run = [];
  };
  for (const attachment of attachments) {
    if (attachment.mimeType.startsWith('image/')) {
      run.push(attachment);
      continue;
    }
    flushRun();
    groups.push({ items: [attachment], album: false });
  }
  flushRun();
  return groups;
}

export interface OfficialTelegramTurnCarrierDeps {
  connectionId: string;
  requestId: string;
  externalKey: string;
  /** 私聊 lane(终稿首段挂完成特效)。 */
  directMessage: boolean;
  /** 该连接**当前**的发送函数; 断线时 undefined。每次出站现取, 不缓存旧 socket。 */
  getSend: () => MsgOpSendFn | undefined;
  router: MsgOpResultRouter;
  log: { info(msg: string): void; warn(msg: string): void };
  resultTimeoutMs?: number;
}

export interface OfficialTelegramTurnCarrier {
  /** 交一帧最新快照(markdown), 按个人 bot 同一节流出站。 */
  update(markdown: string): void;
  /**
   * 不由本端发布终稿时的收口: 立即冲刷最新帧后永久停止。冲刷在同步阶段就把 msg.op
   * 交给连接(管道空闲时), 所以它在 wire 上排在随后的 turn.end 之前; 管道正忙则这一帧
   * 放弃 —— 终稿随后由服务端发布, 不为一帧过程态推迟 turn.end。
   */
  finish(): void;
  /**
   * 由本端发布成功终稿(调用方先确认 isClientFinalEligible 与能力协商)。
   * 返回 true = 全部终稿段与附件都拿到成功回执(turn.end 带 clientFinal.complete=true);
   * false = 没有完整确认, 交回服务端。之后载体永久停止。
   */
  publishFinal(input: ClientFinalInput): Promise<boolean>;
  /** 撤销 / 断线隔离 / 换账号: 永久停止, 不冲刷。幂等。 */
  close(): void;
}

/** 一轮的官方消息载体: msg.op 版 TelegramStreamingDeps + 个人 bot 同一个 handle。 */
export function createOfficialTelegramTurnCarrier(
  deps: OfficialTelegramTurnCarrierDeps,
): OfficialTelegramTurnCarrier {
  const { connectionId, requestId, externalKey, router, log } = deps;
  let closed = false;
  /**
   * 服务端说这一轮的**进度**不归本端(私聊草稿模式由服务端按 turn.progress 出草稿)。
   * 只停进度 op; 终稿仍可由本端发布(那时没有过程载体, finalize 直接新发)。
   */
  let progressStopped = false;
  /** 这一轮整体不归本端(已收口 / 不属于该设备 / 契约错误 / 回执违约) —— 不再出站。 */
  let turnStopped = false;
  let progressSendSeq = 0;
  let progressEditSeq = 0;
  let progressDeleteSeq = 0;
  /** 每个终稿段的 opId 序号: 只在拿到明确失败(含 429 / HTML 400 回落)后换号。 */
  const finalAttempt = new Map<number, number>();
  /** 已用过的最大终稿段号(Rich / HTML 段之后的附件从下一段起编号)。 */
  let lastFinalPart = -1;
  const abort = new AbortController();
  const sleep = abortableSleep(abort.signal);
  const isLive = (): boolean => !closed && !turnStopped;
  const isProgressLive = (): boolean => isLive() && !progressStopped;

  /**
   * 回执未知的过程帧首个 send。服务端按 opId + 内容指纹去重, 所以下一次 send 必须
   * **原样**重发它(同 opId 同正文)对账, 不能沿用 opId 换正文(IDEMPOTENCY_CONFLICT),
   * 也不能换 opId(可能多建一条)。
   */
  let unresolvedProgressSend: { opId: string; action: MessageOpAction } | null = null;
  /** 最近一次过程帧 send 是在原样重发更早的帧(显示的不是本次要发的内容)。 */
  let lastProgressSendReplayed = false;

  async function request(
    opId: string,
    purpose: MessageOpPurpose,
    action: MessageOpAction,
    finalPart?: number,
  ): Promise<MessageOpResultPayload | null> {
    if (purpose === 'turn-progress' ? !isProgressLive() : !isLive()) {
      throw new TelegramMsgOpError('telegram turn carrier is closed');
    }
    const send = deps.getSend();
    if (!send) throw new TelegramMsgOpError('telegram turn carrier is offline');
    return router.request(
      connectionId,
      send,
      makeMessageOp({
        opId,
        requestId,
        scope: { externalKey },
        purpose,
        ...(finalPart !== undefined ? { finalPart } : {}),
        action,
      }),
      opId,
      deps.resultTimeoutMs,
    );
  }

  /** 定案的失败回执: 停手码让本轮停止出站, 其余映射成同形错误抛给 outboundPolicy。 */
  function failed(result: MessageOpResultPayload): TelegramMsgOpError {
    if (result.errorCode === MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE) {
      progressStopped = true;
      log.info(
        `telegram progress ops unavailable for ${requestId}; leaving progress to the server`,
      );
    } else if (isMsgOpStopCode(result)) {
      turnStopped = true;
      log.info(
        `telegram turn ops stopped for ${requestId} (${result.errorCode}); leaving the rest to the server`,
      );
    }
    return msgOpErrorFromResult(result);
  }

  async function progressOp(requested: MessageOpAction): Promise<MessageOpResultPayload> {
    let opId: string;
    let action = requested;
    if (requested.kind === 'send') {
      if (unresolvedProgressSend !== null) {
        ({ opId, action } = unresolvedProgressSend);
        lastProgressSendReplayed = action.kind === 'send' && action.text !== requested.text;
      } else {
        opId = `${requestId}${TELEGRAM_OP_MARKER.progress}send:${progressSendSeq}`;
        unresolvedProgressSend = { opId, action };
        lastProgressSendReplayed = false;
      }
    } else if (requested.kind === 'edit') {
      opId = `${requestId}${TELEGRAM_OP_MARKER.progress}edit:${++progressEditSeq}`;
    } else {
      opId = `${requestId}${TELEGRAM_OP_MARKER.progress}delete:${++progressDeleteSeq}`;
    }
    const result = await request(opId, 'turn-progress', action);
    // 回执未知: send 保持 unresolvedProgressSend, 下一窗口原样重发对账。
    if (isMsgOpOutcomeUnknown(result)) {
      throw new TelegramMsgOpError(`telegram msg.op ${opId} outcome unknown`);
    }
    const settled = result!;
    if (action.kind === 'send') {
      unresolvedProgressSend = null;
      if (!settled.ok) progressSendSeq += 1;
    }
    if (settled.ok) return settled;
    throw failed(settled);
  }

  /** 终稿段: 不在本端对未知回执重试(交回服务端), 明确失败换号以便回落重发。 */
  async function finalOp(part: number, action: MessageOpAction): Promise<MessageOpResultPayload> {
    lastFinalPart = Math.max(lastFinalPart, part);
    const attempt = finalAttempt.get(part) ?? 0;
    const opId = `${requestId}${TELEGRAM_OP_MARKER.final}${part}:${attempt}`;
    const result = await request(opId, 'turn-final', action, part);
    if (isMsgOpOutcomeUnknown(result)) {
      throw new TelegramMsgOpError(`telegram msg.op ${opId} outcome unknown`);
    }
    const settled = result!;
    if (settled.ok) return settled;
    finalAttempt.set(part, attempt + 1);
    throw failed(settled);
  }

  const messageIdOf = (result: MessageOpResultPayload, what: string): string => {
    const id = result.messageId ?? result.messageIds?.[0] ?? null;
    if (id !== null) return id;
    // 违约回执: 没有 messageId 就无法 edit / 删除, 再发只会多建消息。本轮停手。
    turnStopped = true;
    log.warn(`telegram ${what} for ${requestId} succeeded without a messageId; stopping`);
    throw new TelegramMsgOpError(`telegram ${what} returned no messageId`);
  };

  const effectFor = (part: number): { effectId?: string } =>
    part === 0 && deps.directMessage ? { effectId: TELEGRAM_DM_COMPLETION_EFFECT_ID } : {};

  const retry = <T>(call: () => Promise<T>, live: () => boolean = isLive): Promise<T> =>
    callWithTelegramRateLimitRetry(call, { sleep, isLive: live });

  const streamingDeps: TelegramStreamingDeps = {
    async send(markdown) {
      const { html } = markdownToTelegramHtml(markdown);
      const result = await sendTelegramHtmlWithFallback(html, markdown, (text, parseHtml) =>
        retry(
          () =>
            progressOp({ kind: 'send', text, tier: parseHtml ? 'html' : 'plain', silent: true }),
          isProgressLive,
        ),
      );
      const messageId = messageIdOf(result, 'progress send');
      // 对账拿回的是更早那一帧: 尽力补一次 edit 到本帧, 失败交给下一窗口。
      if (lastProgressSendReplayed) {
        lastProgressSendReplayed = false;
        await streamingDeps.edit(messageId, markdown).catch(() => undefined);
      }
      return messageId;
    },
    async edit(messageId, markdown) {
      const { html } = markdownToTelegramHtml(markdown);
      await editTelegramHtmlWithFallback(html, async (text, parseHtml) => {
        await retry(
          () => progressOp({ kind: 'edit', messageId, text, tier: parseHtml ? 'html' : 'plain' }),
          isProgressLive,
        );
      });
    },
    async deleteMessage(messageId) {
      await progressOp({ kind: 'delete', messageId });
    },
    async sendFinalChunk(markdown, part) {
      const { html } = markdownToTelegramHtml(markdown);
      const result = await sendTelegramHtmlWithFallback(html, markdown, (text, parseHtml) =>
        retry(() =>
          finalOp(part, {
            kind: 'send',
            text,
            tier: parseHtml ? 'html' : 'plain',
            ...effectFor(part),
          }),
        ),
      );
      return messageIdOf(result, 'final send');
    },
    async sendFinal(markdown) {
      // Rich 是终稿的新消息; Telegram 明确拒绝(4xx)= 本条 Rich 不可用, 交给 finalize
      // 回落 HTML。拿不到应答 / 服务端拒绝码必须抛出, 不能伪装成可安全降级。
      try {
        const result = await retry(() =>
          finalOp(0, { kind: 'send', text: markdown, tier: 'rich', ...effectFor(0) }),
        );
        return messageIdOf(result, 'rich final');
      } catch (err) {
        if (isTelegramBadRequest(err) || (err as { errorCode?: number }).errorCode === 404) {
          return null;
        }
        throw err;
      }
    },
    // 官方终稿的受管图片已由 runner 收成附件、正文里的引用已剥掉: 这里不会有图片
    // 引用, 附件在 finalize 之后经 media 单独发布。
    chunk: chunkTelegramSource,
    extractImageUrls: () => [],
    uploadImages: async () => {
      throw new Error('official telegram finals publish attachments via msg.op media');
    },
  };
  const carrier = startTelegramTurnCarrier(streamingDeps);

  async function publishAttachments(attachments: readonly TaskAttachment[]): Promise<boolean> {
    for (const group of groupFinalAttachments(attachments)) {
      const part = lastFinalPart + 1;
      const action: MessageOpAction = {
        kind: 'media',
        album: group.album,
        items: group.items.map((item, index) => ({
          // 协议要求非空文件名; 出站附件缺名时按段内序号命名(与 desktop 入站落盘同一习惯)。
          name: item.name || `attachment-${part}-${index + 1}`,
          mimeType: item.mimeType,
          dataBase64: item.dataBase64,
        })),
      };
      let delivered = false;
      for (let replay = 0; replay <= MEDIA_UNKNOWN_REPLAYS && !delivered; replay += 1) {
        try {
          await retry(() => finalOp(part, action));
          delivered = true;
        } catch (err) {
          // 未知回执: 同 opId 同内容原样重发(finalOp 只在明确失败时换号)。
          if (err instanceof TelegramMsgOpError && err.errorCode === undefined && !err.serverCode) {
            continue;
          }
          log.warn(
            `telegram final attachment for ${requestId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        }
      }
      if (!delivered) return false;
    }
    return true;
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    abort.abort();
    carrier.close();
  };

  return {
    update(markdown) {
      if (!isProgressLive()) return;
      carrier.replace(markdown);
    },
    finish() {
      if (closed) return;
      if (isProgressLive()) void carrier.flush();
      close();
    },
    async publishFinal(input) {
      if (closed || turnStopped || !isClientFinalEligible(input)) {
        close();
        return false;
      }
      try {
        await carrier.finalize(input.finalText);
        if (!isLive()) return false;
        return await publishAttachments(input.attachments ?? []);
      } catch (err) {
        log.warn(
          `telegram client final for ${requestId} not confirmed; handing back to the server: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      } finally {
        close();
      }
    },
    close,
  };
}
