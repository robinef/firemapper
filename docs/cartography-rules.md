# Cartographic rules for FireMapper layers

Every layer must pass all three gates before it ships:

1. **Informative** — it answers one question a citizen actually has. Name the
   question in the layer's doc comment. If two questions, split the layer.
2. **Readable at every zoom** — the symbology transforms with scale
   (generalise low, detail high), it does not merely shrink. Verify at z4
   (Europe), z7 (region), z10 (fire), z13 (street).
3. **Form follows meaning** — visual variables per Bertin:

| Variable | Encodes | Use for |
|---|---|---|
| Size | quantity | magnitude (area, MW, km/h) |
| Color value (light→dark) | order | age, rank, intensity class |
| Color hue | category only | layer identity, status class |
| Shape | category | feature type |
| Orientation | direction | spread, wind |

Never encode a number with hue. Never let two layers share a ramp.

**Hierarchy**: the most life-safety-urgent information gets the highest
contrast. Context layers stay low-contrast. One glance = the danger; one
look = the story; one click = the detail.

Sources: Bertin, Sémiologie Graphique (1967); Axis Maps visual variables
guide; PSU GEOG 486; Dumont et al., "Designing multi-scale maps" (IJC 2020).
