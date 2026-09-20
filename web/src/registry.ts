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
  /** This layer only ever shows CURRENT-MOMENT data (live FRP, live wind
   *  samples, today's satellite pass) — it isn't computed for whichever fire
   *  card happens to be open. A historical fire (a settled past scar, or a
   *  closed live fire) has none of that at its own location, so the toggle
   *  would just show nothing there with no way to tell why. Force-hidden at
   *  level 2 when the open fire is historical, regardless of its own state. */
  liveOnly?: boolean;
  /** Live status line under the toggle — e.g. how many fires are in view and
   *  how many this zoom actually draws. Re-evaluated on every render, so a
   *  module can report state that changes with the camera. Returning null
   *  keeps the row quiet. */
  status?: () => string | null;
  /** An extra control inside the row: a filter the layer owns. `onChange` is
   *  called with the new state; the switcher only renders and remembers it. */
  filter?: { label: string; defaultOn: boolean; onChange: (on: boolean) => void };
  /** Called after the reader flips this layer's checkbox, with the new state,
   *  once visibility has been applied. A module that lazy-loads data on
   *  demand (layer_season.ts's cells) needs this: a zoom event alone never
   *  fires when the layer is switched on while already zoomed in. */
  onToggle?: (on: boolean) => void;
  /** Render a custom control under the row while the layer is on — e.g. the
   *  season size slider. Called on EVERY panel render (the panel rebuilds its
   *  DOM on moveend, toggles and level changes), so the module owns the
   *  control's state and must render idempotently into the fresh container. */
  control?: (container: HTMLElement) => void;
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
  /** Re-evaluate ONE module's status line in place, without rebuilding the
   *  panel. A control that lives under the row (the season size slider)
   *  must keep its DOM node — and therefore keyboard focus and pointer
   *  capture — across the aggregation it triggers; a full render() would
   *  replace it mid-drag. */
  refreshStatus(key: string): void;
  /** Swap the panel between the overview (1) and per-fire detail (2) layer sets.
   *  `historical` force-hides `liveOnly` modules at level 2 — pass true for a
   *  settled past scar or a closed live fire, which have no current-moment
   *  data of their own for those layers to show. */
  setLevel(level: Level, opts?: { historical?: boolean }): void;
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
  /** The `.layer-text` span of each row currently in the DOM, so one status
   *  line can be rewritten without touching the rest of the panel. Rebuilt by
   *  every render, so it never points at a detached node. */
  const rowText = new Map<string, HTMLElement>();
  let level: Level = 1;
  let historical = false;
  const inLevel = (m: LayerModule) =>
    (m.levels ?? [1, 2]).includes(level) && !(level === 2 && historical && m.liveOnly);

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
    rowText.clear();
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
        m.onToggle?.(cb.checked);
        // Redraw the rows: a module's control (the season histogram + slider)
        // only exists while its layer is on, and nothing else repaints the
        // panel until the reader pans. Without this, toggling off strands the
        // control under an unchecked row and toggling back on leaves the row
        // bare. This replaces `cb` itself — which is why it runs LAST, once
        // the handler has finished with it.
        render(false);
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
      rowText.set(m.key, text);
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

      if (m.control && state.get(m.key)) {
        const c = document.createElement("div");
        c.className = "layer-control";
        m.control(c);
        layersEl.append(c);
      }
    }
    renderLegends();
  };

  /** Rewrite one row's `.layer-count` and nothing else. Every other node in
   *  the panel — including the module's control and whatever the reader is
   *  holding focus or a pointer on inside it — is left exactly where it is. */
  const refreshStatus = (key: string): void => {
    const m = modules.find((x) => x.key === key);
    const text = rowText.get(key);
    if (!m || !text) return;
    const status = inLevel(m) && state.get(m.key) ? (m.status?.() ?? null) : null;
    const existing = text.querySelector(".layer-count");
    if (status == null) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.textContent = status;
      return;
    }
    const span = document.createElement("span");
    span.className = "layer-count";
    span.textContent = status;
    text.append(span);
  };

  render();

  return {
    isOn: (k) => state.get(k) ?? false,
    refresh: () => render(false),
    refreshStatus,
    setLevel: (l, opts) => {
      level = l;
      historical = !!opts?.historical;
      render();
    },
  };
}
