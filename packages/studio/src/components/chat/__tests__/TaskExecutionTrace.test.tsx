import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagePart, ToolExecution } from "../../../store/chat/types";
import { TaskExecutionTrace, summarizeTrace } from "../TaskExecutionTrace";

const baseToolExecution = (overrides: Partial<ToolExecution> & Pick<ToolExecution, "id" | "tool">): ToolExecution => ({
  label: "test",
  status: "completed",
  startedAt: 0,
  ...overrides,
});

// Test helper that builds a properly-typed MessagePart for a tool execution.
// Using a typed literal instead of `as unknown as MessagePart` makes the
// suite resilient to the parts type gaining new fields — TS will fail loudly
// at the helper if the shape ever drifts.
const toolPart = (overrides: Partial<ToolExecution> & Pick<ToolExecution, "id" | "tool">): MessagePart => ({
  type: "tool",
  execution: baseToolExecution(overrides),
});

// `defaultOpen` forces the wrapper open so SSR renders the body, which is
// otherwise hidden behind Radix Collapsible's default-closed state. We
// want to assert against the expanded view (trace counts + part content).
const render = (parts: ReadonlyArray<MessagePart>) =>
  renderToStaticMarkup(
    <TaskExecutionTrace parts={parts} timestamp={1000} theme={"light" as const} defaultOpen />,
  );

describe("summarizeTrace", () => {
  it("returns zeros for an empty parts array", () => {
    expect(summarizeTrace([])).toEqual({ thinkingCount: 0, toolCount: 0, textCount: 0 });
  });

  it("counts thinking, tool, and text parts correctly", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "a", streaming: false },
      { type: "thinking", content: "b", streaming: false },
      { type: "text", content: "hi" },
      toolPart({ id: "t1", tool: "read" }),
    ];
    expect(summarizeTrace(parts)).toEqual({ thinkingCount: 2, toolCount: 1, textCount: 1 });
  });
});

describe("TaskExecutionTrace", () => {
  it("renders just the text bubble when there is no thinking or tool (no outer trigger)", () => {
    const parts: MessagePart[] = [{ type: "text", content: "hello world" }];
    const html = render(parts);
    expect(html).not.toContain("思考");
    expect(html).not.toContain("执行");
    expect(html).toContain("hello world");
  });

  it("shows the '思考 N 次, 执行 M 条命令' trigger when thinking + tool are present", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "first thought", streaming: false },
      { type: "thinking", content: "second thought", streaming: false },
      toolPart({ id: "t1", tool: "read", label: "读取文件" }),
      toolPart({ id: "t2", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];
    const html = render(parts);
    expect(html).toContain("思考 2 次");
    expect(html).toContain("执行 2 条命令");
  });

  it("renders streaming text in the trigger when a thinking part is mid-stream", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "halfway", streaming: true },
      { type: "thinking", content: "", streaming: true },
      toolPart({ id: "t1", tool: "read", status: "running" }),
    ];
    const html = render(parts);
    expect(html).toContain("思考中");
    expect(html).toContain("2 次");
    expect(html).toContain("1 条");
  });

  it("treats tool status='processing' as streaming too", () => {
    const parts: MessagePart[] = [toolPart({ id: "t1", tool: "sub_agent", status: "processing" })];
    const html = render(parts);
    expect(html).toContain("思考中");
  });

  it("renders thinking prose and tool bodies inside the expanded content", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "let me reason about this", streaming: false },
      toolPart({ id: "t1", tool: "read", label: "读取文件" }),
    ];
    const html = render(parts);
    expect(html).toContain("let me reason about this");
    // ToolExecutionSteps aggregates consecutive utility tools into a single
    // block; we assert against the aggregate summary instead of the raw
    // `label`, which only renders after expanding the inner collapsible.
    expect(html).toContain("1 个文件操作");
    expect(html).toContain('data-trace-kind="thinking"');
    expect(html).toContain('data-trace-kind="tools"');
  });

  it("merges consecutive tool parts into a single ToolExecutionSteps block", () => {
    const parts: MessagePart[] = [
      toolPart({ id: "t1", tool: "read", label: "读取1" }),
      toolPart({ id: "t2", tool: "grep", label: "搜索" }),
      toolPart({ id: "t3", tool: "read", label: "读取2" }),
    ];
    const html = render(parts);
    const matches = html.match(/data-trace-kind="tools"/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).toContain("执行 3 条命令");
  });

  it("separates tool runs that are split by a thinking part", () => {
    const parts: MessagePart[] = [
      toolPart({ id: "t1", tool: "read", label: "读取1" }),
      { type: "thinking", content: "reconsidering", streaming: false },
      toolPart({ id: "t2", tool: "read", label: "读取2" }),
    ];
    const html = render(parts);
    const matches = html.match(/data-trace-kind="tools"/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("skips empty text parts", () => {
    const parts: MessagePart[] = [
      { type: "text", content: "" },
      { type: "text", content: "real text" },
    ];
    const html = render(parts);
    expect(html).toContain("real text");
    expect(html).not.toContain("思考");
  });
});