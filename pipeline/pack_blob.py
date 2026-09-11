"""Packs fires into one gap-free hex blob.

Earlier versions preserved each fire's real detected shape via a
bounding-box spiral (collision-avoided, margin between shapes). That left
visible gaps between fires — a click landing in a gap hit nothing and fell
through to the map's own pan, and the empty space read as "nothing here"
when it was really just packing margin, not a meaningful absence.

Individual fire shape was never the point — the point is a felt sense of
total scale. So: pick one fixed hex size, give each fire a hex COUNT
proportional to its real area, and fill one continuous spiral with them,
each fire a contiguous run. A spiral fill can't produce a gap or a
collision — there is no "avoid overlap" step because there is nothing to
avoid; every position is used exactly once, in order."""
import math

Polygon = list[tuple[float, float]]

# 0.7 km² — the same VIIRS single-cell area already used elsewhere
# (pipeline.metrics.CELL_KM2), not a new unit invented for this.
HEX_AREA_KM2 = 0.7
_HEX_EDGE_M = math.sqrt((HEX_AREA_KM2 * 1_000_000) / (3 * math.sqrt(3) / 2))

# Standard axial hex-grid direction vectors (pointy-top), in ring-walk order.
# See redblobgames.com/grids/hexagons — direction 4 is the start-of-ring
# corner; walking all 6 directions `radius` steps each traces one full ring.
_DIRECTIONS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]


def hex_count_for_area(area_km2: float) -> int:
    """How many fixed-size display hexes represent this much real area.
    Never zero — a fire too small to round up to one hex would otherwise
    vanish from the blob entirely, which is worse than a slight oversize."""
    return max(1, round(area_km2 / HEX_AREA_KM2))


def _spiral_axial_coords(n: int):
    """The first `n` axial (q, r) hex coordinates in spiral order, starting
    at the center and expanding ring by ring. Every position is distinct and
    every position within the spiral is filled — no gaps, no collisions, by
    construction rather than by checking afterward."""
    if n <= 0:
        return
    yield (0, 0)
    produced = 1
    radius = 1
    while produced < n:
        dq0, dr0 = _DIRECTIONS[4]
        q, r = dq0 * radius, dr0 * radius
        for dq, dr in _DIRECTIONS:
            for _ in range(radius):
                if produced >= n:
                    return
                yield (q, r)
                produced += 1
                q, r = q + dq, r + dr
        radius += 1


def _axial_to_local_m(q: int, r: int) -> tuple[float, float]:
    x = _HEX_EDGE_M * (math.sqrt(3) * q + math.sqrt(3) / 2 * r)
    y = _HEX_EDGE_M * (1.5 * r)
    return x, y


def _hexagon_vertices_m(cx: float, cy: float) -> Polygon:
    return [
        (
            cx + _HEX_EDGE_M * math.cos(math.radians(60 * i - 30)),
            cy + _HEX_EDGE_M * math.sin(math.radians(60 * i - 30)),
        )
        for i in range(6)
    ]


def pack_fires_as_blob(fire_hex_counts: dict[str, int], start_index: int = 0) -> dict[str, list[Polygon]]:
    """Assigns each fire a contiguous run of hexes in one shared spiral,
    starting after `start_index` positions already used by previously-packed
    fires — so a new fire is placed without ever moving or overlapping an
    already-published one. Iteration order of `fire_hex_counts` is the order
    fires are laid out in the spiral."""
    total_new = sum(fire_hex_counts.values())
    coords = list(_spiral_axial_coords(start_index + total_new))[start_index:]

    result: dict[str, list[Polygon]] = {}
    i = 0
    for fire_id, count in fire_hex_counts.items():
        polys = []
        for _ in range(count):
            q, r = coords[i]
            cx, cy = _axial_to_local_m(q, r)
            polys.append(_hexagon_vertices_m(cx, cy))
            i += 1
        result[fire_id] = polys
    return result
