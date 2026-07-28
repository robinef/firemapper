import { describe, expect, it } from "vitest";
import { VIIRS_LAYERS, viirsTileUrl } from "../src/map";

describe("VIIRS GIBS layer", () => {
  it("requests both 375 m VIIRS sensors for the given day", () => {
    const u = viirsTileUrl("2026-07-23");
    expect(u).toContain("VIIRS_NOAA20_Thermal_Anomalies_375m_All");
    expect(u).toContain("VIIRS_SNPP_Thermal_Anomalies_375m_All");
    expect(u).toContain("TIME=2026-07-23");
  });

  it("keeps the bbox token unencoded so MapLibre can substitute it", () => {
    expect(viirsTileUrl("2026-07-23")).toContain("{bbox-epsg-3857}");
  });

  it("combines sensors in one request", () => {
    expect(VIIRS_LAYERS.split(",")).toHaveLength(2);
  });
});
