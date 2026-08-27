import * as maplibregl from "maplibre-gl";
import { cellToBoundary } from "h3-js";
import { areaText, footprintNote } from "./area";
import { loadTrack } from "./data";
import { mountTimeline } from "./timeline";
import { fireLayerIds } from "./layer_fires";
import { SCAR_LAYER_IDS } from "./layer_scars";
import type { FeatureSnapshot, Scar } from "./layer_imagery";
import type { Switcher } from "./registry";
import type { EventProps, Manifest, TimelineDay, Track } from "./types";
import { safeHttpUrl } from "./escape";
import { emitUi } from "./ui_events";
import {
  eventPosition,
  readoutModel,
  renderReadoutFull,
  renderReadoutPeek,
  type Readout,
} from "./fire_readout";
import { clearReadout, mountReadout } from "./fire_readout_mount";

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

export function fireCardHtml(p: EventProps, track: Track | null, readout?: Readout | null): string {
  const st = STATUS[p.status] ?? STATUS.closed;
  const stt = STATE[p.state] ?? STATE.steady;
  const title = p.place?.name ?? "Fire";
  const peak = track && track.series.length ? Math.max(...track.series.map((b) => b.frp_sum)) : 0;
  const mv = p.movement;
  const rows = [
    stat("Burned area", areaText(p.area_km2, p.cum_cells)),
    footprintNote(p.cum_cells) ? stat("Footprint", footprintNote(p.cum_cells)) : "",
    stat("Ignited", `${fmtDate(p.started)} · ${rel(p.started)}`),
    stat("Last detection", rel(p.freshness.viirs)),
    p.freshness.meteosat ? stat("Live (Meteosat)", rel(p.freshness.meteosat)) : "",
    peak ? stat("Peak intensity", `${Math.round(peak)} MW`) : "",
    mv ? stat("Spreading", `${compass(mv.bearing_deg)} · ${(mv.distance_24h_m / 1000).toFixed(1)} km / 24 h`) : "",
    p.place ? stat("Nearest town", `${esc(p.place.name)} (${p.place.distance_km} km)`) : "",
  ].join("");
  // Both halves of the GDACS alert are third-party: the pipeline copies title
  // and link straight out of gdacs.org's RSS without validating either. The
  // title is text, but the link lands in an href, which is a script sink — so
  // it goes through safeHttpUrl, exactly as panel.ts does with the same field.
  const alert = p.gdacs
    ? `<a class="fc-alert" href="${safeHttpUrl(p.gdacs.link)}" target="_blank" rel="noopener">⚠ ${esc(p.gdacs.title)}</a>`
    : "";
  // Arrival ramp legend — only when we have per-bin cells to paint.
  const arrival = track && track.cell_bins && track.cell_bins.length
    ? `<div class="fc-arrival"><span>Footprint colour · when it burned</span>` +
      `<div class="fc-ramp"></div>` +
      `<div class="fc-ramp-lbl"><span>earlier</span><span>now</span></div>` +
      `<div class="fc-arrival-hint">Click a histogram bar to rewind the fire.</div></div>`
    : "";
  // The peeked strip: the whole card compressed to one tappable line, so a
  // phone can dock it above the time bar and keep the map — and the fire's
  // own histogram scrubbing — visible. CSS hides its siblings at that size.
  //
  // The readout rides INSIDE .fc-peek because style.css:295 hides every other
  // child of #panel in peek state — and peek is where a phone user lands the
  // moment they tap a fire. Placed beside this div it would simply not be
  // there, on the one screen size where it matters most.
  const peek =
    `<div class="fc-peek"><b>${esc(title)}</b>` +
    `<span>${p.area_km2} km² · ${st.t}</span>` +
    (readout ? renderReadoutPeek(readout) : "") +
    `<i aria-hidden="true">›</i></div>`;
  return (
    peek +
    `<button class="fc-close" aria-label="Close">✕</button>` +
    `<div class="fc-title">${esc(title)}</div>` +
    `<div class="fc-sub">${fmtDate(p.started)} · <span style="color:${st.c}">${st.t}</span> fire</div>` +
    `<span class="fc-badge" style="background:${stt.c}">${stt.t}</span>` +
    `<div class="fc-stats">${rows}</div>` +
    // After the stat rows, not among them: "Burning" is a live reading and
    // "Peak intensity" is this fire's all-time high. Sat in the same row group
    // they read as two versions of one number.
    (readout ? renderReadoutFull(readout) : "") +
    arrival +
    alert +
    `<button class="fc-ba">Before / after imagery →</button>`
  );
}

export function scarCardHtml(s: Scar): string {
  const peek =
    `<div class="fc-peek"><b>${esc(s.place || s.label)}</b>` +
    `<span>${s.kind === "past" ? "Past fire" : "Active fire"}</span>` +
    `<i aria-hidden="true">›</i></div>`;
  return (
    peek +
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

/**
 * Compare mode is entered from a button INSIDE the card, long after the map
 * click that opened it — so these take a snapshot of the clicked feature, never
 * the event. MapLibre deletes `event.features` as soon as a delegated layer
 * handler returns, so an event held in a closure has nothing left on it by the
 * time the button is pressed: the scar entry did nothing at all, and the fire
 * entry silently fell back to "ignited yesterday", which then dated the
 * pre-fire baseline six days off the wrong day.
 */
export interface CompareLike {
  fromFire: (snap: FeatureSnapshot) => void;
  fromScar: (snap: FeatureSnapshot) => void;
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

/** A loaded track (or lack of one) reshaped for open()'s footprint/timeline
 *  params — shared by openFire and openScar so the mapping can't drift
 *  between the two. */
function trackTimeline(track: Track | null): {
  series: TimelineDay[] | null;
  centroids: [number, number][] | null;
  cellBins: [string, string[]][] | null;
} {
  const bins = track?.series ?? [];
  const series: TimelineDay[] = bins.map((b) => ({
    date: b.bin,
    count: b.new_cells,
    frp: b.frp_sum,
  }));
  const centroids = bins.map((b) => b.centroid);
  return {
    series: series.length ? series : null,
    centroids: centroids.length ? centroids : null,
    cellBins: track?.cell_bins ?? null,
  };
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
  /** Wind sample points, already loaded by the caller — the nearest fresh one
   *  becomes the card's wind reading.
   *
   *  Optional with a null default, and it has to stay that way: there are five
   *  call sites and four of them are tests that predate this argument, and
   *  tsconfig type-checks the test directory. A fire with no wind collection
   *  reads exactly like a fire with no sample near it, which is a state the
   *  renderers already handle. */
  windPoints: GeoJSON.FeatureCollection | null = null,
): FireCard {
  const panel = document.getElementById("panel")!;
  const saved: Record<string, Record<string, unknown>> = {};

  // The overlay and the card's own copy are alternatives, never both: two live
  // readings of one fire on one screen ask the reader to reconcile them, and
  // neither mount alone is a silent regression to the state before this
  // feature existed — so no test on one of them could catch the double.
  //
  // The same 641px the stylesheet switches on, so JS and CSS cannot disagree
  // about which mount is live (#fire-readout is display:none below it, and
  // .fc-peek display:none above it).
  //
  // Optional-chained throughout, including `addEventListener`: jsdom has no
  // matchMedia at all, and the stub some suites install carries `matches` and
  // nothing else. With no media query to ask, we behave as mobile — the card
  // keeps the reading, which is the safe direction, since that copy lives
  // inside #panel and cannot be left orphaned over the map.
  const mq = window.matchMedia?.("(min-width: 641px)") ?? null;
  const isDesktop = () => mq?.matches === true;
  /** The reading currently on display, so a breakpoint crossing can move it. */
  let lastReadout: Readout | null = null;
  /** Repaints the open card for the current breakpoint. Captures its own
   *  onBeforeAfter rather than reading a shared one, so a repaint can never be
   *  paired with a different card's compare-mode entry. */
  let rerenderCard: (() => void) | null = null;

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
    // openFire's guard only rechecks openToken after its await, so a track
    // request kicked off just before this close() (e.g. click fire B, then hit
    // Escape) is still "current" as far as that guard can tell — close() never
    // calls open(), so nothing else invalidates it. Bumping here is what makes
    // that late response a no-op instead of reopening the card just dismissed.
    openToken++;
    panel.classList.add("hidden");
    panel.innerHTML = "";
    lastReadout = null;
    rerenderCard = null;
    clearReadout(document.body);
    clearBin();
    undim();
    mountOverview(); // restore the Level-1 histogram (with day-click)
    compare?.exit();
    switcher.setLevel(1); // back to the overview layer set
    document.body.classList.remove("fire-focus");
    emitUi("detail:close");
  };

  /**
   * Writing the card's HTML and binding its controls are ONE operation.
   *
   * They used to be two statements sitting at either end of open(), which was
   * fine while open() was the only thing that ever wrote the panel. The moment
   * a second path re-renders it — the breakpoint handler below — that shape
   * produces a card whose ✕ and "Before / after imagery" buttons quietly do
   * nothing, with nothing about the card LOOKING wrong. Anything that repaints
   * the card goes through here, so the two can never come apart again.
   */
  const paintCard = (html: string, onBeforeAfter: () => void) => {
    panel.innerHTML = html;
    panel.querySelector(".fc-close")?.addEventListener("click", close);
    panel.querySelector(".fc-ba")?.addEventListener("click", onBeforeAfter);
  };

  // A card open across a rotation (or a desktop window dragged narrow) has to
  // move its reading to the other mount, and the card must be repainted for
  // the new width — through paintCard, so its controls come back with it.
  // Gated on fire-focus: with no card open there is nothing to move.
  mq?.addEventListener?.("change", () => {
    if (!document.body.classList.contains("fire-focus")) return;
    // mountReadout(_, null) clears, so a scar card (which never sets a
    // readout) is left exactly as it was at either width.
    if (isDesktop()) mountReadout(document.body, lastReadout);
    else clearReadout(document.body);
    rerenderCard?.();
  });

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
    /** A settled past scar or a closed live fire has no current-moment data
     *  of its own — force-hides the liveOnly sublayers (Fire intensity/
     *  spread/wind/VIIRS) at level 2, which would otherwise show nothing
     *  there with no way to tell why. See registry.ts's Switcher.setLevel. */
    historical: boolean,
    onBeforeAfter: () => void,
  ) => {
    // Bumped here, not just in openFire: this is the single choke point every
    // card display goes through (a fresh fire, openScar — also awaiting its
    // own loadTrack now — or any future caller), so it's the honest place to
    // invalidate whichever earlier fire's loadTrack might still be in flight
    // — patching openFire alone would only cover today's callers, not the
    // next one added.
    openToken++;
    // The mount lifecycle is reset HERE, not only in close(), for the same
    // reason openToken is bumped here: this is the single choke point every
    // card display goes through. Opening a scar, or a second fire, never calls
    // close() — so clearing there alone would leave the previous fire's
    // readings standing over the map beside a card they do not belong to.
    // openFire re-establishes both immediately after this returns.
    lastReadout = null;
    rerenderCard = null;
    clearReadout(document.body);
    clearBin();
    onEnter(); // clear any overview state (e.g. a painted day slice)
    paintCard(html, onBeforeAfter);
    panel.classList.remove("hidden");
    document.body.classList.add("fire-focus");
    switcher.setLevel(2, { historical }); // swap to this fire's detail layers
    emitUi("detail:open");
    map.flyTo({ center: [lon, lat], zoom: 10.5 });
    dim(id);
    if (fireSeries) {
      let onSelect: ((d: TimelineDay, i: number) => void) | undefined;
      // Only the footprint branch below paints anything before the scrubber
      // mounts; a series with no cell bins never desyncs, so it keeps the
      // control's default of bin 0.
      let initialIndex = 0;
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
        // The map above just painted the finished fire — the scrubber must
        // agree, or its label claims bin 0 while the map shows the end state.
        initialIndex = fireSeries.length - 1;
      }
      mountTimeline(timelineEl, fireSeries, {
        title: "This fire · new burned cells / 6 h",
        unit: "new cells",
        showTrend: false,
        partialLast: false,
        onSelect,
        initialIndex,
      });
    } else {
      mountOverview();
    }
  };

  // The fire/scar's OWN position first (`eventPosition`, Point geometry) — a
  // real click's `e.lngLat` is the pixel the user's finger or cursor landed
  // on, several metres to a halo-width off the dot's actual centre. Only a
  // feature with no Point geometry (the footprint polygon) falls back to the
  // tap point, since a polygon click has no single centre to read.
  const coords = (e: maplibregl.MapLayerMouseEvent, feat: maplibregl.MapGeoJSONFeature): [number, number] => {
    const pos = eventPosition(feat);
    if (pos) return pos;
    if (e.lngLat) return [e.lngLat.lng, e.lngLat.lat];
    return [0, 0];
  };

  // Guards `loadTrack`: a click on one fire while a previous fire's track is
  // still loading must not let that earlier response win and overwrite the
  // card the user is now looking at once it finally arrives.
  let openToken = 0;

  const openFire = async (e: maplibregl.MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const mine = ++openToken;
    const p = reparse(feat.properties ?? {});
    // One position, read once: `pos` is the fire's own Point geometry, null
    // for the footprint-polygon click path (no single point to read). Camera
    // and before/after always need SOME coordinate, so `[lon, lat]` falls
    // back to the tap point; the wind/intensity readout below uses `pos`
    // directly and shows nothing rather than attach a real figure to a guess.
    const pos = eventPosition(feat);
    const [lon, lat] = pos ?? (e.lngLat ? [e.lngLat.lng, e.lngLat.lat] : [0, 0]);
    let track: Track | null = null;
    try {
      track = await loadTrack(manifest, p.id, "/data", fetch, p.track_gen);
    } catch {
      /* no track (e.g. tiny fire) — card still renders from props */
    }
    if (mine !== openToken) return; // superseded by a newer fire click
    const { series, centroids, cellBins } = trackTimeline(track);
    const readout = pos ? readoutModel(track?.frp_live ?? null, pos, windPoints, new Date()) : null;
    const desktop = isDesktop();
    const onBeforeAfter = () =>
      compare?.fromFire({ props: { ...(feat.properties ?? {}) }, lon, lat });
    // Exactly one mount is populated: the card is handed the readout only when
    // the overlay will not be.
    open(fireCardHtml(p, track, desktop ? null : readout), lon, lat, p.id,
      series, centroids, cellBins,
      p.status === "closed", onBeforeAfter);
    // AFTER open(), never before: open() resets both of these on the way in,
    // to clear whatever card came before. Setting them first would hand the
    // reset the very state it is meant to preserve.
    lastReadout = readout;
    rerenderCard = () =>
      paintCard(fireCardHtml(p, track, isDesktop() ? null : readout), onBeforeAfter);
    if (desktop) mountReadout(document.body, readout);
  };

  // A past scar with a permanent archive (s.track_gen === "archive", see
  // pipeline/archive_tracks.py) loads the same H3 arrival-footprint detail an
  // active fire's card shows — mirrors openFire below, down to the openToken
  // race guard, since the same "click fire B while fire A's track is still
  // in flight" race applies here too now that this awaits loadTrack as well.
  const openScar = async (e: maplibregl.MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat) return;
    const mine = ++openToken;
    const s = feat.properties as unknown as Scar;
    const scarId = String(s.id ?? "");
    const [lon, lat] = coords(e, feat);
    // Curated megafires, EFFIS scars, and a real past fire not yet archived
    // all carry no track_gen — skip the fetch rather than pay a guaranteed
    // 404 on every one of those clicks (the majority of scar clicks).
    let track: Track | null = null;
    if (s.track_gen) {
      try {
        track = await loadTrack(manifest, scarId, "/data", fetch, s.track_gen);
      } catch {
        /* archived track missing/failed — card still renders from props */
      }
    }
    if (mine !== openToken) return; // superseded by a newer fire/scar click
    const { series, centroids, cellBins } = trackTimeline(track);
    open(scarCardHtml(s), lon, lat, scarId,
      series, centroids, cellBins,
      s.kind === "past",
      () => compare?.fromScar({ props: { ...(feat.properties ?? {}) }, lon, lat }));
  };

  return {
    openFire,
    openScar,
    close,
    get isOpen() {
      return !panel.classList.contains("hidden");
    },
  };
}
