import type { StateCreator } from "zustand";
import type {
  AgentResponse,
  ChatAttachmentPayload,
  ChatSessionKind,
  ChatStore,
  MessageActions,
  SendMessageOptions,
  SessionResponse,
  SessionSummary,
} from "../../types";
import { fetchJson } from "../../../../hooks/use-api";
import { attachSessionStreamListeners } from "./stream-events";
import {
  bookKey,
  createSessionRuntime,
  deriveResolvedProposals,
  deserializeMessages,
  extractErrorMessage,
  mergeSessionIds,
  updateSession,
  upsertSessionSummary,
  withToolExecutions,
} from "./runtime";

const SKILL_DIRECTIVE_RE = /(^|\s)@([a-z][a-z0-9-]*)(?=\s|$)/gi;

function parseSkillDirectives(text: string): { instruction: string; requestedSkills: string[] } {
  const requestedSkills: string[] = [];
  const seen = new Set<string>();
  const instruction = text.replace(SKILL_DIRECTIVE_RE, (match, prefix: string, rawId: string) => {
    const id = rawId.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      requestedSkills.push(id);
    }
    return prefix;
  }).replace(/\s+/g, " ").trim();
  return { instruction: instruction || text.trim(), requestedSkills };
}

function mergeSkillIds(
  parsed: ReadonlyArray<string>,
  explicit: ReadonlyArray<string> | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of [...parsed, ...(explicit ?? [])]) {
    const id = value.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function formatAttachmentSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${size} B`;
}

function formatUserMessageForDisplay(text: string, attachments: ReadonlyArray<ChatAttachmentPayload>): string {
  if (attachments.length === 0) return text;
  const lines = text ? [text, "", "附件："] : ["附件："];
  for (const attachment of attachments) {
    lines.push(`- ${attachment.filename} (${attachment.mediaType || "application/octet-stream"}, ${formatAttachmentSize(attachment.size)})`);
  }
  return lines.join("\n");
}

export const createMessageSlice: StateCreator<ChatStore, [], [], MessageActions> = (set, get) => ({
  activateSession: (sessionId) =>
    set({ activeSessionId: sessionId }),

  setSessionPlayMode: (sessionId, playMode) => {
    const session = get().sessions[sessionId];
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ playMode })),
    }));
    if (session?.isDraft) return;
    void fetchJson(`/sessions/${sessionId}/play-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playMode }),
    }).catch(() => undefined);
  },

  setInput: (text) => set({ input: text }),

  addUserMessage: (sessionId, content) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "user", content, timestamp: Date.now() }],
        lastError: null,
      })),
    })),

  appendStreamChunk: (sessionId, text, streamTs) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => {
        const last = session.messages[session.messages.length - 1];
        if (last?.timestamp === streamTs && last.role === "assistant") {
          return {
            messages: [...session.messages.slice(0, -1), { ...last, content: last.content + text }],
          };
        }
        return {
          messages: [...session.messages, { role: "assistant", content: text, timestamp: streamTs }],
        };
      }),
    })),

  finalizeStream: (sessionId, streamTs, content, toolCall) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: session.messages.map((message) => {
          if (message.timestamp !== streamTs || message.role !== "assistant") return message;
          const parts = [...(message.parts ?? [])];
          const lastPart = parts[parts.length - 1];
          if (lastPart?.type === "text") {
            parts[parts.length - 1] = { ...lastPart, content };
          } else if (content) {
            parts.push({ type: "text", content });
          }
          return { ...message, content, toolCall, parts };
        }),
      })),
    })),

  replaceStreamWithError: (sessionId, streamTs, errorMsg) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [
          ...session.messages.filter(
            (message) => !(message.timestamp === streamTs && message.role === "assistant"),
          ),
          { role: "assistant", content: `\u2717 ${errorMsg}`, timestamp: Date.now() },
        ],
        isStreaming: false,
        lastError: errorMsg,
        stream: null,
      })),
    })),

  addErrorMessage: (sessionId, errorMsg) =>
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (session) => ({
        messages: [...session.messages, { role: "assistant", content: `\u2717 ${errorMsg}`, timestamp: Date.now() }],
        lastError: errorMsg,
      })),
    })),

  loadSessionMessages: (sessionId, msgs) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session || session.messages.length > 0) return {};
      const messages = deserializeMessages(msgs);
      return {
        sessions: updateSession(state.sessions, sessionId, () => ({ messages })),
        resolvedProposals: {
          ...state.resolvedProposals,
          ...deriveResolvedProposals(messages),
        },
      };
    }),

  setSelectedModel: (model, service) => set({ selectedModel: model, selectedService: service }),

  loadSessionList: async (bookId) => {
    const query = bookId === null ? "null" : encodeURIComponent(bookId);
    try {
      const data = await fetchJson<{ sessions: ReadonlyArray<SessionSummary> }>(`/sessions?bookId=${query}`);
      set((state) => {
        let sessions = state.sessions;
        for (const summary of data.sessions) {
          sessions = upsertSessionSummary(sessions, summary);
        }
        return {
          sessions,
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(bookId)]: data.sessions.map((session) => session.sessionId),
          },
        };
      });
      return data.sessions;
    } catch {
      return [];
    }
  },

  createSession: async (bookId, sessionKind, playMode) => {
    const data = await fetchJson<SessionResponse>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId, sessionKind, playMode }),
    });
    const sessionId = data.session?.sessionId;
    if (!sessionId) {
      throw new Error("Failed to create session");
    }

    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId: data.session?.bookId ?? bookId ?? null,
        sessionKind: data.session?.sessionKind ?? sessionKind,
        playMode: data.session?.playMode,
        title: data.session?.title ?? null,
      });
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: runtime,
        },
        sessionIdsByBook: {
          ...state.sessionIdsByBook,
          [bookKey(runtime.bookId)]: mergeSessionIds(
            state.sessionIdsByBook[bookKey(runtime.bookId)],
            [sessionId],
          ),
        },
        activeSessionId: sessionId,
      };
    });

    return sessionId;
  },

  createDraftSession: (bookId, sessionKind, playMode) => {
    // 前端生成 sessionId（与后端 createBookSession 同格式），暂不持久化到磁盘，
    // 也暂不写入 sessionIdsByBook——侧边栏看不到这条 draft。
    // 发送第一条消息时 sendMessage 会调 POST /sessions { sessionId, bookId } 落盘
    // 并把 id 追加进 sessionIdsByBook，那一刻侧边栏才出现该会话（带着 title）。
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const runtime = createSessionRuntime({
        sessionId,
        bookId,
        sessionKind,
        playMode,
        title: null,
        isDraft: true,
      });
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: runtime,
        },
        activeSessionId: sessionId,
      };
    });
    return sessionId;
  },

  renameSession: async (sessionId, title) => {
    const previous = get().sessions[sessionId]?.title ?? null;
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ title })),
    }));

    try {
      await fetchJson(`/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, () => ({ title: previous })),
      }));
    }
  },

  deleteSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    session?.stream?.close();
    // 草稿会话还没写到磁盘，跳过 DELETE 请求避免后端返回 404
    if (session && !session.isDraft) {
      try {
        await fetchJson(`/sessions/${sessionId}`, { method: "DELETE" });
      } catch {
        // ignore
      }
    }

    set((state) => {
      const { [sessionId]: deleted, ...rest } = state.sessions;
      const sessionIdsByBook = Object.fromEntries(
        Object.entries(state.sessionIdsByBook).map(([key, ids]) => [
          key,
          ids.filter((id) => id !== sessionId),
        ]),
      );

      let activeSessionId = state.activeSessionId;
      if (activeSessionId === sessionId) {
        const fallbackKey = bookKey(session?.bookId ?? null);
        activeSessionId = sessionIdsByBook[fallbackKey]?.[0] ?? null;
      }

      return {
        sessions: rest,
        sessionIdsByBook,
        activeSessionId,
      };
    });
  },

  abortSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    session?.stream?.close();
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({
        isStreaming: false,
        stream: null,
        lastError: null,
      })),
    }));
    try {
      await fetchJson(`/sessions/${sessionId}/abort`, { method: "POST" });
    } catch (error) {
      get().addErrorMessage(sessionId, error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * Restore a session to "just after" the given message index.
   *
   * `messageIndex` follows the same ordering backend uses (`committedMessageEvents`
   * 按 seq 排序后的数组索引)，与 store.messages 数组中的位置对应。
   *
   * 行为：
   * 1. 关闭 in-flight SSE 流
   * 2. POST /sessions/:sessionId/messages/:messageIndex/rewind（后端 truncate + evict）
   * 3. 同步 store：移除该 index 之后的所有 messages（含 assistant / tool executions），
   *    并标记 isStreaming=false，draftRounds 清空避免残留。
   *
   * 注意：restore 是同步本地 + 后端的 destructive 行为，所以不提供"soft" 模式。
   * 如果想保留 history 而不实际删除，传 `keepInSession: true`（保留兼容外部
   * Agent.run，但当前 UI 不暴露该选项）。
   */
  rewindToMessage: async (sessionId, messageIndex) => {
    const session = get().sessions[sessionId];
    if (!session) return null;

    const total = session.messages.length;
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= total) {
      get().addErrorMessage(sessionId, `rewindToMessage: invalid index ${messageIndex}`);
      return null;
    }

    const targetMessage = session.messages[messageIndex];
    const retryContent = targetMessage.role === "user" ? targetMessage.content : null;

    session.stream?.close();
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, (current) => ({
        isStreaming: false,
        stream: null,
        lastError: null,
        messages: current.messages.slice(0, messageIndex),
        draftRounds: [],
      })),
    }));

    try {
      await fetchJson(
        `/sessions/${sessionId}/messages/${messageIndex}/rewind`,
        { method: "POST" },
      );
    } catch (error) {
      get().addErrorMessage(sessionId, error instanceof Error ? error.message : String(error));
    }

    return retryContent;
  },

  /**
   * Restore to a user message then immediately re-send its content.
   *
   * 配合 `rewindToMessage` 使用，UI 流程：
   * 1. 用户点 user message 上的"Retry"按钮
   * 2. 后端 truncate + evict
   * 3. store 截断 messages
   * 4. sendMessage 把同一条 user content 重新发出去（模型不同 = 不同响应）
   */
  retryFromMessage: async (sessionId, messageIndex) => {
    const retryContent = await get().rewindToMessage(sessionId, messageIndex);
    if (retryContent !== null) {
      await get().sendMessage(sessionId, retryContent, {});
    } else {
      // 不在 user message 上重试时，跳过 re-send。让 UI 的 Restore 流程单独处理。
    }
  },

  loadSessionDetail: async (sessionId) => {
    // 草稿会话：磁盘上还没有文件，直接跳过远端拉取。
    // 本地已有消息：不拉取远端，避免流式中或未持久化的消息被覆盖。
    const existing = get().sessions[sessionId];
    if (existing?.isDraft) return;
    if (existing && existing.messages.length > 0) return;

    try {
      const data = await fetchJson<SessionResponse>(`/sessions/${sessionId}`);
      const detail = data.session;
      if (!detail?.sessionId) return;
      const detailSessionId = detail.sessionId;
      const messages = detail.messages ? deserializeMessages(detail.messages) : [];
      const restoredResolutions = deriveResolvedProposals(messages);

      set((state) => {
        const runtime = state.sessions[detailSessionId];
        // set 执行到这里可能已有本地消息写入（比如并发 sendMessage），再查一次。
        if (runtime && runtime.messages.length > 0) return {};
        const nextBookId = detail.bookId ?? runtime?.bookId ?? null;
        return {
          sessions: {
            ...state.sessions,
            [detailSessionId]: {
              ...(runtime ?? createSessionRuntime({
                sessionId: detailSessionId,
                bookId: nextBookId,
                sessionKind: detail.sessionKind,
                playMode: detail.playMode,
                title: detail.title ?? null,
              })),
              bookId: nextBookId,
              sessionKind: detail.sessionKind ?? runtime?.sessionKind,
              playMode: detail.playMode ?? runtime?.playMode,
              title: detail.title ?? runtime?.title ?? null,
              messages,
            },
          },
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(nextBookId)]: mergeSessionIds(
              state.sessionIdsByBook[bookKey(nextBookId)],
              [detailSessionId],
            ),
          },
          resolvedProposals: {
            ...state.resolvedProposals,
            ...restoredResolutions,
          },
        };
      });
    } catch {
      // ignore
    }
  },

  sendMessage: async (sessionId, text, options?: SendMessageOptions) => {
    const trimmed = text.trim();
    const attachments = options?.attachments ?? [];
    const session = get().sessions[sessionId];
    if ((!trimmed && attachments.length === 0) || !session || session.isStreaming) return;
    const userInstruction = trimmed || "请阅读我上传的文件。";
    const activeBookId = options?.activeBookId ?? session.bookId ?? undefined;
    const sessionKind: ChatSessionKind = options?.sessionKind
      ?? session.sessionKind
      ?? (activeBookId ? "book" : "chat");
    const actionSource = options?.actionSource ?? "free-text";
    const playMode = options?.playMode ?? session.playMode;

    if (!get().selectedModel) {
      get().addUserMessage(sessionId, formatUserMessageForDisplay(userInstruction, attachments));
      get().addErrorMessage(sessionId, "请先选择一个模型");
      return;
    }

    // 草稿会话：第一条消息发送时才真正把 session 文件写到磁盘。
    // 后端 POST /sessions 支持接受客户端传入的 sessionId，所以 id 保持一致，
    // 前端 store 里的 runtime 不用 remount，只需要把 isDraft 翻成 false。
    if (session.isDraft) {
      try {
        await fetchJson<SessionResponse>("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, bookId: session.bookId, sessionKind, playMode }),
        });
        // 落盘成功：把 isDraft 翻成 false，同时把 sessionId 追加进 sessionIdsByBook
        // 让侧边栏现在才看到这条会话。
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, () => ({ isDraft: false, sessionKind, playMode })),
          sessionIdsByBook: {
            ...state.sessionIdsByBook,
            [bookKey(session.bookId)]: mergeSessionIds(
              state.sessionIdsByBook[bookKey(session.bookId)],
              [sessionId],
            ),
          },
        }));
      } catch (err) {
        get().addErrorMessage(sessionId, err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const skillDirectives = parseSkillDirectives(userInstruction);
    const instruction = skillDirectives.instruction;
    const requestedSkills = mergeSkillIds(skillDirectives.requestedSkills, options?.requestedSkills);
    const disabledSkills = mergeSkillIds([], options?.disabledSkills);
    const streamTs = Date.now() + 1;

    set((state) => ({
      input: "",
      activeSessionId: sessionId,
      sessions: updateSession(state.sessions, sessionId, () => ({
        isStreaming: true,
        lastError: null,
      })),
    }));

    get().addUserMessage(sessionId, formatUserMessageForDisplay(userInstruction, attachments));
    session.stream?.close();
    const streamEs = new EventSource("/api/v1/events");
    set((state) => ({
      sessions: updateSession(state.sessions, sessionId, () => ({ stream: streamEs })),
    }));
    attachSessionStreamListeners({ sessionId, streamTs, streamEs, set, get });

    try {
      const data = await fetchJson<AgentResponse>("/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          activeBookId,
          sessionKind,
          playMode,
          actionSource,
          requestedIntent: options?.requestedIntent,
          actionPayload: options?.actionPayload,
          requestedSkills,
          disabledSkills,
          attachments,
          sessionId,
          model: get().selectedModel ?? undefined,
          service: get().selectedService ?? undefined,
        }),
      });

      streamEs.close();

      const finalContent = data.details?.draftRaw || data.response || "";
      const toolCall = data.details?.toolCall ?? undefined;
      const responseToolExecutions = data.details?.toolExecutions ?? [];
      const responseBookId = data.session?.activeBookId ?? data.session?.bookId;
      const responseSessionKind = data.session?.sessionKind;
      if (responseBookId || responseSessionKind || data.session?.title || data.session?.playMode) {
        set((state) => {
          const runtime = state.sessions[sessionId];
          if (!runtime) return {};
          const nextBookId = responseBookId ?? runtime.bookId;
          return {
            sessions: updateSession(state.sessions, sessionId, () => ({
              bookId: nextBookId,
              sessionKind: responseSessionKind ?? runtime.sessionKind,
              playMode: data.session?.playMode ?? runtime.playMode,
              title: data.session?.title ?? runtime.title,
            })),
            sessionIdsByBook: {
              ...state.sessionIdsByBook,
              [bookKey(nextBookId)]: mergeSessionIds(
                state.sessionIdsByBook[bookKey(nextBookId)],
                [sessionId],
              ),
            },
          };
        });
      }
      const hasStream = Boolean(
        get().sessions[sessionId]?.messages.some((message) => message.timestamp === streamTs),
      );
      const attachResponseTools = () => {
        if (responseToolExecutions.length === 0) return;
        set((state) => ({
          sessions: updateSession(state.sessions, sessionId, (runtime) => ({
            messages: runtime.messages.map((message) => (
              message.timestamp === streamTs && message.role === "assistant"
                ? withToolExecutions(message, responseToolExecutions)
                : message
            )),
          })),
        }));
      };

      if (data.error) {
        const errorMessage = extractErrorMessage(data.error);
        if (hasStream) {
          get().replaceStreamWithError(sessionId, streamTs, errorMessage);
        } else {
          get().addErrorMessage(sessionId, errorMessage);
        }
      } else if (finalContent) {
        if (hasStream) {
          get().finalizeStream(sessionId, streamTs, finalContent, toolCall);
          attachResponseTools();
        } else {
          const message = withToolExecutions({
            role: "assistant",
            content: finalContent,
            timestamp: Date.now(),
            toolCall,
          }, responseToolExecutions);
          set((state) => ({
            sessions: updateSession(state.sessions, sessionId, (runtime) => ({
              messages: [
                ...runtime.messages,
                message,
              ],
            })),
          }));
        }
      } else if (responseToolExecutions.length > 0) {
        if (hasStream) {
          get().finalizeStream(sessionId, streamTs, "", toolCall);
          attachResponseTools();
        } else {
          const message = withToolExecutions({
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            toolCall,
          }, responseToolExecutions);
          set((state) => ({
            sessions: updateSession(state.sessions, sessionId, (runtime) => ({
              messages: [...runtime.messages, message],
            })),
          }));
        }
      } else {
        if (hasStream) {
          get().finalizeStream(sessionId, streamTs, "", toolCall);
        } else {
          const emptyMessage = "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。";
          get().addErrorMessage(sessionId, emptyMessage);
        }
      }
    } catch (error) {
      streamEs.close();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const hasStream = Boolean(
        get().sessions[sessionId]?.messages.some((message) => message.timestamp === streamTs),
      );
      if (hasStream) {
        get().replaceStreamWithError(sessionId, streamTs, errorMessage);
      } else {
        get().addErrorMessage(sessionId, errorMessage);
      }
    } finally {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => ({
          isStreaming: false,
          stream: runtime.stream === streamEs ? null : runtime.stream,
        })),
      }));
    }
  },
});
