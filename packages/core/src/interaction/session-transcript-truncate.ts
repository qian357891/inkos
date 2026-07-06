/**
 * Transcript 截断到指定 message 之后。
 *
 * 用于实现 Studio Chat "Restore to here" / "Retry from here" 两类用户动作：
 * 截断 JSONL 文件，去掉 target message 之后的所有 events（包括它之后的
 * 同一 request / 后续 user 输入 / 后续 assistant 响应）。下次重新跑 model 时，
 * transcript 会按截断后的 events 重建上下文，自然回滚到 target message 之后的状态。
 *
 * 设计取舍：截断文件而不是追加"撤销"事件，因为：
 * 1. transcript 是事件流，append-only 已经有 seq 单调；截断文件等价于"那段历史不存在"
 * 2. 后续 readTranscriptEvents 不会读到截断行，下游 restoreAgentMessagesFromTranscript、
 *    committedMessageEvents 都基于 readTranscriptEvents，行为天然一致
 * 3. 避免反向事件的实现复杂度（撤销 request_started 等）
 *
 * 调用方：agent-session 的 rewindSessionToMessage、studio 的 /messages/:uuid/rewind 路由。
 */

import { writeFile, readFile } from "node:fs/promises";
import { readTranscriptEvents, transcriptPath } from "./session-transcript.js";
import { committedMessageEvents } from "./session-transcript-restore.js";
import type { SessionKind } from "./session-transcript-schema.js";

export interface TruncateResult {
  /** 截断的目标 seq。所有 <= targetSeq 的 events 都被保留；> targetSeq 的被丢弃。 */
  readonly targetSeq: number;
  /** 截断前的事件总数。 */
  readonly removedCount: number;
  /** 截断后保留的事件总数。 */
  readonly keptCount: number;
}

/**
 * Find the `seq` for a given message uuid across the transcript events.
 *
 * 只看 `type === "message"` 的 events，因为只有它们携带 uuid 字段。
 * 返回 undefined 表示找不到该 uuid（可能消息尚未持久化、uuid 错了、
 * 跨 session 引用了别的 sessionId 等）。
 */
export async function findMessageSeqByUuid(
  projectRoot: string,
  sessionId: string,
  messageUuid: string,
): Promise<number | undefined> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  for (const event of events) {
    if (event.type === "message" && event.uuid === messageUuid) {
      return event.seq;
    }
  }
  return undefined;
}

/**
 * Truncate the transcript file to everything <= targetSeq.
 *
 * 实现：用 readTranscriptEvents 拿到所有 events，过滤，写回 JSONL。
 * atomic：整段过滤后 writeFile，不写中间态，避免 partial 写入。
 */
export async function truncateTranscriptToSeq(
  projectRoot: string,
  sessionId: string,
  targetSeq: number,
): Promise<TruncateResult> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  if (events.length === 0) {
    return { targetSeq, removedCount: 0, keptCount: 0 };
  }

  const kept = events.filter((event) => event.seq <= targetSeq);
  const removed = events.length - kept.length;

  // 重新写整个 JSONL（按 seq 升序，与 readTranscriptEvents 的 sort 行为一致）
  const lines = kept
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((event) => JSON.stringify(event))
    .join("\n");

  if (lines.length === 0) {
    await writeFile(transcriptPath(projectRoot, sessionId), "", "utf-8");
  } else {
    await writeFile(transcriptPath(projectRoot, sessionId), `${lines}\n`, "utf-8");
  }

  return {
    targetSeq,
    removedCount: removed,
    keptCount: kept.length,
  };
}

/**
 * Convenience: 一次性 helper — 找 uuid 对应 seq，再 truncate 到那（含 target message）。
 */
export async function truncateTranscriptToMessage(
  projectRoot: string,
  sessionId: string,
  messageUuid: string,
): Promise<TruncateResult | undefined> {
  const targetSeq = await findMessageSeqByUuid(projectRoot, sessionId, messageUuid);
  if (targetSeq === undefined) return undefined;
  return truncateTranscriptToSeq(projectRoot, sessionId, targetSeq);
}

/**
 * Read-after-truncate helper — 用于测试和 caller 验证 truncate 是否生效。
 * 直接走 readFile 而不是 readTranscriptEvents，避开 schema safeParse 的吞错。
 */
export async function readTranscriptRawLines(
  projectRoot: string,
  sessionId: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(projectRoot, sessionId), "utf-8");
  } catch {
    return [];
  }
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * Convenience: 把 Studio frontend 的 array index 翻译成 transcript seq，再 truncate。
 *
 * 语义：committed message 是 `transcript` 中 request_committed 闭合的 message events，
 * 排序是按 seq。取第 messageIndex 条 committed message 的 seq，传给 truncateTranscriptToSeq。
 *
 * sessionKind（可选）：传入后与 session-transcript-restore 行为对齐，只取同 kind 的
 * committed message；不传则不过滤。与 store 派生保持一致，前端 ChatPage 不感知 kind。
 */
export async function truncateTranscriptToCommittedMessageIndex(
  projectRoot: string,
  sessionId: string,
  messageIndex: number,
  sessionKind?: SessionKind,
): Promise<TruncateResult | undefined> {
  if (!Number.isInteger(messageIndex) || messageIndex < 0) return undefined;
  const allEvents = await readTranscriptEvents(projectRoot, sessionId);
  const committed = committedMessageEvents(allEvents, sessionKind);
  const target = committed[messageIndex];
  if (!target) return undefined;
  return truncateTranscriptToSeq(projectRoot, sessionId, target.seq);
}
