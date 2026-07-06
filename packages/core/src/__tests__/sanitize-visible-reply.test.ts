import { describe, expect, it } from "vitest";
import { __test } from "../agent/agent-session.js";

const { sanitizeVisibleReply, isThinkingAloudParagraph, narrationOnlyFallback } = __test;

describe("sanitizeVisibleReply", () => {
  it("strips paragraphs starting with English thinking-aloud narration in zh mode", () => {
    // Real-world MiniMax-M3 output observed in Studio Chat: the model
    // narrates its chain-of-thought in English as visible text. The user's
    // session is Chinese-pinned, the model echoed the story_frame quote
    // verbatim — and then narrated what it planned to do. The
    // sanitization layer must drop the narration paragraphs.
    const userFacing = `The user wants to add a setting: injuries sustained in the other world, when returning to reality, will manifest as similar injuries in the real world within 1 day due to various accidents.

Let me check the current truth files. Looking at the story_frame.md, I see there's already a similar concept mentioned:

"其四，死亡与伤害兑现：陆沉在异世界死掉，等于他在现实以各种荒诞方式死掉；受伤亦然——他在异世界受到的物理伤害，在"回过神"回到现实世界后，二十四小时内会以意外事故的形式在身体上兑现同样程度的伤害。没有复活机会，也没有规避手段。这是本书最核心的重量机制：每一次他在异世界的冒险，回归现实后都必须以血肉之躯偿还。"

So this setting already exists in the story_frame.md. The user is asking to add it - but it's already there. Let me read carefully...

Yes, in the 世界观底色 section of story_frame.md, this exact rule (伤害兑现) already exists as the fourth iron rule. So I should:

Acknowledge that this setting is already part of the story's canon (in story_frame.md)
Check if it needs to be propagated to other places`;

    const cleaned = sanitizeVisibleReply(userFacing, "zh");
    expect(cleaned).not.toMatch(/^The user wants/im);
    expect(cleaned).not.toMatch(/^Let me check/im);
    expect(cleaned).not.toMatch(/^So this setting already exists/im);
    expect(cleaned).not.toMatch(/^Yes, in/im);
    expect(cleaned).not.toMatch(/^Acknowledge/im);
    expect(cleaned).not.toMatch(/^Check if/im);
    // The direct Chinese-quoted truth survives because it does not start
    // with a narration opener.
    expect(cleaned).toContain("其四，死亡与伤害兑现");
  });

  it("returns a Chinese explanatory fallback when substantial narration is the only content", () => {
    const onlyNarration = `The user wants to add a setting: injuries sustained in the other world, when returning to reality, will manifest as similar injuries in the real world within 1 day due to various accidents.

Let me check the current truth files. Looking at the story_frame.md, I see there's already a similar concept mentioned:

So this setting already exists. So I should:

Acknowledge that this setting is already part of the story's canon
Check if it needs to be propagated to other places`;

    const cleaned = sanitizeVisibleReply(onlyNarration, "zh");
    // The fallback explanation is Chinese; ensure the matcher accepts the
    // mixed-language fallback content.
    expect(cleaned.length).toBeGreaterThan(0);
    expect(
      cleaned.includes("思考") ||
        cleaned.includes("推理") ||
        cleaned.includes("reasoning") ||
        cleaned.includes("narration"),
    ).toBe(true);
    // The narration should not be in the output.
    expect(cleaned).not.toContain("The user wants to add");
    expect(cleaned).not.toContain("Acknowledge that this setting is");
  });

  it("strips inline <thinking> blocks before paragraph-level scrubbing", () => {
    const withBlock = `<thinking>内部思考应该走专用通道。</thinking>

用户写的设定我可以直接照搬到 story_frame.md 的"四条铁律"那一节。需要我用 write_truth_file 把它落盘吗？`;
    const cleaned = sanitizeVisibleReply(withBlock, "zh");
    expect(cleaned).not.toMatch(/<thinking>/i);
    expect(cleaned).not.toMatch(/<\/thinking>/i);
    expect(cleaned).toContain("用户写的设定");
    expect(cleaned).toContain("需要我用 write_truth_file");
  });

  it("does not scrub legitimate English prose in an en session", () => {
    const legit = `I can help you think through this. The iron rule "injury settlement" already lives in story_frame.md under the world-building section. Want me to flag it in current_focus.md so the next chapter writer picks it up?`;
    const cleaned = sanitizeVisibleReply(legit, "en");
    expect(cleaned).toBe(legit.trim());
  });

  it("preserves a single-paragraph Chinese reply with embedded English quote", () => {
    const legit = `这条设定已经在 outline/story_frame.md 的"死亡与伤害兑现"小节里写过——原文是：injuries sustained in the other world, when returning to reality, will manifest as similar injuries in the real world within 1 day due to various accidents. 需要我把它提到 pending_hooks.md 当作显式钩子吗？`;
    const cleaned = sanitizeVisibleReply(legit, "zh");
    expect(cleaned).toBe(legit.trim());
  });

  it("cleans narration even when no Chinese content is present at all (heavy leak)", () => {
    const heavyEnglishNarration = `The user wants to add a setting.

Let me check the current truth files.

Looking at the story_frame.md, I see there's already a similar concept mentioned.

So this setting already exists.

So I should:

Acknowledge that this setting is already part of the story's canon
Check if it needs to be propagated to other places
Write a follow-up note in pending_hooks.md
Update the user_intent document`;
    const cleaned = sanitizeVisibleReply(heavyEnglishNarration, "zh");
    expect(cleaned.length).toBeGreaterThan(0);
    // The narration opener phrases should be gone.
    expect(cleaned).not.toMatch(/^The user wants/im);
    expect(cleaned).not.toMatch(/^Let me check/im);
    expect(cleaned).not.toMatch(/^Looking at/im);
    expect(cleaned).not.toMatch(/^- Acknowledge/im);
    expect(cleaned).not.toMatch(/^- Check/im);
    // The fallback should mention either Chinese narration-blocking copy or
    // the synthetic fallback explaining what happened.
    expect(
      cleaned.includes("推理") ||
        cleaned.includes("思考") ||
        cleaned.includes("reasoning"),
    ).toBe(true);
  });
});

describe("isThinkingAloudParagraph", () => {
  it("matches the canonical thinking-aloud openers", () => {
    expect(isThinkingAloudParagraph("The user wants to add a setting.")).toBe(true);
    expect(isThinkingAloudParagraph("Let me check the truth files first.")).toBe(true);
    expect(isThinkingAloudParagraph("Let me think about this carefully.")).toBe(true);
    expect(isThinkingAloudParagraph("I need to check the truth files first.")).toBe(true);
    expect(isThinkingAloudParagraph("I should acknowledge this setting.")).toBe(true);
    expect(isThinkingAloudParagraph("So I should:")).toBe(true);
    expect(isThinkingAloudParagraph("Acknowledge that this is in the canon.")).toBe(true);
    expect(isThinkingAloudParagraph("Check if it needs to be propagated.")).toBe(true);
    expect(isThinkingAloudParagraph("Yes, in the story_frame.md this exists.")).toBe(true);
    expect(isThinkingAloudParagraph("Looking at the story_frame.md, ...")).toBe(true);
    expect(isThinkingAloudParagraph("Reading story_frame.md now.")).toBe(true);
    expect(isThinkingAloudParagraph("Now I'll start by checking.")).toBe(true);
    expect(isThinkingAloudParagraph("First, I need to read the bible.")).toBe(true);
  });

  it("does NOT match user-facing Chinese prose", () => {
    expect(isThinkingAloudParagraph("这条设定我帮你写到 outline/story_frame.md。")).toBe(false);
    expect(isThinkingAloudParagraph("让我看看是否要补充一节铁律。")).toBe(false);
    expect(isThinkingAloudParagraph("我会用 write_truth_file 把它落盘。")).toBe(false);
    expect(isThinkingAloudParagraph("需要我继续吗？")).toBe(false);
    expect(isThinkingAloudParagraph("")).toBe(false);
  });

  it("does NOT match a Chinese paragraph that incidentally contains English", () => {
    expect(isThinkingAloudParagraph("这条规则 (in story_frame.md) 已经写过。")).toBe(false);
  });
});

describe("narrationOnlyFallback", () => {
  it("returns a Chinese explanation in zh mode", () => {
    const f = narrationOnlyFallback("zh");
    expect(f).toMatch(/思考|推理|reasoning|narration/);
  });

  it("returns an English explanation in en mode", () => {
    const f = narrationOnlyFallback("en");
    expect(f).toMatch(/thinking-aloud|internal thinking|reasoning/);
  });
});
