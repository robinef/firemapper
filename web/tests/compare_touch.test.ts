import { describe, expect, it } from "vitest";
import { lockMap, unlockMap, type MapLike } from "../src/compare_lock";

// A fake MapLike mirroring MapLibre's IHandler contract, without pulling in
// the real map (compare_lock has no other dependency, so it must not need one
// to test).
function fakeMap(dragPan = true, dragRotate = true): MapLike {
  const handler = (on: boolean) => ({
    _on: on,
    isEnabled() {
      return this._on;
    },
    enable() {
      this._on = true;
    },
    disable() {
      this._on = false;
    },
  });
  return { dragPan: handler(dragPan), dragRotate: handler(dragRotate) } as MapLike;
}

describe("compare map lock", () => {
  it("disables single-finger pan while comparing", () => {
    const map = fakeMap();
    lockMap(map);
    expect(map.dragPan.isEnabled()).toBe(false);
  });

  it("disables rotate too, so a two-finger twist can't fight the divider", () => {
    const map = fakeMap();
    lockMap(map);
    expect(map.dragRotate.isEnabled()).toBe(false);
  });

  it("restores exactly the state captured on entry, not unconditionally on", () => {
    // dragRotate already off before compare (a hypothetical earlier mode) —
    // exit must leave it off, not flip it on just because compare is done.
    const map = fakeMap(true, false);
    const state = lockMap(map);
    unlockMap(map, state);
    expect(map.dragPan.isEnabled()).toBe(true);
    expect(map.dragRotate.isEnabled()).toBe(false);
  });

  it("round-trips a fully-enabled map back to fully enabled", () => {
    const map = fakeMap(true, true);
    const state = lockMap(map);
    unlockMap(map, state);
    expect(map.dragPan.isEnabled()).toBe(true);
    expect(map.dragRotate.isEnabled()).toBe(true);
  });
});
