// "How scores work" — methodology, sources and limitations.
import { WEIGHTS, PARAMS, PLENTY, CATEGORY_LABELS, TIERS, NEEDS, TRANSIT_WEIGHT } from './model.js';
import { scoreColor } from './colors.js';
import { fmtInt } from './ui.js';

export function aboutHtml(store) {
  const t = store.world?.totals || {};
  const pct = (w) => Math.round(w * 100) + '%';
  return `
  <h2 id="about-title">How WalkablePlaces scores the world</h2>
  <p>Every score answers one question: <b>how easy is it to live here on foot?</b> Countries, cities, neighbourhoods and single
  spots are all scored with the same open method, so any two places can be compared fairly — ${fmtInt(t.cities)} cities and
  ${fmtInt(t.neighbourhoods)} neighbourhoods so far.</p>

  <h3>The formula</h3>
  <code class="formula">score = 100 × (${WEIGHTS.needs}·Needs + ${WEIGHTS.grid}·Grid + ${WEIGHTS.transit}·Transit + ${WEIGHTS.ped}·Car-free) × (0.8 + 0.2·Calm)</code>
  <div class="weights">
    <div><b>${pct(WEIGHTS.needs)}</b><span>Daily needs — groceries, food, shops, health, schools, parks, services, culture</span></div>
    <div><b>${pct(WEIGHTS.grid)}</b><span>Street grid — walkable junctions per km² within ${PARAMS.gridRadius} m</span></div>
    <div><b>${pct(WEIGHTS.transit)}</b><span>Transit — rail, metro, ferry, tram and bus stops within ${PARAMS.transitRadius} m</span></div>
    <div><b>${pct(WEIGHTS.ped)}</b><span>Car-free ways — pedestrian streets, paths and steps within ${PARAMS.pedRadius} m</span></div>
    <div><b>×0.8–1</b><span>Highway calm — up to 20% off within ${PARAMS.motorwayClear} m of a motorway</span></div>
  </div>

  <h3>1 · Daily needs</h3>
  <p>For eight kinds of everyday destination, half the credit is <b>access</b>: the nearest few count fully within
  ${PARAMS.fullCredit} m (a 3-minute walk) and fade smoothly after that — a 10-minute walk still earns about 44%, and nothing beyond
  ${(PARAMS.needsRadius / 1000).toFixed(1)} km counts. The first grocery matters most; the tenth café much less. The other half is
  <b>abundance</b>: how many there are within ${PARAMS.plentyRadius} m, against what the liveliest places on Earth have
  (${Object.entries(PLENTY).map(([k, v]) => `${v} ${CATEGORY_LABELS[k].toLowerCase()}`).join(', ')}).</p>

  <h3>2 · Street grid</h3>
  <p>Junctions where three or more walkable streets or paths meet, per km², within ${PARAMS.gridRadius} m. A fine grid means
  short, direct routes; cul-de-sacs and superblocks make every trip longer. ${PARAMS.gridLow}/km² scores 0 and ${PARAMS.gridHigh}/km² scores 100,
  on a log scale. Sidewalks and crossings mapped as separate lines are left out, so cities aren't rewarded for mapping detail.</p>

  <h3>3 · Transit</h3>
  <p>Stops within ${PARAMS.transitRadius} m, weighted by mode (${Object.entries(TRANSIT_WEIGHT).map(([k, v]) => `${k} ${v}`).join(', ')}) and by
  distance, with diminishing returns. Where a city's stops are barely mapped at all (under 0.15 per 1,000 residents), transit
  is left out and the other parts reweighted, rather than scoring missing data as missing buses.</p>

  <h3>4 · Car-free ways and highway calm</h3>
  <p>The length of pedestrian streets, footpaths and steps within ${PARAMS.pedRadius} m (12 km of them scores 100). Motorways and
  trunk roads are barriers and noise: living beside one costs up to 20% of the score, fading to nothing at ${PARAMS.motorwayClear} m.</p>

  <h3>From spots to countries</h3>
  <p>Each city's dense core — its <a href="https://human-settlement.emergency.copernicus.eu/ghs_ucdb_2024.php" target="_blank" rel="noopener">GHSL urban centre</a>
  within 10 km of the centre — is covered by 250 m hexagons, each scored with the formula above. Neighbourhood and city scores
  average their hexagons <b>weighted by where people live</b> (GHSL 2025 population grid), so empty land doesn't drag a city
  down. Country scores average their cities, weighted by population. Neighbourhood boundaries come from Overture Maps divisions
  (from OpenStreetMap). Click any point to score it live, in your browser, from the same map data.</p>

  <h3>Score bands</h3>
  <div class="weights">${TIERS.map((tier, i) => `<div><b style="color:${scoreColor(tier.min + 5)}">${tier.min}${i === 0 ? '–100' : '–' + (TIERS[i - 1].min - 1)}</b><span>${tier.label}</span></div>`).join('')}</div>

  <h3>Data</h3>
  <ul>
    <li><a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a> (release 2026-09-23): places
      (CDLA-Permissive-2.0), transportation, base and divisions (ODbL, from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>).</li>
    <li><a href="https://human-settlement.emergency.copernicus.eu" target="_blank" rel="noopener">Global Human Settlement Layer</a>, European Commission JRC — Urban Centre Database R2024A and 2025 population grid (CC BY 4.0).</li>
    <li><a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a> country shapes (public domain). Basemap by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> / OpenMapTiles. Map engine: MapLibre GL JS.</li>
    <li>City list cross-checked with Boeing (2025), <i>Street network models and indicators for every urban area in the world</i> (CC0).</li>
  </ul>

  <h3>Limitations</h3>
  <ul>
    <li><b>Open map data is uneven.</b> In parts of Africa, South Asia, Iran and mainland China far fewer shops and stops are mapped
      than exist, so scores there understate reality. Those cities carry a “limited data” badge, are hatched on the map and are
      left out of the rankings. Coverage is measured as mapped destinations per 1,000 residents.</li>
    <li>Distances are straight lines, not walking routes; the street-grid score stands in for how direct real routes are.</li>
    <li>Sidewalk quality, safety, shade, hills, climate and transit frequency aren't measured — the map can't see them yet.</li>
    <li>Each city covers its dense core (up to 10 km out), not every suburb; rural areas aren't scored.</li>
  </ul>
  <p class="muted small">Open source: <a href="https://github.com/keyfive5/WalkablePlaces" target="_blank" rel="noopener">github.com/keyfive5/WalkablePlaces</a> — the pipeline and the exact model code are there. Data as of ${store.world?.generated || ''}.</p>`;
}
