/**
 * The desktop overlay: the fire's live reading, parked over the map beside the
 * card rather than inside it.
 *
 * Deliberately a SIBLING of #view, never a child. #view is switched by
 * `data-view` — it holds the layer list, the fire card, the search results and
 * the info panel in one container and shows exactly one of them at a time. A
 * readout parented inside would disappear the instant someone tapped the
 * layers icon, which is precisely the behaviour that made the level-2 layer
 * list feel missing and prompted this whole piece of work.
 *
 * Which mount is live is decided in firecard.ts, at the same 641px breakpoint
 * style.css uses: on desktop this overlay carries the reading and the card
 * carries none; below it the card carries both of its renderings and this
 * overlay is never mounted at all. Exactly one, ever.
 */

import { renderReadoutFull, type Readout } from "./fire_readout";

const ID = "fire-readout";

/** Remove the overlay if one is mounted. Safe to call when none is: the
 *  breakpoint handler runs it on every narrow-ward crossing, including the
 *  ones where nothing was ever mounted. */
export function clearReadout(root: HTMLElement): void {
  root.querySelector(`#${ID}`)?.remove();
}

/**
 * Show `model` in the overlay, replacing whatever was there. A null model —
 * or one carrying no reading at all — mounts nothing rather than an empty
 * bordered box in the corner of the map, which would claim there is a reading
 * and then decline to give one.
 */
export function mountReadout(root: HTMLElement, model: Readout | null): void {
  // Unconditional, and first: this is also what makes a repeat mount replace
  // rather than stack a second box on the previous fire's.
  clearReadout(root);
  if (!model) return;
  const html = renderReadoutFull(model);
  if (!html) return;
  const el = document.createElement("div");
  el.id = ID;
  el.innerHTML = html;
  root.appendChild(el);
}
