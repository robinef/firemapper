import { onUi } from "./ui_events";

/** One bin per step. Slow enough to read a fire's shape, fast enough that a
 *  30-bin history plays in about 13 seconds. */
export const STEP_MS = 450;

/**
 * Why a bin was handed to onScrub. The scrubber cannot see a consumer's
 * selection state (e.g. day_slice_select's shownDay) — caching a guess at it
 * is what caused the regression this type replaces (see git history on
 * `lastEmitted`). Instead the scrubber tells the truth about what IT knows:
 * whether this emit is the user picking a bin ("select": a drag) or playback
 * landing on one ("step": the play button's start or a tick's advance). A
 * consumer that toggles on repeat selections (day_slice_select) can then
 * apply that toggle only to "select" — landing on a bin via playback must
 * always show it, never hide it.
 */
export type ScrubCause = "select" | "step";

export interface ScrubberOpts {
  count: number;
  labelFor: (i: number) => string;
  onScrub: (i: number, cause: ScrubCause) => void;
  /** Where the control starts. A caller may have already painted a bin other
   *  than 0 before mounting (e.g. a fire card opens on the full footprint) —
   *  the label is this feature's whole point, so it must agree with what's
   *  already on screen instead of defaulting to a bin nothing shows.
   *  Defaults to 0 (the overview histogram is unaffected). */
  initialIndex?: number;
}

export interface Scrubber {
  setIndex(i: number): void;
  destroy(): void;
  readonly index: number;
  readonly playing: boolean;
}

export function mountScrubber(host: HTMLElement, opts: ScrubberOpts): Scrubber {
  const last = Math.max(0, opts.count - 1);
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const row = document.createElement("div");
  row.className = "scrub-row";
  row.innerHTML =
    `<button class="scrub-play" type="button" aria-label="Play fire history">▶</button>` +
    `<input class="scrub-range" type="range" min="0" max="${last}" value="0" step="1">` +
    `<span class="scrub-label"></span>`;
  host.appendChild(row);

  const play = row.querySelector<HTMLButtonElement>(".scrub-play")!;
  const range = row.querySelector<HTMLInputElement>(".scrub-range")!;
  const label = row.querySelector<HTMLElement>(".scrub-label")!;

  range.setAttribute("aria-label", "Fire history position");

  const clamp = (i: number) => Math.min(last, Math.max(0, Math.trunc(i)));

  /** Move the control only. Never calls onScrub — see setIndex's test. */
  const show = (i: number) => {
    index = clamp(i);
    range.value = String(index);
    const text = opts.labelFor(index);
    // Screen readers announce aria-valuetext in preference to the raw number,
    // so a listener hears "Jul 29 · 0 new cells" instead of "7".
    range.setAttribute("aria-valuetext", text);
    label.textContent = text;
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    play.textContent = "▶";
    play.setAttribute("aria-label", "Play fire history");
  };

  const tick = () => {
    if (index >= last) {
      stop(); // deliberately no loop: a fire restarting every few seconds reads
      return; // as a glitch rather than a story
    }
    show(index + 1);
    opts.onScrub(index, "step");
    timer = setTimeout(tick, STEP_MS);
  };

  play.addEventListener("click", () => {
    if (timer) {
      stop();
      return;
    }
    // Playing from the end would otherwise do nothing at all.
    if (index >= last) show(0);
    // Emit the bin playback starts from — otherwise the first tick's
    // show(index + 1) skips straight past it and a play-from-0 never shows
    // bin 0 at all, even though the restart-from-end case (above) does. This
    // must always fire, even if that bin was already handed to onScrub (a
    // drag or a bar click landed here just before Play was pressed): tagging
    // it "step" rather than skipping it is what lets a toggling consumer show
    // the bin instead of reading a repeat as "click it again, hide it".
    opts.onScrub(index, "step");
    play.textContent = "❚❚";
    play.setAttribute("aria-label", "Pause fire history");
    timer = setTimeout(tick, STEP_MS);
  });

  range.addEventListener("input", () => {
    stop(); // a hand on the slider outranks playback
    show(Number(range.value));
    opts.onScrub(index, "select"); // a drag is a deliberate pick, same as a bar click
  });

  show(clamp(opts.initialIndex ?? 0));

  // Compare mode hides every data overlay on purpose (fire-bin-fill/-line
  // included) — an unattended play timer must not repaint them back over
  // the before/after imagery once that decision has been made.
  const offCompare = onUi("compare:enter", stop);

  // A caller uses this to sync the control's position after it already made
  // a selection itself (a bar click calls onSelect directly, then this — see
  // timeline.ts's `select`). Move only — never call onScrub, or the caller's
  // onSelect would fire twice for one click.
  const setIndex = (i: number) => {
    show(i);
  };

  return {
    get playing() {
      return timer !== null;
    },
    setIndex,
    destroy: () => {
      stop();
      offCompare();
      row.remove();
    },
    get index() {
      return index;
    },
  };
}
