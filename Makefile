.PHONY: setup test refresh refresh-fast refresh-full watch dev bench sample

setup:
	uv sync
	cd web && npm install
	test -f data/places/cities15000.txt || (mkdir -p data/places && curl -L https://download.geonames.org/export/dump/cities15000.zip -o /tmp/c.zip && unzip -o /tmp/c.zip -d data/places)

test:
	uv run --with pytest pytest -q
	cd web && npx tsc --noEmit && npx vitest run

refresh:
	uv run python -m pipeline.run refresh

# Live layers only (no API key needed) vs. the full run that also tops up the
# 30-day VIIRS archive and the slow bonus tiers (needs FIRMS_MAP_KEY).
refresh-fast:
	uv run python -m pipeline.run refresh fast

refresh-full:
	uv run python -m pipeline.run refresh full

watch:
	uv run python -m pipeline.run watch

dev:
	cd web && npm run dev

bench:
	uv run python -m pipeline.run bench

sample:
	uv run python -m scripts.make_sample
