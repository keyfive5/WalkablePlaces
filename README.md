# WalkablePlaces

**How walkable is the world?** An interactive globe of walkability scores for countries, cities and their neighbourhoods — plus live scoring of any spot on Earth — all computed with one open model from open data.

Live: https://keyfive5.github.io/WalkablePlaces/

- **Model** (`docs/js/model.js`, shared by pipeline and browser): `score = 100 × (0.50·Needs + 0.20·Grid + 0.15·Transit + 0.15·Car-free) × (0.8 + 0.2·Calm)`
- **Data**: Overture Maps (places, transportation, base, divisions), GHSL Urban Centres + 2025 population grid, Natural Earth. Basemap: OpenFreeMap. Map: MapLibre GL JS (vendored).
- **Pipeline**: `pipeline/01-cities.mjs` → `02-extract.py` (DuckDB on Overture GeoParquet) → `03-score.mjs` (250 m hex grid, neighbourhoods) → `04-world.mjs`.
- Cities with sparse open map data are flagged "limited data" and left out of rankings.
