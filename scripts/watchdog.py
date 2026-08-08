"""Is the live map still advancing? Checked from outside Cloudflare.

worker/index.ts already alarms on a failed dispatch and on a manifest that has
stopped moving, and those surface as cron-invocation errors. What none of it
covers is the Worker itself being gone — deleted, cron disabled, account
suspended. There are no invocations to fail, so the map freezes in silence.

The GitHub-side fallback does not save us either. refresh-full is `7 * * * *`,
nominally hourly; measured on 2026-08-08 it fired at 02:15, 04:17, 05:51,
07:08, 08:54 and 09:49 — gaps of 55 min to 2 h 02, which is GitHub's documented
scheduler throttling. A dead Worker means a map hours behind and nobody told.

So this runs on GitHub, and asks the question a visitor would: fetch the PUBLIC
manifest and see how old it is. Going through the public URL rather than R2 is
the point — it exercises the Worker serving /data/** too, so a healthy bucket
behind a broken Worker still reads as broken, which is what a visitor gets.

Residual risk, stated rather than hidden: GitHub disables scheduled workflows
after ~60 days of repository inactivity. If that happens this dies the same
quiet way it exists to catch. Closing that needs a third party outside both
providers.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

# Must equal STALE_AFTER_MIN in worker/index.ts; a test pins them together.
# 90 min rides out three missed 30-minute cycles without crying wolf.
STALE_AFTER_MIN = 90

MANIFEST_URL = os.environ.get("WATCHDOG_MANIFEST_URL") or (
    # Blank (an unset workflow_dispatch input) must fall through to production,
    # not fetch "". `or` rather than a get() default, which only fires on absence.
    "https://firemapper.robinef.workers.dev/data/manifest.json"
)
ISSUE_TITLE = "[watchdog] data is stale"


class Verdict(str, Enum):
    FRESH = "fresh"
    STALE = "stale"
    BROKEN = "broken"


@dataclass(frozen=True)
class IssueAction:
    kind: str            # create | comment | close | none
    number: int | None = None


def manifest_age_min(body: str, now: float) -> float | None:
    """Minutes since the NEWEST attempt across layers, or None if unreadable.

    Newest, not any single layer: one run stamps them all, so a layer whose
    fetch failed keeps an older attempted_at. Reading an arbitrary layer would
    report the whole pipeline dead when it is only partly degraded.
    """
    try:
        manifest = json.loads(body)
    except (TypeError, ValueError):
        return None
    layers = manifest.get("layers")
    if not isinstance(layers, dict):
        return None
    stamps: list[float] = []
    for layer in layers.values():
        raw = (layer or {}).get("attempted_at") if isinstance(layer, dict) else None
        if not raw:
            continue
        try:
            stamps.append(datetime.fromisoformat(raw).timestamp())
        except (TypeError, ValueError):
            continue
    if not stamps:
        return None
    return (now - max(stamps)) / 60.0


def verdict_for(body: str | None, now: float) -> Verdict:
    """FRESH, STALE or BROKEN. Never FRESH by default.

    Anything we cannot read is BROKEN, not FRESH — a watchdog that goes green
    because it failed to parse the answer is worse than no watchdog, because it
    is trusted. Same asymmetry worker/index.ts applies to a missing manifest.
    """
    if body is None:
        return Verdict.BROKEN
    age = manifest_age_min(body, now)
    if age is None:
        return Verdict.BROKEN
    return Verdict.STALE if age > STALE_AFTER_MIN else Verdict.FRESH


def issue_action(verdict: Verdict, open_issue: dict | None) -> IssueAction:
    """What to do about the tracking issue.

    BROKEN and STALE are one case on purpose: to a visitor, "frozen" and
    "unreachable" are the same broken map, and giving BROKEN a quieter path is
    how the louder failure ends up ignored.
    """
    if verdict is Verdict.FRESH:
        return IssueAction("close", open_issue["number"]) if open_issue else IssueAction("none")
    if open_issue:
        return IssueAction("comment", open_issue["number"])
    return IssueAction("create")


def fetch(url: str, attempts: int = 2, pause: float = 5.0) -> str | None:
    """Fetch the manifest, retrying once.

    The Worker retries its dispatch for the same reason: a single 502 anywhere
    in the chain is not evidence the pipeline stopped, and an alarm that fires
    on one blip is one you learn to ignore.
    """
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "firemapper-watchdog"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read().decode()
        except (urllib.error.URLError, OSError, ValueError) as exc:
            print(f"[watchdog] attempt {attempt + 1}/{attempts} failed: {exc}", flush=True)
            if attempt + 1 < attempts:
                time.sleep(pause)
    return None


def main(argv: list[str] | None = None) -> int:
    body = fetch(MANIFEST_URL)
    now = time.time()
    verdict = verdict_for(body, now)
    age = manifest_age_min(body, now) if body is not None else None

    detail = f"{age:.0f} min old" if age is not None else "unreadable"
    print(f"[watchdog] {verdict.value}: manifest {detail} (limit {STALE_AFTER_MIN} min)", flush=True)

    # GITHUB_OUTPUT lets the workflow open or close the issue without this
    # script needing a token of its own.
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"verdict={verdict.value}\n")
            fh.write(f"detail={detail}\n")
            fh.write(f"limit={STALE_AFTER_MIN}\n")
            fh.write(f"url={MANIFEST_URL}\n")
    return 0 if verdict is Verdict.FRESH else 1


if __name__ == "__main__":  # pragma: no cover - entrypoint
    sys.exit(main())
