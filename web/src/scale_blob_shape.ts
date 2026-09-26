// Geometry of the scale-comparison blob, built in the browser from the
// per-fire summary (archive/blob_{year}_fires.json) alone.
//
// The blob used to ship as archive/blob_{year}.json: one polygon per 0.7 km²
// display hex, ~163k of them for 2026 — a 57 MB download, and 163k fill
// polygons plus 163k outlines for maplibre to re-tile on every select and
// drop. At overview zoom a hex is 1–2 px, so those outlines were all the
// reader saw: black/white static, coloured per fire with no legend.
//
// Nothing in that file is needed. The packing (pipeline/pack_blob.py) is a
// fixed hex size, a hex COUNT per fire (round(area / 0.7), never 0) and one
// shared spiral — all derivable from each fire's area. So this module packs
// the same counts on the same spiral, grouped by COUNTRY instead of by fire
// (largest at the centre), and dissolves each country's run into a handful of
// outline rings. The reader gets bands they can name from the breakdown
// panel; maplibre gets a few dozen polygons instead of 163k.
import { isEuCountry } from "./eu27";
import type { FiresSummary } from "./types";

/**
 * The blob's scope: EU-27 fires only. The shape and its breakdown panel both
 * filter through here, so they always describe the same fires. A fire with no
 * country is out (eu27.ts: unknown is never counted as EU).
 */
export function euOnly(summary: FiresSummary): FiresSummary {
  return Object.fromEntries(Object.entries(summary).filter(([, f]) => isEuCountry(f.country)));
}

/** Mirrors pipeline/pack_blob.py's HEX_AREA_KM2 — the VIIRS cell quantum. */
export const HEX_AREA_KM2 = 0.7;
const HEX_EDGE_M = Math.sqrt((HEX_AREA_KM2 * 1_000_000) / ((3 * Math.sqrt(3)) / 2));

/** How many countries get their own colour; the rest share OTHER_COLOR. More
 * than ~8 categorical hues stop being tellable apart on a dark basemap. */
export const NAMED_COUNTRIES = 7;
const COUNTRY_PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1"];
export const OTHER_COLOR = "#9c9c9c";
export const OTHER_KEY = "Other";

/** Mirrors pipeline/pack_blob.py's hex_count_for_area. */
export function hexCountForArea(areaKm2: number): number {
  return Math.max(1, Math.round(areaKm2 / HEX_AREA_KM2));
}

export type BlobGroup = {
  /** Country code, or OTHER_KEY for everything past the named few. */
  key: string;
  color: string;
  hexes: number;
  /** Real detected area — what the label and the panel quote. The shape's own
   * area is hexes × 0.7, which rounds every fire to at least one hex. */
  areaKm2: number;
  fires: number;
};

/**
 * Countries ranked by hex count, the top NAMED_COUNTRIES coloured, the rest
 * (and fires with no country) folded into one OTHER group placed last, on the
 * outside of the spiral.
 */
export function groupByCountry(summary: FiresSummary): BlobGroup[] {
  const by = new Map<string, { hexes: number; areaKm2: number; fires: number }>();
  for (const { country, area_km2 } of Object.values(summary)) {
    const key = country ?? OTHER_KEY;
    const g = by.get(key) ?? { hexes: 0, areaKm2: 0, fires: 0 };
    g.hexes += hexCountForArea(area_km2);
    g.areaKm2 += area_km2;
    g.fires += 1;
    by.set(key, g);
  }
  const ranked = [...by.entries()]
    .filter(([key]) => key !== OTHER_KEY)
    .sort((a, b) => b[1].hexes - a[1].hexes || a[0].localeCompare(b[0]));
  const groups: BlobGroup[] = ranked
    .slice(0, NAMED_COUNTRIES)
    .map(([key, g], i) => ({ key, color: COUNTRY_PALETTE[i], ...g }));
  const rest = [...ranked.slice(NAMED_COUNTRIES), ...(by.has(OTHER_KEY) ? [[OTHER_KEY, by.get(OTHER_KEY)!] as const] : [])];
  if (rest.length > 0) {
    const other = { key: OTHER_KEY, color: OTHER_COLOR, hexes: 0, areaKm2: 0, fires: 0 };
    for (const [, g] of rest) {
      other.hexes += g.hexes;
      other.areaKm2 += g.areaKm2;
      other.fires += g.fires;
    }
    groups.push(other);
  }
  return groups;
}

export type Band = { key: string; color: string };

/** country → the band it is painted in, for the breakdown panel's swatches
 * and row selection. Countries folded into OTHER map to the OTHER band. */
export function bandByCountry(groups: BlobGroup[]): (country: string) => Band {
  const named = new Map(groups.map((g) => [g.key, g.color]));
  return (country) => {
    const color = named.get(country);
    return color ? { key: country, color } : { key: OTHER_KEY, color: OTHER_COLOR };
  };
}

// Axial directions in ring-walk order — pipeline/pack_blob.py's _DIRECTIONS.
const WALK = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;

/** The first `n` axial (q, r) positions of the spiral, centre outwards —
 * pipeline/pack_blob.py's _spiral_axial_coords, position for position. */
export function spiralAxial(n: number): [number, number][] {
  const out: [number, number][] = [];
  if (n <= 0) return out;
  out.push([0, 0]);
  for (let radius = 1; out.length < n; radius++) {
    let q = WALK[4][0] * radius;
    let r = WALK[4][1] * radius;
    for (const [dq, dr] of WALK) {
      for (let s = 0; s < radius; s++) {
        if (out.length >= n) return out;
        out.push([q, r]);
        q += dq;
        r += dr;
      }
    }
  }
  return out;
}

// Pointy-top hex, vertex i at angle 60i − 30° (pack_blob.py's
// _hexagon_vertices_m), counter-clockwise in a y-up frame. On an integer
// lattice of (edge·√3/2, edge/2) every hex vertex lands on whole numbers, so
// shared vertices compare exactly — no float keys.
const VERTEX_DX = [1, 1, 0, -1, -1, 0];
const VERTEX_DY = [-1, 1, 2, 1, -1, -2];
// The neighbour across edge i (vertex i → i+1) sits at angle 60i°.
const ACROSS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]] as const;
const UNIT_X_M = (HEX_EDGE_M * Math.sqrt(3)) / 2;
const UNIT_Y_M = HEX_EDGE_M / 2;

const cellKey = (q: number, r: number) => (q + 50_000) * 100_000 + (r + 50_000);
const vertKey = (x: number, y: number) => (x + 500_000) * 1_000_000 + (y + 500_000);

type Ring = [number, number][];

function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

function contains(ring: Ring, [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Boundary of one group's cells as polygons (outer ring + holes), in lattice
 * units. A directed edge is kept when the cell across it is not in the group;
 * on a hex grid every boundary vertex then has exactly one outgoing edge, so
 * the edges chain into rings with no ambiguity. Counter-clockwise rings are
 * outers, clockwise ones holes, and each hole goes to the smallest outer that
 * contains it.
 */
function dissolve(cells: [number, number][], member: (q: number, r: number) => boolean): Ring[][] {
  const next = new Map<number, [number, number, number]>(); // from → [toKey, toX, toY]
  const start = new Map<number, [number, number]>();
  for (const [q, r] of cells) {
    const cx = 2 * q + r;
    const cy = 3 * r;
    for (let i = 0; i < 6; i++) {
      if (member(q + ACROSS[i][0], r + ACROSS[i][1])) continue;
      const j = (i + 1) % 6;
      const ax = cx + VERTEX_DX[i], ay = cy + VERTEX_DY[i];
      const bx = cx + VERTEX_DX[j], by = cy + VERTEX_DY[j];
      const from = vertKey(ax, ay);
      next.set(from, [vertKey(bx, by), bx, by]);
      start.set(from, [ax, ay]);
    }
  }
  const outers: { ring: Ring; area: number; holes: Ring[] }[] = [];
  const holes: Ring[] = [];
  for (const [first, xy] of start) {
    if (!next.has(first)) continue; // already walked
    const ring: Ring = [xy];
    let at = first;
    for (;;) {
      const step = next.get(at)!;
      next.delete(at);
      at = step[0];
      if (at === first) break;
      ring.push([step[1], step[2]]);
    }
    ring.push(ring[0]);
    const area = signedArea(ring);
    if (area > 0) outers.push({ ring, area, holes: [] });
    else holes.push(ring);
  }
  outers.sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const owner = outers.find((o) => contains(o.ring, hole[0]));
    owner?.holes.push(hole);
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}

export type BlobShape = {
  groups: BlobGroup[];
  /** One MultiPolygon per group, in local metres around the blob's centre —
   * geo_local.ts's projectVertices places it at the drop point. */
  polygonsM: [number, number][][][][];
};

export function buildBlobShape(summary: FiresSummary): BlobShape {
  const groups = groupByCountry(summary);
  const total = groups.reduce((n, g) => n + g.hexes, 0);
  const coords = spiralAxial(total);
  const owner = new Map<number, number>();
  const cellsOf: [number, number][][] = groups.map(() => []);
  let i = 0;
  groups.forEach((g, gi) => {
    for (let k = 0; k < g.hexes; k++, i++) {
      const [q, r] = coords[i];
      owner.set(cellKey(q, r), gi);
      cellsOf[gi].push([q, r]);
    }
  });
  const polygonsM = cellsOf.map((cells, gi) =>
    dissolve(cells, (q, r) => owner.get(cellKey(q, r)) === gi).map((poly) =>
      poly.map((ring) => ring.map(([x, y]) => [x * UNIT_X_M, y * UNIT_Y_M] as [number, number])),
    ),
  );
  return { groups, polygonsM };
}
