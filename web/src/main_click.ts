/**
 * Which layer should handle a tap.
 *
 * MapLibre fires a layer-scoped click handler once per matching layer, so
 * registering the same handler for a dot AND its invisible halo runs it twice —
 * for fires that means two async track loads racing each other. One handler
 * plus this resolver means exactly one open per tap, and one place to state
 * precedence when a fire dot sits on top of a burn scar.
 */
export function dispatchMapClick(
  features: Array<{ layer: { id: string } }>,
  order: string[],
): string | null {
  const hit = new Set(features.map((f) => f.layer.id));
  for (const id of order) if (hit.has(id)) return id;
  return null;
}
