import { expect, test } from "@playwright/test";
import { boxOf, expectNoOverlap, fireRows, openRail, waitForBoot } from "./helpers";

/**
 * Nothing covers anything else.
 *
 * jsdom computes no layout, so not one assertion in the unit suite can see a
 * collision. Every rule checked here corresponds to a defect that shipped, or
 * came within one review of shipping, while the suite was green.
 */

/** Rotate the map the way a mouse does it: right-button drag across the
 *  canvas. The built bundle has no map handle, so the gesture is the API. */
async function rotateMap(page: import("@playwright/test").Page): Promise<void> {
  const c = (await page.locator("canvas").boundingBox())!;
  const x = c.x + c.width / 2, y = c.y + c.height * 0.3;
  await page.mouse.move(x - 80, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x + 80, y + 40, { steps: 12 });
  await page.mouse.up({ button: "right" });
}

/** The north-up compass: absent at north, present once rotated, clear of
 *  the chrome it stacks beside, and one tap puts north back up. */
async function compassRoundTrip(page: import("@playwright/test").Page): Promise<void> {
  const compass = page.locator(".maplibregl-ctrl-compass");
  await expect(compass, "no compass while the map points north").toBeHidden();
  await rotateMap(page);
  await expect(compass, "a rotated map offers the way back").toBeVisible();
  await expectNoOverlap(page, ".maplibregl-ctrl-compass", "#timeline", "the compass must clear the time bar");
  await expectNoOverlap(page, ".maplibregl-ctrl-compass", "#rail", "the compass must clear the rail");
  await expectNoOverlap(page, ".maplibregl-ctrl-compass", ".maplibregl-ctrl-attrib", "the compass must clear the credits");
  await compass.click();
  await expect(compass, "north is back up, so the compass goes").toBeHidden();
}

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

  test("opens on a map that shows fires, not an empty Alps", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // The desktop camera (lon 10, zoom 4.2) spans ~100° at 1280px but ~30° at
    // 375, framing Germany and the Alps: production read "0 of 300 in view".
    // The sample fires are Iberian, as most of a season's are.
    await openRail(page, "rail-layers", "layers");
    // "N in view" when all are drawn, "S of N in view" when some are below the
    // size gate, and nothing at all when none are in view.
    const hint = (await page.locator("#layers").textContent()) ?? "";
    const m = hint.match(/(\d+) of \d+ in view/) ?? hint.match(/(\d+) in view/);
    expect(Number(m?.[1] ?? 0), `layers panel says: "${m?.[0] ?? "no fire in view"}"`).toBeGreaterThan(0);
  });

  test("a rotated map gets a north-up compass, 44px, clear of the chrome", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await compassRoundTrip(page);
    // A two-finger twist rotates the map on a phone; the fix is a finger target.
    await rotateMap(page);
    const box = await boxOf(page, ".maplibregl-ctrl-compass");
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
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

  test("the card's before/after button and the sources link are 44px targets", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // The last two controls under 44px: .fc-ba was 35px, and .info-more an
    // inline link 17px tall.
    await openRail(page, "rail-search", "search");
    await fireRows(page).first().click();
    await page.locator(".fc-peek").click();
    await expect(page.locator("#view")).toHaveAttribute("data-size", "full");
    const ba = await boxOf(page, ".fc-ba");
    expect(ba, "the before/after button must be on screen").not.toBeNull();
    expect(ba!.height).toBeGreaterThanOrEqual(44);
    await page.goto("/");
    await waitForBoot(page);
    await openRail(page, "rail-info", "info");
    const more = await boxOf(page, ".info-more");
    expect(more, "the sources link must be on screen").not.toBeNull();
    expect(more!.height).toBeGreaterThanOrEqual(44);
  });

  test("a rotated map keeps its compass above the before/after swipe", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await rotateMap(page);
    await expect(page.locator(".maplibregl-ctrl-compass")).toBeVisible();
    // Real compare mode needs Sentinel tiles the preview server does not
    // proxy, so stand in for it exactly: the body class, and an opaque layer
    // with layer_imagery.ts's wrapper stacking (absolute, z-index 2),
    // appended to the map container after the control corners as the
    // after-map is. Without its pointer-events:none: elementFromPoint skips
    // such an element, and it is what is painted on top that matters here.
    const hit = await page.evaluate(() => {
      document.body.classList.add("compare-mode");
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:absolute;inset:0;z-index:2;background:#000";
      document.querySelector("#map")!.appendChild(wrap);
      const r = document.querySelector(".maplibregl-ctrl-compass")!.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top?.closest(".maplibregl-ctrl-compass") != null;
    });
    expect(hit, "the after-map must not cover the compass").toBe(true);
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

  test("a rotated map gets a north-up compass, clear of the chrome", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await compassRoundTrip(page);
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

/**
 * The smallest phone held sideways: 568px wide keeps the phone layout, but
 * the 320px height cannot fit the whole time bar and the chrome above it.
 */
test.describe("small phone landscape 568x320, touch", () => {
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });

  test("a peeked card leaves the header, the rail and the credits on screen", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    // The whole time bar was 176px of the 320. One day picker stays: the
    // play/slider row where there is one...
    await expect(page.locator("#timeline .tl-bars")).toBeHidden();
    await expect(page.locator("#timeline .scrub-play")).toBeVisible();
    // ...else the histogram. The sample's first fire has no cell_bins, so
    // its card timeline has no scrubber and must keep its bars.
    await openRail(page, "rail-search", "search");
    await fireRows(page).first().tap();
    await expect(page.locator("#view")).toHaveAttribute("data-size", "peek");
    await expect(page.locator("#timeline .scrub-row")).toHaveCount(0);
    await expect(page.locator("#timeline .tl-bars")).toBeVisible();

    // Raised for the peek strip, the rail row rode up over the header and
    // pushed the credits off the top edge.
    await expectNoOverlap(page, "#rail", "#header", "the rail must clear the header");
    await expectNoOverlap(page, "#rail", ".fc-peek", "the rail must clear the peek strip");
    const attrib = await boxOf(page, ".maplibregl-ctrl-attrib");
    expect(attrib, "the credits must be rendered").not.toBeNull();
    expect(attrib!.y, "the credits must stay on screen").toBeGreaterThanOrEqual(0);
    await expectNoOverlap(page, ".maplibregl-ctrl-attrib", "#header", "the credits must clear the header");
  });
});
