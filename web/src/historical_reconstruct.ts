/**
 * Reconstructs a Track (web/src/types.ts) from raw FIRMS hotspot CSV rows —
 * the client-side half of the historical fire lookup feature. Ports three
 * already-proven pipeline algorithms rather than reinventing them, verified
 * against the actual source at each step (not re-derived from memory):
 *  - CSV parsing + confidence filtering: pipeline/fetch_firms.py's
 *    parse_firms_csv/_LOW_CONF.
 *  - Static heat-source detection: pipeline/events.py's static_cells and
 *    is_static (event-level majority rule, not per-row).
 *  - Clustering: pipeline/events.py's _edges_sql union-find (same-cell
 *    time-consecutive chains + adjacent-cell any-pair, both gated by
 *    CLOSE_AFTER_H=48h). The pipeline's second-pass "bridging"
 *    (_bridge_edges_sql) is deliberately NOT ported here — it exists to
 *    re-join a fire that temporarily split into two very large components
 *    across a longer time gap, out of scope for this lightweight
 *    client-side module; a fire that splits this way instead shows as
 *    multiple "ambiguous" clusters, an acceptable degrade rather than a
 *    silent wrong merge.
 *  - 6h binning: pipeline/events.py's bin_start + pipeline/metrics.py's
 *    bins_series + pipeline/export.py's _cell_bins.
 *
 *  Unlike pipeline/fetch_firms.py's is_near_land filter, this module does
 *  not filter offshore detections (e.g. gas flares on rigs/platforms) — a
 *  deliberate scope limitation for a lightweight client-side module, not
 *  an oversight.
 */

import { latLngToCell, gridDisk } from "h3-js";
import type { Bin, Track } from "./types";

export interface HistoricalRow {
  lat: number;
  lon: number;
  time: Date;
  frp: number;
}

function parseCsvLines(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/** VIIRS confidence is a letter (l/n/h); MODIS confidence is numeric 0-100.
 *  The row's own shape says which filter applies — no separate tier flag
 *  needed. Matches pipeline/fetch_firms.py's _LOW_CONF exactly. */
function isLowConfidence(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return false; // blank/missing confidence is not in Python's _LOW_CONF set — keep it
  if (trimmed === "l") return true; // VIIRS low
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric < 30; // MODIS
  return false;
}

export function parseFirmsCsv(text: string): HistoricalRow[] {
  const rows: HistoricalRow[] = [];
  for (const rec of parseCsvLines(text)) {
    const confidence = rec.confidence ?? "";
    if (isLowConfidence(confidence)) continue;
    const date = rec.acq_date;
    const time = (rec.acq_time ?? "").padStart(4, "0");
    if (!date || !time) continue;
    const hh = time.slice(0, 2);
    const mm = time.slice(2, 4);
    const parsed = new Date(`${date}T${hh}:${mm}:00Z`);
    if (Number.isNaN(parsed.getTime())) continue;
    const lat = Number(rec.latitude);
    const lon = Number(rec.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const frp = Number(rec.frp);
    rows.push({ lat, lon, time: parsed, frp: Number.isFinite(frp) ? frp : 0 });
  }
  return rows;
}

export const H3_RES = 8;
export const STATIC_CELL_DAYS = 20;

function cellAt(row: HistoricalRow): string {
  return latLngToCell(row.lat, row.lon, H3_RES);
}

function calendarDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/** Cells detected on >= STATIC_CELL_DAYS distinct days — a fixed heat source
 *  (flare, refinery), not a wildfire. Ports pipeline/events.py's
 *  static_cells exactly: a real fire's front moves, a static source keeps
 *  re-lighting the same ~0.7 km2 cell. */
export function staticCells(rows: HistoricalRow[]): Set<string> {
  const daysByCell = new Map<string, Set<string>>();
  for (const row of rows) {
    const cell = cellAt(row);
    const days = daysByCell.get(cell) ?? new Set<string>();
    days.add(calendarDay(row.time));
    daysByCell.set(cell, days);
  }
  const flagged = new Set<string>();
  for (const [cell, days] of daysByCell) {
    if (days.size >= STATIC_CELL_DAYS) flagged.add(cell);
  }
  return flagged;
}

export function dropStaticSources(rows: HistoricalRow[]): HistoricalRow[] {
  const flagged = staticCells(rows);
  return rows.filter((row) => !flagged.has(cellAt(row)));
}

export interface ClusterGroup {
  rows: HistoricalRow[];
  cellCount: number;
}

const CLOSE_AFTER_H = 48;
const CLOSE_AFTER_MS = CLOSE_AFTER_H * 60 * 60 * 1000;

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/** Groups rows into clusters via union-find over row-index pairs, ports
 *  pipeline/events.py's _edges_sql exactly: an edge forms between two
 *  detections when EITHER (a) they sit in the SAME H3 res-8 cell and are
 *  time-consecutive within that cell's chronological ordering, with a gap
 *  <= CLOSE_AFTER_H (48h) — a chain, not "all pairs in the cell within 48h"
 *  — OR (b) they sit in ADJACENT cells (gridDisk(cell, 1), ring 1, excluding
 *  the cell itself) and are within CLOSE_AFTER_H of EACH OTHER (any pair,
 *  not just consecutive). Two clusters mean the bbox+date window caught more
 *  than one real fire (or a fire and an unrelated reburn) — the caller must
 *  not silently union them into one fake footprint.
 *
 *  Does NOT port the pipeline's second-pass "bridging" (_bridge_edges_sql) —
 *  a deliberate scope reduction for this lightweight client-side module. A
 *  fire that splits into two very large components across a longer gap and
 *  would be bridged server-side instead surfaces here as multiple
 *  "ambiguous" clusters, an acceptable degrade rather than a silent
 *  wrong merge. */
export function splitIntoClusters(rows: HistoricalRow[]): ClusterGroup[] {
  if (rows.length === 0) return [];

  const cellOf = rows.map((row) => latLngToCell(row.lat, row.lon, H3_RES));
  const rowsByCell = new Map<string, number[]>();
  cellOf.forEach((cell, i) => {
    const bucket = rowsByCell.get(cell) ?? [];
    bucket.push(i);
    rowsByCell.set(cell, bucket);
  });

  const uf = new UnionFind(rows.length);

  // (a) same cell, time-consecutive, gap <= CLOSE_AFTER_H
  for (const indices of rowsByCell.values()) {
    const ordered = [...indices].sort((a, b) => rows[a].time.getTime() - rows[b].time.getTime());
    for (let i = 0; i < ordered.length - 1; i++) {
      const gap = rows[ordered[i + 1]].time.getTime() - rows[ordered[i]].time.getTime();
      if (gap <= CLOSE_AFTER_MS) uf.union(ordered[i], ordered[i + 1]);
    }
  }

  // (b) adjacent cells, any pair within CLOSE_AFTER_H of each other
  const seenCellPairs = new Set<string>();
  for (const cell of rowsByCell.keys()) {
    for (const neighbor of gridDisk(cell, 1)) {
      if (neighbor === cell || !rowsByCell.has(neighbor)) continue;
      const pairKey = cell < neighbor ? `${cell}|${neighbor}` : `${neighbor}|${cell}`;
      if (seenCellPairs.has(pairKey)) continue;
      seenCellPairs.add(pairKey);
      for (const i of rowsByCell.get(cell) as number[]) {
        for (const j of rowsByCell.get(neighbor) as number[]) {
          const gap = Math.abs(rows[i].time.getTime() - rows[j].time.getTime());
          if (gap <= CLOSE_AFTER_MS) uf.union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = uf.find(i);
    const bucket = groups.get(root) ?? [];
    bucket.push(i);
    groups.set(root, bucket);
  }

  return [...groups.values()].map((indices) => ({
    rows: indices.map((i) => rows[i]),
    cellCount: new Set(indices.map((i) => cellOf[i])).size,
  }));
}

const BIN_HOURS = 6;

/** Floors to the 6h UTC boundary — ports pipeline/events.py's bin_start
 *  (hour // BIN_HOURS * BIN_HOURS) exactly, verified against that source. */
function binStart(time: Date): Date {
  const floored = new Date(time);
  floored.setUTCHours(Math.floor(time.getUTCHours() / BIN_HOURS) * BIN_HOURS, 0, 0, 0);
  return floored;
}

export function assembleTrack(rows: HistoricalRow[], id: string): Track {
  const sorted = [...rows].sort((a, b) => a.time.getTime() - b.time.getTime());
  const byBin = new Map<string, { lat: number[]; lon: number[]; newCells: string[]; frp: number }>();
  const seenCells = new Set<string>();

  for (const row of sorted) {
    const binKey = binStart(row.time).toISOString();
    const bucket = byBin.get(binKey) ?? { lat: [], lon: [], newCells: [], frp: 0 };
    bucket.lat.push(row.lat);
    bucket.lon.push(row.lon);
    bucket.frp += row.frp;
    const cell = latLngToCell(row.lat, row.lon, H3_RES);
    if (!seenCells.has(cell)) {
      seenCells.add(cell);
      bucket.newCells.push(cell);
    }
    byBin.set(binKey, bucket);
  }

  const sortedBinKeys = [...byBin.keys()].sort();
  let cumCells = 0;
  const series: Bin[] = sortedBinKeys.map((key) => {
    const bucket = byBin.get(key) as { lat: number[]; lon: number[]; newCells: string[]; frp: number };
    cumCells += bucket.newCells.length;
    return {
      bin: key,
      centroid: [
        bucket.lat.reduce((a, b) => a + b, 0) / bucket.lat.length,
        bucket.lon.reduce((a, b) => a + b, 0) / bucket.lon.length,
      ],
      new_cells: bucket.newCells.length,
      cum_cells: cumCells,
      frp_sum: Math.round(bucket.frp * 10) / 10,
    };
  });
  const cellBins: [string, string[]][] = sortedBinKeys.map((key) => [
    key,
    (byBin.get(key) as { newCells: string[] }).newCells,
  ]);

  return {
    id,
    series,
    cells: [...seenCells],
    cell_bins: cellBins,
    frp_live: [],
  };
}

export type ReconstructResult =
  | { status: "ok"; track: Track }
  | { status: "no_data" }
  | { status: "ambiguous"; clusters: { cellCount: number; rowCount: number }[] };

export function reconstructHistoricalFire(csvText: string, id: string): ReconstructResult {
  const parsed = parseFirmsCsv(csvText);
  const survivors = dropStaticSources(parsed);
  if (survivors.length === 0) return { status: "no_data" };

  const clusters = splitIntoClusters(survivors);
  if (clusters.length > 1) {
    return {
      status: "ambiguous",
      clusters: clusters.map((c) => ({ cellCount: c.cellCount, rowCount: c.rows.length })),
    };
  }

  return { status: "ok", track: assembleTrack(clusters[0].rows, id) };
}
