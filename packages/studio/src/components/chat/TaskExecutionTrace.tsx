"use client";

import { memo, useMemo } from "react";
import {
  Reasoning,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { CollapsibleContent } from "@/components/ui/collapsible";
import { ChatMessage } from "./ChatMessage";
import { ToolExecutionSteps, type ProposedActionDetails } from "./ToolExecutionSteps";
import type { MessagePart } from "@/store/chat/types";
import type { Theme } from "@/hooks/use-theme";

// -- Render items: same grouping as ChatPage's inline assistant rendering.
//    Consecutive tool parts are merged into a single ToolExecutionSteps call.
//    Thinking and text parts stay individual so they keep their position
//    in the chronological narrative. --
type TraceRenderItem =
  | { kind: "thinking"; pi: number; part: Extract<MessagePart, { type: "thinking" }> }
  | { kind: "text"; pi: number; part: Extract<MessagePart, { type: "text" }> }
  | { kind: "tools"; parts: Array<Extract<MessagePart, { type: "tool" }>>; startIdx: number };

function groupTraceParts(parts: ReadonlyArray<MessagePart>): TraceRenderItem[] {
  const items: TraceRenderItem[] = [];
  for (let pi = 0; pi < parts.length; pi += 1) {
    const part = parts[pi];
    if (part.type === "thinking") {
      items.push({ kind: "thinking", pi, part });
    } else if (part.type === "text") {
      items.push({ kind: "text", pi, part });
    } else if (part.type === "tool") {
      const last = items[items.length - 1];
      if (last?.kind === "tools") {
        last.parts.push(part);
      } else {
        items.push({ kind: "tools", parts: [part], startIdx: pi });
      }
    }
  }
  return items;
}

interface TaskExecutionTraceProps {
  readonly parts: ReadonlyArray<MessagePart>;
  readonly timestamp: number;
  readonly theme: Theme;
  readonly onProposedAction?: (details: ProposedActionDetails) => void;
  readonly onRejectProposedAction?: (details: ProposedActionDetails) => void;
  readonly onOpenFilmStudio?: (projectId: string) => void;
  /**
   * Initial open state for the wrapper panel. Defaults to `false`. Pass
   * `true` in tests / storybooks so the rendered body is visible without
   * a click on the trigger.
   */
  readonly defaultOpen?: boolean;
}

/**
 * Task-level collapsible wrapper for an assistant message.
 *
 * Mirrors the IDE-agent "思考 N 次, 执行 M 条命令" trace panel: a single
 * collapsible trigger shows the cumulative count of thinking iterations
 * and tool calls the model ran during this turn. The expanded body
 * re-uses the existing rendering for each MessagePart (per-iteration
 * thinking prose + per-tool ToolExecutionSteps block + visible text).
 *
 * If the message has no thinking or tool parts (e.g. a pure-text reply),
 * the wrapper short-circuits and renders the parts directly without the
 * outer trigger — no "1 次 / 0 条" noise for trivial replies.
 */
export const TaskExecutionTrace = memo(function TaskExecutionTrace({
  parts,
  timestamp,
  theme,
  onProposedAction,
  onRejectProposedAction,
  onOpenFilmStudio,
  defaultOpen,
}: TaskExecutionTraceProps) {
  const items = useMemo(() => groupTraceParts(parts), [parts]);

  const thinkingCount = useMemo(
    () => parts.reduce((n, p) => n + (p.type === "thinking" ? 1 : 0), 0),
    [parts],
  );
  const toolCount = useMemo(
    () => parts.reduce((n, p) => n + (p.type === "tool" ? 1 : 0), 0),
    [parts],
  );

  const isStreaming = useMemo(() => {
    return parts.some(
      (p) =>
        (p.type === "thinking" && p.streaming) ||
        (p.type === "tool" && (p.execution.status === "running" || p.execution.status === "processing")),
    );
  }, [parts]);

  const hasTrace = thinkingCount > 0 || toolCount > 0;

  const renderedItems = items.map((item) => {
    if (item.kind === "thinking") {
      const content = item.part.content;
      return (
        <div
          key={`t-${item.pi}`}
          className="border-l-2 border-muted pl-3 py-1 mb-3 last:mb-0"
          data-trace-kind="thinking"
        >
          {content ? (
            <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {content}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground/70 italic">（思考中…）</div>
          )}
        </div>
      );
    }
    if (item.kind === "tools") {
      return (
        <div key={`x-${item.startIdx}`} className="mb-3 last:mb-0" data-trace-kind="tools">
          <ToolExecutionSteps
            executions={item.parts.map((part) => part.execution)}
            onProposedAction={onProposedAction}
            onRejectProposedAction={onRejectProposedAction}
            onOpenFilmStudio={onOpenFilmStudio}
          />
        </div>
      );
    }
    if (item.kind === "text" && item.part.content) {
      return (
        <div key={`c-${item.pi}`} className="mb-3 last:mb-0" data-trace-kind="text">
          <ChatMessage
            role="assistant"
            content={item.part.content}
            timestamp={timestamp}
            theme={theme}
          />
        </div>
      );
    }
    return null;
  });

  if (!hasTrace) {
    return <>{renderedItems}</>;
  }

  return (
    <Reasoning isStreaming={isStreaming} defaultOpen={defaultOpen}>
      <ReasoningTrigger
        getThinkingMessage={(streaming) =>
          streaming
            ? <>思考中…（{thinkingCount} 次 / {toolCount} 条）</>
            : <>思考 {thinkingCount} 次，执行 {toolCount} 条命令</>
        }
      />
      {/* ReasoningContent's children type is narrowed to `string` so it can
          hand off to <Streamdown>; our body is structured React (multiple
          thinking/tool/text blocks), so we use a plain CollapsibleContent
          that shares the same Radix Collapsible context as the trigger. */}
      <CollapsibleContent className="mt-4 space-y-3 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2">
        {renderedItems}
      </CollapsibleContent>
    </Reasoning>
  );
});

/** Helper for tests / callers that need the same counts. */
export function summarizeTrace(parts: ReadonlyArray<MessagePart>): {
  thinkingCount: number;
  toolCount: number;
  textCount: number;
} {
  let thinkingCount = 0;
  let toolCount = 0;
  let textCount = 0;
  for (const p of parts) {
    if (p.type === "thinking") thinkingCount += 1;
    else if (p.type === "tool") toolCount += 1;
    else textCount += 1;
  }
  return { thinkingCount, toolCount, textCount };
}