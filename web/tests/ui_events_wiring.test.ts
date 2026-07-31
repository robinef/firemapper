/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type maplibregl from "maplibre-gl";
import { onUi } from "../src/ui_events";
import type { Switcher } from "../src/registry";

// The wiring test asserts the CONTRACT, not the internals: closing a fire card
// must announce itself. It uses the real module through a minimal fake map.
describe("ui event wiring", () => {
  it("firecard close emits detail:close", async () => {
    const seen: string[] = [];
    onUi("detail:close", () => seen.push("close"));

    // maplibre-gl's module load path calls this in a browser-like global; jsdom
    // doesn't implement it, so stub it before firecard pulls maplibre-gl in.
    window.URL.createObjectURL ??= () => "";

    const { setupFireCard } = await import("../src/firecard");
    document.body.innerHTML = `<div id="panel"></div><div id="timeline"></div>`;
    const map = {
      getLayer: () => null, getSource: () => null, setPaintProperty: () => {},
      getPaintProperty: () => 1, on: () => {}, off: () => {}, flyTo: () => {},
      getCanvas: () => ({ style: {} }),
    } as unknown as maplibregl.Map;
    const switcher: Switcher = { isOn: () => true, setLevel: () => {} };

    const card = setupFireCard(
      map,
      { generation: "gen-1", layers: {} } as never,
      null,
      document.getElementById("timeline")!,
      switcher,
      () => {},
      () => {},
    );
    card.close();
    expect(seen).toEqual(["close"]);
  });
});
