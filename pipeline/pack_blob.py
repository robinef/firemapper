"""Greedy spiral bounding-box packing: places each fire's real footprint
shape onto a shared canvas with no cross-fire collision, largest first.
Each fire's shape is translated as a whole — never resized or distorted."""
import math

Polygon = list[tuple[float, float]]


def bounding_box(polygons: list[Polygon]) -> tuple[float, float, float, float]:
    xs = [x for poly in polygons for x, _ in poly]
    ys = [y for poly in polygons for _, y in poly]
    return min(xs), min(ys), max(xs), max(ys)


def translate_polygons(polygons: list[Polygon], dx: float, dy: float) -> list[Polygon]:
    return [[(x + dx, y + dy) for x, y in poly] for poly in polygons]


def boxes_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def _box_area(box: tuple[float, float, float, float]) -> float:
    x0, y0, x1, y1 = box
    return (x1 - x0) * (y1 - y0)


def pack_fires(
    fire_polygons: dict[str, list[Polygon]],
    existing_boxes: list[tuple[float, float, float, float]] = (),
) -> dict[str, list[Polygon]]:
    ordered = sorted(fire_polygons.items(), key=lambda kv: -_box_area(bounding_box(kv[1])))
    placed_boxes: list[tuple[float, float, float, float]] = list(existing_boxes)
    result: dict[str, list[Polygon]] = {}

    for fire_id, polys in ordered:
        box = bounding_box(polys)
        w, h = box[2] - box[0], box[3] - box[1]
        step = max(w, h, 1.0) * 0.5 + 25.0  # margin between shapes, meters
        cx0, cy0 = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2

        placed = False
        radius = 0.0
        while not placed:
            candidates = [(0.0, 0.0)] if radius == 0.0 else [
                (radius * math.cos(2 * math.pi * i / n), radius * math.sin(2 * math.pi * i / n))
                for n in [max(int((2 * math.pi * radius) / step), 8)]
                for i in range(n)
            ]
            for cx, cy in candidates:
                dx, dy = cx - cx0, cy - cy0
                candidate_box = (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)
                if not any(boxes_overlap(candidate_box, pb) for pb in placed_boxes):
                    result[fire_id] = translate_polygons(polys, dx, dy)
                    placed_boxes.append(candidate_box)
                    placed = True
                    break
            radius += step

    return result
