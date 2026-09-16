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
