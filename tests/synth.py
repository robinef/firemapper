# tests/synth.py — synthetic fixtures only; coordinates are fictional inland points
import hashlib
from datetime import datetime, timezone


def hs(lat: float, lon: float, t: datetime, tier: str = "viirs", frp: float = 10.0) -> dict:
    assert t.tzinfo is not None
    return {
        "lat": lat, "lon": lon, "acq_time": t.astimezone(timezone.utc), "tier": tier,
        "satellite": "SYN", "confidence": "h", "frp": frp,
        "src_id": hashlib.sha1(f"{lat},{lon},{t.isoformat()},{tier}".encode()).hexdigest(),
    }


def T(day: int, hour: int) -> datetime:
    return datetime(2026, 7, day, hour, 0, tzinfo=timezone.utc)
