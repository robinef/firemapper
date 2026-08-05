import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  loadDaySlice,
  loadEvents,
  loadFrp,
  loadIsochrones,
  loadManifest,
  loadWind,
} from "./data";
import { badgeText } from "./freshness";
import { areaText } from "./area";
import { escapeHtml } from "./escape";
import { createMap } from "./map";
import {
  CLOSED_LAYER_IDS,
  CLOSED_LEGEND,
  FIRE_HUE,
  addActiveFires,
  addClosedFires,
  fireHaloIds,
  fireLayerIds,
  setShowAllSizes,
} from "./layer_fires";
import { dispatchMapClick } from "./main_click";
import { INTENSITY_LAYER_IDS, INTENSITY_LEGEND, addIntensity } from "./layer_intensity";
import { SPREAD_LAYER_IDS, SPREAD_LEGEND, addSpread } from "./layer_spread";
import { WIND_LAYER_IDS, WIND_LEGEND, addWind } from "./layer_wind";
import { VIIRS_LAYER_IDS, VIIRS_LEGEND, addViirs } from "./layer_viirs";
import { SCAR_LAYER_IDS, SCAR_LEGEND, addScars } from "./layer_scars";
import {
  DAY_SLICE_LAYER,
  addDaySlice,
  firesInCell,
  hideDaySlice,
  setDaySlice,
} from "./layer_dayslice";
import { createDaySliceSelector } from "./day_slice_select";
import { lockMap, unlockMap, type HandlerState } from "./compare_lock";
import {
  ImagerySwipe,
  pickCapture,
  rasterFit,
  scarFromClick,
  scarTiles,
  shiftAfter,
  type Capture,
  type FeatureSnapshot,
  type ImageryConfig,
  type Scar,
} from "./layer_imagery";
import { mountSwitcher, type LayerModule } from "./registry";
import { createNav } from "./nav";
import { createShell } from "./shell";
import { infoHtml } from "./info";
import { countFires, countLabel } from "./fire_count";
import { mountPanel } from "./panel";
import { mountTimeline } from "./timeline";
import { setupFireCard } from "./firecard";
import { buildFireIndex, renderFireList, searchFires } from "./firelist";
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
  // Announce the close so the shell can pop whatever entry the panel pushed.
  // mountPanel shows search results and the cell picker (the fire card
  // bypasses it entirely); the cell picker does emit detail:open, so without
  // this the back bar keeps offering a way out of a panel that is already
  // gone. The aircraft panel used to be the other caller, until that layer
  // was retired.
  const panel = mountPanel("panel", () => emitUi("detail:close"));

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
    addClosedFires(map);
    if (frp) addIntensity(map, frp);
    if (frp) addSpread(map, frp);
    const wind =
      manifest.wind_points != null ? await loadWind(manifest, BASE).catch(() => null) : null;
    if (wind) addWind(map, wind);
    addViirs(map, manifest.generated_at.slice(0, 10));
    if (manifest.imagery?.scars?.length) addScars(map, manifest.imagery.scars);

    // Mirrors the size filter below, so the counter describes the map as it
    // actually is rather than as the default gates would have it.
    let showAllSizes = false;
    const modules: LayerModule[] = [
      {
        key: "fires",
        freshnessKeys: ["events"],
        levels: [1, 2] as (1|2)[],
        label: "Active fires",
        question: "Where is fire burning now, and how big?",
        layerIds: [
          ...fireHaloIds, ...fireLayerIds, "fire-footprint-fill", "fire-footprint-line", "fire-labels",
        ],
        defaultOn: true,
        // A ticked layer drawing nothing reads as broken. It is usually just
        // zoom: 1335 of 1344 live fires are `minor`, gated to z8.5. Say so.
        status: () => {
          const b = map.getBounds();
          return countLabel(countFires(
            events.features,
            { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
            map.getZoom(),
            showAllSizes,
          ));
        },
        filter: {
          label: "Show every size (slower, busier)",
          defaultOn: false,
          onChange: (on) => {
            showAllSizes = on;
            setShowAllSizes(map, on);
          },
        },
        legend: {
          title: "Active fires",
          entries: [
            { color: FIRE_HUE, size: 8, shape: "dot", label: "smaller burned area" },
            { color: FIRE_HUE, size: 16, shape: "dot", label: "larger burned area" },
            { color: "rgba(255,90,31,0.4)", size: 14, shape: "dot", label: "quiet — no new detection 24–48 h" },
          ],
          note:
            "One colour = fire. Bigger dot = more area burned; faded = gone quiet. " +
            "Sizes follow the NWCG fire size classes (F \u2265 1000 acres shows from " +
            "zoom 6, G \u2265 5000 from zoom 3, smaller from zoom 8.5). Zoom in for the outline.",
        },
      },
      {
        key: "closed",
        freshnessKeys: ["events"],
        levels: [1, 2] as (1|2)[],
        label: "Burned out (recent)",
        question: "Which fires have stopped, and what did they leave?",
        layerIds: CLOSED_LAYER_IDS,
        defaultOn: false,
        legend: CLOSED_LEGEND,
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
    // Search is the only route into a card that survives the rolling windows:
    // a dot vanishes 48 h after the last detection, the scar list is capped,
    // and the whole event window is 14 days. Built from the events already
    // loaded, so it costs no extra request and covers closed fires too.
    const fireIndex = buildFireIndex(events);
    const openFromList = (id: string) => {
      const entry = fireIndex.find((e) => e.id === id);
      const feature = events.features.find(
        (f) => (f.properties as { id?: string })?.id === id,
      );
      if (!entry || !feature) return;
      map.flyTo({ center: [entry.lon, entry.lat], zoom: 9 });
      fireCard.openFire({
        features: [feature],
        lngLat: { lng: entry.lon, lat: entry.lat },
      } as unknown as maplibregl.MapLayerMouseEvent);
    };
    let lastQuery = "";
    const showFireList = (query: string) => {
      lastQuery = query;
      panel.showHtml(renderFireList(searchFires(fireIndex, query), query, fireIndex.length));
      const box = document.querySelector<HTMLInputElement>(".fl-search");
      // Re-render on every keystroke, then restore focus and caret: innerHTML
      // replaces the input node, so without this the box loses focus after one
      // character and the reader can only ever type one letter.
      box?.addEventListener("input", () => showFireList(box.value));
      if (box && query) {
        box.focus();
        box.setSelectionRange(query.length, query.length);
      }
      for (const row of document.querySelectorAll<HTMLButtonElement>(".fl-row")) {
        row.addEventListener("click", () => openFromList(row.dataset.id ?? ""));
      }
    };
    const nav = createNav();
    const shell = createShell({
      nav,
      map,
      showFireList,
      lastQuery: () => lastQuery,
      infoContent: () => infoHtml(manifest),
    });
    // The count is camera-dependent, so it has to follow the camera — a
    // stale "1 of 54" after panning is a different lie from the one this
    // replaced. moveend rather than move: once per gesture, not per frame.
    map.on("moveend", () => switcher.refresh());
    // Overview histogram: clicking a day paints that day's detections across
    // Europe (a continental time-scrubber). Clicking the shown day again clears.
    const dayDates = new Set(manifest.day_slice_dates ?? []);
    const daySlice = createDaySliceSelector(
      dayDates,
      (date) => loadDaySlice(manifest, date),
      (cells) => setDaySlice(map, cells),
      () => hideDaySlice(map),
    );
    const timelineEl = document.getElementById("timeline")!;
    const mountOverviewTimeline = () =>
      mountTimeline(timelineEl, manifest.timeline, { onSelect: daySlice.onSelect });
    mountOverviewTimeline();
    // Level 2: clicking any fire zone (active dot, footprint, or past-scar
    // marker) opens that fire's card — map flies in, others dim, stats on the
    // right, the fire's own histogram on the bottom. Before/after is a button
    // inside the card, driven by the compare mode built here.
    const compare = setupCompareMode(map, manifest);
    const fireCard = setupFireCard(
      map, manifest, compare, timelineEl, switcher, mountOverviewTimeline,
      // Not just a hide: a day-slice fetch from before the card opened can
      // still be in flight (the scrubber issues one per bin crossed), and
      // without disarming its token here it would land later and repaint the
      // overview slice on top of the fire card that just opened.
      () => daySlice.invalidate(),
    );
    // Nav → views. Everything else in this file talks to nav, never the other
    // way round; these two lines are the only inbound direction.
    nav.onExit("detail", () => fireCard.close());
    if (compare) nav.onExit("compare", () => compare.exit());
    // Precedence, highest first. Halos come before their visible layer so the
    // larger target wins, and fires beat scars where they overlap. A single
    // map-level click handler (instead of one per layer) is what makes "one
    // tap, one open" possible: MapLibre invokes a layer-scoped handler once per
    // matching layer, so a dot sitting under its own halo used to fire twice —
    // harmless for an idempotent panel, but for fires it meant two
    // concurrent `loadTrack` requests racing to render the card.
    const CLICK_ORDER = [
      ...fireHaloIds, ...fireLayerIds, "fire-footprint-fill",
      ...CLOSED_LAYER_IDS, ...SCAR_LAYER_IDS,
      // Last: the slice blankets whole regions, so any dot drawn over it must
      // win the hit test. It is the fallback for "there is no dot here".
      DAY_SLICE_LAYER,
    ];
    const HANDLERS: Record<string, (e: maplibregl.MapLayerMouseEvent) => void> = {};
    for (const id of [
      ...fireHaloIds, ...fireLayerIds, "fire-footprint-fill", ...CLOSED_LAYER_IDS,
    ]) {
      HANDLERS[id] = fireCard.openFire;
    }
    for (const id of SCAR_LAYER_IDS) HANDLERS[id] = fireCard.openScar;

    // Scrub to a day, click where the fire was. This was the obvious route to a
    // fire that has stopped burning, and it did nothing: the layer had no
    // handler, and its cells carried only a count. Resolve the clicked hex
    // against the loaded events instead — which makes closed fires work too.
    HANDLERS[DAY_SLICE_LAYER] = (ev) => {
      const cell = ev.features?.[0]?.properties?.cell;
      if (typeof cell !== "string") return;
      const hits = firesInCell(events.features, cell);
      if (hits.length === 1) {
        fireCard.openFire({
          features: hits,
          lngLat: ev.lngLat,
          point: ev.point,
        } as unknown as maplibregl.MapLayerMouseEvent);
        return;
      }
      panel.showHtml(renderCellPicker(hits, ev.lngLat));
      // Both the multi-fire picker and the "no fire records here" message are
      // #panel views like any other; without announcing, they were the one
      // remaining route to an open panel with no history entry and no way back.
      emitUi("detail:open");
      if (hits.length > 1) {
        for (const b of document.querySelectorAll<HTMLButtonElement>(".cell-pick")) {
          b.addEventListener("click", () => {
            const hit = hits.find((f) => String(f.properties?.id) === b.dataset.id);
            if (!hit) return;
            fireCard.openFire({
              features: [hit],
              lngLat: ev.lngLat,
              point: ev.point,
            } as unknown as maplibregl.MapLayerMouseEvent);
          });
        }
      }
    };

    map.on("click", (e) => {
      const layers = CLICK_ORDER.filter((id) => map.getLayer(id));
      const features = map.queryRenderedFeatures(e.point, { layers });
      const id = dispatchMapClick(features as never, CLICK_ORDER);
      if (!id) {
        // Tapping the map away from any fire or scar is how a phone user
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
        if (fireCard.isOpen) nav.back();
        return;
      }
      // Not `{ ...e }`: MapMouseEvent's preventDefault()/defaultPrevented live
      // on its class prototype (and behind a private field), so spreading the
      // instance silently drops them and leaves a plain object that only
      // looks like the real event. openFire and openScar
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
    // The fire-halo-* layers are fully transparent — a pointer over
    // apparently-empty map would be a false affordance — so they are
    // deliberately left out here even though each is a valid click target.
    for (const id of [
      ...fireLayerIds, "fire-footprint-fill", ...SCAR_LAYER_IDS,
    ]) {
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    }

    // Boot done + layers mounted → drop the cold-start splash and let the rail
    // be used; ⚙ before this point would open an unmounted registry.
    shell.ready();
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
  fromFire: (snap: FeatureSnapshot) => void;
  /** Enter from a past-scar marker click — uses the scar's stored dates. */
  fromScar: (snap: FeatureSnapshot) => void;
  /** Leave compare mode (destroy the swipe, clear the banner). */
  exit: () => void;
}

// Exported (only) so the ui_events wiring test can drive the real enter/exit
// logic instead of duplicating it — boot() still wires it up the same way.
export function setupCompareMode(map: maplibregl.Map, manifest: Manifest): CompareMode | null {
  const cfg = manifest.imagery;
  if (!cfg) return null;
  const fit = rasterFit(cfg);
  let swipe: ImagerySwipe | null = null;
  // Captured on enter so exit restores exactly what was there before compare
  // mode touched it, not both handlers unconditionally on (see compare_lock.ts).
  let locked: HandlerState | null = null;
  let current: Scar | null = null;
  // What pickCapture settled on for each half — the banner names the sensor it
  // actually mounted, and a re-tile keeps the other half's choice.
  let picked: { before?: Capture; after?: Capture } = {};
  // Entering is async (it probes tiles first). A second click must not let a
  // stale probe mount its swipe over the newer one.
  let entry = 0;
  // Tracks compare:enter/compare:exit balance. NOT `swipe != null`: entering
  // now awaits tile probes, so an exit during that window would otherwise skip
  // compare:exit and strand a compare entry on the nav stack for good.
  let comparing = false;

  // Every data overlay is hidden while comparing, so nothing (H3 footprint
  // hexes, heat, hexbins, markers) sits on top of the before/after imagery.
  const OVERLAY_LAYERS = [
    ...fireHaloIds, ...fireLayerIds, "fire-footprint-fill", "fire-footprint-line", "fire-labels",
    "fire-bin-fill", "fire-bin-line", "day-slice-fill", "day-slice-line",
    ...INTENSITY_LAYER_IDS, ...SPREAD_LAYER_IDS, ...WIND_LAYER_IDS,
    ...VIIRS_LAYER_IDS, ...SCAR_LAYER_IDS,
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
    const wasComparing = comparing; // fire-card close also calls exit() unconditionally
    comparing = false;
    entry++; // invalidate any probe still in flight
    swipe?.destroy();
    swipe = null;
    current = null;
    restoreOverlays();
    // Restore whatever dragPan/dragRotate were before enter() locked them —
    // not an unconditional enable, so a future mode that legitimately turns
    // rotation off survives a compare round-trip.
    if (locked) unlockMap(map, locked);
    locked = null;
    setCompareNotice(null, cfg, step, picked);
    if (wasComparing) emitUi("compare:exit");
  };

  // Keyless GIBS hands back one exact day's swath, clouds included. Stepping
  // the after date re-tiles only the right half; the camera and the pre-fire
  // baseline stay put, so the comparison survives the search for a clear pass.
  const step = async (days: number) => {
    if (!swipe || !current) return;
    const moved = shiftAfter(current, days);
    if (moved.after === current.after) return; // already at a clamp
    // Keep walking the same way past any day GIBS does not hold, so one click
    // never lands the reader on a blank half.
    let landed = moved;
    if (!cfg.hd) {
      const c = await pickCapture(
        moved.after, moved.lon, moved.lat, fit.maxzoom, cfg.gibs_layer, days < 0 ? -1 : 1,
      );
      if (!swipe || !current) return; // exited while probing
      picked = { ...picked, after: c };
      landed = shiftAfter(current, dayDelta(current.after, c.date));
    }
    if (landed.after === current.after) return;
    current = landed;
    swipe.setAfterTiles(scarTiles(cfg, landed, picked).after);
    setCompareNotice(landed, cfg, step, picked);
  };

  // GIBS 404s a day it does not hold, and MODIS Terra drops whole days now and
  // then — the layer's own capabilities list the gaps. MapLibre drops a 404
  // raster tile without firing `error`, so an unlucky baseline date renders as
  // an empty half with nothing to explain it. Probing each half over the scar
  // before mounting settles that, the off-nadir smear, and the cloud in one
  // pass. The HD tier searches a window server-side, so it needs none of it.
  const settle = async (scar: Scar): Promise<Scar> => {
    if (cfg.hd) return scar;
    const [b, a] = await Promise.all([
      pickCapture(scar.before, scar.lon, scar.lat, fit.maxzoom, cfg.gibs_layer, -1),
      pickCapture(scar.after, scar.lon, scar.lat, fit.maxzoom, cfg.gibs_layer, -1),
    ]);
    picked = { before: b, after: a };
    // Never let the after image slide back past ignition — a pre-fire frame on
    // both halves reads as "the fire did nothing".
    return { ...scar, before: b.date, after: a.date < scar.started ? scar.after : a.date };
  };
  const enter = async (scar: Scar) => {
    const mine = ++entry;
    swipe?.destroy();
    swipe = null;
    // Announced on intent, not on arrival: probing the tiles takes seconds, and
    // the chrome must switch to compare the moment the reader asks for it.
    comparing = true;
    emitUi("compare:enter");
    // Guard against re-entry (switching scars while already comparing):
    // lockMap() again would capture the already-disabled state and corrupt
    // what exit() restores to, so only capture it the first time in.
    //
    // Only lock on touch: ImagerySwipe appends its divider to
    // main.getContainer() (layer_imagery.ts:163) while MapLibre's drag
    // handlers bind to getCanvasContainer() — a sibling subtree — so a
    // mouse-drag on the divider never reaches MapLibre's pan handler in the
    // first place. On a touchscreen a finger that misses the narrow grab
    // zone WOULD land on the map underneath and pan mid-comparison, so the
    // lock still earns its keep there. Gating on `(pointer: coarse)` rather
    // than a width breakpoint follows the actual ambiguity (touch vs mouse
    // drag), not the viewport width the mobile layout happens to switch at.
    if (!locked && window.matchMedia?.("(pointer: coarse)").matches) locked = lockMap(map);
    hideOverlays();
    // Never past the deepest tile the source has: over-zooming a 250 m MODIS
    // pixel does not add detail, it just smears it.
    map.flyTo({ center: [scar.lon, scar.lat], zoom: fit.zoom });
    const settled = await settle(scar);
    if (mine !== entry) return; // a newer click won while we were probing
    const t = scarTiles(cfg, settled, picked);
    current = settled;
    swipe = new ImagerySwipe(map, t.before, t.after, fit);
    setCompareNotice(settled, cfg, step, picked);
  };

  return {
    fromFire: (snap) => void enter(scarFromClick(snap)),
    fromScar: (snap) => {
      const s = scarFromProps(snap.props);
      if (s) void enter(s);
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


/** Panel shown when a slice hex resolves to something other than one fire.
 *
 * Zero is a legitimate outcome, not a failure: slices reach back 30 days but
 * clustering keeps 14 (events.py WINDOW_DAYS), so an older day genuinely has no
 * fire record left to open. Saying that plainly beats a click that appears to
 * do nothing — which is what this whole layer used to do. */
function renderCellPicker(
  hits: GeoJSON.Feature[],
  at: { lng: number; lat: number },
): string {
  const where = `${at.lat.toFixed(2)}, ${at.lng.toFixed(2)}`;
  if (!hits.length) {
    return (
      `<button class="panel-close" aria-label="Close">&times;</button>` +
      `<div class="fc-title">No fire records here</div>` +
      `<div class="fc-sub">${escapeHtml(where)}</div>` +
      `<p class="legend-note">Detections were recorded in this area on the day ` +
      `you picked, but the fires themselves have aged out of the 14-day event ` +
      `window, so there is no card left to open.</p>`
    );
  }
  const rows = hits
    .map((f) => {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      // GeoJSON stringifies nested props, so `place` arrives as JSON text — and
      // a bad value here must not throw inside a click handler and swallow the
      // interaction entirely.
      let place: string | null = null;
      if (typeof p.place === "string") {
        try {
          place = (JSON.parse(p.place) as { name?: string })?.name ?? null;
        } catch {
          place = null;
        }
      }
      const name = place || (typeof p.id === "string" ? `Fire ${p.id.slice(0, 6)}` : "Fire");
      const started = typeof p.started === "string" ? p.started.slice(0, 10) : "";
      return (
        `<button class="cell-pick" data-id="${escapeHtml(String(p.id ?? ""))}">` +
        `<b>${escapeHtml(String(name))}</b>` +
        `<span>${escapeHtml(areaText(Number(p.area_km2 ?? 0), typeof p.cum_cells === "number" ? p.cum_cells : null))} · ${escapeHtml(started)} · ` +
        `${escapeHtml(String(p.status ?? ""))}</span></button>`
      );
    })
    .join("");
  return (
    `<button class="panel-close" aria-label="Close">&times;</button>` +
    `<div class="fc-title">${hits.length} fires here</div>` +
    `<div class="fc-sub">${escapeHtml(where)} · biggest first</div>` +
    `<div class="cell-picks">${rows}</div>`
  );
}


/** How to state a capture date, which the two tiers know with different
 * precision.
 *
 * MODIS is a daily global mosaic, so the date shown is the date rendered.
 * Sentinel-2 revisits every ~2-3 days, so the HD tier hands Sentinel Hub a
 * multi-day TIME range and lets it pick the clearest pass inside it — meaning
 * the image can be from any day in that range, not the one named. Printing a
 * bare date there claims a precision we do not have, so say "around".
 */
function captureDate(iso: string, cfg: ImageryConfig): string {
  return cfg.hd ? `around ${iso}` : iso;
}

/** Whole days from ISO day `a` to ISO day `b` (negative when b is earlier). */
function dayDelta(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Compare-mode banner: fire label, the two capture dates, source note, and an
 * exit control. Passing null clears it (mode off). */
function setCompareNotice(
  scar: Scar | null,
  cfg: ImageryConfig,
  onStep: (days: number) => void | Promise<void>,
  picked?: { before?: Capture; after?: Capture },
) {
  const el = document.getElementById("notice");
  if (!el) return;
  if (!scar) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  // Name the sensor actually mounted: Terra and Aqua trade places depending on
  // which crossed nearer nadir, and a caption that lies about the source is
  // worse than no caption.
  const sensor = /Aqua/.test(picked?.after?.layer ?? "") ? "MODIS Aqua" : "MODIS Terra";
  const src = cfg.hd
    ? "Sentinel-2 · 10 m"
    : `${sensor} · 250 m, coarse (regional scars only)`;
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
    `<b>Before</b> pre-fire · ${captureDate(scar.before, cfg)}<br>` +
    `<b>After</b> ${scar.kind === "past" ? "settled scar" : "latest"} · ` +
    `${captureDate(scar.after, cfg)}` +
    `<span class="compare-step">` +
    `<button class="compare-day" type="button" data-days="-1" ` +
    `title="Previous capture day">&#9664;</button>` +
    `<button class="compare-day" type="button" data-days="1" ` +
    `title="Next capture day">&#9654;</button>` +
    `</span>` +
    `</span>` +
    hint +
    // Clouds are the norm, not a fault: say so once rather than letting a white
    // frame read as a broken image.
    `<span class="compare-hint">Cloudy? Step the after day.</span>` +
    `<span class="compare-src">${src}</span>` +
    `</div>`;
  el.style.display = "block";
  for (const b of el.querySelectorAll<HTMLButtonElement>(".compare-day")) {
    b.addEventListener("click", () => void onStep(Number(b.dataset.days)));
  }
}

boot();
