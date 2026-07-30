/**
 * How old is the data, really?
 *
 * The header badge answers a citizen's question — "how old is the newest
 * satellite detection?" — so it may only be computed from the FIRE sources,
 * events and frp. A successful wind or imagery fetch says nothing about whether
 * we can still see fires, and letting it feed the badge would paint a dead map
 * fresh.
 *
 * The previous badge read `manifest.live_frp.latest`, which is null whenever
 * the MTG fetch fails — so the badge silently disappeared exactly when it had
 * something to report.
 */
import type { Manifest } from "./types";

export interface LayerFreshness {
  /** When the run tried to fetch. */
  attempted_at: string;
  /** When data actually arrived, or null if the fetch failed. */
  fetched_at: string | null;
  /** Newest OBSERVATION inside the payload — what the public cares about. */
  observed_at: string | null;
  status: "ok" | "empty" | "carried" | "failed";
  source: string;
  max_age_s: number;
}

const FIRE_LAYERS = ["events", "frp"] as const;
const DEFAULT_FIRE_BUDGET_S = 3 * 3600;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function humanAge(minutes: number): string {
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

export function badgeText(m: Manifest, now: Date): string {
  const layers = m.layers ?? {};
  let newest: number | null = null;
  let budget = DEFAULT_FIRE_BUDGET_S;

  for (const key of FIRE_LAYERS) {
    const layer = layers[key];
    const seen = ms(layer?.observed_at);
    if (seen !== null && (newest === null || seen > newest)) newest = seen;
    if (key === "events" && layer?.max_age_s) budget = layer.max_age_s;
  }

  if (newest === null) {
    // No fire source has an observation: say so plainly rather than borrowing
    // freshness from some other layer that happened to succeed.
    const built = ms(m.generated_at);
    if (built === null) return "";
    const minutes = Math.round((now.getTime() - built) / 60000);
    return ` · no live satellite data · built ${humanAge(minutes)} ago`;
  }

  const minutes = Math.round((now.getTime() - newest) / 60000);
  const stale = (now.getTime() - newest) / 1000 > budget ? " ⚠ stale" : "";
  return ` · newest satellite data ${humanAge(minutes)} old${stale}`;
}

export function layerState(
  m: Manifest,
  key: string,
  now: Date,
): { stale: boolean; ageText: string; reason: string | null } {
  const layer = m.layers?.[key];
  if (!layer) return { stale: false, ageText: "", reason: null };

  const seen = ms(layer.observed_at) ?? ms(layer.fetched_at);
  if (seen === null) {
    return { stale: true, ageText: "", reason: `${layer.source} unavailable` };
  }

  const ageS = (now.getTime() - seen) / 1000;
  const minutes = Math.round(ageS / 60);
  const stale = ageS > layer.max_age_s;
  return {
    stale,
    ageText: `${humanAge(minutes)} old`,
    reason: stale ? `${layer.source} feed ${humanAge(minutes)} old` : null,
  };
}

/** A module is stale when ANY source it draws from is stale — the worst status
 * wins, because a spread arrow computed from stale pixels is stale too. */
export function moduleStale(
  m: Manifest,
  module: { freshnessKeys?: string[] },
  now: Date,
): boolean {
  return (module.freshnessKeys ?? []).some((key) => layerState(m, key, now).stale);
}

/** The first reason among a module's sources, for the switcher's caption. */
export function moduleReason(
  m: Manifest,
  module: { freshnessKeys?: string[] },
  now: Date,
): string | null {
  for (const key of module.freshnessKeys ?? []) {
    const reason = layerState(m, key, now).reason;
    if (reason) return reason;
  }
  return null;
}
