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

describe("summarizeTrace", () => {
  it("returns zeros for an empty parts array", () => {
    expect(summarizeTrace([])).toEqual({ thinkingCount: 0, toolCount: 0, textCount: 0 });
  });

  it("counts thinking, tool, and text parts correctly", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "a", streaming: false },
      { type: "thinking", content: "b", streaming: false },
      { type: "text", content: "hi" },
      baseToolExecution({ id: "t1", tool: "read" }) as unknown as MessagePart,
    ];
    expect(summarizeTrace(parts)).toEqual({ thinkingCount: 2, toolCount: 1, textCount: 1 });
  });
});

describe("TaskExecutionTrace", () => {
  const theme = "light" as const;

  it("renders just the text bubble when there is no thinking or tool (no outer trigger)", () => {
    const parts: MessagePart[] = [{ type: "text", content: "hello world" }];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    // No trace trigger should be rendered.
    expect(html).not.toContain("思考");
    expect(html).not.toContain("执行");
    expect(html).toContain("hello world");
  });

  it("shows the '思考 N 次, 执行 M 条命令' trigger when thinking + tool are present", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "first thought", streaming: false },
      { type: "thinking", content: "second thought", streaming: false },
      baseToolExecution({ id: "t1", tool: "read", label: "读取文件" }) as unknown as MessagePart,
      baseToolExecution({ id: "t2", tool: "sub_agent", agent: "writer", label: "写作" }) as unknown as MessagePart,
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    expect(html).toContain("思考 2 次");
    expect(html).toContain("执行 2 条命令");
  });

  it("renders streaming text in the trigger when a thinking part is mid-stream", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "halfway", streaming: true },
      { type: "thinking", content: "", streaming: true },
      baseToolExecution({ id: "t1", tool: "read", status: "running" }) as unknown as MessagePart,
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    expect(html).toContain("思考中");
    expect(html).toContain("2 次");
    expect(html).toContain("1 条");
  });

  it("treats tool status='processing' as streaming too", () => {
    const parts: MessagePart[] = [
      baseToolExecution({ id: "t1", tool: "sub_agent", status: "processing" }) as unknown as MessagePart,
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    expect(html).toContain("思考中");
  });

  it("renders thinking prose and tool bodies inside the expanded content", () => {
    const parts: MessagePart[] = [
      { type: "thinking", content: "let me reason about this", streaming: false },
      baseToolExecution({ id: "t1", tool: "read", label: "读取文件" }) as unknown as MessagePart,
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    expect(html).toContain("let me reason about this");
    expect(html).toContain("读取文件");
    expect(html).toContain('data-trace-kind="thinking"');
    expect(html).toContain('data-trace-kind="tools"');
  });

  it("merges consecutive tool parts into a single ToolExecutionSteps block", () => {
    const parts: MessagePart[] = [
      baseToolExecution({ id: "t1", tool: "read", label: "读取1" }) as unknown as MessagePart,
      baseToolExecution({ id: "t2", tool: "grep", label: "搜索" }) as unknown as MessagePart,
      baseToolExecution({ id: "t3", tool: "read", label: "读取2" }) as unknown as MessagePart,
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    // Only one tools group block (data-trace-kind="tools") for the consecutive run.
    const matches = html.match(/data-trace-kind="tools"/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).toContain("执行 3 条命令");
  });

  it("separates tool runs that are split by a thinking part", () => {
    const parts: MessagePart[] = [
      baseToolExecution({ id: "t1", tool: "read", label: "读取1" }) as unknown as MessagePart,
      { type: "thinking", content: "reconsidering", streaming: false },
      baseToolExecution({ id: "t2", tool: "read", label: "读取2" }) as unknown as MessagePart,
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    const matches = html.match(/data-trace-kind="tools"/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("skips empty text parts", () => {
    const parts: MessagePart[] = [
      { type: "text", content: "" },
      { type: "text", content: "real text" },
    ];
    const html = renderToStaticMarkup(
      <TaskExecutionTrace parts={parts} timestamp={1000} theme={theme} />,
    );
    expect(html).toContain("real text");
    // No trigger since there is no thinking/tool.
    expect(html).not.toContain("思考");
  });
});