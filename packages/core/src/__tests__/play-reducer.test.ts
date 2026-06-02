import { describe, expect, it } from "vitest";
import type {
  PlayEdgeInput,
  PlayEntity,
  PlayEntityInput,
  PlayEventInput,
  PlayStateSlot,
  PlayStateSlotInput,
} from "../models/play.js";
import { applyPlayMutation } from "../play/play-reducer.js";

class FakePlayDB {
  entities = new Map<string, PlayEntity>();
  edges = new Map<string, PlayEdgeInput>();
  stateSlots = new Map<string, PlayStateSlot>();
  events: PlayEventInput[] = [];
  transactionCalls = 0;

  transaction<T>(fn: () => T): T {
    this.transactionCalls += 1;
    return fn();
  }

  upsertEntity(entity: PlayEntityInput): void {
    this.entities.set(entity.id, {
      summary: "",
      status: "",
      ...entity,
    });
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
    this.stateSlots.set(slot.id, {
      ownerEntityId: null,
      ...slot,
      value: slot.value,
    });
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

describe("applyPlayMutation", () => {
  it("records the event and applies entity, edge, state, and evidence changes atomically", () => {
    const db = new FakePlayDB();

    const result = applyPlayMutation({
      db,
      mutation: {
        eventId: "evt-1",
        turn: 1,
        actionKind: "look",
        summary: "玩家看见了账本。",
        entities: {
          upsert: [
            { id: "player", type: "actor", label: "宋词" },
            { id: "ledger", type: "evidence", label: "常用地址统计" },
            { id: "claim-affair", type: "claim", label: "徐晋安另有家庭" },
          ],
        },
        edges: {
          upsert: [{
            id: "edge-ledger-claim",
            fromId: "ledger",
            type: "supports",
            toId: "claim-affair",
            validFromEventId: "evt-1",
            sourceEventId: "evt-1",
            strength: 0.7,
          }],
        },
        stateSlots: {
          upsert: [{
            id: "pressure:player:danger",
            ownerEntityId: "player",
            kind: "pressure",
            label: "被发现风险",
            value: { current: 120, min: 0, max: 100 },
            updatedEventId: "evt-1",
          }],
        },
        evidence: {
          transitions: [{
            entityId: "ledger",
            to: "seen",
            reason: "屏幕弹出统计。",
          }],
        },
      },
      rawInput: "看一下导航记录",
      createdAt: "2026-05-28T00:00:00.000Z",
    });

    expect(result.event).toMatchObject({
      id: "evt-1",
      turn: 1,
      actionKind: "look",
      rawInput: "看一下导航记录",
      outcomeSummary: "玩家看见了账本。",
    });
    expect(db.transactionCalls).toBe(1);
    expect(db.events).toHaveLength(1);
    expect(db.entities.get("ledger")?.type).toBe("evidence");
    expect(db.edges.get("edge-ledger-claim")?.toId).toBe("claim-affair");
    expect(db.stateSlots.get("pressure:player:danger")?.value).toEqual({ current: 100, min: 0, max: 100 });
    expect(db.stateSlots.get("evidence:ledger:status")?.value).toEqual({
      previous: "unknown",
      status: "seen",
      reason: "屏幕弹出统计。",
    });
  });

  it("skips edges that point at missing entities (fail-open) while applying the rest of the turn (C3)", () => {
    const db = new FakePlayDB();

    const result = applyPlayMutation({
      db,
      mutation: {
        eventId: "evt-2",
        turn: 2,
        actionKind: "do",
        entities: { upsert: [
          { id: "lin", type: "actor", label: "林远" },
          { id: "clerk", type: "actor", label: "账房先生" },
        ] },
        edges: {
          upsert: [
            // valid: both endpoints exist this turn
            { id: "good-edge", fromId: "lin", type: "怀疑", toId: "clerk", validFromEventId: "evt-2", sourceEventId: "evt-2" },
            // dangling: must be skipped, NOT crash the turn (which used to wipe everything)
            { id: "bad-edge", fromId: "lin", type: "knows", toId: "ghost", validFromEventId: "evt-2", sourceEventId: "evt-2" },
          ],
        },
      },
      rawInput: "调查",
    });

    expect(result.event.id).toBe("evt-2");
    expect(db.events).toHaveLength(1);          // turn was NOT wiped
    expect(db.entities.size).toBe(2);           // entities applied
    expect(db.edges.get("good-edge")?.toId).toBe("clerk"); // valid edge kept
    expect(db.edges.has("bad-edge")).toBe(false);          // dangling edge dropped
  });

  it("resolves edge endpoints that reference existing entities by label", () => {
    const db = new FakePlayDB();
    db.upsertEntity({ id: "actor_afu", type: "actor", label: "阿福" });
    db.upsertEntity({ id: "actor_laochen", type: "actor", label: "老陈" });

    applyPlayMutation({
      db,
      mutation: {
        eventId: "evt-4",
        turn: 4,
        actionKind: "say",
        summary: "阿福试探老陈。",
        edges: {
          upsert: [{
            id: "edge_ask",
            fromId: "阿福",
            type: "试探",
            toId: "老陈",
            validFromEventId: "evt-4",
            sourceEventId: "evt-4",
          }],
        },
      },
      rawInput: "我问老陈旧账的事",
    });

    expect(db.edges.get("edge_ask")).toMatchObject({
      fromId: "actor_afu",
      toId: "actor_laochen",
      type: "试探",
    });
  });

  it("rejects evidence status regressions", () => {
    const db = new FakePlayDB();
    db.upsertEntity({ id: "receipt", type: "evidence", label: "住院收据" });
    db.upsertStateSlot({
      id: "evidence:receipt:status",
      ownerEntityId: "receipt",
      kind: "evidence",
      label: "证据状态",
      value: { status: "verified" },
      updatedEventId: "evt-old",
    });

    expect(() => applyPlayMutation({
      db,
      mutation: {
        eventId: "evt-3",
        turn: 3,
        actionKind: "do",
        evidence: {
          transitions: [{
            entityId: "receipt",
            to: "seen",
          }],
        },
      },
      rawInput: "重新看收据",
    })).toThrow(/regress/i);

    expect(db.events).toHaveLength(0);
  });
});
