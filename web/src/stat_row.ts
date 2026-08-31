/**
 * One label/value row in a `.fc-stats` block (fire card, info panel).
 *
 * Does not escape — same sink-side convention as escape.ts: callers escape
 * whichever fields aren't already trusted pipeline output.
 */
export function statRow(label: string, value: string): string {
  return `<div class="fc-stat"><span>${label}</span><b>${value}</b></div>`;
}
