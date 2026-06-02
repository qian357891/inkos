import {
  PlayEventSchema,
  PlayMutationSchema,
  type PlayEdgeInput,
  type PlayEntity,
  type PlayEntityInput,
  type PlayEvent,
  type PlayEventInput,
  type PlayEvidenceStatus,
  type PlayMutationInput,
  type PlayStateSlot,
  type PlayStateSlotInput,
} from "../models/play.js";
import type { PlayGraphSnapshot } from "./play-file-db.js";

export interface PlayReducerDB {
  readonly snapshot?: () => PlayGraphSnapshot;
  readonly transaction?: <T>(fn: () => T) => T;
  readonly getEntity: (id: string) => PlayEntity | null;
  readonly upsertEntity: (entity: PlayEntityInput) => void;
  readonly upsertEdge: (edge: PlayEdgeInput) => void;
  readonly expireEdge: (edgeId: string, validUntilEventId: string) => void;
  readonly upsertStateSlot: (slot: PlayStateSlotInput) => void;
  readonly getStateSlotsForEntity: (entityId: string) => PlayStateSlot[];
  readonly recordEvent: (event: PlayEventInput) => void;
}

export interface ApplyPlayMutationInput {
  readonly db: PlayReducerDB;
  readonly mutation: PlayMutationInput;
  readonly rawInput: string;
  readonly createdAt?: string;
}

export interface ApplyPlayMutationResult {
  readonly event: PlayEvent;
  readonly blocked: boolean;
}

const EVIDENCE_ORDER: readonly PlayEvidenceStatus[] = [
  "unknown",
  "hinted",
  "seen",
  "collected",
  "verified",
  "weaponized",
  "exposed",
  "exhausted",
];

export function applyPlayMutation(input: ApplyPlayMutationInput): ApplyPlayMutationResult {
  const mutation = resolveEdgeEndpointLabels(input.db, PlayMutationSchema.parse(input.mutation));
  const event = PlayEventSchema.parse({
    id: mutation.eventId,
    turn: mutation.turn,
    actionKind: mutation.actionKind,
    rawInput: input.rawInput,
    outcomeSummary: mutation.summary || mutation.blockedReason,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });

  validateMutation(input.db, mutation);

  const apply = () => {
    input.db.recordEvent(event);

    if (!mutation.blocked) {
      for (const entity of mutation.entities.upsert) {
        input.db.upsertEntity(entity);
      }
      for (const edge of mutation.edges.expire) {
        input.db.expireEdge(edge.edgeId, edge.validUntilEventId);
      }
      // Relationship edges are fail-open: a single edge that points at an entity
      // we never saw is skipped, not allowed to crash the whole turn (which used
      // to wipe an entire turn's mutations and leave the relationship panel empty).
      const upsertedEntityIds = new Set(mutation.entities.upsert.map((e) => e.id));
      const endpointExists = (id: string): boolean => upsertedEntityIds.has(id) || input.db.getEntity(id) !== null;
      for (const edge of mutation.edges.upsert) {
        if (endpointExists(edge.fromId) && endpointExists(edge.toId)) {
          input.db.upsertEdge(edge);
        }
      }
      for (const slot of mutation.stateSlots.upsert) {
        input.db.upsertStateSlot(normalizeStateSlot(slot));
      }
      for (const transition of mutation.evidence.transitions) {
        input.db.upsertStateSlot({
          id: evidenceStatusSlotId(transition.entityId),
          ownerEntityId: transition.entityId,
          kind: "evidence",
          label: "证据状态",
          value: {
            previous: currentEvidenceStatus(input.db, transition.entityId),
            status: transition.to,
            reason: transition.reason,
          },
          updatedEventId: mutation.eventId,
        });
      }
    }

    return { event, blocked: mutation.blocked };
  };

  return input.db.transaction ? input.db.transaction(apply) : apply();
}

type ParsedPlayMutation = ReturnType<typeof PlayMutationSchema.parse>;

function resolveEdgeEndpointLabels(db: PlayReducerDB, mutation: ParsedPlayMutation): ParsedPlayMutation {
  if (mutation.edges.upsert.length === 0) {
    return mutation;
  }
  const labelToId = buildEntityAliasMap(db, mutation.entities.upsert);
  if (labelToId.size === 0) {
    return mutation;
  }
  const resolve = (value: string): string => labelToId.get(value.trim()) ?? value;
  return {
    ...mutation,
    edges: {
      ...mutation.edges,
      upsert: mutation.edges.upsert.map((edge) => ({
        ...edge,
        fromId: resolve(edge.fromId),
        toId: resolve(edge.toId),
      })),
    },
  };
}

function buildEntityAliasMap(db: PlayReducerDB, turnEntities: ReadonlyArray<PlayEntityInput>): Map<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (alias: string | undefined, id: string | undefined) => {
    const a = alias?.trim();
    const entityId = id?.trim();
    if (!a || !entityId) return;
    const existing = aliases.get(a);
    if (existing && existing !== entityId) {
      ambiguous.add(a);
      aliases.delete(a);
      return;
    }
    if (!ambiguous.has(a)) aliases.set(a, entityId);
  };

  for (const entity of readExistingEntities(db)) {
    add(entity.id, entity.id);
    add(entity.label, entity.id);
  }
  for (const entity of turnEntities) {
    add(entity.id, entity.id);
    add(entity.label, entity.id);
  }
  return aliases;
}

function readExistingEntities(db: PlayReducerDB): ReadonlyArray<PlayEntity> {
  try {
    return db.snapshot?.().entities ?? [];
  } catch {
    return [];
  }
}

function validateMutation(db: PlayReducerDB, mutation: ReturnType<typeof PlayMutationSchema.parse>): void {
  const upsertedEntityIds = new Set(mutation.entities.upsert.map((entity) => entity.id));
  const entityExists = (entityId: string): boolean => upsertedEntityIds.has(entityId) || db.getEntity(entityId) !== null;

  // NB: relationship edges are validated fail-open at apply time (a dangling
  // edge is skipped, not thrown) so one bad ref can't wipe the whole turn.

  for (const slot of mutation.stateSlots.upsert) {
    if (slot.ownerEntityId && !entityExists(slot.ownerEntityId)) {
      throw new Error(`Play mutation references missing entity in state slot ${slot.id}: ${slot.ownerEntityId}`);
    }
  }

  for (const transition of mutation.evidence.transitions) {
    const entity = upsertedEntityIds.has(transition.entityId)
      ? mutation.entities.upsert.find((candidate) => candidate.id === transition.entityId)
      : db.getEntity(transition.entityId);
    if (!entity) {
      throw new Error(`Play mutation references missing entity in evidence transition: ${transition.entityId}`);
    }
    if (entity.type !== "evidence" && entity.type !== "clue") {
      throw new Error(`Play evidence transition requires evidence or clue entity: ${transition.entityId}`);
    }
    const current = currentEvidenceStatus(db, transition.entityId);
    if (transition.from && transition.from !== current) {
      throw new Error(`Play evidence transition expected ${transition.from} but current status is ${current}`);
    }
    if (evidenceRank(transition.to) < evidenceRank(current)) {
      throw new Error(`Play evidence transition cannot regress from ${current} to ${transition.to}`);
    }
  }
}

function normalizeStateSlot(slot: PlayStateSlotInput): PlayStateSlotInput {
  if (!isRecord(slot.value)) return slot;
  const current = slot.value.current;
  const min = slot.value.min;
  const max = slot.value.max;
  if (typeof current !== "number") return slot;

  let next = current;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  if (next === current) return slot;

  return {
    ...slot,
    value: {
      ...slot.value,
      current: next,
    },
  };
}

function currentEvidenceStatus(db: PlayReducerDB, entityId: string): PlayEvidenceStatus {
  const slot = db.getStateSlotsForEntity(entityId)
    .find((candidate) => candidate.id === evidenceStatusSlotId(entityId) || candidate.kind === "evidence");
  if (!slot || !isRecord(slot.value)) return "unknown";
  const status = slot.value.status;
  return typeof status === "string" && (EVIDENCE_ORDER as readonly string[]).includes(status)
    ? status as PlayEvidenceStatus
    : "unknown";
}

function evidenceStatusSlotId(entityId: string): string {
  return `evidence:${entityId}:status`;
}

function evidenceRank(status: PlayEvidenceStatus): number {
  return EVIDENCE_ORDER.indexOf(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
