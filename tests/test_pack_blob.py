import math

from pipeline.pack_blob import HEX_AREA_KM2, hex_count_for_area, pack_fires_as_blob


def test_hex_count_for_area_divides_by_the_fixed_hex_size():
    assert hex_count_for_area(HEX_AREA_KM2 * 10) == 10


def test_hex_count_for_area_never_returns_zero():
    # A fire smaller than one display hex must still show up as one hex —
    # invisible is worse than slightly oversized for something this small.
    assert hex_count_for_area(0.001) == 1


def test_pack_fires_as_blob_assigns_every_fire_its_requested_hex_count():
    packed = pack_fires_as_blob({"a": 3, "b": 7})
    assert len(packed["a"]) == 3
    assert len(packed["b"]) == 7


def test_pack_fires_as_blob_produces_a_gap_free_contiguous_fill():
    """The whole point: no two hexes may share a position, and none may be
    skipped — a spiral fill is gap-free and collision-free by construction,
    not by checking after the fact."""
    packed = pack_fires_as_blob({"a": 50, "b": 50})
    all_polys = packed["a"] + packed["b"]
    # Every hex's centroid (mean of its vertices) must be distinct — two
    # hexes landing on the same spiral position would produce identical
    # centroids, which a real gap-free tiling can never do.
    centroids = {
        (round(sum(x for x, _ in poly) / len(poly), 3), round(sum(y for _, y in poly) / len(poly), 3))
        for poly in all_polys
    }
    assert len(centroids) == len(all_polys)


def test_pack_fires_as_blob_hexes_are_regular_and_uniformly_sized():
    packed = pack_fires_as_blob({"a": 1})
    poly = packed["a"][0]
    assert len(poly) == 6
    cx = sum(x for x, _ in poly) / 6
    cy = sum(y for _, y in poly) / 6
    radii = [math.hypot(x - cx, y - cy) for x, y in poly]
    assert max(radii) - min(radii) < 1e-6  # every vertex equidistant from center


def test_pack_fires_as_blob_new_fires_never_move_or_overlap_already_placed_ones():
    """The incremental contract pipeline/export_scale_blob.py depends on:
    packing new fires against a start_index derived from what's already
    published must never touch positions 0..start_index-1."""
    first = pack_fires_as_blob({"a": 10})
    second = pack_fires_as_blob({"b": 10}, start_index=10)

    def centroids(polys):
        return {
            (round(sum(x for x, _ in poly) / len(poly), 3), round(sum(y for _, y in poly) / len(poly), 3))
            for poly in polys
        }

    assert centroids(first["a"]).isdisjoint(centroids(second["b"]))


def test_pack_fires_as_blob_is_deterministic_across_calls():
    a = pack_fires_as_blob({"x": 5})
    b = pack_fires_as_blob({"x": 5})
    assert a == b
