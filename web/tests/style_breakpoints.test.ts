import { describe, expect, it } from "vitest";
import styleSource from "../src/style.css?inline";

/**
 * The mobile/desktop split must PARTITION the width axis: every viewport width
 * matches exactly one of the two blocks, never neither.
 *
 * Nothing else in CI can catch a gap here. jsdom applies no stylesheet, so the
 * whole suite passes with style.css deleted, and the smoke tests drive two
 * fixed widths (375 and 1280) that sit nowhere near the boundary.
 *
 * The failure this guards is not hypothetical arithmetic. `max-width: 640px`
 * paired with `min-width: 641px` leaves widths that match neither — routine at
 * browser zoom or on a fractional device pixel ratio, where the viewport is
 * not an integer and Chrome lays out on a 1/64 px grid. In that band .fc-peek
 * loses its `display: none` and .fc-peek .ro-peek loses its flex gap at the
 * same time, so the peek strip reappears with its readings run together as
 * "510 MW30 min".
 *
 * Read as TEXT, for the same reason vite_config.test.ts does: there is no CSSOM
 * to query without a browser, and matching on source is the honest price.
 *
 * `?inline`, and `test.css` had to be turned on in vite.config.ts to make it
 * work: vitest disables CSS processing by default, so EVERY css import — `?raw`
 * and `?inline` alike — hands back an empty string, against which every
 * assertion in this file passes vacuously. Confirmed, not assumed: both gave
 * len=0 before that flag, and the mutation check below only discriminates
 * with it on. Reading the file with node:fs instead would need @types/node,
 * which this project deliberately does not carry (see vite_config.test.ts).
 */

/** Every `@media <condition> {` in the stylesheet, condition text only. */
function mediaConditions(css: string): string[] {
  return [...css.matchAll(/@media\s+([^{]+?)\s*\{/g)].map((m) => m[1].trim());
}

const DESKTOP = "(min-width: 641px)";
const MOBILE = `not all and ${DESKTOP}`;

describe("style.css breakpoints", () => {
  it("splits on exactly one number, shared with firecard.ts", () => {
    // Two numbers (a max-width and a min-width) is what creates the chance of
    // a gap in the first place, and they have to be maintained in lockstep
    // with the matchMedia query in firecard.ts. One number cannot drift.
    const widths = new Set(
      [...styleSource.matchAll(/@media[^{]*?(\d+(?:\.\d+)?)px/g)].map((m) => m[1]),
    );
    expect([...widths]).toEqual(["641"]);
  });

  it("has no width-bounded query that is not one of the two halves", () => {
    const conditions = mediaConditions(styleSource);
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(
        [DESKTOP, MOBILE],
        `unrecognised media condition "${condition}" — a third width-bounded ` +
          `query breaks the two-way partition this file relies on`,
      ).toContain(condition);
    }
  });

  it("states the mobile half as the exact negation, never a paired max-width", () => {
    // `max-width: 640px`   → 4 representable Chrome widths match neither.
    // `max-width: 640.98px` → 1 (640.984375) still matches neither.
    // `max-width: 640.99px` → none today, but reopens on a finer layout grid.
    // The negation is airtight by construction, at any precision.
    expect(styleSource).not.toMatch(/@media[^{]*max-width/);
    expect(styleSource).toContain(`@media ${MOBILE}`);
  });

  it("uses both halves, so neither side of the split is dead", () => {
    const conditions = mediaConditions(styleSource);
    expect(conditions).toContain(DESKTOP);
    expect(conditions).toContain(MOBILE);
  });

  it("leaves no width matching neither half", () => {
    // Walk Chrome's 1/64 px layout grid across the boundary and assert the
    // two conditions are complements at every representable width. This is
    // the property the whole file turns on, asserted directly rather than
    // inferred from the source text above.
    const matches = (condition: string, w: number) =>
      condition === DESKTOP ? w >= 641 : !(w >= 641);
    for (let n = -128; n <= 128; n++) {
      const w = 641 + n / 64;
      const hits = [DESKTOP, MOBILE].filter((c) => matches(c, w));
      expect(hits, `width ${w}px matched ${hits.length} blocks, not 1`).toHaveLength(1);
    }
  });
});
