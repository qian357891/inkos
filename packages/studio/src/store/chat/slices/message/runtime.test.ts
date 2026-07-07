import { describe, expect, it } from "vitest";
import type { Message, ToolExecution } from "../../types";
import { createSessionRuntime, deriveResolvedProposals, deserializeMessages, extractErrorMessage, extractToolError, withToolExecutions } from "./runtime";

function exec(overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution {
  const { id, tool, ...rest } = overrides;
  return {
    id,
    tool,
    label: tool,
    status: "completed",
    startedAt: 1,
    ...rest,
  };
}

describe("chat runtime error copy", () => {
  it("localizes known assistant errors", () => {
    expect(extractErrorMessage({
      message: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    })).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes known tool errors", () => {
    expect(extractToolError({
      content: [
        {
          type: "text",
          text: "Latest chapter 2 is state-degraded. Repair state or rewrite that chapter before continuing.",
        },
      ],
    })).toBe("最新第 2 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });
});

describe("createSessionRuntime", () => {
  it("carries playMode on the session runtime", () => {
    const rt = createSessionRuntime({ sessionId: "s1", bookId: null, sessionKind: "play", playMode: "guided", title: null });
    expect(rt.playMode).toBe("guided");
  });
});

describe("deriveResolvedProposals", () => {
  it("marks a proposed play start as confirmed when play_start completed later", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动旧影院",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "play-1",
            tool: "play_start",
            details: { kind: "play_world_started" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed interactive-film creation as confirmed when the tool completed later", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "interactive_film_create",
              targetSessionKind: "interactive-film",
              instruction: "制作鸦冠之宴",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "interactive-1",
            tool: "interactive_film_create",
            details: { kind: "interactive_film_created" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed book creation as confirmed only by an architect sub-agent", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本债务悬疑",
            },
          }),
          exec({ id: "writer-1", tool: "sub_agent", agent: "writer" }),
          exec({ id: "architect-1", tool: "sub_agent", agent: "architect" }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("confirms only one matching proposal per completed production action", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "old-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动旧广播站",
            },
          }),
          exec({
            id: "new-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动水文站",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "play-1",
            tool: "play_start",
            details: { kind: "play_world_started" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "new-proposal": "confirmed" });
  });
});

describe("deserializeMessages", () => {
  it("restores tool executions from legacyDisplay for tool-only assistant messages", () => {
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        legacyDisplay: {
          toolExecutions: [
            exec({
              id: "interactive-1",
              tool: "interactive_film_create",
              details: { kind: "interactive_film_created", baseDir: "interactive-films/crow-crown-banquet" },
            }),
          ],
        },
      } as any,
    ]);

    expect(messages[0]?.toolExecutions?.[0]?.tool).toBe("interactive_film_create");
    expect(messages[0]?.parts?.[0]?.type).toBe("tool");
  });

  it("expands thinkingBlocks into one thinking part per iteration", () => {
    // Each entry is one thinking:start/end round from the live stream. The
    // task-level "思考 N 次" counter depends on this 1:1 mapping surviving
    // the round trip through transcript → SessionMessage → Message.parts.
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "完成了。",
        timestamp: 1,
        thinking: "iter 1\n\n---\n\niter 2\n\n---\n\niter 3",
        thinkingBlocks: ["iter 1", "iter 2", "iter 3"],
      },
    ]);

    const parts = messages[0]?.parts ?? [];
    const thinkingParts = parts.filter((p) => p.type === "thinking");
    expect(thinkingParts).toHaveLength(3);
    expect(thinkingParts.map((p) => (p.type === "thinking" ? p.content : ""))).toEqual([
      "iter 1",
      "iter 2",
      "iter 3",
    ]);
    expect(parts.map((p) => p.type)).toEqual(["thinking", "thinking", "thinking", "text"]);
  });

  it("falls back to a single thinking part when only the merged `thinking` string is present", () => {
    // Old sessions (pre-thinkingBlocks) only have the joined string. We must
    // not drop the thinking content, but the count collapses to 1 — that's
    // the documented backward-compat behavior.
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "hi",
        timestamp: 1,
        thinking: "some old thinking",
      },
    ]);

    const thinkingParts = (messages[0]?.parts ?? []).filter((p) => p.type === "thinking");
    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0]).toMatchObject({ type: "thinking", content: "some old thinking", streaming: false });
  });

  it("filters out empty-string thinkingBlocks entries", () => {
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "ok",
        timestamp: 1,
        thinkingBlocks: ["real thought", "   ", ""],
      },
    ]);

    const thinkingParts = (messages[0]?.parts ?? []).filter((p) => p.type === "thinking");
    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0]).toMatchObject({ type: "thinking", content: "real thought" });
  });
});

describe("withToolExecutions", () => {
  it("adds returned tool executions before final text content", () => {
    const message = withToolExecutions({
      role: "assistant",
      content: "完成。",
      timestamp: 1,
    }, [
      exec({
        id: "script-1",
        tool: "script_create",
        details: { kind: "script_created" },
      }),
    ]);

    expect(message.toolExecutions?.map((execution) => execution.tool)).toEqual(["script_create"]);
    expect(message.parts?.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(message.content).toBe("完成。");
  });
});
