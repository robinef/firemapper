import { expect, type Page, type Locator } from "@playwright/test";

/** Screen-space box, in CSS pixels, of a rendered element. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Wait for boot to finish, using only signals a reader can see.
 *
 * `window.__map` is DEV-only, so a suite running against the built output
 * cannot ask maplibre whether it loaded. That is a feature: these are the same
 * signals a person uses, and they only appear after `map.on("load")` has run.
 * When the maplibre worker 404'd, every one of them stayed absent while the
 * network showed nothing but 200s.
 */
export async function waitForBoot(page: Page): Promise<void> {
  // The splash is removed 450ms after the layers mount, so its absence is the
  // single strongest "the map actually loaded" signal available from outside.
  await expect(page.locator("#loading")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator("#header")).not.toBeEmpty();
  await expect(page.locator("#rail button")).toHaveCount(3);
  await expect(page.locator("canvas")).toHaveCount(1);
}

/** Box of an element, or null when it is not rendered at all. */
export async function boxOf(page: Page, selector: string): Promise<Box | null> {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) return null;
  if (!(await el.isVisible())) return null;
  return await el.boundingBox();
}

/** Do two rendered elements share any pixel? */
export function overlaps(a: Box, b: Box): boolean {
  return !(
    a.y + a.height <= b.y ||
    a.y >= b.y + b.height ||
    a.x + a.width <= b.x ||
    a.x >= b.x + b.width
  );
}

/**
 * Assert two elements are BOTH on screen and do not cover each other.
 *
 * Requiring presence is the whole point. An earlier version skipped silently
 * when either box was missing, which made it vacuous exactly where it mattered
 * most: #view-chip only renders while a card is peeked, so a test that had not
 * opened one asserted nothing at all — and passed happily with the chip moved
 * back on top of the freshness badge. A collision test that cannot fail is
 * worse than no test, because it reads as coverage.
 *
 * Use `expectNoOverlapIfBothPresent` for the genuinely breakpoint-dependent
 * pairs, and say in the test why absence is acceptable there.
 *
 * The message carries both boxes because "they overlapped" is not actionable
 * and the numbers are what tell you which rule moved.
 */
export async function expectNoOverlap(
  page: Page,
  aSel: string,
  bSel: string,
  why: string,
): Promise<void> {
  const [a, b] = [await boxOf(page, aSel), await boxOf(page, bSel)];
  expect(a, `${aSel} must be on screen for this assertion to mean anything`).not.toBeNull();
  expect(b, `${bSel} must be on screen for this assertion to mean anything`).not.toBeNull();
  expect(
    overlaps(a, b),
    `${aSel} must not cover ${bSel} — ${why}\n` +
      `  ${aSel}: y ${Math.round(a.y)}–${Math.round(a.y + a.height)}, ` +
      `x ${Math.round(a.x)}–${Math.round(a.x + a.width)}\n` +
      `  ${bSel}: y ${Math.round(b.y)}–${Math.round(b.y + b.height)}, ` +
      `x ${Math.round(b.x)}–${Math.round(b.x + b.width)}`,
  ).toBe(false);
}

/** The lenient variant, for pairs where one side legitimately does not render
 *  at this breakpoint. Every call site must say why absence is expected. */
export async function expectNoOverlapIfBothPresent(
  page: Page,
  aSel: string,
  bSel: string,
  why: string,
): Promise<void> {
  const [a, b] = [await boxOf(page, aSel), await boxOf(page, bSel)];
  if (!a || !b) return;
  await expectNoOverlap(page, aSel, bSel, why);
}

/** The layer row's live count, or null when the row says nothing. */
export async function fireCountLabel(page: Page): Promise<string | null> {
  const el = page.locator(".layer-count").first();
  if ((await el.count()) === 0) return null;
  return (await el.textContent())?.trim() ?? null;
}

/** Open a rail view by id, and wait for the shell to actually switch. */
export async function openRail(page: Page, id: string, view: string): Promise<void> {
  await page.locator(`#${id}`).click();
  await expect(page.locator("#view")).toHaveAttribute("data-view", view);
}

/** Rows in the search list, which is the only reliable route to a fire card:
 *  clicking a dot needs a dot to be under a known pixel, and which fires are
 *  drawn depends on the fixture. */
export function fireRows(page: Page): Locator {
  return page.locator(".fl-row");
}

/**
 * Rows for fires that are still burning.
 *
 * The list is ordered by size, so its first row is often a burned-out fire —
 * and "Active fires" excludes closed ones from its count deliberately. Flying
 * to one therefore lands on a view with zero live fires, where the counter
 * correctly renders nothing and cannot demonstrate anything about zoom.
 */
export function liveFireRows(page: Page): Locator {
  return page.locator(".fl-row", { hasText: "Active" });
}
