import maplibregl from "maplibre-gl";
import { cellToBoundary } from "h3-js";
import { loadTrack } from "./data";
import { mountTimeline } from "./timeline";
import { fireLayerIds } from "./layer_fires";
import { SCAR_LAYER_IDS } from "./layer_scars";
import type { Scar } from "./layer_imagery";
import type { Switcher } from "./registry";
import type { EventProps, Manifest, TimelineDay, Track } from "./types";
import { emitUi } from "./ui_events";

/**
 * Level 2 — the fire card. Clicking a fire (active dot, footprint, or past-scar
 * marker) enters a focused view: the map flies in and dims every other fire,
 * the right panel shows this fire's stats, and the bottom histogram switches
 * from the Europe-wide daily activity to THIS fire's own growth per 6 h bin.
 * Before/after imagery is a button inside the card, not the whole interaction.
 * Closing restores the Level-1 overview.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const STATUS: Record<string, { t: string; c: string }> = {
  active: { t: "Active", c: "#ff5a1f" },
  stale: { t: "Quiet", c: "#c98a5a" },
  closed: { t: "Closed", c: "#8a8a8a" },
};
const STATE: Record<string, { t: string; c: string }> = {
  accelerating: { t: "Accelerating", c: "#ff2d2d" },
  growing: { t: "Growing", c: "#ff8c00" },
  steady: { t: "Steady", c: "#ffd000" },
  declining: { t: "Declining", c: "#8a8a8a" },
};
// Circle layers dimmed to spotlight the selected fire (paint saved/restored).
const DIM_LAYERS = [...fireLayerIds, "scars-glow", "scars-dot"];
const DIM_PROPS = ["circle-opacity", "circle-stroke-opacity"] as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function rel(iso: string): string {
  const h = (Date.now() - Date.parse(iso)) / 3.6e6;
  if (h < 1) return `${Math.max(0, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
function compass(deg: number): string {
  return DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
/** GeoJSON feature props arrive with nested objects JSON-stringified. */
function reparse(props: Record<string, unknown>): EventProps {
  const out = { ...props };
  for (const k of ["movement", "freshness", "place", "gdacs"]) {
    if (typeof out[k] === "string") {
      try {
        out[k] = JSON.parse(out[k] as string);
      } catch {
        /* leave */
      }
    }
  }
  return out as unknown as EventProps;
}

function stat(label: string, value: string): string {
  return `<div class="fc-stat"><span>${label}</span><b>${value}</b></div>`;
}

function fireCardHtml(p: EventProps, track: Track | null): string {
  const st = STATUS[p.status] ?? STATUS.closed;
  const stt = STATE[p.state] ?? STATE.steady;
  const title = p.place?.name ?? "Fire";
  const peak = track && track.series.length ? Math.max(...track.series.map((b) => b.frp_sum)) : 0;
  const mv = p.movement;
  const rows = [
    stat("Burned area", `${p.area_km2} km²`),
    stat("Ignited", `${fmtDate(p.started)} · ${rel(p.started)}`),
    stat("Last detection", rel(p.freshness.viirs)),
    p.freshness.meteosat ? stat("Live (Meteosat)", rel(p.freshness.meteosat)) : "",
    peak ? stat("Peak intensity", `${Math.round(peak)} MW`) : "",
    mv ? stat("Spreading", `${compass(mv.bearing_deg)} · ${(mv.distance_24h_m / 1000).toFixed(1)} km / 24 h`) : "",
    p.place ? stat("Nearest town", `${p.place.name} (${p.place.distance_km} km)`) : "",
  ].join("");
  const alert = p.gdacs
    ? `<a class="fc-alert" href="${p.gdacs.link}" target="_blank" rel="noopener">⚠ ${esc(p.gdacs.title)}</a>`
    : "";
  // Arrival ramp legend — only when we have per-bin cells to paint.
  const arrival = track && track.cell_bins && track.cell_bins.length
    ? `<div class="fc-arrival"><span>Footprint colour · when it burned</span>` +
      `<div class="fc-ramp"></div>` +
      `<div class="fc-ramp-lbl"><span>earlier</span><span>now</span></div>` +
      `<div class="fc-arrival-hint">Click a histogram bar to rewind the fire.</div></div>`
    : "";
  return (
    `<button class="fc-close" aria-label="Close">✕</button>` +
    `<div class="fc-title">${esc(title)}</div>` +
    `<div class="fc-sub">${fmtDate(p.started)} · <span style="color:${st.c}">${st.t}</span> fire</div>` +
    `<span class="fc-badge" style="background:${stt.c}">${stt.t}</span>` +
    `<div class="fc-stats">${rows}</div>` +
    arrival +
    alert +
    `<button class="fc-ba">Before / after imagery →</button>`
  );
}

function scarCardHtml(s: Scar): string {
  return (
    `<button class="fc-close" aria-label="Close">✕</button>` +
    `<div class="fc-title">${esc(s.place || s.label)}</div>` +
    `<div class="fc-sub">${s.kind === "past" ? "Past fire" : "Active fire"} · ${fmtDate(s.started)}</div>` +
    `<div class="fc-stats">` +
    stat("Location", `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}`) +
    stat("Before (pre-fire)", s.before) +
    stat("After (scar)", s.after) +
    `</div>` +
    `<button class="fc-ba">Before / after imagery →</button>`
  );
}

export interface CompareLike {
  fromFire: (e: maplibregl.MapLayerMouseEvent) => void;
  fromScar: (e: maplibregl.MapLayerMouseEvent) => void;
  exit: () => void;
}

export interface FireCard {
  openFire: (e: maplibregl.MapLayerMouseEvent) => void;
  openScar: (e: maplibregl.MapLayerMouseEvent) => void;
  close: () => void;
  /** Whether a fire/scar card is currently showing. Callers that only want
   *  to dismiss an OPEN card (e.g. a background map tap) must check this
   *  first: close() is not side-effect-free when nothing is open — it also
   *  calls mountOverview(), which re-renders the level-1 histogram and wipes
   *  any selected day bin, so calling it unconditionally on every miss-click
   *  would silently clear a selection the user never asked to touch. */
  readonly isOpen: boolean;
}

export function setupFireCard(
  map: maplibregl.Map,
  manifest: Manifest,
  compare: CompareLike | null,
  timelineEl: HTMLElement,
  switcher: Switcher,
  /** Re-mount the Level-1 overview histogram (with its day-click wiring). */
  mountOverview: () => void,
  /** Called when a fire card opens, so the overview state (e.g. a painted day)
   *  can be cleared. */
  onEnter: () => void,
): FireCard {
  const panel = document.getElementById("panel")!;
  const saved: Record<string, Record<string, unknown>> = {};

  const dim = (id: string) => {
    const pick = ["case", ["==", ["get", "id"], id], 0.95, 0.12] as unknown;
    for (const lid of DIM_LAYERS) {
      if (!map.getLayer(lid)) continue;
      saved[lid] ??= {};
      for (const prop of DIM_PROPS) {
        if (!(prop in saved[lid])) saved[lid][prop] = map.getPaintProperty(lid, prop);
        map.setPaintProperty(lid, prop, pick as never);
      }
    }
  };
  const undim = () => {
    for (const lid of Object.keys(saved)) {
      if (!map.getLayer(lid)) continue;
      for (const prop of DIM_PROPS) map.setPaintProperty(lid, prop, saved[lid][prop] as never);
    }
    for (const k of Object.keys(saved)) delete saved[k];
  };

  const close = () => {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    clearBin();
    undim();
    mountOverview(); // restore the Level-1 histogram (with day-click)
    compare?.exit();
    switcher.setLevel(1); // back to the overview layer set
    document.body.classList.remove("fire-focus");
    emitUi("detail:close");
  };

  // Clicking a histogram bin paints the fire's footprint AS OF that bin (the
  // cumulative burned cells up to then) plus a pulse at that bin's centroid —
  // so the map shows the fire's real extent that day, not just one dot.
  let binMarker: maplibregl.Marker | null = null;
  const ensureFootprint = () => {
    if (map.getSource("fire-bin")) return;
    map.addSource("fire-bin", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "fire-bin-fill", type: "fill", source: "fire-bin", layout: { visibility: "none" },
      // Colour by arrival t (0 = first burned … 1 = most recent): cool → hot.
      paint: {
        "fill-color": [
          "interpolate", ["linear"], ["get", "t"],
          0, "#3aa7e0", 0.4, "#8fd36b", 0.7, "#ff8c00", 1, "#ff2d2d",
        ],
        "fill-opacity": 0.42,
      },
    });
    map.addLayer({
      id: "fire-bin-line", type: "line", source: "fire-bin", layout: { visibility: "none" },
      paint: { "line-color": "#000", "line-width": 0.3, "line-opacity": 0.25 },
    });
  };
  const setFootprint = (cells: [string, number][]) => {
    ensureFootprint();
    const features: GeoJSON.Feature[] = cells.map(([cell, t]) => {
      const ring = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { t } };
    });
    (map.getSource("fire-bin") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });
    for (const id of ["fire-bin-fill", "fire-bin-line"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    }
  };
  const clearBin = () => {
    binMarker?.remove();
    binMarker = null;
    for (const id of ["fire-bin-fill", "fire-bin-line"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    }
  };
  const markBin = (centroids: [number, number][], i: number) => {
    const c = centroids[i];
    if (!c) return;
    const [lat, lon] = c; // bins_series centroids are [lat, lon]
    if (!binMarker) {
      const dot = document.createElement("div");
      dot.className = "bin-marker";
      binMarker = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
    } else {
      binMarker.setLngLat([lon, lat]);
    }
  };

  const open = (
    html: string,
    lon: number,
    lat: number,
    id: string,
    fireSeries: TimelineDay[] | null,
    centroids: [number, number][] | null,
    cellBins: [string, string[]][] | null,
    onBeforeAfter: () => void,
  ) => {
    clearBin();
    onEnter(); // clear any overview state (e.g. a painted day slice)
    panel.innerHTML = html;
    panel.classList.remove("hidden");
    document.body.classList.add("fire-focus");
    switcher.setLevel(2); // swap the panel to this fire's detail layers
    emitUi("detail:open");
    map.flyTo({ center: [lon, lat], zoom: 10.5 });
    dim(id);
    if (fireSeries) {
      let onSelect: ((d: TimelineDay, i: number) => void) | undefined;
      if (centroids && cellBins && cellBins.length) {
        // Arrival index per cell (the bin it first appeared in) → normalised t.
        const nb = cellBins.length;
        const arrivalOf = new Map<string, number>();
        cellBins.forEach(([, cells], bi) => {
          for (const c of cells) if (!arrivalOf.has(c)) arrivalOf.set(c, bi);
        });
        const renderUpto = (i: number) => {
          const cells: [string, number][] = [];
          arrivalOf.forEach((bi, cell) => {
            if (bi <= i) cells.push([cell, nb > 1 ? bi / (nb - 1) : 0]);
          });
          setFootprint(cells);
        };
        onSelect = (_d, i) => {
          renderUpto(i); // fire's extent as of this bin, coloured by arrival
          markBin(centroids, i);
        };
        renderUpto(nb - 1); // show the full arrival footprint on open
      }
      mountTimeline(timelineEl, fireSeries, {
        title: "This fire · new burned cells / 6 h",
        unit: "new cells",
        showTrend: false,
        partialLast: false,
        onSelect,
      });
    } else {
      mountOverview();
    }
    panel.querySelector(".fc-close")?.addEventListener("click", close);
    panel.querySelector(".fc-ba")?.addEventListener("click", onBeforeAfter);
  };

  const coords = (e: maplibregl.MapLayerMouseEvent, feat: maplibregl.MapGeoJSONFeature): [number, number] => {
    if (e.lngLat) return [e.lngLat.lng, e.lngLat.lat];
    const g = feat.geometry;
    return g.type === "Point" ? (g.coordinates as [number, number]) : [0, 0];
  };

  const openFire = async (e: maplibregl.MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const p = reparse(feat.properties ?? {});
    const [lon, lat] = coords(e, feat);
    let track: Track | null = null;
    try {
      track = await loadTrack(manifest, p.id);
    } catch {
      /* no track (e.g. tiny fire) — card still renders from props */
    }
    const bins = track?.series ?? [];
    const series: TimelineDay[] = bins.map((b) => ({
      date: b.bin,
      count: b.new_cells,
      frp: b.frp_sum,
    }));
    const centroids = bins.map((b) => b.centroid);
    const cellBins = track?.cell_bins ?? null;
    open(fireCardHtml(p, track), lon, lat, p.id, series.length ? series : null,
      centroids.length ? centroids : null, cellBins, () => compare?.fromFire(e));
  };

  const openScar = (e: maplibregl.MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const s = feat.properties as unknown as Scar;
    const [lon, lat] = coords(e, feat);
    open(scarCardHtml(s), lon, lat, String(s.id ?? ""), null, null, null, () => compare?.fromScar(e));
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.classList.contains("hidden")) close();
  });

  return {
    openFire,
    openScar,
    close,
    get isOpen() {
      return !panel.classList.contains("hidden");
    },
  };
}
