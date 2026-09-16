import { describe, expect, it } from "vitest";
import { parseFirmsCsv, type HistoricalRow } from "../src/historical_reconstruct";

describe("parseFirmsCsv", () => {
  it("parses a VIIRS-shaped row, combining acq_date + acq_time as UTC", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1155,n,12.5\n";
    const rows = parseFirmsCsv(csv);
    expect(rows).toEqual([
      { lat: 44.84, lon: -1.03, time: new Date("2022-07-22T11:55:00Z"), frp: 12.5 },
    ]);
  });

  it("zero-pads a short acq_time the same way the pipeline's .zfill(4) does", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,600,n,1\n";
    const rows = parseFirmsCsv(csv);
    expect(rows[0].time).toEqual(new Date("2022-07-22T06:00:00Z"));
  });

  it("drops VIIRS rows with confidence 'l' (low)", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1200,l,1\n";
    expect(parseFirmsCsv(csv)).toEqual([]);
  });

  it("keeps VIIRS rows with confidence 'n' or 'h'", () => {
    const csv =
      "latitude,longitude,acq_date,acq_time,confidence,frp\n" +
      "44.84,-1.03,2022-07-22,1200,n,1\n44.85,-1.03,2022-07-22,1200,h,1\n";
    expect(parseFirmsCsv(csv)).toHaveLength(2);
  });

  it("drops MODIS rows with numeric confidence under 30", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1200,29,1\n";
    expect(parseFirmsCsv(csv)).toEqual([]);
  });

  it("keeps MODIS rows with numeric confidence 30 or above", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1200,30,1\n";
    expect(parseFirmsCsv(csv)).toHaveLength(1);
  });

  it("defaults a missing frp to 0 rather than NaN", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1200,n,\n";
    expect(parseFirmsCsv(csv)[0].frp).toBe(0);
  });

  it("keeps a row with a blank/missing confidence field, matching Python's set-membership _LOW_CONF (blank is not in the set)", () => {
    const csv = "latitude,longitude,acq_date,acq_time,confidence,frp\n44.84,-1.03,2022-07-22,1200,,5\n";
    expect(parseFirmsCsv(csv)).toHaveLength(1);
  });

  it("returns an empty array for an empty/header-only CSV", () => {
    expect(parseFirmsCsv("latitude,longitude,acq_date,acq_time,confidence,frp\n")).toEqual([]);
    expect(parseFirmsCsv("")).toEqual([]);
  });
});

import { staticCells, dropStaticSources, STATIC_CELL_DAYS } from "../src/historical_reconstruct";

// A real H3 res-8 cell and a point guaranteed to land in it (pins the fixture,
// not a real fire location).
const CELL_LAT = 44.84;
const CELL_LON = -1.03;

function rowsOnDistinctDays(n: number, lat = CELL_LAT, lon = CELL_LON): HistoricalRow[] {
  return Array.from({ length: n }, (_, i) => ({
    lat, lon, frp: 1, time: new Date(Date.UTC(2022, 6, 1 + i, 12, 0, 0)),
  }));
}

describe("staticCells", () => {
  it(`flags a cell detected on >= ${STATIC_CELL_DAYS} distinct days`, () => {
    const flagged = staticCells(rowsOnDistinctDays(STATIC_CELL_DAYS));
    expect(flagged.size).toBe(1);
  });

  it(`does not flag a cell detected on fewer than ${STATIC_CELL_DAYS} distinct days`, () => {
    const flagged = staticCells(rowsOnDistinctDays(STATIC_CELL_DAYS - 1));
    expect(flagged.size).toBe(0);
  });

  it("counts distinct CALENDAR days, not detection count — repeats same-day don't count twice", () => {
    const oneDay = Array.from({ length: 50 }, () => ({
      lat: CELL_LAT, lon: CELL_LON, frp: 1, time: new Date("2022-07-01T12:00:00Z"),
    }));
    expect(staticCells(oneDay).size).toBe(0);
  });
});

describe("dropStaticSources", () => {
  it("removes every row sitting in a flagged static cell", () => {
    const staticRows = rowsOnDistinctDays(STATIC_CELL_DAYS);
    const realFire = [{ lat: 44.9, lon: -1.2, frp: 5, time: new Date("2022-07-22T12:00:00Z") }];
    const survivors = dropStaticSources([...staticRows, ...realFire]);
    expect(survivors).toEqual(realFire);
  });

  it("keeps everything when nothing is static", () => {
    const rows = rowsOnDistinctDays(3);
    expect(dropStaticSources(rows)).toEqual(rows);
  });
});

import { isClusterStatic } from "../src/historical_reconstruct";

describe("isClusterStatic", () => {
  it("returns false for an empty cluster", () => {
    expect(isClusterStatic([], new Set())).toBe(false);
  });

  it("returns true when all of a cluster's members sit in a static cell", () => {
    const cell = latLngToCell(CELL_LAT, CELL_LON, 8);
    const rows = rowsOnDistinctDays(4);
    expect(isClusterStatic(rows, new Set([cell]))).toBe(true);
  });

  it("returns false when fewer than STATIC_EVENT_FRAC (50%) of members sit in a static cell", () => {
    const staticCell = latLngToCell(CELL_LAT, CELL_LON, 8);
    const rows: HistoricalRow[] = [
      { lat: CELL_LAT, lon: CELL_LON, frp: 1, time: new Date() }, // in the static cell
      { lat: 48.0, lon: 2.0, frp: 1, time: new Date() }, // not
      { lat: 48.0, lon: 2.0, frp: 1, time: new Date() },
    ];
    expect(isClusterStatic(rows, new Set([staticCell]))).toBe(false);
  });

  it("treats exactly STATIC_EVENT_FRAC (50%) as static — >=, not >", () => {
    const staticCell = latLngToCell(CELL_LAT, CELL_LON, 8);
    const rows: HistoricalRow[] = [
      { lat: CELL_LAT, lon: CELL_LON, frp: 1, time: new Date() },
      { lat: CELL_LAT, lon: CELL_LON, frp: 1, time: new Date() },
      { lat: 48.0, lon: 2.0, frp: 1, time: new Date() },
      { lat: 48.0, lon: 2.0, frp: 1, time: new Date() },
    ];
    expect(isClusterStatic(rows, new Set([staticCell]))).toBe(true);
  });
});

import { splitIntoClusters } from "../src/historical_reconstruct";
import { latLngToCell, cellToLatLng, gridDisk } from "h3-js";

// Build a small chain of adjacent res-8 cells around a real anchor, and a
// second chain far enough away to never be adjacent to the first — avoids
// hardcoding literal H3 index strings, which are opaque and easy to get
// subtly wrong by hand.
function adjacentChain(anchorLat: number, anchorLon: number, length: number): HistoricalRow[] {
  const anchor = latLngToCell(anchorLat, anchorLon, 8);
  const ring = gridDisk(anchor, length); // more than enough contiguous cells
  return ring.slice(0, length).map((cell, i) => {
    const [lat, lon] = cellToLatLng(cell);
    return { lat, lon, frp: 1, time: new Date(Date.UTC(2022, 6, 1, i)) };
  });
}

describe("splitIntoClusters", () => {
  it("returns one cluster for a set of spatially-adjacent detections", () => {
    const rows = adjacentChain(44.84, -1.03, 5);
    const clusters = splitIntoClusters(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rows).toHaveLength(5);
  });

  it("returns two clusters for two spatially-disjoint groups", () => {
    const near = adjacentChain(44.84, -1.03, 3);
    const far = adjacentChain(48.0, 2.0, 3); // Bordeaux area vs Paris area — never adjacent
    const clusters = splitIntoClusters([...near, ...far]);
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((c) => c.rows.length).sort();
    expect(sizes).toEqual([3, 3]);
  });

  it("returns an empty array for no input", () => {
    expect(splitIntoClusters([])).toEqual([]);
  });

  it("treats a single point as its own one-cell cluster", () => {
    const clusters = splitIntoClusters([{ lat: 44.84, lon: -1.03, frp: 1, time: new Date() }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].cellCount).toBe(1);
  });

  it("keeps spatially-adjacent but temporally-distant detections in separate clusters, matching pipeline/events.py's CLOSE_AFTER_H=48h gate", () => {
    const anchor = latLngToCell(44.84, -1.03, 8);
    const neighborCell = gridDisk(anchor, 1).find((c) => c !== anchor) as string;
    const [nLat, nLon] = cellToLatLng(neighborCell);
    const rows: HistoricalRow[] = [
      { lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-01-01T00:00:00Z") },
      { lat: nLat, lon: nLon, frp: 1, time: new Date("2022-03-01T00:00:00Z") }, // ~60 days later
    ];
    const clusters = splitIntoClusters(rows);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.rows.length).sort()).toEqual([1, 1]);
  });
});

import { assembleTrack } from "../src/historical_reconstruct";

describe("assembleTrack", () => {
  it("floors acq_time to a 6h UTC bin, matching pipeline/events.py's bin_start", () => {
    const rows = [{ lat: 44.84, lon: -1.03, frp: 5, time: new Date("2022-07-22T11:55:00Z") }];
    const track = assembleTrack(rows, "lookup-1");
    expect(track.series[0].bin).toBe("2022-07-22T06:00:00.000Z");
    expect(track.cell_bins?.[0][0]).toBe("2022-07-22T06:00:00.000Z");
  });

  it("only counts a cell as new the first time it appears, matching _cell_bins", () => {
    const cell1 = { lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-07-22T07:00:00Z") };
    const sameSpotLater = { lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-07-22T13:00:00Z") };
    const track = assembleTrack([cell1, sameSpotLater], "lookup-1");
    const bins = track.cell_bins ?? [];
    expect(bins).toHaveLength(2); // two 6h bins (06:00 and 12:00)
    expect(bins[1][1]).toEqual([]); // no NEW cells in the second bin, same cell reburned
  });

  it("sums frp per bin into series[].frp_sum", () => {
    const rows = [
      { lat: 44.84, lon: -1.03, frp: 3, time: new Date("2022-07-22T07:00:00Z") },
      { lat: 44.85, lon: -1.03, frp: 4, time: new Date("2022-07-22T08:00:00Z") },
    ];
    const track = assembleTrack(rows, "lookup-1");
    expect(track.series[0].frp_sum).toBe(7);
  });

  it("accumulates cum_cells across bins", () => {
    const rows = [
      { lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-07-22T07:00:00Z") },
      { lat: 44.85, lon: -1.03, frp: 1, time: new Date("2022-07-22T13:00:00Z") },
    ];
    const track = assembleTrack(rows, "lookup-1");
    expect(track.series.map((b) => b.cum_cells)).toEqual([1, 2]);
  });

  it("carries the given id and an empty frp_live — no live MTG series for a historical lookup", () => {
    const track = assembleTrack(
      [{ lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-07-22T07:00:00Z") }],
      "lookup-42",
    );
    expect(track.id).toBe("lookup-42");
    expect(track.frp_live).toEqual([]);
  });

  it("carries every distinct cell in .cells, deduped", () => {
    const track = assembleTrack(
      [
        { lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-07-22T07:00:00Z") },
        { lat: 44.84, lon: -1.03, frp: 1, time: new Date("2022-07-22T13:00:00Z") }, // same cell again
      ],
      "lookup-1",
    );
    expect(track.cells).toHaveLength(1);
  });
});

import { reconstructHistoricalFire } from "../src/historical_reconstruct";

function csvRow(lat: number, lon: number, date: string, time: string, frp = 5, conf = "n") {
  return `${lat},${lon},${date},${time},${conf},${frp}`;
}
const HEADER = "latitude,longitude,acq_date,acq_time,confidence,frp";

function toCsvRow(row: HistoricalRow): string {
  const date = row.time.toISOString().slice(0, 10);
  const hh = String(row.time.getUTCHours()).padStart(2, "0");
  const mm = String(row.time.getUTCMinutes()).padStart(2, "0");
  return csvRow(row.lat, row.lon, date, `${hh}${mm}`, row.frp);
}

describe("reconstructHistoricalFire", () => {
  it("returns no_data for an empty result set", () => {
    expect(reconstructHistoricalFire(`${HEADER}\n`, "lookup-1")).toEqual({ status: "no_data" });
  });

  it("returns no_data when every row was filtered out as low-confidence", () => {
    const csv = `${HEADER}\n${csvRow(44.84, -1.03, "2022-07-22", "1200", 1, "l")}\n`;
    expect(reconstructHistoricalFire(csv, "lookup-1")).toEqual({ status: "no_data" });
  });

  it("returns no_data when the only detections were a static source", () => {
    const rows = Array.from(
      { length: STATIC_CELL_DAYS },
      (_, i) => csvRow(44.84, -1.03, `2022-07-${String(i + 1).padStart(2, "0")}`, "1200"),
    ).join("\n");
    expect(reconstructHistoricalFire(`${HEADER}\n${rows}\n`, "lookup-1")).toEqual({ status: "no_data" });
  });

  it("returns ok with a real Track for a single-cluster result", () => {
    const csv = `${HEADER}\n${csvRow(44.84, -1.03, "2022-07-22", "1200")}\n`;
    const result = reconstructHistoricalFire(csv, "lookup-1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.track.id).toBe("lookup-1");
      expect(result.track.cells).toHaveLength(1);
    }
  });

  it("returns ambiguous with cluster summaries for two disjoint fires in the window", () => {
    const near = adjacentChain(44.84, -1.03, 3)
      .map((r) => csvRow(r.lat, r.lon, "2022-07-22", "1200"))
      .join("\n");
    const far = adjacentChain(48.0, 2.0, 3)
      .map((r) => csvRow(r.lat, r.lon, "2022-07-22", "1200"))
      .join("\n");
    const result = reconstructHistoricalFire(`${HEADER}\n${near}\n${far}\n`, "lookup-1");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.clusters).toHaveLength(2);
      expect(result.clusters.every((c) => c.rowCount === 3)).toBe(true);
    }
  });

  it("keeps the WHOLE cluster when static-cell rows are a minority of its members — event-level, not row-level, filtering", () => {
    const anchor = latLngToCell(44.84, -1.03, 8);
    const neighbors = gridDisk(anchor, 1).filter((c) => c !== anchor);
    const realCells = [anchor, ...neighbors.slice(0, 5)]; // 6 real, non-static cells
    const cellC = neighbors[5]; // 7th cell, directly adjacent to anchor -- the fire spreads into it

    const realRows: HistoricalRow[] = realCells.map((cell, i) => {
      const [lat, lon] = cellToLatLng(cell);
      return { lat, lon, frp: 1, time: new Date(Date.UTC(2022, 6, 1, i)) };
    });
    const [cLat, cLon] = cellToLatLng(cellC);
    // 3 detections in cellC during the fire's active window -- connects to realRows via
    // the 48h adjacent-cell rule. The minority share of this cluster.
    const inWindowRows: HistoricalRow[] = [0, 1, 2].map((d) => ({
      lat: cLat, lon: cLon, frp: 1, time: new Date(Date.UTC(2022, 6, 1 + d, 8)),
    }));
    // 17 much-older detections in the SAME cell, >48h from the fire and from each other's
    // day-neighbours -- only here to push cellC's distinct-day count to >= STATIC_CELL_DAYS
    // so it gets independently flagged static (reuses rowsOnDistinctDays' fixture idea).
    const oldRows: HistoricalRow[] = Array.from({ length: 17 }, (_, i) => ({
      lat: cLat, lon: cLon, frp: 1, time: new Date(Date.UTC(2022, 0, 1 + i, 8)),
    }));

    const csv = [HEADER, ...[...realRows, ...inWindowRows, ...oldRows].map(toCsvRow)].join("\n");
    const result = reconstructHistoricalFire(csv, "lookup-1");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // 6 real cells + cellC = 7 distinct cells in the surviving cluster.
      expect(result.track.cells).toHaveLength(7);
      expect(result.track.cells).toContain(cellC);
      // All 9 rows of the surviving cluster are present, not just the 6 non-static ones.
      const totalFrp = result.track.series.reduce((sum, b) => sum + b.frp_sum, 0);
      expect(totalFrp).toBe(9);
    }
  });

  it("drops the WHOLE cluster when static-cell rows are the majority -- contributes to no_data as the only surviving-candidate cluster", () => {
    const anchor2 = latLngToCell(50.0, 3.0, 8);
    const neighbors2 = gridDisk(anchor2, 1).filter((c) => c !== anchor2);
    const realCells2 = [anchor2, ...neighbors2.slice(0, 4)]; // 5 real cells
    const cellC2 = neighbors2[4]; // adjacent to anchor2

    const realRows: HistoricalRow[] = realCells2.map((cell, i) => {
      const [lat, lon] = cellToLatLng(cell);
      return { lat, lon, frp: 1, time: new Date(Date.UTC(2022, 7, 1, i)) };
    });
    const [cLat, cLon] = cellToLatLng(cellC2);
    // 15 distinct-day detections in cellC2 during the fire's active window, chained to
    // each other (24h apart) and to realRows via the 48h adjacent-cell rule -- the
    // MAJORITY of this cluster.
    const inWindowRows: HistoricalRow[] = Array.from({ length: 15 }, (_, d) => ({
      lat: cLat, lon: cLon, frp: 1, time: new Date(Date.UTC(2022, 7, 1 + d, 12)),
    }));
    // 5 much-older, disconnected detections in the same cell, only to push cellC2's
    // distinct-day count to exactly STATIC_CELL_DAYS (15 + 5 = 20).
    const oldRows: HistoricalRow[] = Array.from({ length: 5 }, (_, i) => ({
      lat: cLat, lon: cLon, frp: 1, time: new Date(Date.UTC(2022, 0, 1 + i, 12)),
    }));

    const csv = [HEADER, ...[...realRows, ...inWindowRows, ...oldRows].map(toCsvRow)].join("\n");
    const result = reconstructHistoricalFire(csv, "lookup-1");

    expect(result).toEqual({ status: "no_data" });
  });
});
