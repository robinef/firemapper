/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { escapeHtml, safeHttpUrl } from "../src/escape";

describe("escapeHtml", () => {
  it("neutralises every HTML metacharacter", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("renders null and undefined as empty, not as the word", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("safeHttpUrl", () => {
  it("keeps ordinary http(s) links", () => {
    expect(safeHttpUrl("https://gdacs.org/report?e=1")).toContain("https://gdacs.org/report");
  });

  it("refuses javascript: — an href is a script sink, not just text", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBe("#");
    expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBe("#");
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
  });

  it("refuses empty and unparseable input", () => {
    expect(safeHttpUrl(null)).toBe("#");
    expect(safeHttpUrl("")).toBe("#");
    expect(safeHttpUrl("   ")).toBe("#");
  });
});
