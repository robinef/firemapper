import { escapeHtml, safeHttpUrl } from "./escape";
import type { EventProps, Track } from "./types";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compass(bearing: number): string {
  return COMPASS[Math.round(bearing / 45) % 8];
}

export function minutesAgo(iso: string, now: Date): number {
  return Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
}

function freshnessLine(props: EventProps, now: Date): string {
  const parts: string[] = [`${minutesAgo(props.freshness.viirs, now)} min ago (VIIRS)`];
  if (props.freshness.meteosat) {
    parts.unshift(`${minutesAgo(props.freshness.meteosat, now)} min ago (Meteosat live)`);
  }
  return parts.join(" · ");
}

export function sparklinePath(track: Track, w: number, h: number): string {
  const vals = track.series.map((b) => b.cum_cells);
  const max = Math.max(1, ...vals);
  const n = vals.length;
  return vals
    .map((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * w;
      const y = h - (v / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function movementArrow(props: EventProps): { bearing: number } | null {
  return props.movement ? { bearing: props.movement.bearing_deg } : null;
}

export function renderPanel(props: EventProps, track: Track, now: Date = new Date()): string {
  const badgeClass = props.state === "accelerating" ? "badge badge-accel" : "badge";
  const startedH = Math.round(
    (now.getTime() - new Date(props.started).getTime()) / 3600000,
  );
  const startedTxt = startedH >= 48 ? `${Math.round(startedH / 24)} days ago` : `${startedH} h ago`;

  const move = props.movement
    ? `Estimated movement: <b>${(props.movement.distance_24h_m / 1000).toFixed(1)} km</b>` +
      ` heading <b>${compass(props.movement.bearing_deg)}</b> in the last 24 h`
    : `<span class="muted">No clear movement</span>`;

  // GeoNames place names and the GDACS feed are third-party text; the GDACS
  // link is a third-party URL landing in an href, which is a script sink.
  const place = props.place
    ? `Nearest: <b>${escapeHtml(props.place.name)}</b> (${props.place.distance_km} km)`
    : "";
  const gdacs = props.gdacs
    ? `<a href="${safeHttpUrl(props.gdacs.link)}" target="_blank" rel="noopener">` +
      `${escapeHtml(props.gdacs.title)} ↗ (GDACS)</a>`
    : "";

  return `
    <button class="panel-close" aria-label="Close">×</button>
    <div class="${badgeClass}">${props.state.toUpperCase()}</div>
    <div class="panel-row muted">Started ${startedTxt} · ${props.status}</div>
    <div class="panel-row"><b>${props.area_km2} km²</b> burning area (${props.cum_cells} cells)</div>
    <div class="panel-row">${move}</div>
    <svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none">
      <polyline points="${sparklinePath(track, 120, 30)}" fill="none" stroke="#ff6b00" stroke-width="2"/>
    </svg>
    <div class="panel-row small">Growth over time</div>
    <div class="panel-row small">Last satellite update: ${freshnessLine(props, now)}</div>
    ${place ? `<div class="panel-row small">${place}</div>` : ""}
    ${gdacs ? `<div class="panel-row small">${gdacs}</div>` : ""}
    <div class="safety">⚠ Satellite data is not an official alert. In danger call <b>112</b> and follow local authorities.</div>
  `;
}

const SAFETY =
  `<div class="safety">⚠ Satellite data is not an official alert. In danger call <b>112</b> and follow local authorities.</div>`;

function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "unknown";
  const m = minutesAgo(iso, now);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Detail view for a single Meteosat FRP pixel. */
export function renderFrpPanel(p: Record<string, unknown>, now: Date = new Date()): string {
  const age = p.age_min as number | null;
  const first = p.first_min as number | null;
  const dir = p.dir as number | null;
  const n = (p.n as number) ?? 1;
  const spanMin = first !== null && age !== null ? first - age : null;
  const duration =
    n <= 1 || spanMin === null || spanMin < 20
      ? `Seen once by Meteosat`
      : spanMin < 90
        ? `Burning for about <b>${spanMin} min</b> (${n} observations)`
        : `Burning for about <b>${Math.round(spanMin / 60)} h</b> (${n} observations)`;
  return `
    <button class="panel-close" aria-label="Close">×</button>
    <div class="badge">FIRE PIXEL · METEOSAT</div>
    <div class="panel-row"><b>${p.frp} MW</b> peak radiative power</div>
    <div class="panel-row">Last seen burning ${age === null ? "unknown" : ago(p.t as string, now)}</div>
    <div class="panel-row">${duration}</div>
    <div class="panel-row">${
      dir === null || dir === undefined
        ? `<span class="muted">No clear local spread direction</span>`
        : `Spreading toward <b>${compass(dir)}</b> (${dir}°)`
    }</div>
    <div class="panel-row small muted">~2 km Meteosat pixel · Meteosat scans every 10 min, this map republishes every 15</div>
    ${SAFETY}
  `;
}

/** Detail view for a wind sample. */
export function renderWindPanel(p: Record<string, unknown>, now: Date = new Date()): string {
  const rh = p.rh as number | null;
  const temp = p.temp_c as number | null;
  const dry = rh !== null && rh !== undefined && rh < 30;
  return `
    <button class="panel-close" aria-label="Close">×</button>
    <div class="badge">WIND</div>
    <div class="panel-row"><b>${p.kmh} km/h</b> from <b>${compass(p.from_deg as number)}</b> (${p.from_deg}°)</div>
    <div class="panel-row">Gusting to <b>${p.gust_kmh} km/h</b></div>
    ${temp !== null ? `<div class="panel-row">${temp} °C · ${rh}% humidity ${dry ? "<b>(very dry)</b>" : ""}</div>` : ""}
    <div class="panel-row small muted">Forecast surface wind at 10 m — this is not observed fire movement.</div>
    ${SAFETY}
  `;
}

/** Detail view for a firefighting aircraft. */
export function renderAircraftPanel(p: Record<string, unknown>, now: Date = new Date()): string {
  const alt = p.alt_m as number | null;
  const spd = p.speed_kmh as number | null;
  const hdg = p.heading as number | null;
  // Epoch seconds, from OpenSky time_position: when the POSITION was fixed, not
  // when the transponder was last heard. Grounded aircraft never get here — the
  // pipeline drops them, along with fixes older than the publish budget.
  const posTime = p.pos_time as number | null;
  const ageMin = posTime ? Math.round((now.getTime() / 1000 - posTime) / 60) : null;
  // A fast mover with an old fix is misleading — say how old, and warn.
  const stale = ageMin !== null && ageMin > 5;
  const ageLine =
    ageMin === null
      ? "position age unknown"
      : `position ${ageMin < 1 ? "just now" : `${ageMin} min ago`}${stale ? " ⚠ may have moved" : ""}`;
  return `
    <button class="panel-close" aria-label="Close">×</button>
    <div class="badge">AIRBORNE · ${escapeHtml(p.role)}</div>
    <div class="panel-row"><b>${escapeHtml(p.callsign)}</b> · identified as ${escapeHtml(p.type)}</div>
    <div class="panel-row">${spd ?? "?"} km/h · heading <b>${
      hdg === null ? "?" : compass(hdg)
    }</b>${alt !== null ? ` · ${alt} m` : ""}</div>
    <div class="panel-row small ${stale ? "" : "muted"}">${ageLine}</div>
    <div class="panel-row small muted">${escapeHtml(p.country)} · ADS-B via OpenSky · type inferred from callsign</div>
    ${SAFETY}
  `;
}

export interface PanelHandle {
  show(props: EventProps, track: Track): void;
  showHtml(html: string): void;
  hide(): void;
}

export function mountPanel(
  containerId: string,
  onClose: () => void,
): PanelHandle {
  const el = document.getElementById(containerId)!;
  const open = (html: string) => {
    el.innerHTML = html;
    el.classList.remove("hidden");
    el.querySelector(".panel-close")?.addEventListener("click", () => {
      el.classList.add("hidden");
      onClose();
    });
  };
  return {
    show(props, track) {
      open(renderPanel(props, track));
    },
    showHtml(html) {
      open(html);
    },
    hide() {
      el.classList.add("hidden");
    },
  };
}
