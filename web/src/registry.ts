import type * as maplibregl from "maplibre-gl";

import { moduleReason, moduleStale } from "./freshness";
import type { Manifest } from "./types";

export type Level = 1 | 2;

/** One map layer group the user can toggle, with its own legend. */
export interface LayerModule {
  key: string;
  label: string;
  /** The single question this layer answers, shown under its name. */
  question: string;
  /** maplibre layer ids this module owns (for visibility toggling). */
  layerIds: string[];
  defaultOn: boolean;
  /** Which UI levels show this layer's toggle: 1 = overview ("where are the
   *  fires?"), 2 = one fire's card ("how is THIS fire behaving?"). Defaults to
   *  both. A layer hidden at the current level is force-hidden on the map, so a
   *  detail layer left on never leaks back into the overview. */
  levels?: Level[];
  /** Live status line under the toggle — e.g. how many fires are in view and
   *  how many this zoom actually draws. Re-evaluated on every render, so a
   *  module can report state that changes with the camera. Returning null
   *  keeps the row quiet. */
  status?: () => string | null;
  /** An extra control inside the row: a filter the layer owns. `onChange` is
   *  called with the new state; the switcher only renders and remembers it. */
  filter?: { label: string; defaultOn: boolean; onChange: (on: boolean) => void };
  /** Manifest `layers` keys this module draws from. A module is greyed when any
   *  of them is past its age budget — derived layers (spread, isochrones) name
   *  the source they were computed from, not themselves. */
  freshnessKeys?: string[];
  legend?: {
    title: string;
    /** `shape:"dot"` + `size` render a scaled circle, so a legend can show a
     *  SIZE encoding (e.g. burned area), not just a colour swatch. `color` may
     *  be rgba to show an OPACITY encoding (e.g. active vs quiet). */
    entries?: { color: string; label: string; size?: number; shape?: "dot" | "square" }[];
    note?: string;
  };
}

export interface Switcher {
  isOn(key: string): boolean;
  /** Re-render the rows, so camera-dependent status lines update. */
  refresh(): void;
  /** Swap the panel between the overview (1) and per-fire detail (2) layer sets. */
  setLevel(level: Level): void;
}

/**
 * Renders the layer list + the legends of active layers, adapting to the level:
 * the overview shows coarse "where are the fires" layers, a fire card shows that
 * fire's detail layers. A layer's legend is only shown while its layer is on, so
 * colour codings never compete — the rule that stops the "everything is red"
 * problem returning.
 */
export function mountSwitcher(
  layersEl: HTMLElement,
  legendEl: HTMLElement,
  modules: LayerModule[],
  map: maplibregl.Map,
  manifest?: Manifest,
): Switcher {
  const state = new Map(modules.map((m) => [m.key, m.defaultOn]));
  /** Filter state lives here, not in the module, so a re-render does not reset
   * a choice the reader made. */
  const filters = new Map<string, boolean>();
  let level: Level = 1;
  const inLevel = (m: LayerModule) => (m.levels ?? [1, 2]).includes(level);

  const applyVis = (m: LayerModule) => {
    const on = inLevel(m) && !!state.get(m.key);
    for (const id of m.layerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
  };

  const renderLegends = () => {
    const blocks: string[] = [];
    for (const m of modules) {
      if (!inLevel(m) || !state.get(m.key) || !m.legend) continue;
      const sw = (m.legend.entries ?? [])
        .map((e) => {
          const px = e.size ?? 12;
          const radius = e.shape === "dot" ? "50%" : "2px";
          // Fixed-width slot so different dot sizes stay vertically aligned.
          const icon =
            `<span style="display:inline-flex;width:20px;justify-content:center">` +
            `<i style="width:${px}px;height:${px}px;background:${e.color};border-radius:${radius}"></i></span>`;
          return `<span class="sw">${icon}${e.label}</span>`;
        })
        .join("");
      const note = m.legend.note ? `<div class="legend-note">${m.legend.note}</div>` : "";
      blocks.push(`<div class="legend-block"><b>${m.legend.title}</b>${sw}${note}</div>`);
    }
    legendEl.innerHTML = blocks.join("");
    legendEl.style.display = blocks.length ? "block" : "none";
  };

  /** `reassertVis` false = redraw the panel only.
   *
   * applyVis writes `visibility: visible` for every on, in-level module, which
   * is right when the reader has just changed something — and wrong on a plain
   * redraw. Compare mode hides the overlay layers itself (main.ts hideOverlays)
   * and then flies the camera; the resulting moveend used to re-render, which
   * put every fire dot, halo, footprint and label straight back on top of the
   * before/after swipe for the whole session. Nothing may hide a layer behind
   * the switcher's back unless a status-only redraw leaves visibility alone. */
  const render = (reassertVis = true) => {
    const title = level === 2 ? "This fire · detail" : "Layers";
    layersEl.innerHTML = `<div class='layers-title'>${title}</div>`;
    for (const m of modules) {
      if (reassertVis) applyVis(m); // out-of-level hidden, in-level follow their toggle
      if (!inLevel(m)) continue;
      const row = document.createElement("label");
      row.className = "layer-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state.get(m.key);
      cb.addEventListener("change", () => {
        state.set(m.key, cb.checked);
        applyVis(m);
        renderLegends();
      });
      const text = document.createElement("span");
      text.className = "layer-text";
      // A layer past its age budget still renders, but says so: silently
      // showing hours-old pixels as current is the failure this guards against.
      const stale = manifest ? moduleStale(manifest, m, new Date()) : false;
      const reason = stale && manifest ? moduleReason(manifest, m, new Date()) : null;
      if (stale) row.classList.add("stale");
      // Only while the layer is on: a count for a hidden layer is noise, and a
      // count that contradicts an empty map is the thing being fixed here.
      const status = state.get(m.key) ? (m.status?.() ?? null) : null;
      text.innerHTML =
        `<span class="layer-name">${m.label}</span>` +
        `<span class="layer-hint">${m.question}</span>` +
        (reason ? `<span class="layer-reason">⚠ ${reason}</span>` : "") +
        (status ? `<span class="layer-count">${status}</span>` : "");
      row.append(cb, text);
      layersEl.append(row);

      if (m.filter && state.get(m.key)) {
        const f = document.createElement("label");
        f.className = "layer-filter";
        const fcb = document.createElement("input");
        fcb.type = "checkbox";
        fcb.checked = filters.get(m.key) ?? m.filter.defaultOn;
        fcb.addEventListener("change", () => {
          filters.set(m.key, fcb.checked);
          m.filter!.onChange(fcb.checked);
          render();
        });
        const span = document.createElement("span");
        span.textContent = m.filter.label;
        f.append(fcb, span);
        layersEl.append(f);
      }
    }
    renderLegends();
  };

  render();

  return {
    isOn: (k) => state.get(k) ?? false,
    refresh: () => render(false),
    setLevel: (l) => {
      level = l;
      render();
    },
  };
}
