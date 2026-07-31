/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { escapeHtml, safeHttpUrl } from "../src/escape";
import { renderAircraftPanel } from "../src/panel";

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

describe("renderAircraftPanel escaping", () => {
  it("does not emit markup from a spoofed callsign", () => {
    // Anyone with a transponder can broadcast this. The pipeline refuses it at
    // ingest; the sink must not depend on that.
    const html = renderAircraftPanel({
      callsign: `PELICAN1<img src=x onerror=alert(1)>`,
      type: "Canadair CL-415",
      role: "water bomber",
      country: "France",
      pos_time: Math.floor(Date.now() / 1000),
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes type, role and country too", () => {
    const html = renderAircraftPanel({
      callsign: "MILAN78",
      type: `<script>1</script>`,
      role: `"><b>injected`,
      country: `<i>x</i>`,
      pos_time: Math.floor(Date.now() / 1000),
    });
    // Assert on the injected payloads specifically — the panel's own markup
    // legitimately contains <b> and <div>, so a bare "no angle brackets"
    // assertion would be testing the wrong thing.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>injected");
    expect(html).not.toContain("<i>x</i>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;injected");
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
  });
});
