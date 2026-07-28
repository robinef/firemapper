import type maplibregl from "maplibre-gl";

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
): Switcher {
  const state = new Map(modules.map((m) => [m.key, m.defaultOn]));
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

  const render = () => {
    const title = level === 2 ? "This fire · detail" : "Layers";
    layersEl.innerHTML = `<div class='layers-title'>${title}</div>`;
    for (const m of modules) {
      applyVis(m); // force out-of-level layers hidden, in-level follow their toggle
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
      text.innerHTML = `<span class="layer-name">${m.label}</span><span class="layer-hint">${m.question}</span>`;
      row.append(cb, text);
      layersEl.append(row);
    }
    renderLegends();
  };

  render();

  return {
    isOn: (k) => state.get(k) ?? false,
    setLevel: (l) => {
      level = l;
      render();
    },
  };
}
