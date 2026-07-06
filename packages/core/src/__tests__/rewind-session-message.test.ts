import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendTranscriptEvents,
  readTranscriptEvents,
} from "../interaction/session-transcript.js";
import {
  rewindSessionToMessageIndex,
  type RewindResult,
} from "../agent/agent-session.js";
import type { TranscriptEvent } from "../interaction/session-transcript-schema.js";

const SESSION = "s-rewind-integration";

describe("rewindSessionToMessageIndex — transcript truncate + abort (Restore/Retry integration)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-rewind-int-"));
    await mkdir(join(projectRoot, "books", "book-a", "story"), { recursive: true });
    await writeFile(join(projectRoot, "books", "book-a", "story", "story_bible.md"), "测试书");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  /**
   * Seed 7 events total:
   * - session_created (seq=1)
   * - r1: user (seq=2) → assistant (seq=3) → request_committed (seq=4)
   * - r2: user (seq=5) → assistant (seq=6) → request_committed (seq=7)
   *
   * `committedMessageEvents` 会按 seq 排序后吐出 4 条 message（user+assistant×2）。
   * 所以 committed message index:
   *   0 → r1 user     (seq 2)
   *   1 → r1 assistant (seq 3)
   *   2 → r2 user     (seq 5)
   *   3 → r2 assistant (seq 6)
   */
  async function seedTranscript(): Promise<void> {
    await appendTranscriptEvents(projectRoot, SESSION, ({ nextSeq }) => {
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
          type: "message", version: 1, sessionId: SESSION, requestId: "r1",
          uuid: "uuid-r1-u", parentUuid: null, seq: nextSeq + 1, role: "user",
          timestamp: 2,
          message: { role: "user", content: "first ask" },
        },
        {
          type: "message", version: 1, sessionId: SESSION, requestId: "r1",
          uuid: "uuid-r1-a", parentUuid: "uuid-r1-u", seq: nextSeq + 2, role: "assistant",
          timestamp: 3,
          message: { role: "assistant", content: [{ type: "text", text: "first reply" }] },
        },
        {
          type: "request_committed", version: 1, sessionId: SESSION,
          requestId: "r1", seq: nextSeq + 3, timestamp: 4,
        },
        {
          type: "message", version: 1, sessionId: SESSION, requestId: "r2",
          uuid: "uuid-r2-u", parentUuid: "uuid-r1-a", seq: nextSeq + 4, role: "user",
          timestamp: 5,
          message: { role: "user", content: "second ask (will be removed by rewind)" },
        },
        {
          type: "message", version: 1, sessionId: SESSION, requestId: "r2",
          uuid: "uuid-r2-a", parentUuid: "uuid-r2-u", seq: nextSeq + 5, role: "assistant",
          timestamp: 6,
          message: { role: "assistant", content: [{ type: "text", text: "second reply" }] },
        },
        {
          type: "request_committed", version: 1, sessionId: SESSION,
          requestId: "r2", seq: nextSeq + 6, timestamp: 7,
        },
      ];
      return events;
    });
  }

  it("rewindSessionToMessageIndex(1) → r1 assistant (seq 3)，保留 events [1..3]", async () => {
    await seedTranscript();
    expect(await readTranscriptEvents(projectRoot, SESSION)).toHaveLength(7);

    const result = await rewindSessionToMessageIndex(projectRoot, SESSION, 1);
    expect(result.targetIndex).toBe(1);
    expect(result.truncated).toEqual<RewindResult["truncated"]>({
      targetSeq: 3,
      keptCount: 3,
      removedCount: 4,
    });
    expect(result.cacheEvicted).toBe(false);
    expect(result.aborted).toBe(false);

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(3);
    expect(eventsAfter.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("rewindSessionToMessageIndex(0) → r1 user (seq 2)，保留 [1..2]", async () => {
    // 把 r1 整段都删掉 → 第二轮 user 也跟着没了，只剩 session_created + r1 user。
    await seedTranscript();
    const result = await rewindSessionToMessageIndex(projectRoot, SESSION, 0);
    expect(result.truncated).toEqual({
      targetSeq: 2,
      keptCount: 2,
      removedCount: 5,
    });

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(2);
    expect(eventsAfter.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("rewindSessionToMessageIndex(3) → r2 assistant (seq 6)，保留 [1..6]", async () => {
    await seedTranscript();
    const result = await rewindSessionToMessageIndex(projectRoot, SESSION, 3);
    expect(result.truncated).toEqual({
      targetSeq: 6,
      keptCount: 6,
      removedCount: 1,
    });

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(6);
    expect(eventsAfter.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rewindSessionToMessageIndex(out-of-range) returns truncated=undefined and leaves file untouched", async () => {
    await seedTranscript();
    const result = await rewindSessionToMessageIndex(projectRoot, SESSION, 99);
    expect(result.truncated).toBeUndefined();
    expect(result.cacheEvicted).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.targetIndex).toBe(99);

    const eventsAfter = await readTranscriptEvents(projectRoot, SESSION);
    expect(eventsAfter).toHaveLength(7);
  });

  it("rewindSessionToMessageIndex(negative) returns truncated=undefined (no crash)", async () => {
    await seedTranscript();
    const result = await rewindSessionToMessageIndex(projectRoot, SESSION, -1);
    expect(result.truncated).toBeUndefined();
  });
});
