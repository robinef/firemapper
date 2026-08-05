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
});
