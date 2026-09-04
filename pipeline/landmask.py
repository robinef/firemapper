"""Land/sea classification for hotspot ingest.

Wildfires happen on land. A VIIRS/MODIS detection over open water is sun
glint, a ship, or a gas flare on an oil/gas platform — never a wildfire — and
FIRMS's NRT area API gives no field to tell those apart (no `type` column;
confirmed empirically, not every doc claim about the API holds for the
NRT product). A land mask is the only filter with the right shape for this
tool's actual purpose.

global_land_mask ships a 1km-resolution grid (Natural Earth derived) as a
2.5MB compressed array, checked entirely offline — no network call, no
external service.
"""
from __future__ import annotations

from global_land_mask import globe

# VIIRS/MODIS geolocation error is on the order of 100-150m; a real fire
# right at the shoreline can land a pixel just offshore of the 1km grid's
# coastline. Without a buffer that reclassifies a genuine coastal fire as a
# sea false-positive. 2km is generous relative to the geolocation error while
# staying far short of the hundreds of km the actual ocean glint clusters sit
# offshore (see the purge that motivated this module).
_BUFFER_KM = 2.0
_KM_PER_DEG_LAT = 111.0


def is_near_land(lat: float, lon: float, buffer_km: float = _BUFFER_KM) -> bool:
    """True if the point is on land, or within `buffer_km` of it.

    Checks the point itself plus four offsets (N/S/E/W by buffer_km) rather
    than a true geodesic buffer — cheap, and sufficient at this scale: a
    point that is land-adjacent within a couple of km has a landward offset
    in at least one cardinal direction on a 1km grid.
    """
    if globe.is_land(lat, lon):
        return True
    dlat = buffer_km / _KM_PER_DEG_LAT
    km_per_deg_lon = _KM_PER_DEG_LAT * max(0.01, abs(_cos_deg(lat)))
    dlon = buffer_km / km_per_deg_lon
    offsets = [(dlat, 0.0), (-dlat, 0.0), (0.0, dlon), (0.0, -dlon)]
    return any(globe.is_land(lat + dy, lon + dx) for dy, dx in offsets)


def _cos_deg(deg: float) -> float:
    import math

    return math.cos(math.radians(deg))
