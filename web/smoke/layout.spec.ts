import { expect, test } from "@playwright/test";
import { boxOf, expectNoOverlap, fireRows, openRail, waitForBoot } from "./helpers";

/**
 * Nothing covers anything else.
 *
 * jsdom computes no layout, so not one assertion in the unit suite can see a
 * collision. Every rule checked here corresponds to a defect that shipped, or
 * came within one review of shipping, while the suite was green.
 */

test.describe("mobile 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the rail clears the time bar", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await expectNoOverlap(page, "#rail", "#timeline", "the rail must clear the time bar");
  });

  test("the view chip clears the freshness badge", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    // A card must be OPEN first: #view-chip only renders while one is peeked
    // (body[data-size="peek"]). Asserting at boot passes with the chip parked
    // straight back on top of the badge, because there is no chip to measure —
    // which is how the first version of this test failed to catch that.
    await openRail(page, "rail-search", "search");
    const rows = fireRows(page);
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator("#view")).toHaveAttribute("data-size", "peek");
    await expect(page.locator("#view-chip")).toBeVisible();

    // The chip moved from top 12px to 56px for exactly this reason: the
    // freshness badge is the project's contract with the reader about how old
    // the data is, and a chip parked on top of it hid that.
    await expectNoOverlap(page, "#view-chip", "#header", "the freshness badge must stay readable");
  });

  test("the scale-blob control sits inside the layers panel, not floating over the map", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    // It moved out of the map's floating chrome and into #sidebar — the same
    // panel Wind/Fires/etc. live in, reachable the same way, rather than a
    // separately-positioned button whose corner had to be kept clear of
    // #header and #fire-readout by hand. Only rendered once the layers view
    // is actually open, same as every other row in that panel.
    await openRail(page, "rail-layers", "layers");

    await expect(page.locator("#scale-blob-toggle")).toBeVisible();
    // The spec's binding framing, asserted where a reader would see it rather
    // than only in the stylesheet: a large mass of real fire outlines with no
    // statement that it is a PARTIAL footprint reads as the whole season.
    await expect(page.locator("#scale-blob-note")).toHaveText(
      /EU-27 · detected fire footprint, archived fires only/i,
    );

    // Structurally inside #sidebar, stacked below the layer checkboxes in
    // normal flow — not escaped back out to some independent floating
    // position, the failure mode the old absolutely-positioned version had.
    const control = await boxOf(page, "#scale-blob-control");
    const sidebar = await boxOf(page, "#sidebar");
    const layers = await boxOf(page, "#layers");
    expect(control, "#scale-blob-control must be on screen").not.toBeNull();
    expect(sidebar, "#sidebar must be on screen").not.toBeNull();
    expect(layers, "#layers must be on screen").not.toBeNull();
    expect(control!.x).toBeGreaterThanOrEqual(sidebar!.x - 1);
    expect(control!.x + control!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width + 1);
    expect(control!.y).toBeGreaterThanOrEqual(layers!.y + layers!.height - 1);
  });

  test("a peeked fire card clears both the rail and the time bar", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    await openRail(page, "rail-search", "search");
    const rows = fireRows(page);
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator("#view")).toHaveAttribute("data-size", "peek");

    // --timebar is measured from #timeline at runtime. It was a hardcoded
    // 120px guess against a real 164px, which put the rail 44px into the time
    // bar and the peek strip over the histogram.
    await expectNoOverlap(page, "#rail", ".fc-peek", "the rail must clear the peek strip");
    await expectNoOverlap(page, ".fc-peek", "#timeline", "the peek strip must clear the time bar");
    await expectNoOverlap(page, "#rail", "#timeline", "the rail must clear the time bar");
  });

  test("an open view is full-page, never a half-open middle state", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await openRail(page, "rail-layers", "layers");

    const view = await boxOf(page, "#view");
    const viewport = page.viewportSize()!;
    expect(view, "#view must be rendered once layers is open").not.toBeNull();
    // "Small screens can only either show the map, or a full-page overlay."
    expect(
      view!.height,
      `#view is ${Math.round(view!.height)}px tall in a ${viewport.height}px viewport`,
    ).toBeGreaterThan(viewport.height * 0.9);
  });

  test("the map attribution clears the time bar and the rail", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    // It sat UNDER the time bar at every phone size: the lift rule matched
    // maplibre-gl.css on specificity and lost on bundle order. The OSM and
    // CARTO credits are a licence condition, not decoration.
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", "#timeline", "the credits must clear the time bar");
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", "#rail", "the credits must clear the rail");

    // The peek strip pushes the rail up 56px; the credits have to follow it.
    await openRail(page, "rail-search", "search");
    await fireRows(page).first().click();
    await expect(page.locator("#view")).toHaveAttribute("data-size", "peek");
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", "#rail", "the credits must clear the raised rail");
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", ".fc-peek", "the credits must clear the peek strip");
  });

  test("text inputs are 16px, so iOS Safari does not zoom in on focus", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // iOS zooms into any focused input under 16px and never zooms back out.
    // Chromium does not, so the computed size is the only thing to assert.
    const px = (sel: string) =>
      page.locator(sel).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    await openRail(page, "rail-search", "search");
    expect(await px(".fl-search")).toBeGreaterThanOrEqual(16);
    await page.goBack();
    await openRail(page, "rail-historical", "historical");
    for (const sel of ["#historical-lookup-q", "#historical-lookup-before", "#historical-lookup-after"]) {
      expect(await px(sel), sel).toBeGreaterThanOrEqual(16);
    }
  });
});

test.describe("desktop 1280x800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the slide-out sits beside the rail and clears the time bar", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await openRail(page, "rail-layers", "layers");

    await expectNoOverlap(page, "#view", "#rail", "the panel must sit beside the icon rail");

    // The desktop max-height was calc(100% - 130px), a static guess that ran
    // 44px into a time bar which is actually ~164px tall once a fire card
    // swaps its own series in. It now reads the measured --timebar.
    await expectNoOverlap(page, "#view", "#timeline", "the panel must clear the time bar");
  });

  test("the scale-blob control sits inside the layers panel, not floating over the map", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    // It moved out of the map's floating chrome and into #sidebar — the same
    // slide-out panel Wind/Fires/etc. live in at this width (left: 68px,
    // width: 320px), rather than a bottom-right button that had to be kept
    // clear of #fire-readout, #header, and the time bar by hand.
    await openRail(page, "rail-layers", "layers");

    await expect(page.locator("#scale-blob-toggle")).toBeVisible();
    await expect(page.locator("#scale-blob-note")).toHaveText(
      /EU-27 · detected fire footprint, archived fires only/i,
    );

    const control = await boxOf(page, "#scale-blob-control");
    const sidebar = await boxOf(page, "#sidebar");
    const layers = await boxOf(page, "#layers");
    expect(control, "#scale-blob-control must be on screen").not.toBeNull();
    expect(sidebar, "#sidebar must be on screen").not.toBeNull();
    expect(layers, "#layers must be on screen").not.toBeNull();
    expect(control!.x).toBeGreaterThanOrEqual(sidebar!.x - 1);
    expect(control!.x + control!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width + 1);
    expect(control!.y).toBeGreaterThanOrEqual(layers!.y + layers!.height - 1);
  });

  test("mobile-only chrome stays hidden here", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // Both are mobile affordances. On desktop the panel is always full, so a
    // peek strip would be a control that does nothing. Asserted as hidden
    // rather than skipped, so "it never rendered" cannot pass for "it did not
    // collide".
    await expect(page.locator("#view-chip")).toBeHidden();
    await expect(page.locator(".fc-peek")).toBeHidden();
  });

  test("the map attribution and scale bar clear the time bar and the rail", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // Both lift rules lost to maplibre-gl.css, so both controls sat under the
    // time bar.
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", "#timeline", "the credits must clear the time bar");
    await expectNoOverlap(page, ".maplibregl-ctrl-scale", "#timeline", "the scale bar must clear the time bar");
  });
});

/**
 * A phone held sideways is 844px wide, so the width split hands it the desktop
 * layout. Touch sizing has to follow the finger too, or the card's ✕ is 29x24.
 */
test.describe("phone landscape 844x390, touch", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("touch targets stay 44px and the card's two corner buttons do not overlap", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    // Only a short viewport brings the rail column down to the scale bar's
    // row; at 1280x800 the rail ends 500px above it and cannot catch this.
    await expectNoOverlap(page, ".maplibregl-ctrl-scale", "#rail", "the scale bar must clear the rail");
    await expectNoOverlap(page, ".maplibregl-ctrl-scale", "#timeline", "the scale bar must clear the time bar");

    const play = await boxOf(page, "#timeline .scrub-play");
    expect(play, "the play button must be on screen").not.toBeNull();
    expect(play!.width).toBeGreaterThanOrEqual(44);
    expect(play!.height).toBeGreaterThanOrEqual(44);

    await openRail(page, "rail-search", "search");
    await fireRows(page).first().tap();
    await expect(page.locator(".fc-close")).toBeVisible();
    for (const sel of [".fc-close", ".fc-share"]) {
      const b = await boxOf(page, sel);
      expect(b, `${sel} must be on screen`).not.toBeNull();
      expect(b!.width, sel).toBeGreaterThanOrEqual(44);
      expect(b!.height, sel).toBeGreaterThanOrEqual(44);
    }
    // At 44px wide, ✕ (right 14px) and 🔗 (right 46px) shared 12px.
    await expectNoOverlap(page, ".fc-close", ".fc-share", "a tap must land on the button it aims at");
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", "#timeline", "the credits must clear the time bar");
  });
});
