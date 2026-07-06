import { describe, expect, it } from "vitest";
import { stripReasoning } from "../utils/strip-reasoning.js";

const focusMarker = "=== SECTION: 当前焦点 ===";
const bodyLine = "主角那令牌在潮汐城地下市场。";

describe("stripReasoning", () => {
  it("trims trailing whitespace when there are no reasoning tags", () => {
    const input = focusMarker + "\n" + bodyLine + "\n";
    expect(stripReasoning(input)).toBe(input.trim());
  });

  it("returns empty on empty input", () => {
    expect(stripReasoning("")).toBe("");
  });

  it("strips a closed <thinking>...</thinking> block at the head", () => {
    const input =
      "<thinking>thinking content here</thinking>\n\n" +
      focusMarker + "\n" + bodyLine;
    expect(stripReasoning(input)).toBe(focusMarker + "\n" + bodyLine);
  });

  it("strips a closed <reasoning>...</reasoning> block", () => {
    const input =
      "<reasoning>reasoning content here</reasoning>\n\n" +
      focusMarker + "\n" + bodyMarkerSafe();
    expect(stripReasoning(input)).toBe(focusMarker + "\n主角那令牌。");
  });

  it("strips a closed think block", () => {
    const input =
      "<think>think content here</think>\n\n" +
      focusMarker + "\n" + bodyLine;
    expect(stripReasoning(input)).toBe(focusMarker + "\n" + bodyLine);
  });

  it("strips multiple consecutive <thinking>/<reasoning> blocks before the first SECTION", () => {
    const input =
      "<thinking>first block</thinking>\n\n" +
      "<reasoning>second block</reasoning>\n\n" +
      focusMarker + "\n正文";
    expect(stripReasoning(input)).toBe(focusMarker + "\n正文");
  });

  it("strips an unclosed <thinking> tag at the head - drops everything after", () => {
    const input = "<thinking>thinking cut mid-stream\n正文继续";
    expect(stripReasoning(input)).toBe("");
  });

  it("matches case-insensitively", () => {
    const input = "<THINK>reasoning</THINK>\n" + focusMarker + "\n正文。";
    expect(stripReasoning(input)).toBe(focusMarker + "\n正文。");
  });

  it("handles attributes on open tags", () => {
    const input =
      '<think type="extended">some long reasoning content we need to pad out so the regex non-greedy match has stuff to match here</think>\n' +
      focusMarker + "\n正文。";
    expect(stripReasoning(input)).toBe(focusMarker + "\n正文。");
  });

  it("does not strip tags that look similar but are not in the reasoning list", () => {
    const input = focusMarker + "\n主角想着<somethink>过去的事</somethink>。";
    expect(stripReasoning(input)).toBe(input.trim());
  });

  it("leaves pure multi-section content unchanged (only trim applied)", () => {
    const input = focusMarker + "\nA\n\n=== SECTION: 下一拍 ===\nB";
    expect(stripReasoning(input)).toBe(input.trim());
  });

  it("regression guard: 普通中文文本（无效标签）不会被误剥", () => {
    const input = "这里是初始的思考片段，但还没闭合\n" + focusMarker + "\n" + bodyLine;
    expect(stripReasoning(input)).toBe(input.trim());
  });
});

// helper: 简化输入构造，避免在 expect 上重复写字面
function bodyMarkerSafe() {
  return "主角那令牌。";
}
