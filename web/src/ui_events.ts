/**
 * A five-event bus so one listener can learn what the UI is doing without any
 * view module learning that the listener exists. That listener is shell.ts,
 * which turns these announcements into pushes and pops on the nav stack; the
 * original one was the mobile sheet, and the point of the bus is that
 * replacing it changed nothing on the emitting side.
 *
 * Deliberately tiny: no payloads, no wildcard, no async. The consumer only
 * needs "something opened / something closed" — it reads the DOM for anything
 * more, such as a card's title — and every extra capability here is a coupling
 * point between modules that are otherwise independent.
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

/** Test-only introspection: lets a leak/unsubscribe test assert on the
 *  subscriber count directly instead of on a side effect that can't
 *  distinguish "never subscribed" from "subscribed and never unsubscribed". */
export function uiSubscriberCount(event: UiEvent): number {
  return subscribers.get(event)?.size ?? 0;
}

export function emitUi(event: UiEvent): void {
  for (const fn of subscribers.get(event) ?? []) {
    // One bad subscriber must not stop the others: the shell and any future
    // listener are independent, and a thrown error here would otherwise leave
    // the UI half-updated.
    try {
      fn();
    } catch (e) {
      console.error(`ui event ${event} subscriber failed`, e);
    }
  }
}
