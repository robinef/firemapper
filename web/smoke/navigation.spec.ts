import { expect, test } from "@playwright/test";
import { fireCountLabel, fireRows, liveFireRows, openRail, waitForBoot } from "./helpers";

/**
 * Can a reader get in, and back out again?
 *
 * The unit suite proves the nav stack's arithmetic. It cannot prove that the
 * control a person actually presses is on screen, on top, and connected — and
 * three separate bugs here lived in that gap.
 */

test.describe("getting back out", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a fire card offers a way back to the map", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    await openRail(page, "rail-search", "search");
    const rows = fireRows(page);
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "detail");

    // The chip is the mobile escape hatch while a card is peeked: at that size
    // the back bar is hidden, so this is the only visible way out.
    const chip = page.locator("#view-chip");
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "map");
  });

  test("hardware back leaves a view, rather than the site", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await openRail(page, "rail-layers", "layers");

    // The whole reason the stack is history-backed: one backward path, so the
    // phone's own gesture agrees with the on-screen control.
    await page.goBack();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "map");
    await expect(page.locator("canvas")).toHaveCount(1);
  });
});

test.describe("desktop navigation", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the rail icon opens and closes the same view", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    // Re-tapping used to be a deliberate no-op, which read as a dead control:
    // the thing that opened the panel would not close it. Driven by a real
    // click, not element.click(), because a synthetic click ignores hit
    // testing and would pass even with the icon buried under the overlay.
    //
    // Desktop only, and that is the design rather than a convenience: at 375px
    // an open view is full-page and hides the rail entirely, so there is no
    // icon left to press. The mobile way out is the chip, asserted above.
    await openRail(page, "rail-layers", "layers");
    await page.locator("#rail-layers").click();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "map");
  });

  test("never sends the reader the wrong way at high zoom", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    await openRail(page, "rail-search", "search");
    // A LIVE fire specifically. The list is size-ordered and its first row is
    // usually burned out; "Active fires" excludes closed ones, so flying to one
    // lands somewhere the counter says nothing and proves nothing. That is
    // what the first version of this test did, and it failed against a label
    // left over from the continental view it had not yet left.
    const rows = liveFireRows(page);
    if ((await rows.count()) === 0) test.skip(true, "fixture has no active fires");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator("#view")).toHaveAttribute("data-view", "detail");

    // Opening a card flies to z10.5. The dots used to stop at z9.5, so the
    // count fell to zero and the label said "zoom in for the rest" — advice
    // that caused the state it described and never escaped it.
    //
    // Scope: this asserts the LABEL, not what renders. countFires derives
    // `shown` from HANDOVER_ZOOM in JS and never reads the layer's maxzoom, so
    // restoring that cutoff breaks the map while leaving this green (verified
    // by mutation). The layer config is pinned in tests/layer_fires.test.ts
    // instead; what lives here is that the two agree at the zoom a card lands
    // on.
    //
    // Polled, because the counter refreshes on moveend and the flight takes
    // ~2s; the assertion still fails if the label never settles.
    await openRail(page, "rail-layers", "layers");
    await expect
      .poll(async () => await fireCountLabel(page), {
        message: "counter never settled after flying to a live fire",
        timeout: 25_000,
      })
      .toMatch(/^\d+ in view$/);
  });
});
