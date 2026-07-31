/**
 * A five-event bus so the mobile sheet can learn what the UI is doing without
 * any view module learning that mobile exists.
 *
 * Deliberately tiny: no payloads, no wildcard, no async. The sheet only needs
 * "something opened / something closed", and every extra capability here is a
 * coupling point between modules that are otherwise independent.
 */
export type UiEvent =
  | "detail:open"
  | "detail:close"
  | "aircraft:open"
  | "compare:enter"
  | "compare:exit";

const subscribers = new Map<UiEvent, Set<() => void>>();

export function onUi(event: UiEvent, fn: () => void): () => void {
  const set = subscribers.get(event) ?? new Set();
  set.add(fn);
  subscribers.set(event, set);
  return () => set.delete(fn);
}

export function emitUi(event: UiEvent): void {
  for (const fn of subscribers.get(event) ?? []) {
    // One bad subscriber must not stop the others: the sheet and any future
    // listener are independent, and a thrown error here would otherwise leave
    // the UI half-updated.
    try {
      fn();
    } catch (e) {
      console.error(`ui event ${event} subscriber failed`, e);
    }
  }
}
