import { describe, expect, it } from "vitest";
import { EU27, isEuCountry } from "../src/eu27";
import { EU27 as EU27_VIA_FILTER } from "../src/season_filter";

/**
 * Membership is a fact about the world, not about a layer: it changes when a
 * treaty changes, and every EU-only view in the app has to change with it at
 * the same instant. These assertions are the contract of the one place that
 * holds it.
 */
describe("EU27", () => {
  it("holds exactly the 27 member states", () => {
    expect(EU27.size).toBe(27);
  });

  it("is written in ISO 3166-1 alpha-2, upper case", () => {
    for (const code of EU27) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it("contains every member state", () => {
    // The full roster, spelled out: a test that only spot-checks a handful
    // would pass with a member silently missing, and a missing member is a
    // country's fires quietly dropped from an "EU-27" total.
    const members = [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
      "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    ];
    for (const code of members) expect(EU27.has(code)).toBe(true);
    expect([...EU27].sort()).toEqual([...members].sort());
  });

  it("excludes European non-members", () => {
    // Every one of these appears in the season layer's Europe box, so each is a
    // country the EU-27 scope has to leave out — GB and the EFTA states because
    // they left or never joined, UA/RU/TR because the box simply reaches them.
    for (const outside of ["GB", "CH", "NO", "IS", "UA", "RU", "TR", "RS", "DZ", "MA"]) {
      expect(EU27.has(outside)).toBe(false);
    }
  });
});

describe("isEuCountry", () => {
  it("is true for a member state's code", () => {
    expect(isEuCountry("ES")).toBe(true);
    expect(isEuCountry("FR")).toBe(true);
  });

  it("is false for a non-member", () => {
    expect(isEuCountry("UA")).toBe(false);
  });

  // "Unknown" is not "EU". A fire the geocoder could not place must not be
  // counted into a total the reader will compare against an EFFIS EU-27 number.
  it("is false for a missing code", () => {
    expect(isEuCountry(null)).toBe(false);
    expect(isEuCountry(undefined)).toBe(false);
    expect(isEuCountry("")).toBe(false);
  });

  // The codes in blob_{year}_fires.json are upper case (GeoNames-derived). A
  // case-insensitive match here would be a lie about what the data contains.
  it("is case-sensitive", () => {
    expect(isEuCountry("es")).toBe(false);
  });
});

describe("season_filter's re-export", () => {
  // season_filter re-exports EU27 so its existing importers keep working. It
  // must be the SAME set, not a copy that can drift from the module above.
  it("is the very same set", () => {
    expect(EU27_VIA_FILTER).toBe(EU27);
  });
});
