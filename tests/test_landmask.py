from pipeline.landmask import is_near_land


def test_is_near_land_true_for_inland_point():
    assert is_near_land(38.7223, -9.1393)  # Lisbon


def test_is_near_land_true_for_a_narrow_island():
    # Fair Isle: on land at the point itself, but narrow enough that all four
    # cardinal 2km offsets land in surrounding water. Isolates the direct
    # globe.is_land(lat, lon) check from the buffer fallback below it — a
    # point like Lisbon is inland enough that the buffer alone would also
    # pass, masking a broken direct check.
    assert is_near_land(59.5350, -1.6300)


def test_is_near_land_false_for_open_ocean():
    assert not is_near_land(45.9612, -22.1465)  # mid-Atlantic, hundreds of km offshore


def test_is_near_land_true_just_offshore_of_a_coastline():
    # A few hundred metres off the Portuguese coast near Nazare: within the
    # geolocation-error buffer a real coastal fire's pixel could land in.
    assert is_near_land(39.60, -9.10)


def test_is_near_land_false_several_km_offshore():
    assert not is_near_land(39.60, -9.30)
