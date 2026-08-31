import * as maplibregl from "maplibre-gl";
import { numOr } from "./area";

/**
 * Before/after Sentinel-2 true-colour swipe.
 *
 * Question answered: "How much did the fire destroy?" — green forest before,
 * black scar after. This is days-behind burn-scar imagery, NOT live fire, so it
 * is a focused compare mode: a draggable vertical divider with the pre-fire
 * image on the left and the latest clear image on the right.
 *
 * Implementation: the "before" image is a raster layer on the main map; the
 * "after" image lives on a second, non-interactive MapLibre map stacked on top
 * and synced to the main camera, whose container is clipped to the right of the
 * divider. Dragging the divider re-clips. Cheap, robust, no external library.
 */

export interface Scar {
  id: string;
  label: string;
  place?: string | null;
  kind: "active" | "past";
  lon: number;
  lat: number;
  started: string;
  before: string;
  after: string;
  /** Same method as a live fire's `area_km2` (see area.ts): dedup H3 cells ×
   * the sensor's per-cell size for a FIRMS-derived scar, or the mapped
   * polygon's real area for an EFFIS one. */
  area_km2: number;
  /** Deduped cell count, for areaText()'s "≤" unsized-footprint marker.
   * Absent for an EFFIS scar — a real polygon carries no such uncertainty. */
  cum_cells?: number | null;
  /** "archive" when this past scar has a permanent per-fire track (see
   * pipeline/archive_tracks.py) — loadTrack resolves that sentinel to the
   * fire's fixed, non-generation archive path. Absent/null for curated
   * megafires and EFFIS scars, which never ran through our H3 detection and
   * have no track to load. */
  track_gen?: string | null;
}

export interface ImageryConfig {
  source: "gibs";
  gibs_layer: string;
  hd: { wms_base: string; layer: string } | null;
  scars: Scar[];
}

/** NASA GIBS true-colour REST WMTS tiles for one date (keyless, global). */
export function gibsTiles(layer: string, date: string): string[] {
  return [
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}` +
      `/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
  ];
}

// GIBS's GoogleMapsCompatible_Level9 matrix set serves 256 px tiles at matrices
// 0..9 — z10 is an HTTP 400. Both numbers matter: declaring tileSize 512 makes
// MapLibre stretch the 256 px JPEG over a 512 px slot AND request one matrix
// coarser than the view needs, which is a 4x blur on top of MODIS's own 250 m.
export const GIBS_TILE_PX = 256;
export const GIBS_MAX_Z = 9;
// CDSE WMS is rendered to whatever size we ask for, and Sentinel-2 is 10 m.
const HD_TILE_PX = 512;
const HD_MAX_Z = 14;

/** How to mount a source and where to park the camera, per imagery tier. The
 * entry zoom never exceeds the deepest tile the source actually has, so the
 * compare mode opens on real pixels instead of an over-zoomed smear. */
export interface RasterFit {
  tileSize: number;
  maxzoom: number;
  zoom: number;
}

export function rasterFit(cfg: ImageryConfig): RasterFit {
  return cfg.hd
    ? { tileSize: HD_TILE_PX, maxzoom: HD_MAX_Z, zoom: 13 }
    : { tileSize: GIBS_TILE_PX, maxzoom: GIBS_MAX_Z, zoom: GIBS_MAX_Z };
}

/** Earlier of two ISO days (they sort lexicographically). */
function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

/** Shift an ISO day (YYYY-MM-DD) back by N days, staying in UTC. */
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** How many neighbouring days to weigh alongside the requested one. Every extra
 * day costs one small probe tile per sensor, and gaps plus cloud rarely run
 * longer than this. */
export const MAX_DAY_RETRIES = 3;

/** Per-day pull back toward the date actually asked for, so a marginally better
 * image several days off does not quietly replace the one that was requested. */
const RECENCY_DECAY = 0.9;

/** Slippy-map tile covering a lon/lat at zoom z (the GIBS Level9 matrix set is
 * the standard Google/OSM grid, so this indexes it directly). */
export function tileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** One concrete tile URL from a {z}/{y}/{x} template, over a given point. */
export function probeUrl(template: string, lon: number, lat: number, z: number): string {
  const { x, y } = tileXY(lon, lat, z);
  return template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/**
 * The keyless true-colour layers worth trying for one day. Both are MODIS
 * corrected reflectance at 250 m, but Terra crosses in the morning and Aqua in
 * the afternoon, so on any given day one of them is nearer nadir over a given
 * place — and MODIS pixels grow fast off-nadir (the bowtie effect), which is
 * the difference between a legible scar and a smear. Measured over Basilicata:
 * Aqua scored 28.4 vs Terra's 19.2 on 2026-07-30 and 32.4 vs 26.4 on 07-23.
 * Neither wins in general, so we measure per capture instead of guessing.
 */
export const GIBS_TRUE_COLOR_LAYERS = [
  "MODIS_Terra_CorrectedReflectance_TrueColor",
  "MODIS_Aqua_CorrectedReflectance_TrueColor",
];

/** A decoded probe tile, or null when the day/layer has no data. */
export type ProbeTile = { data: Uint8ClampedArray; width: number; height: number } | null;
export type TileProbe = (url: string) => Promise<ProbeTile>;

/** Pixels this bright in all three channels are cloud, not ground. Snow would
 * fool it, which for a summer burn-scar comparison is not a real case. */
const CLOUD_LEVEL = 155;

/**
 * How usable a capture is, in one number: ground detail discounted by how much
 * of the frame is cloud.
 *
 * Detail alone is mean absolute luma step between horizontal neighbours — a
 * crisp near-nadir pass has structure at pixel scale and scores high, a smeared
 * off-nadir pass scores low. But detail alone also rewards cloud, because cloud
 * edges are edges: over Basilicata on 2026-07-22, Aqua scored 6.24 on detail
 * while a quarter of the tile was overcast. Discounting by the cloud fraction
 * puts that behind the 5.09 of a clear Terra pass, which is the honest ranking.
 */
export function tileScore(t: NonNullable<ProbeTile>): number {
  const { data, width, height } = t;
  let detail = 0;
  let steps = 0;
  let cloudy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) > CLOUD_LEVEL) cloudy++;
      if (x === 0) continue;
      const p = i - 4;
      const a = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const b = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      detail += Math.abs(a - b);
      steps++;
    }
  }
  const px = width * height;
  return steps ? (detail / steps) * (1 - (px ? cloudy / px : 0)) : 0;
}

/** A probe that never settles would wedge compare mode open on a blank map,
 * since nothing mounts until the probes resolve. Any environment that does not
 * actually load images (jsdom, a hung connection) must therefore time out. */
const PROBE_TIMEOUT_MS = 8000;

/** Decode one tile in the browser so it can be scored. Returns null on any
 * failure (404, CORS, no DOM, no answer) — every caller treats that as "no
 * data" and falls back to mounting what it was asked for. */
export const domTileProbe: TileProbe = (url) =>
  new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    let done = false;
    const settle = (v: ProbeTile) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(null), PROBE_TIMEOUT_MS);
    const img = new Image();
    img.crossOrigin = "anonymous"; // GIBS sends Access-Control-Allow-Origin: *
    img.onerror = () => settle(null);
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return settle(null);
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        settle({ data: d.data, width: c.width, height: c.height });
      } catch {
        settle(null); // tainted canvas — treat as unusable rather than throw
      }
    };
    img.src = url;
  });

export interface Capture {
  date: string;
  layer: string;
}

/**
 * Choose what to actually mount for one half of the comparison.
 *
 * Three failures, one probe pass over the tile that actually covers the scar.
 *
 * GIBS 404s a day it does not hold — MODIS Terra drops whole days, and the
 * layer's own capabilities list the gaps — and MapLibre discards a 404 raster
 * tile WITHOUT firing `error`, so an unlucky date renders as an empty half with
 * nothing to explain it. A day that does exist may have been caught far
 * off-nadir and be too smeared to read. And it may simply be under cloud.
 *
 * So score every (day, sensor) in a small window around the requested date and
 * mount the best, pulled back toward the date asked for so a marginal gain
 * several days away does not silently win. Note this is NOT first-hit: a day
 * that answers but scores badly still loses to a better neighbour.
 *
 * Falls back to the requested date and `fallbackLayer` whenever nothing can be
 * probed (offline, blocked, no DOM), so this can only improve on mounting blind.
 */
export async function pickCapture(
  date: string,
  lon: number,
  lat: number,
  z: number,
  fallbackLayer: string,
  /** Which way the window extends. -1 (earlier) suits a baseline or a settled
   * scar; +1 suits stepping forward through cloud. */
  dir: 1 | -1 = -1,
  probe: TileProbe = domTileProbe,
  layers: string[] = GIBS_TRUE_COLOR_LAYERS,
): Promise<Capture> {
  const days = Array.from({ length: MAX_DAY_RETRIES + 1 }, (_, i) => i);
  const scored = await Promise.all(
    days.flatMap((i) =>
      layers.map(async (layer) => {
        const day = isoMinusDays(date, -dir * i);
        const t = await probe(probeUrl(gibsTiles(layer, day)[0], lon, lat, z));
        return t ? { date: day, layer, score: tileScore(t) * RECENCY_DECAY ** i } : null;
      }),
    ),
  );
  const best = scored
    .filter((s): s is { date: string; layer: string; score: number } => s !== null)
    .sort((a, b) => b.score - a.score)[0];
  return best ? { date: best.date, layer: best.layer } : { date, layer: fallbackLayer };
}

/**
 * Step the "after" capture by `days`, clamped to [fire start, today].
 *
 * The keyless GIBS tier has no cloud filter: it hands back that exact day's
 * swath, clouds and all, and over Atlantic Europe roughly half of them are
 * overcast. Rather than pretend otherwise, the compare banner lets the reader
 * walk day by day until a clear pass shows up. (The HD tier searches a window
 * server-side, so there stepping just re-centres that window.)
 */
export function shiftAfter(scar: Scar, days: number, today?: string): Scar {
  const cap = today ?? new Date().toISOString().slice(0, 10);
  const next = isoMinusDays(scar.after, -days);
  if (next < scar.started || next > cap) return scar;
  return { ...scar, after: next };
}

/** Build a scar (location + before/after dates) from a clicked fire feature.
 * Uses the click point, so it works whether a proportional dot or the footprint
 * polygon was hit, and falls back to sensible active-fire dates when a footprint
 * feature carries no lifecycle props. */
export function scarFromClick(snap: FeatureSnapshot): Scar {
  const p = snap.props;
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
    lon: snap.lon,
    lat: snap.lat,
    started: isoDay(start),
    before: isoDay(before),
    after: isoDay(after),
    // Same live-fire feature properties fireCardHtml already reads area from.
    area_km2: numOr(p.area_km2, 0),
    cum_cells: numOr(p.cum_cells, null),
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface TileOpts {
  /** How many days back the search window spans (Sentinel-2 revisits Europe
   * every ~2–3 days, so ~12 days almost always holds a usable pass). */
  windowDays?: number;
  /** "leastCC" = clearest scene in the window (best for a settled scar or a
   * pre-fire baseline). "mostRecent" = newest scene under MAXCC (best for an
   * active fire's current state — smoke/fresh burn, not an old clear frame). */
  priority?: "leastCC" | "mostRecent";
  /** Max scene cloud cover %. mostRecent needs a looser cap or it falls back to
   * an old clear scene; leastCC can stay tight. */
  maxcc?: number;
  /** Let the window end LATER than `date` (up to `windowDays` ahead, capped at
   * today) instead of ending exactly at it, and never start before `notBefore`.
   *
   * Both bounds earn their place. A settled-scar date is "ignition +
   * SCAR_SETTLE_DAYS", so a plain backward window spans ignition+2 ..
   * ignition+14 and leastCC could return an image from two days after ignition
   * — still burning — while the caption claimed the later date.
   *
   * But forward alone is worse: for a fire whose settle date is already capped
   * at yesterday there is no room ahead, and a 1-2 day window frequently holds
   * no Sentinel-2 pass at all. Measured over Gujan-Mestras, TIME=2026-08-03/04
   * returned a black 8 KB tile (mean luma 1.0) — a blank compare half, which
   * MapLibre reports as success. So when forward has no room we search back
   * instead, clamped at `notBefore` (ignition), which cannot show a pre-fire
   * scene in the "after" slot even if it may catch the fire still burning. */
  extend?: boolean;
  notBefore?: string;
  /** Injectable for tests; defaults to the real clock. */
  today?: string;
}

/**
 * CDSE Sentinel Hub WMS tiles ending at `date`. A single day often lands on a
 * no-pass or cloudy acquisition, so we search a WINDOW ending at the target and
 * let Sentinel Hub pick either the newest scene under MAXCC (`mostRecent`, for
 * an active fire's current state) or the clearest one (`leastCC`, for a settled
 * scar or a clean pre-fire baseline).
 */
export function wmsTiles(
  wmsBase: string,
  layer: string,
  date: string,
  opts: TileOpts = {},
): string[] {
  const { windowDays = 12, priority = "leastCC", maxcc = 35, extend = false } = opts;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  // One rule, no branch: slide the window as LATE as it will go, then take the
  // full width backwards from there, and never start before `notBefore`.
  //
  // Sliding late is what keeps a settled-scar search out of the burn; taking
  // the full width is what keeps it from going empty. An earlier version
  // branched between "forward" and "backward" and got both wrong — it left the
  // original bug intact for fires aged 14-19 days (window still opened at
  // ignition+1) and, for anything younger, collapsed to a 0-5 day window that
  // Sentinel-2 frequently cannot fill, which renders as a black tile MapLibre
  // reports as success. At age 0 it even emitted an inverted range.
  //
  // `extend` is off for the pre-fire baseline: that window must END at its
  // date, since reaching forward from it would walk into the fire.
  const end = extend ? minDay(isoMinusDays(date, -windowDays), today) : date;
  let start = isoMinusDays(end, windowDays);
  if (opts.notBefore && start < opts.notBefore) start = opts.notBefore;
  // A fire younger than the window simply has less imagery in existence; take
  // what there is rather than inverting the range.
  if (start > end) start = end;
  const p = new URLSearchParams({
    service: "WMS",
    request: "GetMap",
    version: "1.3.0",
    layers: layer,
    styles: "",
    format: "image/jpeg",
    transparent: "false",
    crs: "EPSG:3857",
    width: "512",
    height: "512",
    TIME: `${start}/${end}`,
    MAXCC: String(maxcc),
    PRIORITY: priority,
    bbox: "{bbox-epsg-3857}",
  });
  return [`${wmsBase}?${p.toString()}`.replace("%7Bbbox-epsg-3857%7D", "{bbox-epsg-3857}")];
}

/** Before/after tile URLs for a scar, HD if available else keyless GIBS.
 * Before is always the clearest pre-fire baseline. After depends on the fire:
 * an ACTIVE fire wants its current state (newest pass under a looser cloud cap,
 * so smoke/fresh burn shows), a PAST scar wants the clearest settled image. */
export function scarTiles(
  cfg: ImageryConfig,
  scar: Scar,
  /** Per-side layer chosen by pickCapture, when one was measured. Ignored on
   * the HD tier, which has a single configured layer. */
  picked?: { before?: Capture; after?: Capture },
  /** Injectable clock, so window arithmetic is testable at a fixed date. */
  today?: string,
  /** True when called from step() — the reader explicitly asked to see THIS
   * date, so the window must end exactly there rather than sliding forward
   * toward today. `extend` is what settle()'s initial placement wants (avoid
   * defaulting onto a still-burning frame); for a fire settled within the
   * last windowDays it also means `end` sticks at `today` no matter what
   * `scar.after` is, so every step re-queries the byte-identical window and
   * Sentinel Hub returns the same scene forever (reproduced live on
   * Mont-de-Marsan, TIME=2026-08-23/2026-08-28 unchanged across steps). */
  stepping = false,
): { before: string[]; after: string[] } {
  if (cfg.hd) {
    const { wms_base, layer } = cfg.hd;
    // Active fire: look BACK from the nominal date for the newest usable pass —
    // the question is "what does it look like now". Settled scar: look FORWARD,
    // so the search cannot wander back into days when the fire was still
    // burning (see TileOpts.forward) — unless the reader is stepping, who
    // gets exactly the date they asked for.
    const afterOpts: TileOpts =
      scar.kind === "active"
        ? { priority: "mostRecent", maxcc: 60, notBefore: scar.started, today }
        : { priority: "leastCC", maxcc: 35, extend: !stepping, notBefore: scar.started, today };
    return {
      // No `notBefore`/`extend` here on purpose: the baseline window ends at
      // its date and runs backwards, so it is entirely pre-ignition already.
      before: wmsTiles(wms_base, layer, scar.before, { priority: "leastCC", maxcc: 35, today }),
      after: wmsTiles(wms_base, layer, scar.after, afterOpts),
    };
  }
  return {
    before: gibsTiles(picked?.before?.layer ?? cfg.gibs_layer, scar.before),
    after: gibsTiles(picked?.after?.layer ?? cfg.gibs_layer, scar.after),
  };
}

const BEFORE_SRC = "imagery-before";
const BEFORE_LAYER = "imagery-before";
const AFTER_SRC = "after";
const AFTER_LAYER = "after";

export type Side = "before" | "after";

/** A clicked map feature, captured at click time. MapLibre deletes
 * `event.features` as soon as a delegated layer handler returns, so anything
 * read later must come from a snapshot like this, never from the event. */
export interface FeatureSnapshot {
  props: Record<string, unknown>;
  lon: number;
  lat: number;
}

export class ImagerySwipe {
  private after: maplibregl.Map;
  private divider: HTMLDivElement;
  private wrap: HTMLDivElement;
  private ratio = 0.5;
  private syncing = false;
  private onMove: () => void;
  // Set while a drag is in flight, cleared by pointerup/pointercancel/destroy.
  // destroy() needs this to tear down an in-progress drag itself — otherwise
  // a destroy() mid-gesture (Escape, a second finger tapping the back bar,
  // or enter()'s swipe?.destroy() re-entering while a drag is live) leaves
  // the closure's pointermove/pointerup/pointercancel listeners bound to
  // `window` forever, leaking the whole second maplibregl.Map in this.after.
  private releaseDrag: (() => void) | null = null;
  private destroyed = false;
  private afterTiles: string[];
  private afterReady = false;

  constructor(
    private main: maplibregl.Map,
    beforeTiles: string[],
    afterTiles: string[],
    // Mount geometry for the tier in play (see rasterFit): GIBS is 256 px tiles
    // capped at z9, CDSE Sentinel-2 is 512 px and goes far deeper.
    private fit: RasterFit = { tileSize: GIBS_TILE_PX, maxzoom: GIBS_MAX_Z, zoom: GIBS_MAX_Z },
  ) {
    // "Before" raster goes on TOP of the whole basemap, not under it. The dark
    // basemap is opaque all the way down — its `landcover` fill is #0e0e0e and
    // its `water` fill is #2C353C at full opacity — so a raster inserted above
    // only the `background` layer is painted over completely and the before
    // side reads as an empty map. Topmost also matches the after map, which is
    // a bare raster with no basemap under it: both halves show pixels alone.
    // Every data overlay is hidden for the duration of compare mode, so there
    // is nothing left that this could cover up.
    this.mountBefore(beforeTiles);

    // "After" on a second map stacked over the main one.
    const parent = main.getContainer();
    this.wrap = document.createElement("div");
    this.wrap.style.cssText =
      "position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none";
    const afterDiv = document.createElement("div");
    afterDiv.style.cssText = "position:absolute;inset:0";
    this.wrap.appendChild(afterDiv);
    parent.appendChild(this.wrap);

    this.after = new maplibregl.Map({
      container: afterDiv,
      style: { version: 8, sources: {}, layers: [] },
      center: main.getCenter(),
      zoom: main.getZoom(),
      bearing: main.getBearing(),
      pitch: main.getPitch(),
      interactive: false,
      attributionControl: false,
    });
    this.afterTiles = afterTiles;
    this.after.on("load", () => {
      this.afterReady = true;
      this.mountAfter();
    });

    // Divider handle. Class carries only touch-action (style.css) — layout,
    // colour, etc. stay inline below; a CSS rule targeting this class would
    // otherwise sit next to an element that had no class to match.
    this.divider = document.createElement("div");
    this.divider.className = "swipe-divider";
    this.divider.style.cssText =
      "position:absolute;top:0;bottom:0;width:3px;background:#fff;z-index:3;" +
      "cursor:ew-resize;box-shadow:0 0 4px rgba(0,0,0,.6);pointer-events:auto";
    this.divider.innerHTML =
      "<div style='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);" +
      "width:34px;height:34px;border-radius:50%;background:#fff;color:#111;" +
      "display:flex;align-items:center;justify-content:center;font-size:15px'>⇆</div>";
    parent.appendChild(this.divider);

    this.onMove = () => this.syncAfter();
    main.on("move", this.onMove);
    this.attachDrag(parent);
    this.setRatio(0.5);
  }

  /** (Re)mount the before raster on TOP of the whole basemap. */
  private mountBefore(tiles: string[]) {
    if (this.main.getLayer(BEFORE_LAYER)) this.main.removeLayer(BEFORE_LAYER);
    if (this.main.getSource(BEFORE_SRC)) this.main.removeSource(BEFORE_SRC);
    this.main.addSource(BEFORE_SRC, {
      type: "raster",
      tiles,
      tileSize: this.fit.tileSize,
      maxzoom: this.fit.maxzoom,
    });
    this.main.addLayer({
      id: BEFORE_LAYER,
      type: "raster",
      source: BEFORE_SRC,
      paint: { "raster-opacity": 1 },
    });
  }

  /** Swap the before image for a different pre-fire capture day. */
  setBeforeTiles(tiles: string[]) {
    this.mountBefore(tiles);
  }

  /** (Re)mount the after raster from the current tile template. */
  private mountAfter() {
    if (!this.afterReady) return;
    if (this.after.getLayer(AFTER_LAYER)) this.after.removeLayer(AFTER_LAYER);
    if (this.after.getSource(AFTER_SRC)) this.after.removeSource(AFTER_SRC);
    this.after.addSource(AFTER_SRC, {
      type: "raster",
      tiles: this.afterTiles,
      tileSize: this.fit.tileSize,
      maxzoom: this.fit.maxzoom,
    });
    this.after.addLayer({ id: AFTER_LAYER, type: "raster", source: AFTER_SRC });
  }

  /** Swap the after image for a different capture day, keeping the camera, the
   * divider position and the before image exactly where they are — the reader
   * is stepping past a cloudy pass, not restarting the comparison. */
  setAfterTiles(tiles: string[]) {
    this.afterTiles = tiles;
    this.mountAfter();
  }

  private syncAfter() {
    if (this.syncing) return;
    this.syncing = true;
    this.after.jumpTo({
      center: this.main.getCenter(),
      zoom: this.main.getZoom(),
      bearing: this.main.getBearing(),
      pitch: this.main.getPitch(),
    });
    this.syncing = false;
  }

  private setRatio(r: number) {
    this.ratio = Math.min(0.98, Math.max(0.02, r));
    const w = this.main.getContainer().clientWidth;
    const x = this.ratio * w;
    this.wrap.style.clipPath = `inset(0 0 0 ${x}px)`;
    this.divider.style.left = `${x}px`;
  }

  private attachDrag(parent: HTMLElement) {
    const move = (clientX: number) => {
      const rect = parent.getBoundingClientRect();
      this.setRatio((clientX - rect.left) / rect.width);
    };
    // A single tracked pointerId means a second finger landing mid-drag is
    // ignored rather than hijacking the divider.
    let activePointerId: number | null = null;
    const onDown = (e: PointerEvent) => {
      if (activePointerId !== null) return; // a drag is already in progress
      e.preventDefault();
      const pointerId = e.pointerId;
      activePointerId = pointerId;
      // setPointerCapture/releasePointerCapture can throw NotFoundError if the
      // browser has already implicitly released capture (a real, documented
      // cross-browser Pointer Events quirk: capture is dropped automatically
      // when the pointer is cancelled or the element leaves the document, and
      // the release call then has nothing to release). An uncaught throw here
      // would abort before `release` is wired up below, leaving
      // activePointerId stuck non-null and the divider dead for the rest of
      // the page's life.
      try {
        this.divider.setPointerCapture?.(pointerId);
      } catch (err) {
        // NotFoundError = proceed without native capture; window-level
        // listeners still work. Anything else is unexpected — surface it.
        if (!(err instanceof DOMException) || err.name !== "NotFoundError") {
          console.warn("layer_imagery: setPointerCapture failed unexpectedly", err);
        }
      }
      const onPointer = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) move(ev.clientX);
      };
      // Shared teardown for pointerup, pointercancel, AND destroy() calling
      // it directly mid-drag — see releaseDrag's field comment for why that
      // third caller matters.
      const release = () => {
        try {
          this.divider.releasePointerCapture?.(pointerId);
        } catch (err) {
          // NotFoundError = already released implicitly; state reset below
          // still runs. Anything else is unexpected — surface it.
          if (!(err instanceof DOMException) || err.name !== "NotFoundError") {
            console.warn("layer_imagery: releasePointerCapture failed unexpectedly", err);
          }
        }
        activePointerId = null;
        this.releaseDrag = null;
        window.removeEventListener("pointermove", onPointer);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        release();
      };
      this.releaseDrag = release;
      window.addEventListener("pointermove", onPointer);
      window.addEventListener("pointerup", onUp);
      // Without pointercancel, an interrupted gesture (incoming call, OS
      // gesture) leaves pointermove bound and the divider follows a finger
      // that is no longer there.
      window.addEventListener("pointercancel", onUp);
    };
    this.divider.addEventListener("pointerdown", onDown);
  }

  destroy() {
    // Idempotent: main.ts only ever destroy()s a swipe once today, but this
    // was cheap insurance against a future double call re-removing the
    // (already-detached) MapLibre sub-map or double-releasing pointer capture.
    if (this.destroyed) return;
    this.destroyed = true;
    // Tear down an in-flight drag before anything else — otherwise the
    // window listeners captured in this.releaseDrag would outlive the
    // divider they move (see the field's comment).
    this.releaseDrag?.();
    this.main.off("move", this.onMove);
    if (this.main.getLayer(BEFORE_LAYER)) this.main.removeLayer(BEFORE_LAYER);
    if (this.main.getSource(BEFORE_SRC)) this.main.removeSource(BEFORE_SRC);
    this.after.remove();
    this.wrap.remove();
    this.divider.remove();
  }
}
