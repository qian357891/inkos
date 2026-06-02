import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlayActionIntentInput,
  PlayEdgeInput,
  PlayEntity,
  PlayEntityInput,
  PlayEventInput,
  PlayMutationInput,
  PlayStateSlot,
  PlayStateSlotInput,
} from "../models/play.js";
import { PlayRunner } from "../play/play-runner.js";
import type { PlaySceneRender } from "../play/play-agents.js";
import { PlayStore } from "../play/play-store.js";

class FakePlayDB {
  entities = new Map<string, PlayEntity>();
  edges = new Map<string, PlayEdgeInput>();
  stateSlots = new Map<string, PlayStateSlot>();
  events: PlayEventInput[] = [];

  transaction<T>(fn: () => T): T {
    return fn();
  }

  upsertEntity(entity: PlayEntityInput): void {
    this.entities.set(entity.id, { summary: "", status: "", ...entity });
  }

  getEntity(id: string): PlayEntity | null {
    return this.entities.get(id) ?? null;
  }

  upsertEdge(edge: PlayEdgeInput): void {
    this.edges.set(edge.id, edge);
  }

  expireEdge(edgeId: string, validUntilEventId: string): void {
    const edge = this.edges.get(edgeId);
    if (edge) this.edges.set(edgeId, { ...edge, validUntilEventId });
  }

  upsertStateSlot(slot: PlayStateSlotInput): void {
    this.stateSlots.set(slot.id, { ownerEntityId: null, ...slot });
  }

  getStateSlotsForEntity(entityId: string): PlayStateSlot[] {
    return [...this.stateSlots.values()].filter((slot) => slot.ownerEntityId === entityId);
  }

  recordEvent(event: PlayEventInput): void {
    this.events.push(event);
  }

  snapshot() {
    return {
      entities: [...this.entities.values()],
      edges: [...this.edges.values()] as never[],
      stateSlots: [...this.stateSlots.values()],
      events: this.events as never[],
    };
  }
}

describe("PlayRunner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-play-runner-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs one player action end to end and persists event, transcript, and projections", async () => {
    const db = new FakePlayDB();
    const action: PlayActionIntentInput = {
      actionKind: "look",
      targetEntityLabel: "导航记录",
      intent: "查看常用地址统计",
    };
    const mutation: PlayMutationInput = {
      eventId: "evt-1",
      turn: 1,
      actionKind: "look",
      summary: "发现新城花园 187 次。",
      entities: {
        upsert: [
          { id: "player", type: "actor", label: "宋词" },
          { id: "nav-stats", type: "evidence", label: "常用地址统计" },
        ],
      },
      stateSlots: {
        upsert: [{
          id: "pressure:player:danger",
          ownerEntityId: "player",
          kind: "pressure",
          label: "被发现风险",
          value: { current: 20, min: 0, max: 100 },
          updatedEventId: "evt-1",
        }],
      },
      evidence: {
        transitions: [{
          entityId: "nav-stats",
          to: "seen",
          reason: "车机弹出统计。",
        }],
      },
    };
    const render: PlaySceneRender = {
      sceneText: "屏幕弹出新城花园 187 次，宋词握着手机没有抬头。",
      suggestedActions: ["继续看医院记录", "问徐晋安今晚去哪"],
    };

    const runner = new PlayRunner({
      projectRoot: root,
      worldId: "betrayal-car",
      runId: "run-1",
      db,
      agents: {
        actionInterpreter: { interpret: vi.fn(async () => action) },
        worldMutator: { proposeMutation: vi.fn(async () => mutation) },
        sceneRenderer: { render: vi.fn(async () => render) },
      },
    });

    const result = await runner.step("我假装看天气，顺手点开车机导航记录");

    expect(result.sceneText).toContain("新城花园");
    expect(result.suggestedActions).toEqual(["继续看医院记录", "问徐晋安今晚去哪"]);
    expect(db.events).toHaveLength(1);
    expect(db.entities.get("nav-stats")?.type).toBe("evidence");
    expect(db.stateSlots.get("evidence:nav-stats:status")?.value).toMatchObject({ status: "seen" });

    const runDir = join(root, "worlds", "betrayal-car", "runs", "run-1");
    await expect(readFile(join(runDir, "events.jsonl"), "utf-8"))
      .resolves.toContain("\"id\":\"evt-1\"");
    await expect(readFile(join(runDir, "transcript.jsonl"), "utf-8"))
      .resolves.toContain("我假装看天气");
    await expect(readFile(join(runDir, "projections", "state.md"), "utf-8"))
      .resolves.toContain("发现新城花园 187 次");
    await expect(readFile(join(runDir, "projections", "scene.md"), "utf-8"))
      .resolves.toContain("屏幕弹出新城花园 187 次");
  });

  it("does not persist a one-sided user transcript when mutation application fails", async () => {
    const db = new FakePlayDB();
    const runner = new PlayRunner({
      projectRoot: root,
      worldId: "bad-turn",
      runId: "run-1",
      db,
      agents: {
        actionInterpreter: { interpret: vi.fn(async () => ({ actionKind: "look", intent: "看墙上的钟" })) },
        worldMutator: {
          proposeMutation: vi.fn(async () => ({
            eventId: "evt-1",
            turn: 1,
            actionKind: "look",
            summary: "错误地引用了不存在的人。",
            stateSlots: {
              upsert: [{
                id: "slot_missing",
                ownerEntityId: "missing_actor",
                kind: "pressure",
                label: "压力",
                value: 10,
                updatedEventId: "evt-1",
              }],
            },
          })),
        },
        sceneRenderer: { render: vi.fn(async () => ({ sceneText: "钟停在十二点。", suggestedActions: [] })) },
      },
    });

    await expect(runner.step("我看墙上的钟")).rejects.toThrow(/missing entity/);
    await expect(readFile(join(root, "worlds", "bad-turn", "runs", "run-1", "transcript.jsonl"), "utf-8"))
      .rejects
      .toThrow();
  });

  it("feeds the world premise and existing entity roster to the mutator so it can reuse ids", async () => {
    const db = new FakePlayDB();
    db.upsertEntity({
      id: "actor_laochen",
      type: "actor",
      label: "老陈",
      summary: "雨夜茶馆掌柜，知道镖队旧账。",
      status: "戒备",
      updatedEventId: "evt-0",
    });
    db.upsertEntity({
      id: "org_tieshou_escort",
      type: "organization",
      label: "铁手镖队",
      summary: "本地押镖组织，和旧账有关。",
      status: "盘踞城南",
      updatedEventId: "evt-0",
    });
    const store = new PlayStore(root);
    await store.createWorld({
      id: "rain-teahouse",
      title: "雨夜茶馆",
      premise: "玩家扮演阿福，雨夜茶馆跑堂，被一笔镖队旧账拖进江湖纠纷。",
      language: "zh",
    });
    await store.ensureRun("rain-teahouse", "run-1");
    await store.writeProjection("rain-teahouse", "run-1", "projections/scene.md", "雨夜茶馆里，老陈在柜台后拨算盘。\n");

    const action: PlayActionIntentInput = {
      actionKind: "say",
      targetEntityLabel: "老陈",
      intent: "问他旧账怎么回事",
    };
    const mutation: PlayMutationInput = {
      eventId: "evt-1",
      turn: 1,
      actionKind: "say",
      summary: "阿福向老陈追问镖队旧账。",
      edges: {
        upsert: [{
          id: "edge_ask_laochen",
          fromId: "actor_laochen",
          type: "被追问",
          toId: "org_tieshou_escort",
          validFromEventId: "evt-1",
          sourceEventId: "evt-1",
        }],
      },
    };
    let mutatorContext = "";
    const proposeMutation = vi.fn(async (input: { readonly context: string }) => {
      mutatorContext = input.context;
      return mutation;
    });

    const runner = new PlayRunner({
      projectRoot: root,
      worldId: "rain-teahouse",
      runId: "run-1",
      store,
      db,
      agents: {
        actionInterpreter: { interpret: vi.fn(async () => action) },
        worldMutator: { proposeMutation },
        sceneRenderer: { render: vi.fn(async () => ({ sceneText: "老陈指节一顿，算盘珠子碰出一声脆响。", suggestedActions: [] })) },
      },
    });

    await runner.step("我压低声音问老陈，铁手镖队那笔旧账到底是谁欠的？");

    expect(mutatorContext).toContain("世界设定");
    expect(mutatorContext).toContain("阿福");
    expect(mutatorContext).toContain("当前实体名册");
    expect(mutatorContext).toContain("actor_laochen [actor]: 老陈");
    expect(mutatorContext).toContain("org_tieshou_escort [organization]: 铁手镖队");
  });
});
