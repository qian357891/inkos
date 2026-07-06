import { readFile, writeFile, mkdir, readdir, rm, stat, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import { bootstrapStructuredStateFromMarkdown, resolveDurableStoryProgress } from "./state-bootstrap.js";

/** A lock file is considered stale after this many ms, regardless of PID alive check. */
const LOCK_TTL_MS = 5 * 60 * 1000;

interface LockContent {
  readonly pid: number;
  readonly ts: number;
  readonly token: string;
}

function parseLockContent(raw: string): LockContent | null {
  const pidMatch = raw.match(/pid:(\d+)/);
  const tsMatch = raw.match(/ts:(\d+)/);
  const tokenMatch = raw.match(/token:([\w-]+)/);
  if (!pidMatch || !tsMatch || !tokenMatch) return null;
  const pid = Number.parseInt(pidMatch[1] ?? "", 10);
  const ts = Number.parseInt(tsMatch[1] ?? "", 10);
  const token = tokenMatch[1] ?? "";
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts) || !token) return null;
  return { pid, ts, token };
}

function formatLockContent(pid: number, ts: number, token: string): string {
  return `pid:${pid} ts:${ts} token:${token}\n`;
}

export class StateManager {
  /** Books actively being written by this process — used for same-process in-process queue. */
  private readonly activeBookLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly projectRoot: string) {}

  private static defaultAuthorIntent(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 作者意图\n\n（在这里描述这本书的长期创作方向。）\n"
      : "# Author Intent\n\n(Describe the long-horizon vision for this book here.)\n";
  }

  private static defaultCurrentFocus(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 当前聚焦\n\n## 当前重点\n\n（描述接下来 1-3 章最需要优先推进的内容。）\n"
      : "# Current Focus\n\n## Active Focus\n\n(Describe what the next 1-3 chapters should prioritize.)\n";
  }

  async ensureControlDocuments(bookId: string, authorIntent?: string): Promise<void> {
    const language = await this.resolveControlDocumentLanguage(bookId);
    await this.ensureControlDocumentsAt(this.bookDir(bookId), language, authorIntent);
  }

  async ensureControlDocumentsAt(
    bookDir: string,
    language: "zh" | "en",
    authorIntent?: string,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    const outlineDir = join(storyDir, "outline");
    const rolesMajorDir = join(storyDir, "roles", "主要角色");
    const rolesMinorDir = join(storyDir, "roles", "次要角色");

    await mkdir(storyDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });
    await mkdir(rolesMajorDir, { recursive: true });
    await mkdir(rolesMinorDir, { recursive: true });

    await this.writeIfMissing(
      join(storyDir, "author_intent.md"),
      authorIntent?.trim()
        ? authorIntent.trimEnd() + "\n"
        : StateManager.defaultAuthorIntent(language),
    );

    await this.writeIfMissing(
      join(storyDir, "current_focus.md"),
      StateManager.defaultCurrentFocus(language),
    );

    // Ensure style_guide includes writing methodology even without reference text
    const styleGuidePath = join(storyDir, "style_guide.md");
    try {
      const existing = await readFile(styleGuidePath, "utf-8");
      if (!existing.includes("写作方法论") && !existing.includes("Writing Methodology")) {
        const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
        await writeFile(styleGuidePath, `${existing}\n\n${buildWritingMethodologySection(language)}`, "utf-8");
      }
    } catch {
      const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
      await writeFile(styleGuidePath, buildWritingMethodologySection(language), "utf-8");
    }
  }

  async loadControlDocuments(bookId: string): Promise<{
    authorIntent: string;
    currentFocus: string;
    runtimeDir: string;
  }> {
    await this.ensureControlDocuments(bookId);

    const storyDir = join(this.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    const [authorIntent, currentFocus] = await Promise.all([
      readFile(join(storyDir, "author_intent.md"), "utf-8"),
      readFile(join(storyDir, "current_focus.md"), "utf-8"),
    ]);

    return { authorIntent, currentFocus, runtimeDir };
  }

  private async resolveControlDocumentLanguage(bookId: string): Promise<"zh" | "en"> {
    try {
      const raw = await readFile(join(this.bookDir(bookId), "book.json"), "utf-8");
      const parsed = JSON.parse(raw) as { language?: unknown };
      return parsed.language === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  }

  /**
   * Acquire an exclusive write lock for a book.
   *
   * ## Concurrency model
   *
   * Two layers, both must succeed to claim the lock:
   *
   * 1. **In-process gate** (`activeBookLocks` map):
   *    If a same-process claimant is already registered for this book,
   *    immediately throw — don't queue. This matches the existing
   *    `allows only one concurrent lock claimant` behavior and prevents
   *    accidental in-process deadlocks.
   *
   * 2. **Cross-process file lock** (`.write.lock`):
   *    Uses `open(path, "wx")` (exclusive create) as a low-level mutex.
   *    Each lock file carries a unique `token` (random UUID written by this
   *    process), `pid`, and `ts` (acquired-at epoch ms).
   *
   * ## Stale lock recovery
   *
   * On EEXIST, the existing lock is evaluated as stale if any of these hold:
   *
   *   a. Lock content is unparseable (legacy / corrupted format).
   *   b. `Date.now() - existing.ts > LOCK_TTL_MS` (5 minutes — survives
   *      long-running ops, exits if a daemon process crashed even days ago).
   *   c. `existing.pid` is no longer alive (`process.kill(pid, 0)` returns
   *      ESRCH).
   *   d. `existing.pid === process.pid && existing.token !== token` —
   *      same process holds a leftover lock with a stale token, but we are
   *      a fresh acquisition. Safe to clear.
   *
   * If none of the above, the lock is owned by another live process:
   * throw with diagnostics so the user can decide whether to delete manually.
   *
   * ## Release
   *
   * `release()` first removes the in-process map entry, then verifies the
   * on-disk lock file still carries our `pid + token` before unlinking.
   * If a third party (kill -9 daemon recovery, etc.) overwrote the lock
   * with someone else's token, we don't unlink their file — they own it now.
   */
  async acquireBookLock(bookId: string): Promise<() => Promise<void>> {
    await mkdir(this.bookDir(bookId), { recursive: true });
    const lockPath = join(this.bookDir(bookId), ".write.lock");

    // ── Step 1: in-process gate (synchronous — no waiting) ──
    if (this.activeBookLocks.has(bookId)) {
      throw new Error(
        `Book "${bookId}" is locked by another in-process claimant ` +
          `(this process already has the lock).`,
      );
    }

    let inProcessRelease!: () => void;
    const inProcessSlot = new Promise<void>((resolve) => {
      inProcessRelease = resolve;
    });
    this.activeBookLocks.set(bookId, inProcessSlot);

    // ── Step 2: file lock with retry-loop on stale EEXIST ──
    const token = randomUUID();
    const pid = process.pid;
    const ts = Date.now();
    const ourLockData = formatLockContent(pid, ts, token);

    try {
      while (true) {
        try {
          const handle = await open(lockPath, "wx");
          try {
            await handle.writeFile(ourLockData, "utf-8");
          } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(lockPath).catch(() => undefined);
            throw error;
          }
          await handle.close();
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException | undefined)?.code;
          if (code !== "EEXIST") throw e;

          // Stale evaluation
          const raw = await readFile(lockPath, "utf-8").catch(() => "");
          const existing = parseLockContent(raw);

          // (a) unparseable legacy format — replace
          if (!existing) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }

          // (b) TTL exceeded — replace
          if (Date.now() - existing.ts > LOCK_TTL_MS) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }

          // (d) same process but token mismatch — own-process stale
          if (existing.pid === pid && existing.token !== token) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }

          // (c) PID is dead — replace
          if (!this.isProcessAlive(existing.pid)) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }

          // All stale criteria failed: a live process owns this lock
          const ageSec = Math.round((Date.now() - existing.ts) / 1000);
          throw new Error(
            `Book "${bookId}" is locked by another live process ` +
              `(pid=${existing.pid} age=${ageSec}s token=${existing.token}). ` +
              `If this is stale, delete ${lockPath}.`,
          );
        }
      }
    } catch (e) {
      // File lock step failed — release the in-process slot so subsequent
      // attempts aren't blocked behind a phantom queue entry.
      if (this.activeBookLocks.get(bookId) === inProcessSlot) {
        this.activeBookLocks.delete(bookId);
      }
      inProcessRelease();
      throw e;
    }

    // ── Step 3: return release handle ──
    return async () => {
      if (this.activeBookLocks.get(bookId) === inProcessSlot) {
        this.activeBookLocks.delete(bookId);
      }
      inProcessRelease();

      // Only unlink if the on-disk lock still carries our pid+token.
      // If a watchdog / external tool overwrote with a different token,
      // leave their file alone.
      try {
        const raw = await readFile(lockPath, "utf-8");
        const existing = parseLockContent(raw);
        if (existing && existing.pid === pid && existing.token === token) {
          await unlink(lockPath);
        }
      } catch {
        // ignore — best effort
      }
    };
  }

  /**
   * Stale-lock watchdog: scan every book under `books/` for `.write.lock`
   * left behind by crashed predecessors, and clean those whose pid is dead
   * or whose TTL is exceeded. Safe to call at daemon startup; doesn't
   * touch locks owned by live processes.
   *
   * Returns the count of locks cleaned. Best-effort: errors per book are
   * swallowed so one bad book doesn't block the rest.
   */
  async reclaimStaleBookLocks(): Promise<number> {
    let cleaned = 0;
    let entries: string[] = [];
    try {
      entries = await readdir(this.booksDir);
    } catch {
      return 0;
    }
    for (const bookId of entries) {
      const lockPath = join(this.bookDir(bookId), ".write.lock");
      try {
        const raw = await readFile(lockPath, "utf-8");
        const existing = parseLockContent(raw);
        if (!existing) {
          await unlink(lockPath).catch(() => undefined);
          cleaned += 1;
          continue;
        }
        const expired = Date.now() - existing.ts > LOCK_TTL_MS;
        const dead = !this.isProcessAlive(existing.pid);
        if (expired || dead) {
          await unlink(lockPath).catch(() => undefined);
          cleaned += 1;
        }
      } catch {
        // no lock file for this book, or unlink failure; skip silently
      }
    }
    return cleaned;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        return false;
      }
      return true;
    }
  }

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  stateDir(bookId: string): string {
    return join(this.bookDir(bookId), "story", "state");
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    const configPath = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) {
      throw new Error(`book.json is empty for book "${bookId}"`);
    }
    return JSON.parse(raw) as BookConfig;
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    await this.saveBookConfigAt(this.bookDir(bookId), config);
  }

  async saveBookConfigAt(bookDir: string, config: BookConfig): Promise<void> {
    await mkdir(bookDir, { recursive: true });
    await writeFile(
      join(bookDir, "book.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  async ensureRuntimeState(bookId: string, fallbackChapter = 0): Promise<void> {
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter,
    });
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextChapterNumber(bookId: string): Promise<number> {
    const durableChapter = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    // Ensure structured state is bootstrapped (side-effect: creates missing
    // JSON files), but do NOT trust its chapter number for progress — only
    // the contiguous durable artifact chain is authoritative.
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter: durableChapter,
    });
    return durableChapter + 1;
  }

  async getPersistedChapterCount(bookId: string): Promise<number> {
    const chaptersDir = join(this.bookDir(bookId), "chapters");
    const chapterNumbers = new Set<number>();

    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        chapterNumbers.add(parseInt(match[1]!, 10));
      }
    } catch {
      return 0;
    }

    return chapterNumbers.size;
  }

  async loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const indexPath = join(this.bookDir(bookId), "chapters", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ReadonlyArray<ChapterMeta>;
      if (Array.isArray(parsed)) {
        const rebuilt = await this.rebuildChapterIndexFromFiles(bookId);
        return rebuilt.length > 0 ? rebuilt : parsed as ReadonlyArray<ChapterMeta>;
      }
    } catch {
      const rebuilt = await this.rebuildChapterIndexFromFiles(bookId);
      if (rebuilt.length > 0) return rebuilt;
    }
    return [];
  }

  private async rebuildChapterIndexFromFiles(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    return this.rebuildChapterIndexFromFilesAt(this.bookDir(bookId));
  }

  private async rebuildChapterIndexFromFilesAt(bookDir: string): Promise<ReadonlyArray<ChapterMeta>> {
    const chaptersDir = join(bookDir, "chapters");
    let files: string[];
    try {
      files = await readdir(chaptersDir);
    } catch {
      return [];
    }

    const rows = await Promise.all(files.flatMap(async (file) => {
      const match = file.match(/^(\d+)[_-]?(.*?)\.md$/);
      if (!match) return [];
      const number = parseInt(match[1]!, 10);
      if (!Number.isFinite(number) || number <= 0) return [];
      const filePath = join(chaptersDir, file);
      const [metadata, content] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, "utf-8").catch(() => ""),
      ]);
      const timestamp = (metadata?.mtime ?? new Date()).toISOString();
      const rawTitle = match[2]?.replace(/^_+/, "").replace(/_/g, " ").trim();
      return [{
        number,
        title: rawTitle || `第${number}章`,
        status: "ready-for-review" as const,
        wordCount: content.replace(/\s+/g, "").length,
        createdAt: timestamp,
        updatedAt: timestamp,
        auditIssues: [],
        lengthWarnings: [],
      }];
    }));

    return rows
      .flat()
      .sort((a, b) => a.number - b.number);
  }

  async saveChapterIndex(
    bookId: string,
    index: ReadonlyArray<ChapterMeta>,
    options: { readonly allowEmptyWithChapterFiles?: boolean } = {},
  ): Promise<void> {
    await this.saveChapterIndexAt(this.bookDir(bookId), index, options);
  }

  async saveChapterIndexAt(
    bookDir: string,
    index: ReadonlyArray<ChapterMeta>,
    options: { readonly allowEmptyWithChapterFiles?: boolean } = {},
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    const safeIndex = index.length === 0 && !options.allowEmptyWithChapterFiles
      ? await this.rebuildChapterIndexFromFilesAt(bookDir).then((rebuilt) => rebuilt.length > 0 ? rebuilt : index)
      : index;
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify(safeIndex, null, 2),
      "utf-8",
    );
  }

  async snapshotState(bookId: string, chapterNumber: number): Promise<void> {
    await this.snapshotStateAt(this.bookDir(bookId), chapterNumber);
  }

  async snapshotStateAt(bookDir: string, chapterNumber: number): Promise<void> {
    const storyDir = join(bookDir, "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );

    const stateDir = join(bookDir, "story", "state");
    const snapshotStateDir = join(snapshotDir, "state");
    try {
      const stateFiles = await readdir(stateDir);
      if (stateFiles.length > 0) {
        await mkdir(snapshotStateDir, { recursive: true });
        await Promise.all(
          stateFiles.map(async (fileName) => {
            const content = await readFile(join(stateDir, fileName), "utf-8");
            await writeFile(join(snapshotStateDir, fileName), content, "utf-8");
          }),
        );
      }
    } catch {
      // state directory missing — skip
    }
  }

  async isCompleteBookDirectory(bookDir: string): Promise<boolean> {
    // Phase 5 cleanup: prefer outline/* paths, fall back to legacy flat files
    // so older books on disk still resolve as complete.
    const requiredSingle = [
      join(bookDir, "book.json"),
      join(bookDir, "story", "book_rules.md"),
      join(bookDir, "story", "current_state.md"),
      join(bookDir, "story", "pending_hooks.md"),
      join(bookDir, "chapters", "index.json"),
    ];

    const eitherOr: Array<ReadonlyArray<string>> = [
      // story_frame (new) OR story_bible (legacy)
      [
        join(bookDir, "story", "outline", "story_frame.md"),
        join(bookDir, "story", "story_bible.md"),
      ],
      // volume_map (new) OR volume_outline (legacy)
      [
        join(bookDir, "story", "outline", "volume_map.md"),
        join(bookDir, "story", "volume_outline.md"),
      ],
    ];

    for (const requiredPath of requiredSingle) {
      try {
        await stat(requiredPath);
      } catch {
        return false;
      }
    }

    for (const alternatives of eitherOr) {
      let found = false;
      for (const candidate of alternatives) {
        try {
          await stat(candidate);
          found = true;
          break;
        } catch {
          // try next alternative
        }
      }
      if (!found) return false;
    }

    return true;
  }

  async restoreState(bookId: string, chapterNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    try {
      // current_state.md and pending_hooks.md are required;
      // particle_ledger.md is optional (numericalSystem=false genres don't have it)
      // the rest are optional (may not exist in older snapshots)
      const requiredFiles = ["current_state.md", "pending_hooks.md"];
      const optionalFiles = files.filter((f) => !requiredFiles.includes(f));

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          const targetPath = join(storyDir, f);
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(targetPath, content, "utf-8");
          } catch {
            await rm(targetPath, { force: true });
          }
        }),
      );

      const stateDir = this.stateDir(bookId);
      let restoredStructuredState = false;
      try {
        const snapshotStateDir = join(snapshotDir, "state");
        const stateFiles = await readdir(snapshotStateDir);
        if (stateFiles.length > 0) {
          restoredStructuredState = true;
          await mkdir(stateDir, { recursive: true });
          await Promise.all(
            stateFiles.map(async (fileName) => {
              const content = await readFile(join(snapshotStateDir, fileName), "utf-8");
              await writeFile(join(stateDir, fileName), content, "utf-8");
            }),
          );
        }
      } catch {
        // snapshot structured state missing — skip
      }
      if (!restoredStructuredState) {
        await rm(stateDir, { recursive: true, force: true });
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Roll back state to the snapshot at `targetChapter`, removing all chapters
   * after it and their associated files (chapter markdown, snapshots, runtime).
   * Used by review reject to undo a bad chapter and everything that followed.
   *
   * Returns the list of chapter numbers that were discarded.
   */
  async rollbackToChapter(
    bookId: string,
    targetChapter: number,
  ): Promise<ReadonlyArray<number>> {
    const restored = await this.restoreState(bookId, targetChapter);
    if (!restored) {
      throw new Error(`Cannot restore snapshot for chapter ${targetChapter} in "${bookId}"`);
    }

    const bookDir = this.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const index = await this.loadChapterIndex(bookId);

    const kept: ChapterMeta[] = [];
    const discarded: number[] = [];

    for (const entry of index) {
      if (entry.number <= targetChapter) {
        kept.push(entry);
      } else {
        discarded.push(entry.number);
      }
    }

    // Delete chapter markdown files for discarded chapters
    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(chaptersDir, file)).catch(() => {});
        }
      }
    } catch {
      // chapters directory missing
    }

    // Delete snapshots for discarded chapters
    const snapshotsDir = join(bookDir, "story", "snapshots");
    try {
      const snapshots = await readdir(snapshotsDir);
      for (const snap of snapshots) {
        const num = parseInt(snap, 10);
        if (Number.isFinite(num) && num > targetChapter) {
          await rm(join(snapshotsDir, snap), { recursive: true, force: true });
        }
      }
    } catch {
      // snapshots directory missing
    }

    // Delete runtime artifacts for discarded chapters
    const runtimeDir = join(bookDir, "story", "runtime");
    try {
      const runtimeFiles = await readdir(runtimeDir);
      for (const file of runtimeFiles) {
        const match = file.match(/^chapter-(\d+)\./);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(runtimeDir, file)).catch(() => {});
        }
      }
    } catch {
      // runtime directory missing
    }

    // Also check story/drafts/ for discarded chapter files
    const draftsDir = join(bookDir, "story", "drafts");
    try {
      const draftFiles = await readdir(draftsDir);
      for (const file of draftFiles) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(draftsDir, file)).catch(() => {});
        }
      }
    } catch {
      // drafts directory missing
    }

    // Drop any persisted sqlite acceleration index so discarded chapters
    // cannot leak back into retrieval after the markdown/state rollback.
    await Promise.all([
      rm(join(bookDir, "story", "memory.db"), { force: true }),
      rm(join(bookDir, "story", "memory.db-shm"), { force: true }),
      rm(join(bookDir, "story", "memory.db-wal"), { force: true }),
    ]);

    await this.saveChapterIndex(bookId, kept);
    return discarded;
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await stat(path);
    } catch {
      await writeFile(path, content, "utf-8");
    }
  }
}
