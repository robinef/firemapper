import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  loadDaySlice,
  loadEvents,
  loadFiresSummary,
  loadFrp,
  loadIsochrones,
  loadManifest,
  loadSeason,
  loadSeasonSizes,
  loadWind,
} from "./data";
import { badgeText } from "./freshness";
import { areaText, numOr } from "./area";
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
import { FIRE_WIND_LAYER_IDS, WIND_LAYER_IDS, WIND_LEGEND, addWind } from "./layer_wind";
import { VIIRS_LAYER_IDS, VIIRS_LEGEND, addViirs } from "./layer_viirs";
import { SCAR_LAYER_IDS, SCAR_LEGEND, addScars } from "./layer_scars";
import {
  DAY_SLICE_LAYER,
  addDaySlice,
  firesInCell,
  hideDaySlice,
  setDaySlice,
} from "./layer_dayslice";
import {
  SEASON_LAYER_IDS,
  addSeason,
  createSeasonCellsLoader,
  seasonLegend,
  seasonStatus,
  setCellsThreshold,
  setSeasonAggregate,
} from "./layer_season";
import { createSeasonFilter, isEuFire, sidecarCountries, type SeasonScope } from "./season_filter";
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
import { activateScaleBlob, deactivateScaleBlob, isScaleBlobActive } from "./layer_scale_blob";
import { hideScaleBlobPanel, showScaleBlobPanel } from "./scale_blob_panel";
import { createNav } from "./nav";
import { createShell } from "./shell";
import { infoHtml } from "./info";
import { countFires, countLabel } from "./fire_count";
import { mountPanel } from "./panel";
import { mountTimeline } from "./timeline";
import { setupFireCard } from "./firecard";
import { buildFireIndex, renderFireList, searchFires } from "./firelist";
import { emitUi, onUi } from "./ui_events";
import {
  renderHistoricalLookupForm, renderAmbiguousResult, renderNoDataResult,
  runHistoricalLookup, wireGeocodeSearch,
} from "./historical_lookup_ui";
import type { FiresSummary, Manifest } from "./types";

const BASE = "/data";

// The wind grid is a coarse ~0.5deg mesh (~200 points, whole globe): at level
// 2's tight per-fire zoom the nearest sample is very often off-screen even
// when it's within the readout's 60km threshold, so the toggle looks broken
// with nothing to click to fix it. ?wind=1 unlocks the toggle at level 1
// (overview) too, pre-checked, and enough map is in view there for multiple
// grid points to actually render -- a debug/QA affordance, not a default
// behaviour change.
const params = new URLSearchParams(location.search);
// ?layers=intensity,spread,viirs,closed,wind pre-checks those modules' toggles
// on boot, e.g. so a QA link opens already showing the thing under test
// instead of landing on a blank map that needs manual clicking to prove it
// works. Keys match each module's `key` below.
const FORCE_LAYERS = new Set((params.get("layers") ?? "").split(",").filter(Boolean));
const FORCE_WIND = FORCE_LAYERS.has("wind") || params.get("wind") === "1";
// Opens a specific fire's card on boot, e.g. to link straight to one with a
// wind sample close enough to actually render (see openFromList below).
const FORCE_FIRE = params.get("fire");

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

    // Started here, awaited just before addSeason: draw order forces the season
    // layers to be added before the day slice and the fires, but nothing forces
    // its *fetch* to be serial, and awaiting it in place delayed the first fire
    // paint by a whole round-trip (a 404 on every boot while no season file is
    // published). loadSeason resolves null on any failure, so this promise can
    // never reject while it sits unawaited.
    const seasonYear = Number(manifest.generated_at.slice(0, 4));
    const seasonP = loadSeason(seasonYear, BASE);
    // The size filter's input (~300 KB): histogram, counts and EU-27 scope,
    // with no cells file. Started beside the summary for the same reason and
    // equally unable to reject (null on any failure → the old cells-file path).
    const sizesP = loadSeasonSizes(seasonYear, BASE);

    const frp =
      manifest.frp_points != null
        ? await loadFrp(manifest, BASE).catch(() => null)
        : null;

    // Season (whole-year burned cells) sits under everything: the day slice
    // paints on top of it when a histogram day is clicked, live fires on top
    // of that. Null when the pipeline has not published a season file yet.
    const season = await seasonP;
    if (season) addSeason(map, season);
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
    // Assigned right after mountSwitcher (it needs switcher.isOn); the
    // module's onToggle closes over the variable, not the value.
    let seasonLoader: ReturnType<typeof createSeasonCellsLoader> | null = null;
    // Owns the size threshold and re-aggregation; assigned with the loader
    // below. The module's status/control close over the variable.
    let seasonFilter: ReturnType<typeof createSeasonFilter> | null = null;
    // Per-fire countries, null until the summary resolves (or forever, if the
    // file is missing). The loader's cellProps closes over the VARIABLE, so
    // cells installed before the file lands are re-tagged by retag() after.
    let countries: FiresSummary | null = null;
    // The scope of the totals the status line is currently showing — updated
    // with them, in onAggregate, so heading and numbers can never disagree.
    let seasonScope: SeasonScope = "all";
    // The one load of archive/blob_{year}_fires.json, started on first use.
    // With the sizes sidecar the season layer no longer needs it (the sidecar
    // carries each fire's country), so it is fetched only if the sidecar fails
    // or places no fire — or when the scale-comparison panel opens, which
    // shares this promise rather than downloading its own copy.
    let firesP: Promise<FiresSummary | null> | null = null;
    const firesSummary = (): Promise<FiresSummary | null> => (firesP ??= loadFiresSummary(seasonYear, BASE));
    // Where the filter's sizes come from, once sizesP settles: the sidecar, or
    // (it failed) the cells file, fetched on idle exactly as before it existed.
    let sizesFrom: "pending" | "sidecar" | "fallback" = "pending";
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
        defaultOn: FORCE_LAYERS.has("closed"),
        legend: CLOSED_LEGEND,
      },
      {
        key: "intensity",
        freshnessKeys: ["frp"],
        // Level 2 only. At overview zoom the only thing rendering is frp-heat,
        // a diffuse smear across a continent; the readout now carries this
        // fire's intensity at level 2, and the spatial view stays reachable
        // from the layer list there.
        levels: [2] as (1|2)[],
        label: "Fire intensity",
        question: "How violently is it burning right now?",
        layerIds: INTENSITY_LAYER_IDS,
        defaultOn: FORCE_LAYERS.has("intensity"),
        legend: INTENSITY_LEGEND,
        liveOnly: true,
      },
      {
        key: "spread",
        freshnessKeys: ["frp"],
        levels: [2] as (1|2)[],
        label: "Fire spread",
        question: "Which way is it moving, and how fast?",
        layerIds: SPREAD_LAYER_IDS,
        defaultOn: FORCE_LAYERS.has("spread"),
        legend: SPREAD_LEGEND,
        liveOnly: true,
      },
      {
        key: "wind",
        freshnessKeys: ["wind"],
        // Normally level 2 only (see FORCE_WIND above for why that's a poor
        // way to actually see the grid). ?wind=1 unlocks level 1 too, where
        // the sparse ~0.5deg mesh has room to show more than one arrow.
        levels: (FORCE_WIND ? [1, 2] : [2]) as (1|2)[],
        label: "Wind",
        question: "Which way is the wind pushing it?",
        // Both the coarse overview grid AND the per-fire arrows on a fire's
        // own H3 footprint (firecard.ts's addFireWind) — one checkbox, one
        // question, both answers. addFireWind still forces its layer visible
        // on every open (see its own comment); firecard.ts corrects that
        // against this same toggle right after calling it.
        layerIds: [...WIND_LAYER_IDS, ...FIRE_WIND_LAYER_IDS],
        defaultOn: FORCE_WIND,
        legend: WIND_LEGEND,
        liveOnly: true,
      },
      {
        key: "viirs",
        freshnessKeys: ["gibs_tiles"],
        levels: [2] as (1|2)[],
        label: "VIIRS detail",
        question: "Finest-resolution detection footprint (375 m)",
        layerIds: VIIRS_LAYER_IDS,
        defaultOn: FORCE_LAYERS.has("viirs"),
        legend: VIIRS_LEGEND,
        liveOnly: true,
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
      ...(season
        ? [{
            key: "season",
            levels: [1] as (1|2)[],
            label: "Burned this year",
            question: `Where did ${season.year} burn?`,
            layerIds: SEASON_LAYER_IDS,
            defaultOn: true,
            // Filtered totals once the reader has moved the slider; the
            // pipeline's totals until then — one number in the panel, never two.
            //
            // The scope comes from the aggregate those totals came from, not
            // from seasonFilter.scope(): between a scope click and the
            // debounced re-aggregation the control's scope has already moved
            // and `summary()` has not, and a panel rebuild in that window
            // (any moveend) would print an "EU-27 ·" heading over all-Europe
            // numbers — a pairing that was never true.
            //
            // The floor travels with them for the same reason: "since 13 Jul"
            // is a fact about the fires being counted, so a scope or a size
            // threshold that drops the earliest fire has to move the date. The
            // pipeline's floor stands only until the first aggregate lands —
            // before that there is no filtered selection to date.
            //
            // Before the first aggregate, a selection made from the sizes
            // sidecar alone (no cells yet) prints its own count and floor with
            // a pending km² — the pipeline's totals would describe fires the
            // reader has just filtered out.
            status: () => {
              const s = seasonFilter?.summary();
              if (s) return seasonStatus({ ...season, fires: s.fires, km2: s.km2, floor: s.floor }, seasonScope);
              const p = seasonFilter?.preview();
              if (p) return seasonStatus({ ...season, fires: p.fires, km2: null, floor: p.floor }, p.scope);
              return seasonStatus(season, seasonScope);
            },
            control: (el: HTMLElement) => seasonFilter?.control(el),
            legend: seasonLegend(season.floor, season.year),
            // `force` only on the fallback path: there the size histogram
            // needs the cells file at any zoom, and toggling the layer off
            // before the idle prefetch ran (ensure() returns early while it is
            // off) would strand the control on "loading sizes…" for good. With
            // the sidecar the histogram needs no cells, and an unforced
            // ensure() still covers toggling on past the prefetch zoom.
            onToggle: (on: boolean) => { if (on) void seasonLoader?.ensure({ force: sizesFrom === "fallback" }); },
          } as LayerModule]
        : []),
    ];
    const switcher = mountSwitcher(
      document.getElementById("layers")!,
      document.getElementById("legend")!,
      modules,
      map,
      manifest,
    );
    if (season) {
      seasonFilter = createSeasonFilter({
        onAggregate: (agg) => {
          seasonScope = agg.scope;
          setSeasonAggregate(map, agg.r6);
          setCellsThreshold(map, agg.threshold, agg.scope);
          // Status line only: a full refresh would rebuild the panel and hand
          // the reader a brand-new range input mid-interaction, dropping
          // keyboard focus to <body> and breaking a paused drag's pointer
          // capture. The filter repaints its own label after this returns.
          switcher.refreshStatus("season");
        },
        // A slider move or scope click. The hex rebuild needs the cells file,
        // so the first one fetches it wherever the camera is (ensure() is
        // idempotent after that); the status line shows the sidecar's count
        // and floor meanwhile.
        onSelect: () => {
          void seasonLoader?.ensure({ force: true });
          switcher.refreshStatus("season");
        },
      });
      // mountSwitcher renders once on the way in, while seasonFilter is still
      // null — the module's control() drew nothing into an empty box. Redraw
      // now that it exists, or the row stays blank until the cells land: on a
      // slow connection that is precisely when the "loading sizes…" state is
      // the only thing the reader has.
      switcher.refresh();
      seasonLoader = createSeasonCellsLoader(map, season.year, () => switcher.isOn("season"), fetch, {
        onLoaded: (cells, sizes) => { seasonFilter?.setCells(cells, sizes); switcher.refresh(); },
        onGaveUp: () => { seasonFilter?.setUnavailable(); switcher.refresh(); },
        // The EU-27 tag the cell filter reads on the GPU: the fire's own km²
        // when it burned in the EU, 0 when it did not. A size, not a flag —
        // cellFeatures maxes it across claimants, so a cell ends up carrying
        // the size of its LARGEST EU claimant, which is the number the
        // "EU-27, ≥ t km²" filter has to compare against for the cells to
        // match the hexes. Evaluated at install time and again on retag(), so
        // it always reflects the countries file as it is NOW.
        cellProps: (id, km2) => ({ eu_km2: isEuFire(countries, id) ? km2 : 0 }),
        // The sidecar's sizes, so a cells file landing after it costs no
        // fireSizes pass (~565 ms at 4× CPU throttle on the full season).
        knownSizes: () => seasonFilter?.knownSizes() ?? null,
      });
      void seasonLoader.ensure(); // a deep link may boot already past the prefetch zoom
      // Fallback only (no sizes sidecar): the size histogram then needs the
      // cells file wherever the camera is, so fetch it once the boot work has
      // drained — after first paint, never before it.
      // The timeout caps the wait: on a page that never goes idle the
      // histogram would otherwise never arrive.
      const idle: (fn: () => void) => void =
        typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback === "function"
          ? (fn) =>
              (window as unknown as {
                requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void;
              }).requestIdleCallback(fn, { timeout: 3000 })
          : (fn) => { setTimeout(fn, 1500); };
      // …but not on a connection the reader is rationing. Data-saver mode and
      // 2g are an explicit "spend nothing you don't have to", and the cells
      // file is megabytes for a histogram nobody asked for yet. Those readers
      // get the cells — and with them the size filter — on approach to z7.5,
      // exactly as they did before this feature existed. `connection` is not
      // in lib.dom (Network Information API, Chromium-only), hence the local
      // shape and the optional chaining.
      const conn = (navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }).connection;
      const constrained =
        conn?.saveData === true || conn?.effectiveType === "2g" || conn?.effectiveType === "slow-2g";
      // Per-fire countries from the scale blob's summary: the fallback's only
      // source, and the sidecar's backup when it places no fire at all. The
      // files race; whichever order they land in, the scope button enables
      // (setCountries repaints the live button itself, so no panel rebuild is
      // needed — and a rebuild here would steal focus) and the
      // already-installed cells, if any, get their tag.
      const countriesFromBlob = () => {
        void firesSummary().then((s) => {
          countries = s;
          seasonFilter?.setCountries(s);
          seasonLoader?.retag();
        });
      };
      void sizesP.then((sizes) => {
        if (sizes) {
          // Histogram, counts and EU-27 scope, ready now. The cells file now
          // loads only on approach to the prefetch zoom or on the first
          // slider/scope interaction (onSelect) — never on idle.
          sizesFrom = "sidecar";
          countries = sidecarCountries(sizes);
          seasonFilter?.setSizes(sizes);
          seasonLoader?.retag();
          if (!countries) countriesFromBlob();
          return;
        }
        // No sidecar: exactly the pre-sidecar boot.
        sizesFrom = "fallback";
        countriesFromBlob();
        if (!constrained) idle(() => { void seasonLoader?.ensure({ force: true }); });
      });
    }
    wireScaleBlobToggle(
      map,
      document.getElementById("scale-blob-toggle") as HTMLButtonElement,
      document.getElementById("scale-blob-breakdown") as HTMLElement,
      // A getter: the panel reads `promise` only when it opens, so the file is
      // fetched then (once, shared with the season layer's fallback), not at boot.
      season ? { year: seasonYear, get promise() { return firesSummary(); } } : undefined,
    );
    // Search is the only route into a card that survives the rolling windows:
    // a dot vanishes 48 h after the last detection, the scar list is capped,
    // and the whole event window is 14 days. Built from the events already
    // loaded, so it costs no extra request and covers closed fires too.
    const fireIndex = buildFireIndex(events);
    // Returns whether `id` matched a live/closed event, so FORCE_FIRE below
    // can fall back to the past-scar index on a miss.
    const openFromList = (id: string): boolean => {
      const entry = fireIndex.find((e) => e.id === id);
      const feature = events.features.find(
        (f) => (f.properties as { id?: string })?.id === id,
      );
      if (!entry || !feature) return false;
      // openFire's own open() only flies once its `await loadTrack(...)`
      // resolves — on a slow connection the camera would otherwise sit still
      // for the whole round trip, and not move at all if a second list click
      // supersedes this one first. Fly immediately, to the SAME zoom open()
      // uses, so its later flyTo to an identical target is a no-op rather
      // than a second visible hop.
      map.flyTo({ center: [entry.lon, entry.lat], zoom: 10.5 });
      fireCard.openFire({
        features: [feature],
        lngLat: { lng: entry.lon, lat: entry.lat },
      } as unknown as maplibregl.MapLayerMouseEvent);
      return true;
    };
    // Companion to openFromList, for a scar's share link: past scars never
    // enter `events`/fireIndex (they're pulled from manifest.imagery.scars,
    // rendered by addScars), so ?fire=<id> needs its own lookup here. Only
    // "past" scars are ever clickable/shareable — addScars filters the same
    // way when it builds the map layer these ids came from.
    const scarIndex = new Map(
      (manifest.imagery?.scars ?? [])
        .filter((s) => s.kind === "past")
        .map((s) => [s.id, s]),
    );
    const openScarFromList = (id: string): boolean => {
      const s = scarIndex.get(id);
      if (!s) return false;
      map.flyTo({ center: [s.lon, s.lat], zoom: 10.5 });
      fireCard.openScar({
        features: [{
          properties: { ...s },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        }],
        lngLat: { lng: s.lon, lat: s.lat },
      } as unknown as maplibregl.MapLayerMouseEvent);
      return true;
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
    // Where the historical-lookup form's location came from — a geocode
    // search result or a map click — and the currently-armed map-click
    // handler for that mode. `fireCard` (referenced inside
    // showHistoricalLookup, below) is assigned further down, the same
    // forward-reference pattern openFromList above already relies on for
    // fireCard.openFire: neither closure runs until the reader can actually
    // reach it (via the rail, after shell.ready()), by which point fireCard
    // is long since assigned.
    let pickedLocation: { lon: number; lat: number; place: string } | null = null;
    let historicalClickHandler: ((e: maplibregl.MapMouseEvent) => void) | null = null;
    const showHistoricalLookup = () => {
      pickedLocation = null;
      panel.showHtml(renderHistoricalLookupForm());
      // Deliberately NOT emitUi("detail:open") — openRail() (shell.ts) already
      // pushes the "historical" nav entry itself before/around calling this
      // function, exactly like rail-search's showFireList. Calling
      // detail:open here too, while nav.top is still the PREVIOUS view (this
      // runs before openRail's own push), made openDetail() push a second,
      // bogus "detail" entry underneath "historical" — every open cost two
      // stack levels instead of one, and the first Back press looked dead.

      // A prior lookup's map-click listener may still be bound if this view
      // is being re-entered without ever having been popped off the nav
      // stack (its entry's `restore` re-runs this function) — remove it
      // defensively before arming a new one, rather than relying solely on
      // nav.onExit("historical", ...) below, which only fires when this
      // entry is actually popped, not when it's merely covered and restored.
      if (historicalClickHandler) {
        map.off("click", historicalClickHandler);
        historicalClickHandler = null;
      }

      const container = document.getElementById("panel")!;
      const locationEl = document.getElementById("historical-lookup-location")!;

      wireGeocodeSearch(container, fetch, (lon, lat, place) => {
        pickedLocation = { lon, lat, place };
        locationEl.textContent = `Location: ${place}`;
      });

      // Map-click mode: only active while this view is the current one.
      // Deliberately the plain, layer-less map.on('click', ...) form (not
      // routed through HANDLERS/CLICK_ORDER above), since a historical
      // lookup can target anywhere, not just an existing fire feature.
      // Cleaned up by nav.onExit("historical", ...) below, and defensively
      // at the top of this function on re-entry (see above).
      historicalClickHandler = (e) => {
        pickedLocation = { lon: e.lngLat.lng, lat: e.lngLat.lat, place: "Picked on map" };
        locationEl.textContent = `Location: ${e.lngLat.lat.toFixed(2)}, ${e.lngLat.lng.toFixed(2)}`;
      };
      map.on("click", historicalClickHandler);

      const form = document.getElementById("historical-lookup-form") as HTMLFormElement;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!pickedLocation) {
          document.getElementById("historical-lookup-result")!.textContent = "Pick a location first.";
          return;
        }
        const before = (document.getElementById("historical-lookup-before") as HTMLInputElement).value;
        const after = (document.getElementById("historical-lookup-after") as HTMLInputElement).value;
        const resultEl = document.getElementById("historical-lookup-result")!;
        resultEl.textContent = "Looking up…";
        await runHistoricalLookup(pickedLocation.lon, pickedLocation.lat, pickedLocation.place, before, after, {
          fetchFn: fetch,
          // A successful lookup calls fireCard.openHistoricalLookup, which
          // overwrites #panel with the fire card and fires detail:open while
          // this "historical" entry is still nav's top — openDetail()
          // replace()s it (it's not "map"/"search"), which never fires
          // nav.onExit("historical", ...). Strip the listener here,
          // proactively, right before that happens — the only path that
          // leaves this view without popping it off the stack first.
          openHistoricalLookup: (track, meta) => {
            if (historicalClickHandler) {
              map.off("click", historicalClickHandler);
              historicalClickHandler = null;
            }
            return fireCard.openHistoricalLookup(track, meta);
          },
          onAmbiguous: (clusters) => { resultEl.innerHTML = renderAmbiguousResult(clusters); },
          onNoData: () => { resultEl.innerHTML = renderNoDataResult(); },
          onError: (message) => { resultEl.textContent = message; },
        });
      });
    };
    const nav = createNav();
    const shell = createShell({
      nav,
      showFireList,
      lastQuery: () => lastQuery,
      infoContent: () => infoHtml(manifest),
      showHistoricalLookup,
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
      // The same collection the wind LAYER draws from, loaded once above — the
      // card's reading and the streamlines on the map must come from one
      // sample set, or the overlay names a direction the map contradicts.
      // Null when the layer failed or the manifest carries no wind: the card
      // then reads exactly as a fire with no sample near it does.
      wind,
    );
    // Nav → views. Everything else in this file talks to nav, never the other
    // way round; these two lines are the only inbound direction.
    nav.onExit("detail", () => fireCard.close());
    if (compare) nav.onExit("compare", () => compare.exit());
    // Stop the plain map-click listener the moment the reader leaves this
    // view — without this, a click on the map after backing out of the form
    // would still silently update a `pickedLocation` nothing reads anymore.
    nav.onExit("historical", () => {
      if (historicalClickHandler) {
        map.off("click", historicalClickHandler);
        historicalClickHandler = null;
      }
    });
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
    // ?fire=<id> deep-links straight to that fire's card, same path as a
    // search-list click; a miss falls back to the past-scar index (a scar's
    // own share button copies the same param). Silently no-ops if neither
    // knows the id, same as openFromList already does for a stale search
    // result.
    if (FORCE_FIRE && !openFromList(FORCE_FIRE)) openScarFromList(FORCE_FIRE);
  });
}

/**
 * Wire the on-map scale-blob trigger.
 *
 * layer_scale_blob.ts is deliberately not a registry.ts LayerModule (see that
 * file's own header comment), so its trigger is wired here rather than joining
 * `modules` in boot(). activateScaleBlob resolves NORMALLY (without throwing)
 * on a 404 — no archive/blob_<year>.json for this year yet — so success is read
 * back from isScaleBlobActive() after the await, not assumed from the promise
 * settling; otherwise a missing archive would silently flip the button into a
 * bogus "active" state.
 *
 * Exported, and taking its two collaborators as arguments, so the compare-mode
 * rule below is testable: boot() needs a WebGL map, a manifest and a network,
 * and none of that can run under jsdom.
 *
 * `fires`: the per-fire country summary boot() shares with the season layer's
 * fallback EU-27 scope (loaded on first use by whichever needs it — `promise`
 * may be a getter, read only when the panel opens), so the breakdown panel
 * costs no second download of the same ~1.1 MB file. It carries the year it was loaded for and is used only
 * when that matches the blob's: the blob is always the CURRENT year's, the
 * season's year comes from the manifest, and across a new year those disagree
 * — last season's countries under this season's shape would be a wrong answer
 * rather than a slow one.
 */
export function wireScaleBlobToggle(
  map: maplibregl.Map,
  button: HTMLButtonElement,
  breakdown: HTMLElement,
  fires?: { year: number; promise: Promise<FiresSummary | null> },
): () => void {
  const reset = () => {
    button.setAttribute("aria-pressed", "false");
    button.textContent = "Compare fire scale";
    hideScaleBlobPanel(breakdown);
  };
  const onClick = () => void (async () => {
    if (isScaleBlobActive()) {
      deactivateScaleBlob(map);
      reset();
      return;
    }
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const year = new Date().getFullYear();
      await activateScaleBlob(map, year);
      if (isScaleBlobActive()) {
        button.setAttribute("aria-pressed", "true");
        button.textContent = "Exit fire-scale compare";
        // Best-effort: a failed/empty fetch here just leaves the breakdown
        // panel empty (showScaleBlobPanel is tolerant of that), it doesn't
        // affect whether the blob itself activated. Fire-and-forget, but
        // guarded: a slow fetch can still be in flight after the reader
        // deactivates (or compare:enter deactivates for them) — without the
        // isScaleBlobActive() recheck, this would resolve afterward and
        // silently repopulate the panel for a blob that is no longer shown.
        //
        // The .catch is not decoration: the enclosing try/catch is already
        // past by the time this settles, and the fallback path really can
        // REJECT (fetchFiresSummary does not swallow a network error, unlike
        // data.ts::loadFiresSummary). Unhandled, that is a console error on a
        // blob that activated perfectly well.
        void showScaleBlobPanel(
          breakdown,
          year,
          fetch,
          fires?.year === year ? fires.promise : undefined,
        )
          .then(() => {
            if (!isScaleBlobActive()) hideScaleBlobPanel(breakdown);
          })
          .catch(() => {});
      } else {
        button.textContent = "Compare fire scale (unavailable)";
      }
    } catch {
      button.textContent = "Compare fire scale (unavailable)";
    } finally {
      button.disabled = false;
    }
  })();
  button.addEventListener("click", onClick);

  // Entering compare mode must TURN THE BLOB OFF, not merely hide its button.
  // style.css drops #scale-blob-control under body.compare-mode because
  // dragging the shape fights the swipe divider for the same gesture — but CSS
  // reaches neither the fill layer, nor its GeoJSON source, nor the native
  // canvas pointer listeners layer_scale_blob.ts installs. Left active, the
  // shape kept painting over the two dated images, the drag kept working
  // against the divider, and the one control that could switch it off was now
  // invisible: unreachable until the reader left compare mode. The button's own
  // state is reset too, so it does not come back out of compare mode reading
  // "Exit fire-scale compare" over a shape that is gone.
  //
  // Subscribed here rather than in shell.ts's compare:enter handler (which is
  // where the body class is added): the shell is chrome + nav and holds no map
  // reference by design, and scrubber.ts already sets the precedent of a
  // non-shell module listening for this event to stop what it is doing.
  const offCompare = onUi("compare:enter", () => {
    deactivateScaleBlob(map);
    reset();
  });

  // Opening any fire's card (a fresh fire, a past scar, or a historical
  // lookup — open() in firecard.ts fires this event for all three) flies the
  // camera in to that one fire. The blob is a real geographic shape sized in
  // km2, not a screen-space overlay, so left active it keeps painting at its
  // fixed location — and grows to dominate the view — as the map zooms in
  // underneath it, exactly the same problem compare:enter already guards
  // against above.
  const offDetail = onUi("detail:open", () => {
    deactivateScaleBlob(map);
    reset();
  });

  return () => {
    button.removeEventListener("click", onClick);
    offCompare();
    offDetail();
  };
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
    ...INTENSITY_LAYER_IDS, ...SPREAD_LAYER_IDS, ...WIND_LAYER_IDS, ...FIRE_WIND_LAYER_IDS,
    ...VIIRS_LAYER_IDS, ...SCAR_LAYER_IDS, ...SEASON_LAYER_IDS,
  ];
  // Not Record<string, string>: maplibre 6 types `visibility` as a union, and
  // it was only ever these two values — the wider type just deferred the error.
  const overlayVis: Record<string, "visible" | "none"> = {};
  const hideOverlays = () => {
    for (const id of OVERLAY_LAYERS) {
      if (!map.getLayer(id)) continue;
      overlayVis[id] =
        (map.getLayoutProperty(id, "visibility") as "visible" | "none" | undefined) ?? "visible";
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
    // stepping=true: end the HD search window exactly at `landed.after`
    // rather than sliding it forward to today, or a recently-settled scar's
    // window never moves and every step re-queries the identical scene.
    swipe.setAfterTiles(scarTiles(cfg, landed, picked, undefined, true).after);
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
    area_km2: numOr(p.area_km2, 0),
    cum_cells: numOr(p.cum_cells, null),
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
        `<span>${escapeHtml(areaText(numOr(p.area_km2, 0), numOr(p.cum_cells, null)))} · ${escapeHtml(started)} · ` +
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
