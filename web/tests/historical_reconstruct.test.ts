import { describe, expect, it } from "vitest";
import { parseFirmsCsv } from "../src/historical_reconstruct";

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
});
