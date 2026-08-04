/**
 * Test doubles shared by nav.test.ts, shell.test.ts and nav_integration.test.ts.
 *
 * Not a .test.ts file: vitest would try to run it and fail on finding no tests.
 */
import type { HistoryLike } from "../src/nav";

/** A synchronous stand-in for window.history + window.
 *
 * jsdom queues back()/go() and does not reliably dispatch popstate for them,
 * so driving the real thing turns every assertion into a race. This dispatches
 * popstate inline, which is also what makes "the stack moves only when the
 * browser says so" observable in a test at all. */
export function fakeHistory(): { history: HistoryLike; target: EventTarget } {
  const target = new EventTarget();
  const states: unknown[] = [null];
  let index = 0;
  const history: HistoryLike = {
    pushState(state) {
      states.length = index + 1;
      states.push(state);
      index = states.length - 1;
    },
    replaceState(state) {
      states[index] = state;
    },
    back() {
      this.go(-1);
    },
    go(delta) {
      const next = Math.max(0, Math.min(index + delta, states.length - 1));
      if (next === index) return;
      index = next;
      target.dispatchEvent(
        Object.assign(new Event("popstate"), { state: states[index] }),
      );
    },
    get state() {
      return states[index];
    },
  };
  return { history, target };
}

/** The shell's DOM contract from index.html, reduced to what the shell reads.
 *  #rail and #view-chip deliberately sit OUTSIDE #view and BEFORE it, exactly
 *  as the real document has them — that ordering is what makes a sibling
 *  selector unable to reach them, and a fixture that got it wrong would hide
 *  the bug the body-attribute mirroring exists to avoid. */
export function mountShellDom(): void {
  document.body.innerHTML = `
    <div id="map"></div>
    <nav id="rail" class="hidden">
      <button id="rail-layers"></button>
      <button id="rail-search"></button>
      <button id="rail-info"></button>
    </nav>
    <div id="view" data-view="map">
      <div id="view-bar"></div>
      <aside id="sidebar"><div id="layers"></div><div id="legend"></div></aside>
      <div id="panel" class="hidden"></div>
      <div id="info"></div>
    </div>
    <div id="compare-bar"></div>
    <button id="view-chip" type="button">‹ Map</button>
    <div id="notice"></div>
    <div id="timeline"></div>`;
  delete document.body.dataset.view;
  delete document.body.dataset.size;
  document.body.className = "";
}
