import { describe, expect, it } from "vitest";
import { buildView } from "../PlayHud";

describe("PlayHud buildView", () => {
  it("classifies held inventory from graph edges, not status words", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "guided", premise: "查一个配送柜。" },
      graph: {
        entities: [
          { id: "loc-cabinet", type: "location", label: "F-07配送柜", status: "就在面前" },
          { id: "blood", type: "evidence", label: "柜内血迹", status: "已看见，还未采集" },
          { id: "note", type: "clue", label: "夹层纸条", status: "正在查阅" },
        ],
        edges: [
          { id: "edge-hold-note", fromId: "actor_player", type: "持有", toId: "note" },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.facing.map((row) => row.label)).toEqual([
      "F-07配送柜",
      "柜内血迹",
    ]);
    expect(view?.holdings.map((row) => row.label)).toEqual(["夹层纸条"]);
  });

  it("does not treat inventory-looking status text as authoritative", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "guided", premise: "查一个配送柜。" },
      graph: {
        entities: [
          { id: "note", type: "clue", label: "夹层纸条", status: "已收起" },
        ],
        edges: [],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.facing.map((row) => row.label)).toEqual(["夹层纸条"]);
    expect(view?.holdings.map((row) => row.label)).toEqual([]);
  });
});
