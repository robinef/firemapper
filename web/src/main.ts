import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  loadAircraft,
  loadDaySlice,
  loadEvents,
  loadFrp,
  loadIsochrones,
  loadManifest,
  loadWind,
} from "./data";
import { badgeText } from "./freshness";
import { createMap } from "./map";
import { FIRE_HUE, addActiveFires, fireLayerIds } from "./layer_fires";
import { dispatchMapClick } from "./main_click";
import { INTENSITY_LAYER_IDS, INTENSITY_LEGEND, addIntensity } from "./layer_intensity";
import { SPREAD_LAYER_IDS, SPREAD_LEGEND, addSpread } from "./layer_spread";
import { WIND_LAYER_IDS, WIND_LEGEND, addWind } from "./layer_wind";
import { VIIRS_LAYER_IDS, VIIRS_LEGEND, addViirs } from "./layer_viirs";
import { AIRCRAFT_LAYER_IDS, AIRCRAFT_LEGEND, addAircraft } from "./layer_aircraft";
import { SCAR_LAYER_IDS, SCAR_LEGEND, addScars } from "./layer_scars";
import { addDaySlice, hideDaySlice, setDaySlice } from "./layer_dayslice";
import { lockMap, unlockMap, type HandlerState } from "./compare_lock";
import { ImagerySwipe, scarTiles, type ImageryConfig, type Scar } from "./layer_imagery";
import { mountSwitcher, type LayerModule } from "./registry";
import { createSheet } from "./sheet";
import { mountPanel, renderAircraftPanel } from "./panel";
import { mountTimeline } from "./timeline";
import { setupFireCard } from "./firecard";
import { emitUi } from "./ui_events";
import type { Manifest } from "./types";

const BASE = "/data";

// Rebuilt layer by layer against docs/cartography-rules.md. Overview shows the
// coarse "where are the fires" layers; a fire's card shows its detail. "When did
// the fire reach each place?" is answered per-fire by the arrival-coloured
// footprint in the card, not a global toggle.
async function boot() {
  const map = createMap("map");
  if (import.meta.env.DEV) {
    (window as unknown as { __map: maplibregl.Map }).__map = map;
  }
  const panel = mountPanel("panel", () => undefined);

  map.on("load", async () => {
    const manifest: Manifest = await loadManifest(BASE);
    // Show DATA age, not when the file was built — the freshness a citizen
    // actually cares about is "how old is the newest satellite detection".
    // Derived from the fire layers' observation times, so the badge cannot be
    // made to look fresh by some unrelated layer that happened to succeed.
    document.getElementById("header")!.textContent =
      `FireMapper${badgeText(manifest, new Date())}`;

    const events = await loadEvents(manifest, BASE);
    const iso = await loadIsochrones(manifest, BASE).catch(
      () => ({ type: "FeatureCollection", features: [] }) as GeoJSON.FeatureCollection,
    );
    // Active-fire footprint = the outermost (open-ended) arrival band.
    const footprint: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: iso.features.filter(
        (f) => (f.properties as { max_age?: number })?.max_age === 9999,
      ),
    };

    const frp =
      manifest.frp_points != null
        ? await loadFrp(manifest, BASE).catch(() => null)
        : null;

    addDaySlice(map); // under the fires: painted when a histogram day is clicked
    addActiveFires(map, events, footprint);
    if (frp) addIntensity(map, frp);
    if (frp) addSpread(map, frp);
    const wind =
      manifest.wind_points != null ? await loadWind(manifest, BASE).catch(() => null) : null;
    if (wind) addWind(map, wind);
    addViirs(map, manifest.generated_at.slice(0, 10));
    const aircraft =
      manifest.aircraft != null ? await loadAircraft(manifest, BASE).catch(() => null) : null;
    if (aircraft) {
      // Stamp each plane's position age now, so the layer can dim a stale
      // airborne fix (it may be km from the truth) — computed here because
      // MapLibre styles have no concept of "now".
      const nowSec = Date.now() / 1000;
      for (const f of aircraft.features) {
        const pt = (f.properties as { pos_time?: number }).pos_time;
        (f.properties as Record<string, unknown>).age_min =
          pt ? Math.round((nowSec - pt) / 60) : null;
      }
      addAircraft(map, aircraft);
    }
    if (manifest.imagery?.scars?.length) addScars(map, manifest.imagery.scars);

    const modules: LayerModule[] = [
      {
        key: "fires",
        freshnessKeys: ["events"],
        levels: [1, 2] as (1|2)[],
        label: "Active fires",
        question: "Where is fire burning now, and how big?",
        layerIds: [
          "fire-halo", ...fireLayerIds, "fire-footprint-fill", "fire-footprint-line", "fire-labels",
        ],
        defaultOn: true,
        legend: {
          title: "Active fires",
          entries: [
            { color: FIRE_HUE, size: 8, shape: "dot", label: "smaller burned area" },
            { color: FIRE_HUE, size: 16, shape: "dot", label: "larger burned area" },
            { color: "rgba(255,90,31,0.4)", size: 14, shape: "dot", label: "quiet — no new detection 24–48 h" },
          ],
          note: "One colour = fire. Bigger dot = more area burned; faded = gone quiet. Zoom in for the outline.",
        },
      },
      {
        key: "intensity",
        freshnessKeys: ["frp"],
        levels: [1, 2] as (1|2)[],
        label: "Fire intensity",
        question: "How violently is it burning right now?",
        layerIds: INTENSITY_LAYER_IDS,
        defaultOn: false,
        legend: INTENSITY_LEGEND,
      },
      {
        key: "spread",
        freshnessKeys: ["frp"],
        levels: [2] as (1|2)[],
        label: "Fire spread",
        question: "Which way is it moving, and how fast?",
        layerIds: SPREAD_LAYER_IDS,
        defaultOn: false,
        legend: SPREAD_LEGEND,
      },
      {
        key: "wind",
        freshnessKeys: ["wind"],
        levels: [2] as (1|2)[],
        label: "Wind",
        question: "Which way is the wind pushing it?",
        layerIds: WIND_LAYER_IDS,
        defaultOn: false,
        legend: WIND_LEGEND,
      },
      {
        key: "viirs",
        freshnessKeys: ["gibs_tiles"],
        levels: [2] as (1|2)[],
        label: "VIIRS detail",
        question: "Finest-resolution detection footprint (375 m)",
        layerIds: VIIRS_LAYER_IDS,
        defaultOn: false,
        legend: VIIRS_LEGEND,
      },
      {
        key: "aircraft",
        freshnessKeys: ["aircraft"],
        levels: [1, 2] as (1|2)[],
        label: "Firefighting aircraft",
        question: "Are water bombers working this fire?",
        layerIds: AIRCRAFT_LAYER_IDS,
        defaultOn: aircraft != null && aircraft.features.length > 0,
        legend: AIRCRAFT_LEGEND,
      },
      {
        key: "scars",
        freshnessKeys: ["imagery"],
        levels: [1] as (1|2)[],
        label: "Burn scars (past fires)",
        question: "How much did past fires destroy?",
        layerIds: SCAR_LAYER_IDS,
        defaultOn: true,
        legend: SCAR_LEGEND,
      },
    ];
    const switcher = mountSwitcher(
      document.getElementById("layers")!,
      document.getElementById("legend")!,
      modules,
      map,
      manifest,
    );
    createSheet(); // no-op above 640px; re-parents the panels below it
    // Overview histogram: clicking a day paints that day's detections across
    // Europe (a continental time-scrubber). Clicking the shown day again clears.
    const dayDates = new Set(manifest.day_slice_dates ?? []);
    let shownDay: string | null = null;
    const timelineEl = document.getElementById("timeline")!;
    const mountOverviewTimeline = () =>
      mountTimeline(timelineEl, manifest.timeline, {
        onSelect: async (d) => {
          if (shownDay === d.date) {
            hideDaySlice(map);
            shownDay = null;
            return;
          }
          if (!dayDates.has(d.date)) {
            hideDaySlice(map);
            shownDay = null;
            return;
          }
          shownDay = d.date;
          setDaySlice(map, await loadDaySlice(manifest, d.date));
        },
      });
    mountOverviewTimeline();
    // Level 2: clicking any fire zone (active dot, footprint, or past-scar
    // marker) opens that fire's card — map flies in, others dim, stats on the
    // right, the fire's own histogram on the bottom. Before/after is a button
    // inside the card, driven by the compare mode built here.
    const compare = setupCompareMode(map, manifest);
    const fireCard = setupFireCard(
      map, manifest, compare, timelineEl, switcher, mountOverviewTimeline,
      () => {
        hideDaySlice(map);
        shownDay = null;
      },
    );
    // Precedence, highest first. Halos come before their visible layer so the
    // larger target wins, and fires beat scars where they overlap. A single
    // map-level click handler (instead of one per layer) is what makes "one
    // tap, one open" possible: MapLibre invokes a layer-scoped handler once per
    // matching layer, so a dot sitting under its own halo used to fire twice —
    // harmless for the idempotent aircraft panel, but for fires it meant two
    // concurrent `loadTrack` requests racing to render the card.
    const CLICK_ORDER = [
      "fire-halo", ...fireLayerIds, "fire-footprint-fill",
      ...SCAR_LAYER_IDS, "aircraft-halo", "aircraft",
    ];
    const HANDLERS: Record<string, (e: maplibregl.MapLayerMouseEvent) => void> = {};
    for (const id of ["fire-halo", ...fireLayerIds, "fire-footprint-fill"]) {
      HANDLERS[id] = fireCard.openFire;
    }
    for (const id of SCAR_LAYER_IDS) HANDLERS[id] = fireCard.openScar;
    for (const id of ["aircraft-halo", "aircraft"]) {
      HANDLERS[id] = (e) => {
        const feat = e.features?.[0];
        if (feat) {
          panel.showHtml(renderAircraftPanel(feat.properties ?? {}));
          emitUi("aircraft:open");
        }
      };
    }

    map.on("click", (e) => {
      const layers = CLICK_ORDER.filter((id) => map.getLayer(id));
      const features = map.queryRenderedFeatures(e.point, { layers });
      const id = dispatchMapClick(features as never, CLICK_ORDER);
      if (!id) {
        // Tapping the map away from any fire/scar/aircraft is how a phone user
        // dismisses a detail card — there's no hardware "back" and the close
        // button can be a stretch one-handed. Confirmed missing only by
        // driving a real click in a real browser: jsdom's tests never asserted
        // a background tap does anything, so this silently regressed to a
        // no-op.
        //
        // Gated on isOpen — close() is not side-effect-free when nothing is
        // open: it also calls mountOverview(), which re-renders the level-1
        // histogram and wipes any selected day bin. Calling it unconditionally
        // on every miss-click made an ordinary empty-map click (any viewport,
        // desktop included) silently clear a selected histogram day even
        // though no card had ever been opened.
        if (fireCard.isOpen) fireCard.close();
        return;
      }
      // Not `{ ...e }`: MapMouseEvent's preventDefault()/defaultPrevented live
      // on its class prototype (and behind a private field), so spreading the
      // instance silently drops them and leaves a plain object that only
      // looks like the real event. openFire/openScar and the aircraft handler
      // above only ever read `features` and `lngLat` (the fire card forwards
      // the same event into compare-mode's scarFromClick, which also only
      // reads those two), so we carry exactly those real values — features
      // narrowed to the one layer that won dispatch — plus `point`, since
      // it's on hand for free and costs nothing to keep faithful.
      const hit = features.filter((f) => f.layer.id === id);
      const clickEvent = {
        features: hit,
        lngLat: e.lngLat,
        point: e.point,
      } as unknown as maplibregl.MapLayerMouseEvent;
      HANDLERS[id](clickEvent);
    });

    // Cursor feedback stays per-layer; it is desktop-only and harmless on touch.
    // aircraft-halo is a visible semi-transparent glow (layer_aircraft.ts:78-87),
    // so it gets the pointer cursor same as before this change. fire-halo is
    // fully transparent — a pointer over apparently-empty map would be a false
    // affordance — so it is deliberately left out here even though it is a
    // valid click target.
    for (const id of [
      ...fireLayerIds, "fire-footprint-fill", ...SCAR_LAYER_IDS, "aircraft-halo", "aircraft",
    ]) {
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    }

    // Boot done + layers mounted → drop the cold-start splash.
    const splash = document.getElementById("loading");
    if (splash) {
      splash.classList.add("done");
      setTimeout(() => splash.remove(), 450);
    }
  });
}

/**
 * Before/after imagery is a compare MODE you ENTER by clicking a fire on the
 * map — the map is the picker, so there is no list in the side panel. The scar
 * (a location + the two capture dates) is derived from the clicked fire itself.
 * Keyless NASA GIBS true-colour by default (works for any date, including last
 * month's fires); CDSE Sentinel-2 10 m when creds provide an HD source, with a
 * deeper zoom cap so close-ups stay crisp instead of over-zooming a coarse tile.
 *
 * Returns an entry handler to bind to fire-layer clicks, or null when no
 * imagery is configured.
 */
interface CompareMode {
  /** Enter from a live fire click — dates synthesised from the fire. */
  fromFire: (e: maplibregl.MapLayerMouseEvent) => void;
  /** Enter from a past-scar marker click — uses the scar's stored dates. */
  fromScar: (e: maplibregl.MapLayerMouseEvent) => void;
  /** Leave compare mode (destroy the swipe, clear the banner). */
  exit: () => void;
}

// Exported (only) so the ui_events wiring test can drive the real enter/exit
// logic instead of duplicating it — boot() still wires it up the same way.
export function setupCompareMode(map: maplibregl.Map, manifest: Manifest): CompareMode | null {
  const cfg = manifest.imagery;
  if (!cfg) return null;
  const maxzoom = cfg.hd ? 14 : 8;
  let swipe: ImagerySwipe | null = null;
  // Captured on enter so exit restores exactly what was there before compare
  // mode touched it, not both handlers unconditionally on (see compare_lock.ts).
  let locked: HandlerState | null = null;

  // Every data overlay is hidden while comparing, so nothing (H3 footprint
  // hexes, heat, hexbins, markers) sits on top of the before/after imagery.
  const OVERLAY_LAYERS = [
    "fire-halo", ...fireLayerIds, "fire-footprint-fill", "fire-footprint-line", "fire-labels",
    "fire-bin-fill", "fire-bin-line", "day-slice-fill", "day-slice-line",
    ...INTENSITY_LAYER_IDS, ...SPREAD_LAYER_IDS, ...WIND_LAYER_IDS,
    ...VIIRS_LAYER_IDS, ...AIRCRAFT_LAYER_IDS, ...SCAR_LAYER_IDS,
  ];
  const overlayVis: Record<string, string> = {};
  const hideOverlays = () => {
    for (const id of OVERLAY_LAYERS) {
      if (!map.getLayer(id)) continue;
      overlayVis[id] = (map.getLayoutProperty(id, "visibility") as string) ?? "visible";
      map.setLayoutProperty(id, "visibility", "none");
    }
  };
  const restoreOverlays = () => {
    for (const id of Object.keys(overlayVis)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", overlayVis[id]);
    }
    for (const id of Object.keys(overlayVis)) delete overlayVis[id];
  };

  const exit = () => {
    const wasComparing = swipe != null; // fire-card close also calls exit() unconditionally
    swipe?.destroy();
    swipe = null;
    restoreOverlays();
    // Restore whatever dragPan/dragRotate were before enter() locked them —
    // not an unconditional enable, so a future mode that legitimately turns
    // rotation off survives a compare round-trip.
    if (locked) unlockMap(map, locked);
    locked = null;
    setCompareNotice(null, cfg, exit);
    if (wasComparing) emitUi("compare:exit");
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") exit();
  });

  const enter = (scar: Scar) => {
    swipe?.destroy();
    // Guard against re-entry (switching scars while already comparing):
    // lockMap() again would capture the already-disabled state and corrupt
    // what exit() restores to, so only capture it the first time in.
    if (!locked) locked = lockMap(map);
    hideOverlays();
    map.flyTo({ center: [scar.lon, scar.lat], zoom: cfg.hd ? 13 : 10 });
    const t = scarTiles(cfg, scar);
    swipe = new ImagerySwipe(map, t.before, t.after, maxzoom);
    setCompareNotice(scar, cfg, exit);
    emitUi("compare:enter");
  };

  return {
    fromFire: (e) => enter(scarFromClick(e)),
    fromScar: (e) => {
      const s = scarFromProps(e.features?.[0]?.properties ?? {});
      if (s) enter(s);
    },
    exit,
  };
}

/** Reconstruct a Scar from a past-scar marker's feature properties, which
 * already carry the exact before/after dates the pipeline computed. */
function scarFromProps(p: Record<string, unknown>): Scar | null {
  const s = ["id", "label", "kind", "before", "after", "started"].every(
    (k) => typeof p[k] === "string",
  );
  if (!s || typeof p.lon !== "number" || typeof p.lat !== "number") return null;
  return {
    id: p.id as string,
    label: p.label as string,
    kind: p.kind as "active" | "past",
    lon: p.lon as number,
    lat: p.lat as number,
    started: p.started as string,
    before: p.before as string,
    after: p.after as string,
  };
}

/** Build a scar (location + before/after dates) from a clicked fire feature.
 * Uses the click point, so it works whether a proportional dot or the footprint
 * polygon was hit, and falls back to sensible active-fire dates when a footprint
 * feature carries no lifecycle props. */
function scarFromClick(e: maplibregl.MapLayerMouseEvent): Scar {
  const p = (e.features?.[0]?.properties ?? {}) as Record<string, unknown>;
  const day = 86_400_000;
  const now = Date.now();
  const yesterday = new Date(now - day);
  const parsed = typeof p.started === "string" ? new Date(p.started) : null;
  const start = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(now - day);
  const past = typeof p.status === "string" ? p.status !== "active" : false;
  const before = new Date(start.getTime() - 6 * day);
  let after = past
    ? new Date(Math.min(start.getTime() + 14 * day, yesterday.getTime()))
    : yesterday;
  if (after.getTime() < start.getTime()) after = new Date(start.getTime());
  const label =
    (typeof p.name === "string" && p.name) ||
    (typeof p.place === "string" && p.place) ||
    (past ? "Burn scar" : "Active fire");
  return {
    id: typeof p.id === "string" ? p.id : "",
    label,
    kind: past ? "past" : "active",
    lon: e.lngLat.lng,
    lat: e.lngLat.lat,
    started: isoDay(start),
    before: isoDay(before),
    after: isoDay(after),
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Compare-mode banner: fire label, the two capture dates, source note, and an
 * exit control. Passing null clears it (mode off). */
function setCompareNotice(scar: Scar | null, cfg: ImageryConfig, onExit: () => void) {
  const el = document.getElementById("notice");
  if (!el) return;
  if (!scar) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  const src = cfg.hd ? "Sentinel-2 · 10 m" : "MODIS · 250 m, coarse (regional scars only)";
  // A burn scar only shows once the fire has burned for days and the sky has
  // cleared. When "after" is within a few days of ignition, say so plainly —
  // otherwise the two images look identical and the mode seems broken.
  const day = 86_400_000;
  const scarAgeDays = (Date.parse(scar.after) - Date.parse(scar.started)) / day;
  const tooRecent = scar.kind === "active" && scarAgeDays < 4;
  const hint = tooRecent
    ? `<span class="compare-hint">Fire too recent — scar not visible yet. ` +
      `Optical scars take days to appear.</span>`
    : "";
  el.innerHTML =
    `<div class="compare-banner">` +
    `<span class="compare-title">${escapeHtml(scar.label)}</span>` +
    `<span class="compare-dates">` +
    `<b>Before</b> pre-fire · ${scar.before}<br>` +
    `<b>After</b> ${scar.kind === "past" ? "settled scar" : "latest"} · ${scar.after}` +
    `</span>` +
    hint +
    `<span class="compare-src">${src}</span>` +
    `<button class="compare-exit" type="button">&times; Exit compare</button>` +
    `</div>`;
  el.style.display = "block";
  el.querySelector(".compare-exit")?.addEventListener("click", onExit);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

boot();
