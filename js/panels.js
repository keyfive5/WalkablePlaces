// Panel views: world, country, city, neighbourhood and spot.
import { store, countryCities, loadHoodIndex, subsOf } from './store.js';
import { SUBSCORES, CATEGORY_LABELS, NEEDS, tierOf, TRANSIT_WEIGHT } from './model.js';
import { scoreColor } from './colors.js';
import {
  esc, round, fmt1, fmtPop, fmtInt, flag, ring, animateIn, subscoreBars, bars, tierStack, row, scoreChip,
  tierBadge, icons, note, DATA_NOTES, dot,
} from './ui.js';

const CATS = Object.keys(NEEDS);
const CONTINENTS = ['Europe', 'Asia', 'North America', 'South America', 'Africa', 'Oceania'];
const countryOf = (iso3) => store.countries.get(iso3);
const countryName = (iso3) => countryOf(iso3)?.name || store.world.pending?.[iso3] || iso3;
const iso2Of = (iso3) => countryOf(iso3)?.iso2;
const continentOf = (iso3) => countryOf(iso3)?.continent;
const pct = (v) => `${Math.round(v)}%`;

function hero(score, caption, pills = '') {
  return `<div class="hero">${ring(score, caption)}<div class="hero-meta">${tierBadge(score)}<div class="ranks">${pills}</div></div></div>`;
}
const pill = (html) => `<span class="pill">${html}</span>`;
function actions(compareItem, extra = '') {
  return `<div class="actions">
    <button class="btn" data-action="compare" data-item='${esc(JSON.stringify(compareItem))}'>${icons.compare}Compare</button>
    <button class="btn" data-action="share">${icons.share}Share</button>${extra}</div>`;
}
const refLegend = (what) => `<div class="legend-inline"><span><i></i>${esc(what)}</span></div>`;

// ---- world -------------------------------------------------------------------------
export function worldView(ctx) {
  const t = store.world.totals;
  const st = ctx.ui.world ??= { tab: 'countries', continent: 'All', order: 'best', limited: false, shown: 25 };
  const html = `
    <section>
      <p class="eyebrow">The world, on foot</p>
      <h1 class="title">How walkable is the world?</h1>
      <p class="subtitle">Scores for <b>${fmtInt(t.cities)}</b> cities and <b>${fmtInt(t.neighbourhoods)}</b> neighbourhoods in <b>${t.countries}</b> countries, measured from open map data. Pick a place, or click anywhere on the map.</p>
    </section>
    <div class="stats">
      <div class="stat"><b class="num">${fmtInt(t.cities)}</b><span>cities scored</span></div>
      <div class="stat"><b class="num">${fmtInt(t.neighbourhoods)}</b><span>neighbourhoods</span></div>
      <div class="stat"><b class="num">${fmtPop(t.people)}</b><span>residents covered</span></div>
    </div>
    <div class="actions">
      <button class="btn primary" data-action="surprise">${icons.dice}Surprise me</button>
      <button class="btn" data-action="locate">${icons.walk}Score where I am</button>
    </div>
    <section>
      <h2 class="section">Leaderboard</h2>
      <div class="tabs" role="tablist">
        ${['countries', 'cities', 'neighbourhoods'].map((k) => `<button role="tab" data-tab="${k}" aria-selected="${st.tab === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
      </div>
      <div class="chips" style="margin-top:10px">${['All', ...CONTINENTS].map((c) => `<button class="chip" data-continent="${c}" aria-pressed="${st.continent === c}">${c}</button>`).join('')}</div>
      <div class="toolbar" style="margin-top:10px">
        <div class="chips">
          <button class="chip" data-order="best" aria-pressed="${st.order === 'best'}">Most walkable</button>
          <button class="chip" data-order="worst" aria-pressed="${st.order === 'worst'}">Least walkable</button>
        </div>
        <label class="switch" title="Places where open map data is too sparse to score fairly"><input type="checkbox" data-limited ${st.limited ? 'checked' : ''}>Include limited data</label>
      </div>
      <ol class="list" id="board" style="margin-top:8px"><li class="skeleton" style="height:240px"></li></ol>
    </section>
    ${note(`Each score blends five things: everyday destinations nearby, a fine street grid, transit, car-free ways and distance from highways. <button class="link-btn" data-action="about">How scores work</button>`, 'info')}`;
  return {
    html,
    mount(root) {
      const board = root.querySelector('#board');
      const draw = async () => {
        board.innerHTML = await leaderboard(st);
        animateIn(board);
      };
      root.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.tab) { st.tab = b.dataset.tab; st.shown = 25; }
        else if (b.dataset.continent) { st.continent = b.dataset.continent; st.shown = 25; }
        else if (b.dataset.order) st.order = b.dataset.order;
        else if (b.dataset.more != null) st.shown += 50;
        else return;
        root.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === st.tab));
        root.querySelectorAll('[data-continent]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.continent === st.continent));
        root.querySelectorAll('[data-order]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.order === st.order));
        draw();
      });
      root.querySelector('[data-limited]').addEventListener('change', (e) => { st.limited = e.target.checked; draw(); });
      draw();
    },
  };
}

async function leaderboard(st) {
  const inContinent = (iso3) => st.continent === 'All' || continentOf(iso3) === st.continent;
  const dir = st.order === 'best' ? -1 : 1;
  let items = [];
  if (st.tab === 'countries') {
    items = [...store.countries.values()]
      .filter((c) => inContinent(c.iso3) && (st.limited || c.data < 1.5))
      .sort((a, b) => dir * (a.score - b.score))
      .map((c) => ({ name: c.name, lead: flag(c.iso2), sub: `${c.cities} ${c.cities === 1 ? 'city' : 'cities'} · ${pct(c.coverage)} of urban residents`, score: c.score, href: `#/country/${c.iso3}`, limited: c.data >= 1.5 }));
  } else if (st.tab === 'cities') {
    items = store.cities
      .filter((c) => inContinent(c.iso3) && (st.limited || c.data < 2))
      .sort((a, b) => dir * (a.score - b.score))
      .map((c) => ({ name: c.name, lead: flag(iso2Of(c.iso3)), sub: `${esc(countryName(c.iso3))} · ${fmtPop(c.pop)} people`, score: c.score, href: `#/city/${c.id}`, limited: c.data >= 2 }));
  } else {
    const idx = await loadHoodIndex();
    items = idx
      .filter(([, cid, , , hexes, pop, dq]) => {
        const c = store.byId.get(cid);
        return c && hexes >= 8 && pop >= 4000 && inContinent(c.iso3) && (st.limited || dq < 2);
      })
      .sort((a, b) => dir * (a[3] - b[3]))
      .map(([name, cid, u, score, , , dq, town]) => {
        const c = store.byId.get(cid);
        return { name, lead: flag(iso2Of(c.iso3)), sub: [town, c.name, countryName(c.iso3)].filter(Boolean).map(esc).join(', '), score, href: `#/city/${cid}/n/${u}`, limited: dq >= 2 };
      });
  }
  if (!items.length) return '<li class="muted small" style="padding:12px 8px">Nothing scored here yet.</li>';
  const shown = items.slice(0, st.shown);
  return shown.map((it, i) => row({
    rank: st.order === 'best' ? i + 1 : items.length - i, name: it.name, lead: it.lead, sub: it.sub, score: it.score, href: it.href,
    badge: it.limited ? '<span class="badge warn" title="Limited map data">limited data</span>' : '', dim: it.limited,
  })).join('') + (items.length > st.shown ? `<li><button class="more" data-more>Show more (${items.length - st.shown} left)</button></li>` : '');
}

// ---- country ------------------------------------------------------------------------
export function countryView(ctx, iso3) {
  const c = countryOf(iso3);
  if (!c) {
    return { html: `<section><p class="eyebrow">Country</p><h1 class="title">${esc(countryName(iso3))}</h1>
      <p class="subtitle">No city here has been scored yet.</p></section>` };
  }
  const cities = countryCities(iso3);
  const rankPill = c.rank ? pill(`<b>#${c.rank}</b> of ${store.rankedCountries} countries`) : pill('Not ranked — limited data');
  const html = `
    <section>
      <p class="eyebrow">${esc(c.continent || '')} · Country</p>
      <h1 class="title">${flag(c.iso2)} ${esc(c.name)}</h1>
      <p class="subtitle">${c.cities} ${c.cities === 1 ? 'city' : 'cities'} measured, home to ${pct(c.coverage)} of its urban residents.</p>
    </section>
    ${hero(c.score, 'urban score', rankPill + pill(`<b>${pct(c.walkShare)}</b> in walkable places`))}
    ${c.data >= 1.5 ? note(DATA_NOTES[2]) : c.data >= 0.75 ? note(DATA_NOTES[1]) : ''}
    ${actions({ kind: 'country', id: iso3 })}
    <section>
      <h2 class="section">What makes up the score</h2>
      ${subscoreBars(c.subs, store.worldAvg.subs)}
      ${refLegend('World average')}
    </section>
    <section>
      <h2 class="section">Cities <span class="aside">by score</span></h2>
      <ol class="list">${cities.map((x, i) => row({
        rank: i + 1, name: x.name, sub: `${fmtPop(x.pop)} people · ${x.units} neighbourhoods`, score: x.score, href: `#/city/${x.id}`,
        badge: x.data >= 2 ? '<span class="badge warn">limited data</span>' : '', dim: x.data >= 2, attrs: `data-city="${x.id}"`,
      })).join('')}</ol>
    </section>
    <p class="muted small">The country score averages its cities, weighted by population. Rural areas are not scored.</p>`;
  return {
    html,
    mount(root) {
      root.querySelectorAll('[data-city]').forEach((a) => {
        a.addEventListener('mouseenter', () => ctx.map.map.setFeatureState({ source: 'cities', id: Number(a.dataset.city) }, { hover: true }));
        a.addEventListener('mouseleave', () => ctx.map.map.setFeatureState({ source: 'cities', id: Number(a.dataset.city) }, { hover: false }));
      });
    },
  };
}

// ---- city ---------------------------------------------------------------------------
export function cityView(ctx, city) {
  const meta = store.byId.get(city.id);
  const s = city.summary;
  const subs = subsOf(s);
  const st = ctx.ui.city?.id === city.id ? ctx.ui.city : (ctx.ui.city = { id: city.id, order: 'best', filter: '' });
  const pills = (meta?.rank ? pill(`<b>#${meta.rank}</b> of ${fmtInt(store.rankedCities)} cities`) : pill('Not ranked — limited data'))
    + (meta?.countryRank ? pill(`<b>#${meta.countryRank}</b> in ${esc(countryName(city.iso3))}`) : '');
  const parent = city.parentId ? store.byId.get(city.parentId) : null;
  const dq = { good: 0, partial: 1, limited: 2 }[city.data?.quality] ?? 0;
  const html = `
    <section>
      <p class="eyebrow">City · <a href="#/country/${city.iso3}">${esc(countryName(city.iso3))}</a></p>
      <h1 class="title">${flag(iso2Of(city.iso3))} ${esc(city.name)}</h1>
      <p class="subtitle">${fmtPop(s.pop)} residents in ${Math.round(s.areaKm2)} km² analysed${parent ? ` (within the <a href="#/city/${parent.id}">${esc(parent.name)}</a> urban area)` : ''} · ${city.units.length} neighbourhoods</p>
    </section>
    ${hero(s.score, 'city score', pills)}
    ${dq ? note(DATA_NOTES[dq]) : ''}
    ${city.data && !city.data.transitMapped ? note('Transit stops are barely mapped here, so transit is left out and the other parts are reweighted.', 'info') : ''}
    ${actions({ kind: 'city', id: city.id })}
    <section>
      <h2 class="section">What makes up the score</h2>
      ${subscoreBars(subs, store.worldAvg.subs, { transitMapped: city.data?.transitMapped !== false })}
      ${refLegend('World city average')}
    </section>
    <section>
      <h2 class="section">Where people live <span class="aside">share of residents</span></h2>
      ${tierStack(s.tiers)}
    </section>
    <section>
      <h2 class="section">Daily needs within walking distance</h2>
      <div class="cats">${CATS.map((k, i) => `<div class="cat">${bars([{ label: CATEGORY_LABELS[k], value: s.cats[i] }])}</div>`).join('')}</div>
    </section>
    <section>
      <h2 class="section">Neighbourhoods <span class="aside">${city.units.length} areas</span></h2>
      <input class="filter-input" type="search" placeholder="Filter neighbourhoods" value="${esc(st.filter)}" data-filter aria-label="Filter neighbourhoods">
      <div class="chips" style="margin-bottom:6px">
        <button class="chip" data-order="best" aria-pressed="${st.order === 'best'}">Most walkable</button>
        <button class="chip" data-order="worst" aria-pressed="${st.order === 'worst'}">Least walkable</button>
        <button class="chip" data-order="az" aria-pressed="${st.order === 'az'}">A–Z</button>
      </div>
      <ol class="list" id="units"></ol>
    </section>
    <section>
      <h2 class="section">Mapped in the analysed area</h2>
      <div class="amen">${[['grocery', 'grocers'], ['food', 'places to eat'], ['shops', 'shops'], ['health', 'health'], ['education', 'schools'], ['stops', 'transit stops']]
        .map(([k, l]) => `<div><b>${fmtInt(s.amen[k])}</b><span>${l}</span></div>`).join('')}</div>
    </section>
    <p class="muted small">Analysed: the GHSL urban centre within ${city.radius / 1000} km of the centre, on a ${city.hexR} m hex grid, weighted by where people live.
      ${city.data ? `${fmt1(city.data.destPer1000)} mapped destinations per 1,000 residents.` : ''} <button class="link-btn" data-action="about">Method</button></p>`;
  return {
    html,
    mount(root) {
      const list = root.querySelector('#units');
      const draw = () => {
        const f = st.filter.trim().toLowerCase();
        let us = city.units.map((u, i) => ({ ...u, i })).filter((u) => !f || u.name.toLowerCase().includes(f) || (u.local || '').toLowerCase().includes(f));
        us.sort(st.order === 'az' ? (a, b) => a.name.localeCompare(b.name) : st.order === 'worst' ? (a, b) => a.score - b.score : (a, b) => b.score - a.score);
        list.innerHTML = us.length ? us.map((u) => row({
          rank: u.rank, name: u.name, sub: [u.town && u.town !== city.name ? esc(u.town) : '', `${fmtPop(u.pop)} residents`, u.local ? esc(u.local) : ''].filter(Boolean).join(' · '), score: u.score,
          href: `#/city/${city.id}/n/${u.i}`, attrs: `data-u="${u.i}"`,
        })).join('') : '<li class="muted small" style="padding:10px 8px">No match.</li>';
        animateIn(list);
      };
      root.querySelector('[data-filter]').addEventListener('input', (e) => { st.filter = e.target.value; draw(); });
      root.querySelectorAll('[data-order]').forEach((b) => b.addEventListener('click', () => {
        st.order = b.dataset.order;
        root.querySelectorAll('[data-order]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.order === st.order));
        draw();
      }));
      list.addEventListener('mouseover', (e) => { const a = e.target.closest('[data-u]'); if (a) ctx.map.previewUnit(Number(a.dataset.u)); });
      list.addEventListener('mouseleave', () => ctx.map.previewUnit(null));
      draw();
    },
  };
}

// ---- neighbourhood ----------------------------------------------------------------------
export function hoodView(ctx, city, ui) {
  const u = city.units[ui];
  const cs = city.summary;
  const diff = u.score - cs.score;
  const neighbours = adjacentUnits(city, ui).map((j) => ({ ...city.units[j], i: j })).sort((a, b) => b.score - a.score);
  const pills = pill(`<b>#${u.rank}</b> of ${city.units.length} in ${esc(city.name)}`)
    + pill(`<span class="${diff >= 0 ? 'delta-up' : 'delta-down'}">${diff >= 0 ? '+' : '−'}${fmt1(Math.abs(diff))}</span> vs city`);
  const html = `
    <section>
      <p class="eyebrow">Neighbourhood · <a href="#/city/${city.id}">${esc(city.name)}</a>, ${esc(countryName(city.iso3))}</p>
      <h1 class="title">${esc(u.name)}</h1>
      ${u.local || (u.town && u.town !== city.name) ? `<p class="subtitle">${[u.local, u.town && u.town !== city.name ? `in ${u.town}` : ''].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
    </section>
    ${hero(u.score, 'score', pills)}
    ${actions({ kind: 'hood', id: `${city.id}.${ui}` }, `<button class="btn" data-action="spot" data-lat="${u.lat}" data-lon="${u.lon}">${icons.pin}What's nearby</button>`)}
    <section>
      <h2 class="section">What makes up the score</h2>
      ${subscoreBars(subsOf(u), subsOf(cs), { transitMapped: city.data?.transitMapped !== false })}
      ${refLegend(`${city.name} average`)}
    </section>
    <section>
      <h2 class="section">Daily needs within walking distance</h2>
      <div class="cats">${CATS.map((k, i) => `<div class="cat">${bars([{ label: CATEGORY_LABELS[k], value: u.cats[i], ref: cs.cats[i] }])}</div>`).join('')}</div>
    </section>
    <section>
      <h2 class="section">Inside the neighbourhood</h2>
      <div class="amen">
        <div><b>${fmtPop(u.pop)}</b><span>residents</span></div>
        <div><b>${fmt1(u.areaKm2)}</b><span>km²</span></div>
        <div><b>${fmtInt(u.pop / Math.max(0.1, u.areaKm2))}</b><span>people / km²</span></div>
        ${[['grocery', 'grocers'], ['food', 'places to eat'], ['shops', 'shops'], ['health', 'health'], ['education', 'schools'], ['stops', 'transit stops']]
          .map(([k, l]) => `<div><b>${fmtInt(u.amen[k])}</b><span>${l}</span></div>`).join('')}
      </div>
    </section>
    ${neighbours.length ? `<section><h2 class="section">Next door</h2><ol class="list">${neighbours.map((n) => row({
      rank: n.rank, name: n.name, sub: `${fmtPop(n.pop)} residents`, score: n.score, href: `#/city/${city.id}/n/${n.i}`, attrs: `data-u="${n.i}"`,
    })).join('')}</ol></section>` : ''}`;
  return {
    html,
    mount(root) {
      root.querySelectorAll('[data-u]').forEach((a) => {
        a.addEventListener('mouseenter', () => ctx.map.previewUnit(Number(a.dataset.u)));
        a.addEventListener('mouseleave', () => ctx.map.previewUnit(null));
      });
    },
  };
}

function adjacentUnits(city, ui) {
  const H = city.hex, at = new Map(H.q.map((q, i) => [q + ',' + H.r[i], i]));
  const out = new Set();
  H.q.forEach((q, i) => {
    if (H.u[i] !== ui) return;
    for (const [dq, dr] of [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]) {
      const j = at.get(q + dq + ',' + (H.r[i] + dr));
      if (j != null && H.u[j] >= 0 && H.u[j] !== ui) out.add(H.u[j]);
    }
  });
  return [...out];
}

// ---- spot ---------------------------------------------------------------------------------
const KIND_LABEL = { metro: 'Metro', rail: 'Rail', tram: 'Tram', ferry: 'Ferry', bus: 'Bus' };
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const walkMin = (m) => Math.max(1, Math.round(m / 80));

export function spotLoadingView(lat, lon, hex) {
  return `
    <section>
      <p class="eyebrow">Spot · ${lat.toFixed(4)}, ${lon.toFixed(4)}</p>
      <h1 class="title" data-place>Scoring this spot…</h1>
      <p class="subtitle">Reading Overture Maps tiles around this point and running the WalkablePlaces model live.</p>
    </section>
    ${hex ? hero(hex.s, 'hex score', pill('From the city grid')) : '<div class="skeleton" style="height:112px"></div>'}
    <div class="progress" aria-label="Loading map tiles"><span data-progress></span></div>
    <p class="muted small" data-progress-text>Fetching tiles…</p>`;
}

export function spotView(ctx, lat, lon, r, placeName) {
  const sub = [r.needs, r.grid, r.transit, r.ped, r.calm].map((v) => 100 * v);
  const nearestRows = CATS.map((k) => {
    const n = r.nearest[k]?.[0];
    return `<div class="nr"><b>${esc(CATEGORY_LABELS[k])}</b><small>${n ? esc(n.name || n.tag?.replace(/_/g, ' ') || 'Unnamed') : 'Nothing within 1.6 km'}</small>
      <em>${n ? `${fmtDist(n.d)} · ${walkMin(n.d)} min` : '—'}</em></div>`;
  }).join('');
  const stops = r.stops.slice(0, 5).map((s) => `<div class="nr"><b>${KIND_LABEL[s.kind] || s.kind}</b><small>${esc(s.name || 'Stop')}</small><em>${fmtDist(s.d)}</em></div>`).join('');
  const html = `
    <section>
      <p class="eyebrow">Spot · ${lat.toFixed(4)}, ${lon.toFixed(4)}</p>
      <h1 class="title">${esc(placeName || 'This spot')}</h1>
      <p class="subtitle">Scored live from ${fmtInt(r.counts.places)} places, ${fmtInt(r.counts.stops)} stops and ${fmtInt(r.counts.intersections)} junctions nearby.</p>
    </section>
    ${hero(r.score, 'spot score', pill(`<b>${r.perCat.grocery.within + r.perCat.food.within + r.perCat.shops.within}</b> shops & cafés within 800 m`))}
    ${actions({ kind: 'spot', id: `${lat.toFixed(5)},${lon.toFixed(5)}`, label: placeName || 'Spot', scores: { score: r.score, subs: sub } })}
    <section>
      <h2 class="section">What makes up the score</h2>
      ${subscoreBars(sub, store.worldAvg.subs)}
      ${refLegend('World city average')}
    </section>
    <section><h2 class="section">Nearest everyday places</h2><div class="nearest">${nearestRows}</div></section>
    ${stops ? `<section><h2 class="section">Transit nearby</h2><div class="nearest">${stops}</div></section>` : ''}
    <p class="muted small">Straight-line distances; a 5-minute walk is about 400 m. Places come from Overture Maps (confidence ≥ 0.5).</p>`;
  return { html };
}

export { CONTINENTS, countryName, iso2Of };
