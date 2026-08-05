import { describe, expect, it } from "vitest";
import { emitUi, onUi } from "../src/ui_events";

describe("ui events", () => {
  it("delivers an event to every subscriber", () => {
    const seen: string[] = [];
    onUi("detail:open", () => seen.push("a"));
    onUi("detail:open", () => seen.push("b"));
    emitUi("detail:open");
    expect(seen).toEqual(["a", "b"]);
  });

  it("does not cross events", () => {
    const seen: string[] = [];
    onUi("detail:close", () => seen.push("close"));
    emitUi("detail:open");
    expect(seen).toEqual([]);
  });

  it("unsubscribes", () => {
    const seen: string[] = [];
    const off = onUi("detail:open", () => seen.push("x"));
    off();
    emitUi("detail:open");
    expect(seen).toEqual([]);
  });

  it("survives a throwing subscriber", () => {
    const seen: string[] = [];
    onUi("compare:enter", () => { throw new Error("boom"); });
    onUi("compare:enter", () => seen.push("still ran"));
    expect(() => emitUi("compare:enter")).not.toThrow();
    expect(seen).toEqual(["still ran"]);
  });
});
