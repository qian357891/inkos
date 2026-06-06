import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gamepad2, X, ChevronDown } from "lucide-react";
import { fetchJson } from "../../hooks/use-api";

// The HUD is genre-neutral: it renders whatever the world graph contains,
// grouped into "what I face" (world/here-now) and "what I hold" (backpack).
// It never hardcodes a mystery-only layout — sections derive from entity
// types, edge types, and state-slot kinds, and empty sections are hidden.

interface PlayEntity {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly summary?: string;
  readonly status?: string;
  readonly imageUrl?: string;
}
interface PlayEdge {
  readonly id: string;
  readonly fromId: string;
  readonly type: string;
  readonly toId: string;
  readonly validUntilEventId?: string | null;
  readonly strength?: number | null;
}
interface PlayStateSlot {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly value: unknown;
  readonly updatedEventId?: string;
}
interface PlayEvent {
  readonly id: string;
  readonly turn: number;
  readonly outcomeSummary?: string;
}
interface PlayGraph {
  readonly entities: ReadonlyArray<PlayEntity>;
  readonly edges: ReadonlyArray<PlayEdge>;
  readonly stateSlots: ReadonlyArray<PlayStateSlot>;
  readonly events: ReadonlyArray<PlayEvent>;
}
interface PlayImageSettings {
  readonly actors: boolean;
  readonly moments: boolean;
  readonly inventory: boolean;
}
interface PlayRunResponse {
  readonly title?: string;
  readonly currentState?: { turn?: number; mode?: string; premise?: string } | null;
  readonly graph?: PlayGraph;
  readonly imageSettings?: PlayImageSettings;
  readonly sceneImageUrl?: string;
}
interface CoverConfigResponse {
  readonly service?: string | null;
  readonly configured?: boolean;
  readonly providers?: ReadonlyArray<{ readonly service: string; readonly connected?: boolean }>;
}

const HOLDING_TYPES = new Set(["item", "evidence", "clue", "claim", "proof_chain"]);
const HOLDING_EDGE_TYPES = new Set(["持有", "携带", "握有", "拿着", "holds", "holding", "carries", "carrying", "has"]);
const HOLDING_GLYPH: Record<string, string> = {
  item: "🎒", evidence: "📄", clue: "🔍", claim: "💡", proof_chain: "🔗",
};
const SLOT_GLYPH: Record<string, string> = {
  timer: "⏳", pressure: "🔥", resource: "🪙", relation: "❤", clue: "🔍", evidence: "📄", flag: "🚩",
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isHoldingEdge(edge: PlayEdge): boolean {
  return HOLDING_EDGE_TYPES.has(edge.type.trim().toLowerCase());
}

function isHeldEntity(entity: PlayEntity, currentEdges: ReadonlyArray<PlayEdge>): boolean {
  if (!HOLDING_TYPES.has(entity.type)) return false;
  return currentEdges.some((edge) =>
    edge.fromId === "actor_player"
    && edge.toId === entity.id
    && isHoldingEdge(edge)
  );
}

interface HudDetail {
  readonly label?: string;
  readonly text: string;
}
interface HudRow {
  readonly id: string;
  readonly glyph: string;
  readonly label: string;
  readonly value?: string;
  readonly note?: string | null;
  // Extra info shown when the row is expanded (summary, relationships, why a
  // meter changed). A row is expandable only when this is non-empty.
  readonly details: ReadonlyArray<HudDetail>;
  // Generated illustration for this entity (actor portrait / item still), if any.
  readonly imageUrl?: string;
}
interface HudView {
  readonly turn: number | null;
  readonly mode: string | null;
  readonly premise: string;
  readonly facing: ReadonlyArray<HudRow>;
  // Actor subset of `facing` (excludes locations) — only actors auto-illustrate.
  readonly actors: ReadonlyArray<HudRow>;
  readonly holdings: ReadonlyArray<HudRow>;
  readonly meters: ReadonlyArray<HudRow>;
}

export function buildView(run: PlayRunResponse | null): HudView | null {
  if (!run?.graph) return null;
  const { entities, edges, stateSlots, events } = run.graph;
  const labelOf = new Map(entities.map((e) => [e.id, e.label]));
  const outcomeOf = new Map(events.map((e) => [e.id, e.outcomeSummary ?? ""]));
  const currentEdges = edges.filter((e) => e.validUntilEventId == null);

  const summaryDetail = (e: PlayEntity): HudDetail[] => {
    const summary = e.summary?.trim();
    if (!summary) return [];
    if (summary === e.label || summary === e.status) return [];
    return [{ text: summary }];
  };
  // All current relationships involving an entity, ids resolved to labels.
  const relationDetails = (id: string): HudDetail[] =>
    currentEdges
      .filter((e) => e.fromId === id || e.toId === id)
      .map((e) => {
        const other = e.fromId === id ? labelOf.get(e.toId) : labelOf.get(e.fromId);
        const strength = typeof e.strength === "number" ? ` ${e.strength}` : "";
        return { label: "关系", text: `${e.type}${strength}${other ? ` · ${other}` : ""}` };
      });

  const locations: HudRow[] = entities
    .filter((e) => e.type === "location")
    .map((e) => ({ id: e.id, glyph: "📍", label: e.label, note: e.status ?? null, details: summaryDetail(e) }));
  const actors: HudRow[] = entities
    .filter((e) => e.type === "actor")
    .map((e) => ({
      id: e.id,
      glyph: "👤",
      label: e.label,
      note: e.status ?? null,
      details: [...summaryDetail(e), ...relationDetails(e.id)],
      imageUrl: e.imageUrl,
    }));
  const surroundings: HudRow[] = entities
    .filter((e) => HOLDING_TYPES.has(e.type) && !isHeldEntity(e, currentEdges))
    .map((e) => ({
      id: e.id,
      glyph: HOLDING_GLYPH[e.type] ?? "•",
      label: e.label,
      note: e.status ?? null,
      details: summaryDetail(e),
      imageUrl: e.imageUrl,
    }));
  const holdings: HudRow[] = entities
    .filter((e) => isHeldEntity(e, currentEdges))
    .map((e) => ({
      id: e.id,
      glyph: HOLDING_GLYPH[e.type] ?? "•",
      label: e.label,
      note: e.status ?? null,
      details: summaryDetail(e),
      imageUrl: e.imageUrl,
    }));
  const meters: HudRow[] = stateSlots.map((slot) => {
    const cause = slot.updatedEventId ? outcomeOf.get(slot.updatedEventId) || "" : "";
    return {
      id: slot.id,
      glyph: SLOT_GLYPH[slot.kind] ?? "•",
      label: slot.label,
      value: formatValue(slot.value),
      note: null,
      details: cause ? [{ label: "因为", text: cause }] : [],
    };
  });

  const turnFromEvents = events.reduce((max, e) => Math.max(max, e.turn), 0);
  return {
    turn: run.currentState?.turn ?? (events.length > 0 ? turnFromEvents : null),
    mode: run.currentState?.mode ?? null,
    premise: run.currentState?.premise ?? "",
    facing: [...locations, ...actors, ...surroundings],
    actors,
    holdings,
    meters,
  };
}

export function PlayHud(props: {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
  readonly sessionTitle?: string | null;
}) {
  const { sessionId, isStreaming, isZh } = props;
  const base = `/play/runs/${encodeURIComponent(sessionId)}/main`;
  const [open, setOpen] = useState(true);
  const [run, setRun] = useState<PlayRunResponse | null>(null);
  const [hasUnseen, setHasUnseen] = useState(false);
  const [settings, setSettings] = useState<PlayImageSettings>({ actors: false, moments: false, inventory: false });
  const [coverReady, setCoverReady] = useState(false);
  const [generating, setGenerating] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef<Set<string>>(new Set());
  const openRef = useRef(open);
  const prevStreaming = useRef(isStreaming);
  openRef.current = open;

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<PlayRunResponse>(base);
      setRun(data);
      if (data.imageSettings) setSettings(data.imageSettings);
      if (!openRef.current) setHasUnseen(true);
    } catch {
      // A play session may not have a persisted world yet (no first action).
      // Leaving run null renders the empty state; do not surface an error.
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  // Refetch when a turn finishes (streaming true -> false).
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) void load();
    prevStreaming.current = isStreaming;
  }, [isStreaming, load]);

  // Image toggles can only be enabled once an image API is configured + connected.
  useEffect(() => {
    fetchJson<CoverConfigResponse>("/cover/config")
      .then((cfg) => {
        // Prefer the server's explicit `configured` (covers the env path too);
        // fall back to "a selected service is connected" for older servers.
        const selected = cfg.service ?? null;
        setCoverReady(
          cfg.configured ?? (!!selected && (cfg.providers ?? []).some((p) => p.service === selected && p.connected)),
        );
      })
      .catch(() => setCoverReady(false));
  }, []);

  const toggleSetting = useCallback(async (key: keyof PlayImageSettings) => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    try {
      await fetchJson(`${base}/image-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    } catch {
      setSettings(settings); // revert on failure
    }
  }, [settings, base]);

  const generate = useCallback(async (
    key: string,
    body: { target: "entity"; entityId: string } | { target: "scene" },
  ) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setGenerating((s) => new Set(s).add(key));
    try {
      await fetchJson(`${base}/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } catch {
      // Generation blip — the row simply stays image-less; user can retry.
    } finally {
      inFlight.current.delete(key);
      setGenerating((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  }, [base, load]);

  const view = useMemo(() => buildView(run), [run]);

  // Auto-illustrate new actors / inventory when the toggle is on and an image
  // API is configured. Decoupled + deduped (inFlight): never blocks a turn,
  // images appear on the next refresh.
  useEffect(() => {
    if (!coverReady || !view) return;
    const targets: string[] = [];
    if (settings.actors) view.actors.forEach((r) => { if (!r.imageUrl) targets.push(r.id); });
    if (settings.inventory) view.holdings.forEach((r) => { if (!r.imageUrl) targets.push(r.id); });
    targets.forEach((id) => void generate(id, { target: "entity", entityId: id }));
  }, [coverReady, settings.actors, settings.inventory, view, generate]);

  const title = props.sessionTitle?.trim() || run?.title?.trim() || (isZh ? "互动世界" : "Play World");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setHasUnseen(false); }}
        className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-lg border border-border/40 bg-card/90 px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur hover:text-primary"
        title={isZh ? "打开世界面板" : "Open world panel"}
      >
        <Gamepad2 size={14} />
        {hasUnseen && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
      </button>
    );
  }

  return (
    <aside className="absolute bottom-28 right-0 top-0 z-20 flex w-[330px] flex-col border-l border-border/40 bg-card/95 backdrop-blur shadow-xl">
      <header className="flex items-center justify-between border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
            <Gamepad2 size={13} />
            <span className="truncate">{title}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {view?.turn != null ? `${isZh ? "第" : "Turn "}${view.turn}${isZh ? " 幕" : ""}` : isZh ? "尚未开始" : "Not started"}
            {view?.mode ? ` · ${view.mode === "guided" ? (isZh ? "互动模式" : "Guided") : (isZh ? "开放模式" : "Open")}` : ""}
          </div>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" title={isZh ? "收起" : "Collapse"}>
          <X size={15} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
        {!view ? (
          <p className="text-xs leading-6 text-muted-foreground">
            {isZh
              ? "这个世界还没有状态。在左侧输入第一个动作，系统会生成开场并把人物、线索、状态显示在这里。"
              : "No world state yet. Take your first action on the left and characters, clues, and state will appear here."}
          </p>
        ) : (
          <>
            {run?.sceneImageUrl && (
              <img
                src={run.sceneImageUrl}
                alt={isZh ? "本幕配图" : "This moment"}
                className="w-full rounded-lg border border-border/30 object-cover"
              />
            )}
            <Zone
              title={isZh ? "我面对的" : "Around me"}
              empty={view.facing.length === 0}
              emptyText={isZh ? "周围还没有出现地点或人物" : "No places or people around yet"}
            >
              {view.facing.map((row) => (
                <Row key={row.id} row={row} isZh={isZh} generating={generating.has(row.id)} />
              ))}
            </Zone>

            <Zone
              title={isZh ? "我握有的" : "What I hold"}
              empty={view.holdings.length === 0}
              emptyText={isZh ? "还没有获得物品、证据或线索" : "No items, evidence, or clues yet"}
            >
              {view.holdings.map((row) => (
                <Row key={row.id} row={row} isZh={isZh} generating={generating.has(row.id)} />
              ))}
            </Zone>

            <Zone
              title={isZh ? "状态" : "State"}
              empty={view.meters.length === 0}
              emptyText={isZh ? "还没有出现数值（压力、资源、关系、倒计时等）" : "No meters yet (pressure, resources, relations, timers…)"}
            >
              {view.meters.map((row) => (
                <Row key={row.id} row={row} isZh={isZh} />
              ))}
            </Zone>

            {view.premise && (
              <div className="rounded-lg border border-border/30 bg-secondary/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                {view.premise}
              </div>
            )}

            <PlayImagePanel
              isZh={isZh}
              settings={settings}
              coverReady={coverReady}
              onToggle={toggleSetting}
              onIllustrateMoment={() => generate("scene", { target: "scene" })}
              momentBusy={generating.has("scene")}
            />
          </>
        )}
      </div>
    </aside>
  );
}

function PlayImagePanel(props: {
  readonly isZh: boolean;
  readonly settings: PlayImageSettings;
  readonly coverReady: boolean;
  readonly onToggle: (key: keyof PlayImageSettings) => void;
  readonly onIllustrateMoment: () => void;
  readonly momentBusy: boolean;
}) {
  const { isZh, settings, coverReady, onToggle, onIllustrateMoment, momentBusy } = props;
  const options: ReadonlyArray<{ key: keyof PlayImageSettings; label: string }> = [
    { key: "actors", label: isZh ? "为角色配图" : "Illustrate characters" },
    { key: "moments", label: isZh ? "为时刻配图" : "Illustrate moments" },
    { key: "inventory", label: isZh ? "为背包配图" : "Illustrate inventory" },
  ];
  return (
    <section className="border-t border-border/30 pt-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {isZh ? "自动配图" : "Auto illustration"}
      </h3>
      <div className="space-y-1.5">
        {options.map((opt) => (
          <label
            key={opt.key}
            className={`flex items-center gap-2 text-[12px] ${coverReady ? "cursor-pointer text-foreground" : "cursor-not-allowed text-muted-foreground/40"}`}
            title={coverReady ? undefined : (isZh ? "先在「模型配置」里配好生图 API 才能开启" : "Configure an image API in Model Settings first")}
          >
            <input
              type="checkbox"
              disabled={!coverReady}
              checked={coverReady && settings[opt.key]}
              onChange={() => onToggle(opt.key)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {opt.label}
          </label>
        ))}
      </div>
      {!coverReady ? (
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground/50">
          {isZh ? "未检测到可用的生图 API。在「模型配置」里配好后即可勾选。" : "No image API configured. Set one up in Model Settings to enable."}
        </p>
      ) : settings.moments ? (
        <button
          type="button"
          onClick={onIllustrateMoment}
          disabled={momentBusy}
          className="mt-2 w-full rounded-lg border border-border/40 bg-secondary/40 px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:text-primary disabled:opacity-50"
        >
          {momentBusy ? (isZh ? "配图中…" : "Illustrating…") : (isZh ? "为这一刻配图" : "Illustrate this moment")}
        </button>
      ) : null}
    </section>
  );
}

function Zone(props: {
  readonly title: string;
  readonly empty: boolean;
  readonly emptyText: string;
  readonly children: React.ReactNode;
}) {
  // Always render the category so the player sees the structure ("what kinds of
  // things can show up here"); content fills in as the story produces it.
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{props.title}</h3>
      {props.empty ? (
        <p className="text-[11px] italic leading-5 text-muted-foreground/40">{props.emptyText}</p>
      ) : (
        <div className="space-y-1.5">{props.children}</div>
      )}
    </section>
  );
}

function Row({ row, isZh, generating }: { readonly row: HudRow; readonly isZh: boolean; readonly generating?: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = row.details.length > 0;
  return (
    <div className="rounded-lg border border-border/30 bg-secondary/30">
      <div
        role={expandable ? "button" : undefined}
        title={expandable ? (open ? (isZh ? "收起" : "Collapse") : (isZh ? "展开详情" : "Show details")) : undefined}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        className={`px-2.5 py-1.5 ${expandable ? "cursor-pointer" : ""}`}
      >
        <div className="flex items-baseline gap-1.5">
          {row.imageUrl ? (
            <img src={row.imageUrl} alt={row.label} className="h-7 w-7 shrink-0 self-center rounded object-cover" />
          ) : (
            <span className="shrink-0 text-xs">{generating ? "⏳" : row.glyph}</span>
          )}
          <span className="text-[13px] font-medium text-foreground">{row.label}</span>
          {row.value ? <span className="ml-auto text-[13px] font-semibold text-primary">{row.value}</span> : null}
          {expandable ? (
            <ChevronDown
              size={12}
              className={`${row.value ? "ml-1.5" : "ml-auto"} shrink-0 text-muted-foreground/50 transition-transform ${open ? "rotate-180" : ""}`}
            />
          ) : null}
        </div>
        {row.note ? <div className="mt-0.5 pl-5 text-[11px] leading-4 text-muted-foreground">{row.note}</div> : null}
      </div>
      {open && (
        <div className="space-y-1 px-2.5 pb-2 pl-7">
          {row.details.map((detail, i) => (
            <p key={i} className="text-[11px] leading-5 text-muted-foreground">
              {detail.label ? <span className="text-muted-foreground/50">{detail.label} </span> : null}
              {detail.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
