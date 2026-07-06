import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InteractionEvent,
  Logger,
  PipelineRunner,
  StateManager,
  ReviseMode,
  LLMClient,
  BookConfig,
} from "../index.js";
import { chatCompletion } from "../index.js";
import { executeEditTransaction } from "./edit-controller.js";
import { defaultChapterLength } from "../utils/length-metrics.js";
import type { InteractionRuntimeTools } from "./runtime.js";
import { writeExportArtifact } from "./export-artifact.js";
import { safeChildPath } from "../utils/path-safety.js";
import { deriveBookIdFromTitle } from "../utils/book-id.js";
import { normalizePlatformOrOther } from "../models/book.js";

const SAFE_TRUTH_FLAT_FILE_NAMES = new Set([
  "author_intent.md",
  "current_focus.md",
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "particle_ledger.md",
  "subplot_board.md",
  "emotional_arcs.md",
  "style_guide.md",
  "parent_canon.md",
  "fanfic_canon.md",
  "character_matrix.md",
  "current_state.md",
  "pending_hooks.md",
  "chapter_summaries.md",
]);

const SAFE_TRUTH_OUTLINE_FILE_NAMES = new Set([
  "outline/story_frame.md",
  "outline/volume_map.md",
  "outline/节奏原则.md",
  "outline/rhythm_principles.md",
]);

const SAFE_ROLE_TRUTH_FILE_RE = /^roles\/(主要角色|次要角色|major|minor)\/[^/\\]+\.md$/u;

/**
 * Lightweight language detection for the simple chat surface.
 * Heuristic only — the goal is to choose between fully-localised system
 * prompts (zh vs en), not to be a typology engine. We pick zh whenever the
 * user wrote any CJK character; everything else falls back to en so the
 * reasoning model is encouraged to think AND respond in the user's language
 * instead of being nudged into English by the system prompt.
 *
 * Reasoning-only models (MiniMax-M3, kimi-k2.5, DeepSeek-R1, etc.) tend to
 * match their internal monologue to whatever the system prompt frames the
 * task in, so a hard-coded English prompt here leaked into thinking text —
 * which is exactly what the user was seeing in their chat replies.
 */
function detectChatLanguage(input: string): "zh" | "en" {
  if (typeof input !== "string" || input.length === 0) return "en";
  return /[\u3400-\u9fff]/.test(input) ? "zh" : "en";
}

/**
 * Localised prompts + fallback strings for the simple chat surface.
 * Keeping these here (not in agent-system-prompt.ts) because the chat path
 * is intentionally thin — it does NOT have the AgentSession tool loop and
 * therefore should not pull in the heavier building/revision instructions.
 */
function buildChatPrompts(language: "zh" | "en", bookLabel: string): {
  systemPrompt: string;
  fallbackGreeting: string;
  emptyModelReply: string;
} {
  if (language === "zh") {
    return {
      systemPrompt: [
        "你是 InkOS 聊天助手（终端工作台内）。",
        "用户用中文与你交流；你的内部思考和最终回复都必须保持中文，不要混用英文。",
        "简洁直接，不寒暄；用户问什么答什么。",
        "没有 active 作品时：帮用户理清下一步想写什么。",
        "有 active 作品时：以当前书的设定为准作答；用户已经在聊天里粘贴的设定摘要、卷纲、章节摘要、角色卡等，都视为本次对话的上下文。",
        "重要：你是 reasoning 模型。如果你的 API 支持 reasoning 通道（reasoning_content / thinking 块），把内部推理放在那里，content 字段只能放最终给用户看的答复。不允许在 content 里出现 \"让我想想\"、\"Wait,\"、\"Actually,\"、\"Let me re-read the user input\" 这种思维串。",
        "如果你认为当前信息不足以回答（例如需要 read 设定/角色卡/章节内容才能给准确答复），明确告诉用户你想读哪个文件，并调用可用的工具（read / grep / ls）去取；不靠脑补。",
        "如果用户给的是确定指令（例如新增设定、改角色卡、续写下一章），直接调用对应工具，不要再用普通文字反问下一步；工具调用本身就是答复。",
      ].join("\n"),
      fallbackGreeting: bookLabel !== "none"
        ? `我在。当前作品是 ${bookLabel}。可以让我续写下一章、修订、改设定，或者贴具体修改要求。`
        : "我在。当前还没有激活作品。可以告诉我题目、题材、开头方向，我们一起把它收出来。",
      emptyModelReply: "这一轮模型只给出了内部推理，没有生成对外可见的答复。已自动重试/上报；如果重发问题仍然得到这个提示，请检查当前选定的 reasoning 模型是否启用了对外输出，或切到非 reasoning 模型再试。",
    };
  }
  return {
    systemPrompt: [
      "You are the InkOS chat assistant inside the terminal workbench.",
      "Match the user's language exactly — both the visible reply and any reasoning/thinking MUST be in the same language as the user.",
      "Be concise and direct. Answer what was asked; do not pad with acknowledgements.",
      "If there is no active book, help the user figure out what to write next.",
      "If there is an active book, ground your answer in that book's context. Treat any inlined story bible / volume map / character cards / chapter summaries the user pasted as canonical for this turn.",
      "Important: you are a reasoning-capable model. If your API exposes a separate reasoning channel (reasoning_content / thinking blocks), keep internal thinking there. The content field is for the user-visible reply only. Do NOT write \"Let me think…\", \"Wait,\", \"Actually,\", \"Let me re-read the user input\" into content — if you find yourself starting that sentence, you leaked thinking into the visible channel and the reply has already failed.",
      "If you genuinely cannot answer without reading the active book's files (story frame / volume map / character cards / chapter summaries), say so explicitly and call the available read / grep / ls tools. Do not invent facts.",
      "If the user gave a concrete instruction (add a setting, change a character card, continue the next chapter), call the matching tool — the tool call IS the answer. Do not respond with a follow-up question first.",
    ].join("\n"),
    fallbackGreeting: bookLabel !== "none"
      ? `I'm here. Active book: ${bookLabel}. Ask me to continue, revise, edit a setting, or to inspect why the pipeline stopped.`
      : "I'm here. No active book yet. Open a book, list books, or tell me what you want to write.",
    emptyModelReply: "This turn the model only produced internal reasoning and no visible reply. The provider boundary stripped it; please retry or check whether the selected reasoning model is configured to emit visible output. Switching to a non-reasoning model is a safe fallback.",
  };
}

export function assertSafeTruthFileName(fileName: string): string {
  const trimmed = fileName.trim();
  const withExtension = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  const lower = withExtension.toLowerCase();
  if (
    !trimmed ||
    withExtension.startsWith("/") ||
    withExtension.includes("\\") ||
    withExtension.includes("\0") ||
    withExtension.includes("..")
  ) {
    throw new Error(`Invalid truth file name: ${JSON.stringify(fileName)}`);
  }
  if (SAFE_TRUTH_FLAT_FILE_NAMES.has(lower)) return lower;
  if (SAFE_TRUTH_OUTLINE_FILE_NAMES.has(lower)) return lower;
  if (SAFE_ROLE_TRUTH_FILE_RE.test(withExtension)) return withExtension;
  throw new Error(`Invalid truth file name: ${JSON.stringify(fileName)}`);
}

type PipelineLike = Pick<PipelineRunner, "writeNextChapter" | "reviseDraft"> & {
  readonly initBook?: (
    book: BookConfig,
    options?: {
      readonly externalContext?: string;
      readonly authorIntent?: string;
      readonly currentFocus?: string;
    },
  ) => Promise<void>;
};
type StateLike = Pick<StateManager, "ensureControlDocuments" | "bookDir" | "loadBookConfig" | "loadChapterIndex" | "saveChapterIndex" | "listBooks" | "acquireBookLock">;
type InstrumentablePipelineLike = PipelineLike & {
  readonly config?: {
    logger?: Logger;
    client?: LLMClient;
    model?: string;
  };
};

function buildBookConfig(input: {
  readonly title: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
  readonly chapterWordCount?: number;
  readonly targetChapters?: number;
}): BookConfig {
  const now = new Date().toISOString();
  return {
    id: deriveBookIdFromTitle(input.title) || `book-${Date.now().toString(36)}`,
    title: input.title,
    platform: normalizePlatformOrOther(input.platform),
    genre: input.genre ?? "other",
    status: "outlining",
    targetChapters: input.targetChapters ?? 200,
    chapterWordCount: input.chapterWordCount ?? defaultChapterLength(input.language === "en" ? "en" : "zh"),
    ...(input.language ? { language: input.language } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function buildCreationExternalContext(input: {
  readonly blurb?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly conflictCore?: string;
  readonly volumeOutline?: string;
  readonly constraints?: string;
}): string | undefined {
  const sections = [
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键角色与势力\n${input.supportingCast}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.volumeOutline ? `## 卷纲方向\n${input.volumeOutline}` : undefined,
    input.blurb ? `## 简介卖点\n${input.blurb}` : undefined,
    input.constraints ? `## 创作约束\n${input.constraints}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

async function withBookMutationLock<T>(
  state: StateLike,
  bookId: string,
  task: () => Promise<T>,
): Promise<T> {
  const releaseLock = await state.acquireBookLock(bookId);
  try {
    return await task();
  } finally {
    await releaseLock();
  }
}

export function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

async function exportBookToPath(state: StateLike, bookId: string, options: {
  readonly format?: "txt" | "md" | "epub";
  readonly approvedOnly?: boolean;
  readonly outputPath?: string;
}) {
  return writeExportArtifact(state, bookId, options);
}

function mapStageMessageToStatus(message: string): InteractionEvent["status"] | undefined {
  const lower = message.trim().toLowerCase();
  if (
    lower.includes("planning next chapter")
    || lower.includes("generating foundation")
    || lower.includes("reviewing foundation")
    || lower.includes("preparing chapter inputs")
    || message.includes("规划下一章意图")
    || message.includes("生成基础设定")
    || message.includes("审核基础设定")
    || message.includes("准备章节输入")
  ) {
    return "planning";
  }
  if (
    lower.includes("composing chapter runtime context")
    || message.includes("组装章节运行时上下文")
  ) {
    return "composing";
  }
  if (
    lower.includes("writing chapter draft")
    || message.includes("撰写章节草稿")
  ) {
    return "writing";
  }
  if (
    lower.includes("auditing draft")
    || message.includes("审计草稿")
  ) {
    return "assessing";
  }
  if (
    lower.includes("fixing")
    || lower.includes("revising chapter")
    || lower.includes("rewrite")
    || lower.includes("repair")
    || message.includes("自动修复")
    || message.includes("整章改写")
    || message.includes("修订第")
  ) {
    return "repairing";
  }
  if (
    lower.includes("persist")
    || lower.includes("saving")
    || lower.includes("snapshot")
    || lower.includes("rebuilding final truth files")
    || lower.includes("validating truth file updates")
    || lower.includes("syncing memory indexes")
    || message.includes("落盘")
    || message.includes("保存")
    || message.includes("快照")
    || message.includes("校验真相文件变更")
    || message.includes("生成最终真相文件")
    || message.includes("同步记忆索引")
  ) {
    return "persisting";
  }
  return undefined;
}

function extractStageDetail(message: string): string | undefined {
  if (message.startsWith("Stage: ")) {
    return message.slice("Stage: ".length).trim();
  }
  if (message.startsWith("阶段：")) {
    return message.slice("阶段：".length).trim();
  }
  return undefined;
}

function createInteractionLogger(
  original: Logger | undefined,
  events: InteractionEvent[],
  bookId: string,
): Logger {
  const emit = (level: "debug" | "info" | "warn" | "error", message: string): void => {
    const stageDetail = extractStageDetail(message);
    const stageStatus = stageDetail ? mapStageMessageToStatus(stageDetail) : undefined;

    if (stageDetail && stageStatus) {
      events.push({
        kind: "stage.changed",
        timestamp: Date.now(),
        status: stageStatus,
        bookId,
        detail: stageDetail,
      });
      return;
    }

    if (level === "warn") {
      events.push({
        kind: "task.warning",
        timestamp: Date.now(),
        status: "blocked",
        bookId,
        detail: message,
      });
      return;
    }

    if (level === "error") {
      events.push({
        kind: "task.failed",
        timestamp: Date.now(),
        status: "failed",
        bookId,
        detail: message,
      });
    }
  };

  const wrap = (base: Logger | undefined): Logger => ({
    debug: (msg, ctx) => {
      emit("debug", msg);
      base?.debug(msg, ctx);
    },
    info: (msg, ctx) => {
      emit("info", msg);
      base?.info(msg, ctx);
    },
    warn: (msg, ctx) => {
      emit("warn", msg);
      base?.warn(msg, ctx);
    },
    error: (msg, ctx) => {
      emit("error", msg);
      base?.error(msg, ctx);
    },
    child: (tag, extraCtx) => wrap(base?.child(tag, extraCtx)),
  });

  return wrap(original);
}

async function withPipelineInteractionTelemetry<T extends { chapterNumber?: number }>(
  pipeline: InstrumentablePipelineLike,
  bookId: string,
  executor: () => Promise<T>,
): Promise<T & {
  __interaction: {
    events: ReadonlyArray<InteractionEvent>;
    activeChapterNumber?: number;
  };
}> {
  const events: InteractionEvent[] = [];
  const originalLogger = pipeline.config?.logger;
  if (pipeline.config) {
    pipeline.config.logger = createInteractionLogger(originalLogger, events, bookId);
  }

  try {
    const result = await executor();
    return {
      ...result,
      __interaction: {
        events,
        ...(typeof result.chapterNumber === "number"
          ? { activeChapterNumber: result.chapterNumber }
          : {}),
      },
    };
  } finally {
    if (pipeline.config) {
      pipeline.config.logger = originalLogger;
    }
  }
}

export function createInteractionToolsFromDeps(
  pipeline: PipelineLike,
  state: StateLike,
  hooks?: {
    readonly onChatTextDelta?: (text: string) => void;
    readonly onDraftTextDelta?: (text: string) => void;
    readonly onDraftRawDelta?: (text: string) => void;
    readonly getChatRequestOptions?: () => {
      readonly temperature?: number;
      readonly maxTokens?: number;
    };
  },
): InteractionRuntimeTools {
  const instrumentedPipeline = pipeline as InstrumentablePipelineLike;

  return {
    listBooks: () => state.listBooks(),
    createBook: async (input) => {
      const book = buildBookConfig(input);
      if (!pipeline.initBook) {
        throw new Error("Pipeline does not support shared book creation.");
      }
      await pipeline.initBook(book, {
        externalContext: buildCreationExternalContext(input),
        authorIntent: input.authorIntent,
        currentFocus: input.currentFocus,
      });
      return {
        bookId: book.id,
        title: book.title,
        __interaction: {
          responseText: `Created ${book.title} (${book.id}).`,
          details: {
            kind: "book_created",
            bookId: book.id,
            title: book.title,
          },
        },
      };
    },
    exportBook: async (bookId, options) => {
      const result = await exportBookToPath(state, bookId, options);
      return {
        ...result,
        __interaction: {
          responseText: `Exported ${bookId} to ${result.outputPath} (${result.chaptersExported} chapters).`,
          details: {
            outputPath: result.outputPath,
            chaptersExported: result.chaptersExported,
            totalWords: result.totalWords,
            format: result.format,
          },
        },
      };
    },
    chat: async (input, options) => {
      const bookLabel = options.bookId ?? "none";
      const chatRequestOptions = hooks?.getChatRequestOptions?.() ?? {};
      const language = detectChatLanguage(input);
      const { systemPrompt, fallbackGreeting, emptyModelReply } = buildChatPrompts(language, bookLabel);
      let response: Awaited<ReturnType<typeof chatCompletion>> | undefined;
      let emptyContentDueToReasoningModel = false;
      if (instrumentedPipeline.config?.client && instrumentedPipeline.config?.model) {
        try {
          response = await chatCompletion(
            instrumentedPipeline.config.client,
            instrumentedPipeline.config.model,
            [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: language === "zh"
                  // zh 路径：用中文标签包用户输入，避免英文 framing 推模型去用英文思考。
                  ? `当前作品=${bookLabel}\n自动化模式=${options.automationMode}\n消息=${input}`
                  // en 路径：保留原来的英文 wrapper。
                  : `activeBook=${bookLabel}\nautomationMode=${options.automationMode}\nmessage=${input}`,
              },
            ],
            {
              temperature: chatRequestOptions.temperature ?? 0.4,
              ...(chatRequestOptions.maxTokens !== undefined && { maxTokens: chatRequestOptions.maxTokens }),
              onTextDelta: hooks?.onChatTextDelta,
            },
          );
        } catch (err) {
          // Reasoning-only 模型（如 MiniMax-M3、kimi-k2.5、DeepSeek-R1）在简单输入下
          // 可能只返回 reasoning_content、content 为空。这种情况被 provider 边界判为
          // "empty response"——给用户一条明确的、不冒充回复的提示，而不是把内部
          // 思考塞回聊天框。
          const msg = err instanceof Error ? err.message : "";
          if (!msg.includes("empty")) {
            throw err;
          }
          emptyContentDueToReasoningModel = true;
        }
      }

      const visibleContent = response?.content?.trim() ?? "";
      // reasoning channel 单独通过 metadata 透传给上层（仅供调试/Tracing），
      // 绝不允许它替代 content 走到用户面前。
      const responseText = visibleContent
        || (emptyContentDueToReasoningModel
          ? emptyModelReply
          : fallbackGreeting);

      return {
        __interaction: {
          responseText,
          ...(response?.reasoningContent
            ? { details: { reasoningContent: response.reasoningContent } }
            : {}),
        },
      };
    },
    writeNextChapter: (bookId) => withPipelineInteractionTelemetry(
      instrumentedPipeline,
      bookId,
      () => pipeline.writeNextChapter(bookId),
    ),
    reviseDraft: (bookId, chapterNumber, mode) => withPipelineInteractionTelemetry(
      instrumentedPipeline,
      bookId,
      () => pipeline.reviseDraft(bookId, chapterNumber, mode as ReviseMode),
    ),
    patchChapterText: async (bookId, chapterNumber, targetText, replacementText) => withBookMutationLock(state, bookId, async () => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "chapter-local-edit",
          bookId,
          chapterNumber,
          instruction: `Replace ${targetText} with ${replacementText}`,
          targetText,
          replacementText,
        },
      );
      return {
        __interaction: {
          activeChapterNumber: chapterNumber,
          responseText: execution.summary,
        },
      };
    }),
    replaceChapterText: async (bookId, chapterNumber, fullText) => withBookMutationLock(state, bookId, async () => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "chapter-replace",
          bookId,
          chapterNumber,
          fullText,
        },
      );
      return {
        __interaction: {
          activeChapterNumber: chapterNumber,
          responseText: execution.summary,
        },
      };
    }),
    renameEntity: async (bookId, oldValue, newValue) => withBookMutationLock(state, bookId, async () => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "entity-rename",
          bookId,
          entityType: "character",
          oldValue,
          newValue,
        },
      );
      return {
        __interaction: {
          responseText: execution.summary,
        },
      };
    }),
    updateCurrentFocus: async (bookId, content) => withBookMutationLock(state, bookId, async () => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), content, "utf-8");
    }),
    updateAuthorIntent: async (bookId, content) => withBookMutationLock(state, bookId, async () => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", "author_intent.md"), content, "utf-8");
    }),
    writeTruthFile: async (bookId, fileName, content) => withBookMutationLock(state, bookId, async () => {
      await state.ensureControlDocuments(bookId);
      const storyDir = join(state.bookDir(bookId), "story");
      const safeFileName = assertSafeTruthFileName(fileName);
      const targetPath = safeChildPath(storyDir, safeFileName);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, "utf-8");
    }),
  };
}
