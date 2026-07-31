import maplibregl from "maplibre-gl";

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

/** Shift an ISO day (YYYY-MM-DD) back by N days, staying in UTC. */
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
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
  const { windowDays = 12, priority = "leastCC", maxcc = 35 } = opts;
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
    TIME: `${isoMinusDays(date, windowDays)}/${date}`,
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
export function scarTiles(cfg: ImageryConfig, scar: Scar): { before: string[]; after: string[] } {
  if (cfg.hd) {
    const { wms_base, layer } = cfg.hd;
    const afterOpts: TileOpts =
      scar.kind === "active"
        ? { priority: "mostRecent", maxcc: 60 }
        : { priority: "leastCC", maxcc: 35 };
    return {
      before: wmsTiles(wms_base, layer, scar.before, { priority: "leastCC", maxcc: 35 }),
      after: wmsTiles(wms_base, layer, scar.after, afterOpts),
    };
  }
  return {
    before: gibsTiles(cfg.gibs_layer, scar.before),
    after: gibsTiles(cfg.gibs_layer, scar.after),
  };
}

const BEFORE_SRC = "imagery-before";
const BEFORE_LAYER = "imagery-before";

export class ImagerySwipe {
  private after: maplibregl.Map;
  private divider: HTMLDivElement;
  private wrap: HTMLDivElement;
  private ratio = 0.5;
  private syncing = false;
  private onMove: () => void;
  // Set while a drag is in flight, cleared by pointerup/pointercancel/destroy.
  // destroy() needs this to tear down an in-progress drag itself — otherwise
  // a destroy() mid-gesture (Escape, a second finger tapping .compare-exit,
  // or enter()'s swipe?.destroy() re-entering while a drag is live) leaves
  // the closure's pointermove/pointerup/pointercancel listeners bound to
  // `window` forever, leaking the whole second maplibregl.Map in this.after.
  private releaseDrag: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private main: maplibregl.Map,
    beforeTiles: string[],
    afterTiles: string[],
    // GIBS true-colour tops out at ~250 m (z8): cap so MapLibre over-zooms the
    // deepest tile instead of requesting z9+ and getting blank 404s. CDSE
    // Sentinel-2 is 10 m, so HD passes a deeper cap for crisp close-ups.
    private maxzoom = 8,
  ) {
    // "Before" raster on the main map, just above the basemap.
    const firstSymbol = main.getStyle().layers?.find((l) => l.type !== "background")?.id;
    main.addSource(BEFORE_SRC, { type: "raster", tiles: beforeTiles, tileSize: 512, maxzoom });
    main.addLayer(
      { id: BEFORE_LAYER, type: "raster", source: BEFORE_SRC, paint: { "raster-opacity": 1 } },
      firstSymbol,
    );

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
    this.after.on("load", () => {
      this.after.addSource("after", {
        type: "raster",
        tiles: afterTiles,
        tileSize: 512,
        maxzoom: this.maxzoom,
      });
      this.after.addLayer({ id: "after", type: "raster", source: "after" });
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
    // ignored rather than hijacking the divider (see sheet.ts's handle drag
    // for the same pattern).
    let activePointerId: number | null = null;
    const onDown = (e: PointerEvent) => {
      if (activePointerId !== null) return; // a drag is already in progress
      e.preventDefault();
      const pointerId = e.pointerId;
      activePointerId = pointerId;
      this.divider.setPointerCapture?.(pointerId);
      const onPointer = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) move(ev.clientX);
      };
      // Shared teardown for pointerup, pointercancel, AND destroy() calling
      // it directly mid-drag — see releaseDrag's field comment for why that
      // third caller matters.
      const release = () => {
        this.divider.releasePointerCapture?.(pointerId);
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
