// Data loading and derived lookups (rankings, averages).
import { SUBSCORES } from './model.js';

const DATA = new URL('../data/', import.meta.url);
const SUB_KEYS = SUBSCORES.map((s) => s.key);

export const store = {
  world: null,
  countries: new Map(),   // iso3 -> country
  cities: [],             // every scored city
  byId: new Map(),
  cityCache: new Map(),
  hoodIndex: null,
  worldAvg: null,
};

export async function loadWorld() {
  const res = await fetch(new URL('world.json', DATA));
  const world = await res.json();
  store.world = world;
  const { cols, rows } = world.cities;
  store.cities = rows.map((r) => Object.fromEntries(cols.map((k, i) => [k, r[i]])));
  for (const c of store.cities) store.byId.set(c.id, c);
  for (const [iso3, c] of Object.entries(world.countries)) store.countries.set(iso3, { iso3, ...c });

  // Rankings: cities with limited map data aren't ranked (their score understates reality).
  const rankable = store.cities.filter((c) => c.data < 2).sort((a, b) => b.score - a.score);
  rankable.forEach((c, i) => { c.rank = i + 1; });
  store.rankedCities = rankable.length;
  const byCountry = new Map();
  for (const c of rankable) {
    if (!byCountry.has(c.iso3)) byCountry.set(c.iso3, []);
    byCountry.get(c.iso3).push(c);
  }
  for (const list of byCountry.values()) list.forEach((c, i) => { c.countryRank = i + 1; });
  const rankableCountries = [...store.countries.values()].filter((c) => c.data < 1.5).sort((a, b) => b.score - a.score);
  rankableCountries.forEach((c, i) => { c.rank = i + 1; });
  store.rankedCountries = rankableCountries.length;

  // Population-weighted world averages of each subscore, for comparison ticks.
  const w = rankable.reduce((a, c) => a + c.pop, 0);
  store.worldAvg = {
    score: rankable.reduce((a, c) => a + c.score * c.pop, 0) / w,
    subs: SUB_KEYS.map((_, k) => rankable.reduce((a, c) => a + (c.subs[k] ?? 0) * c.pop, 0) / w),
  };
  return world;
}

export async function loadCity(id) {
  if (!store.cityCache.has(id)) {
    store.cityCache.set(id, fetch(new URL(`city/${id}.json`, DATA)).then((r) => {
      if (!r.ok) throw new Error(`No data for city ${id}`);
      return r.json();
    }).then((c) => {
      // Rank neighbourhoods within the city.
      const order = c.units.map((u, i) => i).sort((a, b) => c.units[b].score - c.units[a].score);
      order.forEach((ui, k) => { c.units[ui].rank = k + 1; c.units[ui].i = ui; });
      return c;
    }));
  }
  return store.cityCache.get(id);
}

/** [name, cityId, unitIndex, score] for every neighbourhood — fetched on first search. */
export async function loadHoodIndex() {
  if (!store.hoodIndex) store.hoodIndex = fetch(new URL('search.json', DATA)).then((r) => r.json());
  return store.hoodIndex;
}

export const subsOf = (o) => SUB_KEYS.map((k) => o[k]);
export const countryCities = (iso3) => store.cities.filter((c) => c.iso3 === iso3).sort((a, b) => b.score - a.score);
