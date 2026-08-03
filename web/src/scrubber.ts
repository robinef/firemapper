import { onUi } from "./ui_events";

/** One bin per step. Slow enough to read a fire's shape, fast enough that a
 *  30-bin history plays in about 13 seconds. */
export const STEP_MS = 450;

export interface ScrubberOpts {
  count: number;
  labelFor: (i: number) => string;
  onScrub: (i: number) => void;
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
  // The bin most recently handed to onScrub (by any path: tick, a drag, or an
  // external setIndex sync after a bar click already called onSelect itself).
  // null until the first emit, since a bar click's own onSelect call never
  // goes through this scrubber's onScrub — see setIndex below.
  let lastEmitted: number | null = null;

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
    opts.onScrub(index);
    lastEmitted = index;
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
    // bin 0 at all, even though the restart-from-end case (above) does.
    // But skip it when that bin was already handed to onScrub (a drag or a
    // bar click landed here just before Play was pressed): a toggling
    // consumer (the overview's day-slice select) would read a repeat of the
    // bin it's already showing as "click it again" and hide it for one tick.
    if (lastEmitted !== index) {
      opts.onScrub(index);
      lastEmitted = index;
    }
    play.textContent = "❚❚";
    play.setAttribute("aria-label", "Pause fire history");
    timer = setTimeout(tick, STEP_MS);
  });

  range.addEventListener("input", () => {
    stop(); // a hand on the slider outranks playback
    show(Number(range.value));
    opts.onScrub(index);
    lastEmitted = index;
  });

  show(clamp(opts.initialIndex ?? 0));

  // Compare mode hides every data overlay on purpose (fire-bin-fill/-line
  // included) — an unattended play timer must not repaint them back over
  // the before/after imagery once that decision has been made.
  const offCompare = onUi("compare:enter", stop);

  // A caller uses this to sync a selection it already made itself (a bar
  // click calls onSelect directly, then this — see timeline.ts's `select`),
  // so that bin counts as emitted too: Play must not repeat a call the caller
  // just made through a different door.
  const setIndex = (i: number) => {
    show(i);
    lastEmitted = index;
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
