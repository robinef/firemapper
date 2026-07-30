from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

EUROPE_BBOX = (-25.0, 34.0, 45.0, 72.0)  # lon_min, lat_min, lon_max, lat_max
H3_RES = 8
# 1.1.0 adds the per-layer `layers` freshness map. Minor bump: every 1.0 key
# keeps its name and meaning, so an old client still loads a new manifest.
SCHEMA_VERSION = "1.1.0"


@dataclass(frozen=True)
class Settings:
    firms_map_key: str | None
    eumetsat_key: str | None
    eumetsat_secret: str | None
    sh_client_id: str | None
    sh_client_secret: str | None
    sh_instance_id: str | None
    sh_layer: str | None
    data_dir: Path
    out_dir: Path
    firms_history_days: int = 30
    # Cloudflare R2 holds the durable hotspot archive and the published site
    # data, so a scheduled run can pick up where the previous one left off.
    r2_account_id: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None
    r2_bucket: str | None = None

    @property
    def r2_configured(self) -> bool:
        """All four or nothing — a partial config would fail mid-publish."""
        return all(
            value is not None
            for value in (
                self.r2_account_id,
                self.r2_access_key_id,
                self.r2_secret_access_key,
                self.r2_bucket,
            )
        )


def _read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    merged: dict[str, str] = {**_read_dotenv(Path(".env")), **os.environ}
    if env is not None:
        merged = dict(env)
    return Settings(
        firms_map_key=merged.get("FIRMS_MAP_KEY"),
        eumetsat_key=merged.get("EUMETSAT_CONSUMER_KEY"),
        eumetsat_secret=merged.get("EUMETSAT_CONSUMER_SECRET"),
        sh_client_id=merged.get("SENTINELHUB_CLIENT_ID"),
        sh_client_secret=merged.get("SENTINELHUB_CLIENT_SECRET"),
        sh_instance_id=merged.get("SENTINELHUB_INSTANCE_ID"),
        sh_layer=merged.get("SENTINELHUB_LAYER"),
        data_dir=Path(merged.get("DATA_DIR", "data")),
        out_dir=Path(merged.get("OUT_DIR", "web/public/data")),
        firms_history_days=_int(merged.get("FIRMS_HISTORY_DAYS"), 30),
        r2_account_id=merged.get("R2_ACCOUNT_ID"),
        r2_access_key_id=merged.get("R2_ACCESS_KEY_ID"),
        r2_secret_access_key=merged.get("R2_SECRET_ACCESS_KEY"),
        r2_bucket=merged.get("R2_BUCKET"),
    )


def _int(value: str | None, default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default
