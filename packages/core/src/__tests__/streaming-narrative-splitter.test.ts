import { describe, expect, it } from "vitest";
import { StreamingNarrativeSplitter, __test } from "../agent/agent-session.js";

void __test; // imported for parity with sanitize-visible-reply.test.ts; not used here.

function feedAll(splitter: StreamingNarrativeSplitter, ...chunks: string[]): { textDeltas: string[]; thinkingDeltas: string[] } {
  const textDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  for (const chunk of chunks) {
    const out = splitter.acceptTextDelta(chunk);
    textDeltas.push(...out.textDeltas);
    thinkingDeltas.push(...out.thinkingDeltas);
  }
  return { textDeltas, thinkingDeltas };
}

describe("StreamingNarrativeSplitter (zh mode)", () => {
  it("routes a fully-narrative streaming burst to thinking_deltas, normal chunks to text_deltas", () => {
    const splitter = new StreamingNarrativeSplitter("zh");

    // Simulate the realistic MiniMax-M3 streaming pattern: it intermixes
    // English narration paragraphs with the actual reply, splitting on \n\n.
    const { textDeltas, thinkingDeltas } = feedAll(
      splitter,
      "The user wants to add a setting: injuries sustained in the other world, when returning to reality will cause the same injury to manifest on the body within 1 day due to various accidents.\n\n",
      "这条设定已经写在 outline/story_frame.md 的「死亡与伤害兑现」小节。需要的话我可以帮你把它移到 pending_hooks.md 当显式钩子。\n\n",
      "Let me check the current truth files to be sure.\n\n",
    );
    // Flush any remaining in the buffer (none expected).
    const tail = splitter.flush();
    textDeltas.push(...tail.textDeltas);
    thinkingDeltas.push(...tail.thinkingDeltas);

    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);
    expect(thinkingDeltas.join("\n")).toContain("The user wants to add a setting");
    expect(thinkingDeltas.join("\n")).toContain("Let me check");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas.join("\n")).toContain("这条设定已经写在 outline/story_frame.md");
    expect(textDeltas.join("\n")).not.toContain("The user wants to add");
  });

  it("routes a Chinese reply (no narration) entirely to text_deltas", () => {
    const splitter = new StreamingNarrativeSplitter("zh");
    const { textDeltas, thinkingDeltas } = feedAll(
      splitter,
      "这条设定在 outline/story_frame.md 第 4 条铁律里。需要我把它显式提升优先级吗？",
    );
    const tail = splitter.flush();
    textDeltas.push(...tail.textDeltas);
    thinkingDeltas.push(...tail.thinkingDeltas);

    expect(textDeltas.join("")).toContain("这条设定在 outline/story_frame.md");
    expect(thinkingDeltas).toEqual([]);
  });

  it("keeps partial paragraphs buffered until \n\n or flush()", () => {
    const splitter = new StreamingNarrativeSplitter("zh");
    // First three deltas carry narration that has not yet hit \n\n.
    const live = feedAll(splitter, "The user wants to add ", "a setting", " about injuries");
    expect(live.textDeltas).toEqual([]);
    expect(live.thinkingDeltas).toEqual([]);

    // Now the model ends the narration paragraph with \n\n — should emit
    // the completed reasoning paragraph as a thinking delta.
    const afterBreak = splitter.acceptTextDelta(" within 1 day.\n\n");
    expect(afterBreak.thinkingDeltas.length).toBe(1);
    expect(afterBreak.textDeltas).toEqual([]);
    expect(afterBreak.thinkingDeltas[0]).toContain("The user wants to add a setting about injuries within 1 day.");

    // Followed by a Chinese reply that opens mid-stream and finishes
    // cleanly at flush().
    feedAll(splitter, "我先看一下 ", "story_frame.md。");
    const tail = splitter.flush();
    expect(tail.textDeltas.length).toBe(1);
    expect(tail.textDeltas[0]).toContain("我先看一下");
    expect(tail.textDeltas[0]).toContain("story_frame.md");
    expect(tail.thinkingDeltas).toEqual([]);
  });

  it("does nothing for empty or whitespace-only input", () => {
    const splitter = new StreamingNarrativeSplitter("zh");
    expect(splitter.acceptTextDelta("")).toEqual({ textDeltas: [], thinkingDeltas: [] });
    expect(splitter.acceptTextDelta("\n\n")).toEqual({ textDeltas: [], thinkingDeltas: [] });
    expect(splitter.acceptTextDelta("   \n\n   \n\n")).toEqual({ textDeltas: [], thinkingDeltas: [] });
  });

  it("flush() with no buffered content emits nothing", () => {
    const splitter = new StreamingNarrativeSplitter("zh");
    expect(splitter.flush()).toEqual({ textDeltas: [], thinkingDeltas: [] });
  });
});

describe("StreamingNarrativeSplitter (en mode)", () => {
  it("does NOT route anything to thinking_deltas even when the paragraph sounds like reasoning", () => {
    // English mode preserves the model's natural voice — the splitter
    // only routes narration in Chinese sessions where the user would
    // otherwise see English-language thinking in the main bubble.
    const splitter = new StreamingNarrativeSplitter("en");
    const live = feedAll(
      splitter,
      "Let me check the truth files to confirm.\n\n",
      "The setting is already in story_frame.md under the four iron rules.",
    );
    const tail = splitter.flush();
    const textDeltas = [...live.textDeltas, ...tail.textDeltas];

    expect(textDeltas.join("\n")).toContain("Let me check the truth files");
    expect(live.thinkingDeltas).toEqual([]);
    expect(tail.thinkingDeltas).toEqual([]);
  });
});
