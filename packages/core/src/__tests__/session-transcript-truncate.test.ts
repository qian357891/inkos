import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTranscriptEvents, appendTranscriptEvents } from "../interaction/session-transcript.js";
import {
  findMessageSeqByUuid,
  truncateTranscriptToMessage,
  truncateTranscriptToSeq,
  readTranscriptRawLines,
  type TruncateResult,
} from "../interaction/session-transcript-truncate.js";
import type { TranscriptEvent } from "../interaction/session-transcript-schema.js";

const SESSION = "s-rewind";
const ROOT_TAG = "inkos-rewind-";

describe("session transcript truncate (Studio Restore/Retry)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), ROOT_TAG));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  // 构造一份 mock transcript：4 个 request，每个含一条 user + 一条 assistant message。
  // 通过 appendTranscriptEvents 直接控制每条的 seq 和 uuid。
  async function seedMultiTurnTranscript(): Promise<Map<string, number>> {
    // 返回 messageUuid -> 期望 seq 的 map
    const uuidToSeq = new Map<string, number>();

    await appendTranscriptEvents(projectRoot, SESSION, ({ nextSeq }) => {
      uuidToSeq.set("uuid-u1", nextSeq + 1);
      uuidToSeq.set("uuid-a1", nextSeq + 2);
      uuidToSeq.set("uuid-u2", nextSeq + 4);
      uuidToSeq.set("uuid-a2", nextSeq + 5);
      uuidToSeq.set("uuid-u3", nextSeq + 7);
      uuidToSeq.set("uuid-a3", nextSeq + 8);

      const events: TranscriptEvent[] = [
        {
          type: "session_created",
          version: 1,
          sessionId: SESSION,
          bookId: null,
          title: null,
          createdAt: 1,
          updatedAt: 1,
          seq: nextSeq,
          timestamp: 1,
        },
        {
          type: "message",
          version: 1,
          sessionId: SESSION,
          requestId: "r1",
          uuid: "uuid-u1",
          parentUuid: null,
          seq: nextSeq + 1,
          role: "user",
          timestamp: 2,
          message: { role: "user", content: "first user" },
        },
        {
          type: "message",
          version: 1,
          sessionId: SESSION,
          requestId: "r1",
          uuid: "uuid-a1",
          parentUuid: "uuid-u1",
          seq: nextSeq + 2,
          role: "assistant",
          timestamp: 3,
          message: { role: "assistant", content: [{ type: "text", text: "first reply" }] },
        },
        {
          type: "request_committed",
          version: 1,
          sessionId: SESSION,
          requestId: "r1",
          seq: nextSeq + 3,
          timestamp: 4,
        },
        {
          type: "message",
          version: 1,
          sessionId: SESSION,
          requestId: "r2",
          uuid: "uuid-u2",
          parentUuid: "uuid-a1",
          seq: nextSeq + 4,
          role: "user",
          timestamp: 5,
          message: { role: "user", content: "second user" },
        },
        {
          type: "message",
          version: 1,
          sessionId: SESSION,
          requestId: "r2",
          uuid: "uuid-a2",
          parentUuid: "uuid-u2",
          seq: nextSeq + 5,
          role: "assistant",
          timestamp: 6,
          message: { role: "assistant", content: [{ type: "text", text: "second reply" }] },
        },
        {
          type: "request_committed",
          version: 1,
          sessionId: SESSION,
          requestId: "r2",
          seq: nextSeq + 6,
          timestamp: 7,
        },
        {
          type: "message",
          version: 1,
          sessionId: SESSION,
          requestId: "r3",
          uuid: "uuid-u3",
          parentUuid: "uuid-a2",
          seq: nextSeq + 7,
          role: "user",
          timestamp: 8,
          message: { role: "user", content: "third user" },
        },
        {
          type: "message",
          version: 1,
          sessionId: SESSION,
          requestId: "r3",
          uuid: "uuid-a3",
          parentUuid: "uuid-u3",
          seq: nextSeq + 8,
          role: "assistant",
          timestamp: 9,
          message: { role: "assistant", content: [{ type: "text", text: "third reply" }] },
        },
        {
          type: "request_committed",
          version: 1,
          sessionId: SESSION,
          requestId: "r3",
          seq: nextSeq + 9,
          timestamp: 10,
        },
      ];
      return events;
    });

    return uuidToSeq;
  }

  it("findMessageSeqByUuid returns the matching seq", async () => {
    const uuidMap = await seedMultiTurnTranscript();

    for (const [uuid, expectedSeq] of uuidMap.entries()) {
      const seq = await findMessageSeqByUuid(projectRoot, SESSION, uuid);
      expect(seq, `uuid=${uuid}`).toBe(expectedSeq);
    }
  });

  it("findMessageSeqByUuid returns undefined for unknown uuid", async () => {
    await seedMultiTurnTranscript();
    const seq = await findMessageSeqByUuid(projectRoot, SESSION, "uuid-does-not-exist");
    expect(seq).toBeUndefined();
  });

  it("truncateTranscriptToSeq keeps only <= target events", async () => {
    await seedMultiTurnTranscript();
    const eventsBefore = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsBefore).toHaveLength(10);

    // 截到 uuid-u2（含 uuid-u2）= seq 5
    const result = await truncateTranscriptToSeq(projectRoot, SESSION, 5);
    expect(result).toEqual<TruncateResult>({
      targetSeq: 5,
      keptCount: 5,
      removedCount: 5,
    });

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(5);
    // 应当保留 seq 1..5
    expect(eventsAfter.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    // 最后一条 message 必须是 uuid-u2（包含 target）
    const lastMessage = eventsAfter.filter((event) => event.type === "message").at(-1);
    expect(lastMessage?.type === "message" && lastMessage.uuid).toBe("uuid-u2");
  });

  it("truncateTranscriptToMessage (uuid-based) is equivalent to truncateTranscriptToSeq", async () => {
    await seedMultiTurnTranscript();
    const seq = await findMessageSeqByUuid(projectRoot, SESSION, "uuid-a2");
    expect(seq).toBe(6);

    const result = await truncateTranscriptToMessage(projectRoot, SESSION, "uuid-a2");
    expect(result).toEqual<TruncateResult>({
      targetSeq: 6,
      keptCount: 6,
      removedCount: 4,
    });

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("truncateTranscriptToMessage returns undefined for unknown uuid (no-op)", async () => {
    await seedMultiTurnTranscript();
    const result = await truncateTranscriptToMessage(projectRoot, SESSION, "uuid-missing");
    expect(result).toBeUndefined();

    // 文件不受影响
    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(10);
  });

  it("truncate to seq 0 leaves an empty file (truncates everything including session_created)", async () => {
    await seedMultiTurnTranscript();
    // seq 0 意味着全部 > 0 的都删除 — 包括 session_created。
    // 实现上 truncate 只要 kept > 0 就写带换行的字符串，所以 kept=0 时写空文件。
    await truncateTranscriptToSeq(projectRoot, SESSION, 0);

    const lines = await readTranscriptRawLines(projectRoot, SESSION);
    expect(lines).toHaveLength(0);

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(0);
  });

  it("truncate to highest seq keeps everything (no-op)", async () => {
    await seedMultiTurnTranscript();
    const eventsBefore = await readTranscriptEvents(projectRoot, SESSION);
    const lastSeq = eventsBefore.at(-1)!.seq;

    const result = await truncateTranscriptToSeq(projectRoot, SESSION, lastSeq);
    expect(result.removedCount).toBe(0);

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter.map((event) => event.seq)).toEqual(
      eventsBefore.map((event) => event.seq),
    );
  });

  it("truncate preserves JSONL well-formed (raw lines are valid JSON)", async () => {
    await seedMultiTurnTranscript();
    await truncateTranscriptToSeq(projectRoot, SESSION, 5);

    const rawLines = await readTranscriptRawLines(projectRoot, SESSION);
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
