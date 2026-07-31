/**
 * Compare mode's map-gesture lock.
 *
 * On a phone, a horizontal drag is ambiguous: it could mean "move the
 * before/after divider" or "pan the map" — MapLibre's single-finger drag
 * handler and the divider's own pointer listener would both try to claim it.
 * Compare mode resolves the ambiguity by disabling single-finger pan for the
 * duration: the divider owns horizontal drags, the map does not move under it.
 * Pinch-zoom (touchZoomRotate) is untouched — it uses two fingers, so there is
 * no ambiguity to arbitrate, and a citizen still needs it to zoom into a scar.
 *
 * Kept map-independent (MapLike, not maplibregl.Map) so this is testable
 * without booting a real map or a browser.
 */
export interface MapLike {
  dragPan: { isEnabled(): boolean; enable(): void; disable(): void };
  dragRotate: { isEnabled(): boolean; enable(): void; disable(): void };
}

export interface HandlerState {
  dragPan: boolean;
  dragRotate: boolean;
}

/** Disable single-finger pan/rotate for compare mode, returning the state
 * they were in so exit can restore it exactly (see unlockMap). */
export function lockMap(map: MapLike): HandlerState {
  const state: HandlerState = {
    dragPan: map.dragPan.isEnabled(),
    dragRotate: map.dragRotate.isEnabled(),
  };
  map.dragPan.disable();
  map.dragRotate.disable();
  return state;
}

/** Restores each handler to its pre-lock enabled state, not unconditionally
 * on — a future mode that legitimately disables rotation must survive a
 * compare round-trip with rotation still off. */
export function unlockMap(map: MapLike, state: HandlerState): void {
  if (state.dragPan) map.dragPan.enable();
  if (state.dragRotate) map.dragRotate.enable();
}
