from pipeline.pack_blob import bounding_box, boxes_overlap, pack_fires, translate_polygons


def square(cx: float, cy: float, half: float) -> list[tuple[float, float]]:
    return [(cx - half, cy - half), (cx + half, cy - half), (cx + half, cy + half), (cx - half, cy + half)]


def test_bounding_box_of_single_square():
    assert bounding_box([square(0, 0, 10)]) == (-10, -10, 10, 10)


def test_translate_polygons_shifts_every_vertex():
    result = translate_polygons([square(0, 0, 10)], dx=5, dy=-3)
    assert result == [[(-5, -13), (15, -13), (15, 7), (-5, 7)]]


def test_boxes_overlap_true_for_intersecting():
    assert boxes_overlap((-10, -10, 10, 10), (5, 5, 20, 20)) is True


def test_boxes_overlap_false_for_disjoint():
    assert boxes_overlap((-10, -10, 10, 10), (100, 100, 120, 120)) is False


def test_pack_fires_places_all_fires_with_no_overlap():
    fires = {
        "big": [square(0, 0, 50)],
        "medium": [square(0, 0, 20)],
        "small": [square(0, 0, 5)],
    }
    packed = pack_fires(fires)
    assert set(packed.keys()) == {"big", "medium", "small"}
    boxes = [bounding_box(polys) for polys in packed.values()]
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            assert not boxes_overlap(a, b)


def test_pack_fires_preserves_each_fires_internal_shape():
    # A fire's own polygon's relative vertex offsets must survive packing —
    # only a whole-shape translation is allowed, never a resize/distortion.
    fires = {"only": [square(0, 0, 10), square(30, 0, 5)]}
    packed = pack_fires(fires)
    poly_a, poly_b = packed["only"]
    original_a, original_b = fires["only"]
    # vertex 0 of poly_a relative to vertex 0 of poly_b must match the original delta
    dx_before = original_b[0][0] - original_a[0][0]
    dy_before = original_b[0][1] - original_a[0][1]
    dx_after = poly_b[0][0] - poly_a[0][0]
    dy_after = poly_b[0][1] - poly_a[0][1]
    assert abs(dx_after - dx_before) < 1e-9
    assert abs(dy_after - dy_before) < 1e-9


def test_pack_fires_avoids_existing_boxes():
    existing = [(-5, -5, 5, 5)]
    packed = pack_fires({"new": [square(0, 0, 3)]}, existing_boxes=existing)
    new_box = bounding_box(packed["new"])
    assert not boxes_overlap(new_box, existing[0])
