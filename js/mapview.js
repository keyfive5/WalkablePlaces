// The map: globe with a country choropleth and city dots, and a 3D hex grid with
// neighbourhood outlines once a city is open.
import * as maplibregl from '../vendor/maplibre-gl-6.11.2/maplibre-gl.mjs';
import { basemapStyle } from './basemap.js';
import { scoreExpression, theme } from './colors.js';
import { Projection, hexRing, hexEdge, HEX_R, HEX_NEIGHBOURS } from './model.js';

export const METRICS = [
  { key: 'score', hex: 's', label: 'Overall', legend: 'Walkability score' },
  { key: 'needs', hex: 'n', label: 'Daily needs', legend: 'Daily needs nearby' },
  { key: 'grid', hex: 'g', label: 'Street grid', legend: 'Street grid density' },
  { key: 'transit', hex: 't', label: 'Transit', legend: 'Transit access' },
  { key: 'ped', hex: 'p', label: 'Car-free', legend: 'Car-free ways' },
  { key: 'calm', hex: 'c', label: 'Highway calm', legend: 'Distance from highways' },
];

const EMPTY = { type: 'FeatureCollection', features: [] };
const DATA_LAYERS_BEFORE = 'water-label';

export class MapView {
  constructor(container, { onHover, onClick, onMoveStart }) {
    this.onHover = onHover;
    this.onClick = onClick;
    this.data = { countries: EMPTY, cities: EMPTY, hexes: EMPTY, outlines: EMPTY, labels: EMPTY, spot: EMPTY };
    this.metric = 'score';
    this.is3D = !matchMedia('(max-width: 760px)').matches;
    this.hoverRef = null;
    this.activeUnit = null;
    this.selectedCountry = null;
    this.map = new maplibregl.Map({
      container,
      style: basemapStyle(theme()),
      center: [12, 28],
      zoom: matchMedia('(max-width: 760px)').matches ? 0.9 : 1.75,
      minZoom: 0.6,
      maxZoom: 17.5,
      attributionControl: { compact: true, customAttribution: 'Scores: WalkablePlaces · Data <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a>, <a href="https://human-settlement.emergency.copernicus.eu" target="_blank" rel="noopener">GHSL</a>' },
      dragRotate: true,
      maxPitch: 70,
    });
    this.map.on('style.load', () => this.addLayers());
    this.map.on('mousemove', (e) => this.handleMove(e));
    this.map.on('mouseout', () => this.clearHover());
    this.map.on('click', (e) => this.handleClick(e));
    for (const ev of ['mousedown', 'touchstart', 'wheel']) this.map.on(ev, () => { this.stopSpin(); onMoveStart?.(); });
    // Data can be drawn as soon as the style is parsed; no need to wait for every basemap tile.
    this.ready = new Promise((res) => this.map.once('style.load', () => setTimeout(res, 0)));
  }

  // ---- layers -------------------------------------------------------------------
  addLayers() {
    const m = this.map;
    const dark = theme() === 'dark';
    if (!m.hasImage('hatch')) m.addImage('hatch', hatchImage(dark));
    m.addSource('countries', { type: 'geojson', data: this.data.countries, promoteId: 'iso3' });
    m.addSource('cities', { type: 'geojson', data: this.data.cities, promoteId: 'id' });
    m.addSource('hexes', { type: 'geojson', data: this.data.hexes, promoteId: 'i' });
    m.addSource('outlines', { type: 'geojson', data: this.data.outlines });
    m.addSource('hood-labels', { type: 'geojson', data: this.data.labels });
    m.addSource('spot', { type: 'geojson', data: this.data.spot });

    const ink = dark ? '#f2f4f7' : '#111318';
    const panel = dark ? '#0d1016' : '#fcfcfa';
    const noData = dark ? '#1b1f27' : '#e2e0da';
    const limited = dark ? '#3a3d44' : '#c9c7c0';
    const fadeOut = (a, b) => ['interpolate', ['linear'], ['zoom'], a, 1, b, 0];
    const before = m.getLayer(DATA_LAYERS_BEFORE) ? DATA_LAYERS_BEFORE : undefined;

    m.addLayer({
      id: 'countries-fill', type: 'fill', source: 'countries',
      paint: {
        // Limited-data countries get a neutral fill: the hatch says "not enough map data", not "car-dependent".
        'fill-color': ['case', ['!=', ['typeof', ['get', 'score']], 'number'], noData, ['>=', ['coalesce', ['get', 'data'], 0], 1.5], limited, scoreExpression('score')],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'],
          1, ['case', ['boolean', ['feature-state', 'dim'], false], 0.22, 0.82],
          4, ['case', ['boolean', ['feature-state', 'dim'], false], 0.12, 0.5],
          6.5, 0.12, 8, 0],
      },
    }, before);
    m.addLayer({
      id: 'countries-hatch', type: 'fill', source: 'countries', filter: ['>=', ['coalesce', ['get', 'data'], 0], 1.5],
      paint: { 'fill-pattern': 'hatch', 'fill-opacity': fadeOut(5, 7) },
    }, before);
    m.addLayer({
      id: 'countries-line', type: 'line', source: 'countries',
      paint: {
        'line-color': ink,
        'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2, ['boolean', ['feature-state', 'hover'], false], 1.4, 0],
        'line-opacity': fadeOut(6, 8),
      },
    }, before);

    // 3D and flat hexes share one source; only one is visible at a time.
    m.addLayer({
      id: 'hex-2d', type: 'fill', source: 'hexes',
      layout: { visibility: this.is3D ? 'none' : 'visible' },
      paint: {
        'fill-color': this.hexColor(),
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.9],
      },
    }, before);
    m.addLayer({
      id: 'hex-3d', type: 'fill-extrusion', source: 'hexes',
      layout: { visibility: this.is3D ? 'visible' : 'none' },
      paint: {
        'fill-extrusion-color': this.hexColor(),
        'fill-extrusion-height': this.hexHeight(),
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    m.addLayer({
      id: 'hood-bounds', type: 'line', source: 'outlines',
      paint: { 'line-color': ink, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.18, 13, 0.45], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.4] },
    });
    m.addLayer({
      id: 'hood-active', type: 'line', source: 'outlines', filter: ['==', ['get', 'u'], -2],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.5] },
    });
    m.addLayer({
      id: 'hood-labels', type: 'symbol', source: 'hood-labels', minzoom: 10.2,
      layout: {
        'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['to-string', ['round', ['get', 'value']]], { 'font-scale': 1.15, 'text-font': ['literal', ['Noto Sans Bold']] }],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10.5, 15, 13],
        'text-max-width': 8,
        'symbol-sort-key': ['-', 0, ['get', 'pop']],
        'text-padding': 4,
      },
      paint: { 'text-color': ink, 'text-halo-color': panel, 'text-halo-width': 1.6 },
    });

    m.addLayer({
      id: 'cities-dot', type: 'circle', source: 'cities',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          1, ['interpolate', ['linear'], ['sqrt', ['get', 'pop']], 300, 1.4, 2000, 3.2, 6000, 7],
          5, ['interpolate', ['linear'], ['sqrt', ['get', 'pop']], 300, 3, 2000, 6.5, 6000, 13],
          9, ['interpolate', ['linear'], ['sqrt', ['get', 'pop']], 300, 6, 2000, 11, 6000, 20]],
        'circle-color': ['case', ['>=', ['coalesce', ['get', 'data'], 0], 2], limited, scoreExpression('score')],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['>=', ['coalesce', ['get', 'data'], 0], 2], 0.45, 1], 10.5, 0],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'hover'], false], ink, panel],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.2, 0.8],
        'circle-stroke-opacity': fadeOut(9, 10.5),
        'circle-pitch-alignment': 'map',
      },
    });
    m.addLayer({
      id: 'cities-label', type: 'symbol', source: 'cities', minzoom: 2.2, maxzoom: 10.5,
      layout: {
        'text-field': ['format', ['get', 'name'], {}, '  ', {}, ['to-string', ['round', ['get', 'score']]], { 'text-font': ['literal', ['Noto Sans Bold']] }],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10.5, 8, 13],
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.9,
        'symbol-sort-key': ['-', 0, ['get', 'pop']],
        'text-optional': true,
      },
      paint: { 'text-color': ink, 'text-halo-color': panel, 'text-halo-width': 1.5, 'text-opacity': ['case', ['>=', ['coalesce', ['get', 'data'], 0], 2], 0.55, 1] },
    });

    m.addLayer({
      id: 'spot-places', type: 'circle', source: 'spot',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 16, 7], 'circle-color': ['get', 'color'], 'circle-stroke-color': panel, 'circle-stroke-width': 2 },
    });
    m.addLayer({
      id: 'spot-labels', type: 'symbol', source: 'spot', minzoom: 14.5, filter: ['!=', ['get', 'kind'], 'origin'],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': ink, 'text-halo-color': panel, 'text-halo-width': 1.4 },
    });

    this.applySelection();
  }

  hexColor() {
    const key = METRICS.find((x) => x.key === this.metric).hex;
    return ['case', ['boolean', ['feature-state', 'dim'], false], theme() === 'dark' ? '#23262d' : '#d9d7d1', scoreExpression(key)];
  }
  hexHeight() {
    const key = METRICS.find((x) => x.key === this.metric).hex;
    // Squared, so the gap between a 60 and a 90 reads clearly in 3D.
    const v = ['^', ['/', ['to-number', ['get', key], 0], 100], 2];
    return ['interpolate', ['linear'], ['zoom'], 9, ['*', v, 1800], 12, ['*', v, 520], 15, ['*', v, 150]];
  }

  // ---- data ---------------------------------------------------------------------
  setSource(name, data) {
    this.data[name === 'hood-labels' ? 'labels' : name] = data;
    this.map.getSource(name)?.setData(data);
  }

  setCountries(fc) { this.setSource('countries', fc); }
  setCities(fc) { this.setSource('cities', fc); }

  /** Draw a city's hex grid, neighbourhood outlines and labels. */
  setCity(city) {
    if (!city) {
      this.city = null;
      for (const s of ['hexes', 'outlines', 'hood-labels']) this.setSource(s, EMPTY);
      this.map.setLayoutProperty('label-suburb', 'visibility', 'visible');
      return;
    }
    this.city = city;
    const proj = new Projection(city.centre[1], city.centre[0]);
    const H = city.hex, R = city.hexR || HEX_R;
    const features = H.q.map((q, i) => ({
      type: 'Feature', id: i,
      properties: { i, s: H.s[i], n: H.n[i], g: H.g[i], t: H.t[i], p: H.p[i], c: H.c[i], u: H.u[i], pop: H.pop[i] },
      geometry: { type: 'Polygon', coordinates: [hexRing(q, H.r[i], proj, R, 0.9)] },
    }));
    // Outline of each neighbourhood: hex edges whose neighbour is in another unit (or absent).
    const at = new Map(H.q.map((q, i) => [q + ',' + H.r[i], i]));
    const edges = new Map();
    H.q.forEach((q, i) => {
      const u = H.u[i];
      if (u < 0) return;
      HEX_NEIGHBOURS.forEach(([dq, dr], k) => {
        const j = at.get(q + dq + ',' + (H.r[i] + dr));
        if (j != null && H.u[j] === u) return;
        if (!edges.has(u)) edges.set(u, []);
        edges.get(u).push(hexEdge(q, H.r[i], k, proj, R));
      });
    });
    const outlines = [...edges.entries()].map(([u, segs]) => ({ type: 'Feature', properties: { u }, geometry: { type: 'MultiLineString', coordinates: chain(segs) } }));
    const labels = city.units.map((un, u) => ({
      type: 'Feature', properties: { u, name: un.name, value: un[this.metric] ?? un.score, pop: un.pop },
      geometry: { type: 'Point', coordinates: [un.lon, un.lat] },
    }));
    this.setSource('hexes', { type: 'FeatureCollection', features });
    this.setSource('outlines', { type: 'FeatureCollection', features: outlines });
    this.setSource('hood-labels', { type: 'FeatureCollection', features: labels });
    if (this.map.getLayer('label-suburb')) this.map.setLayoutProperty('label-suburb', 'visibility', 'none');
  }

  setMetric(key) {
    this.metric = key;
    if (!this.map.getLayer('hex-2d')) return;
    this.map.setPaintProperty('hex-2d', 'fill-color', this.hexColor());
    this.map.setPaintProperty('hex-3d', 'fill-extrusion-color', this.hexColor());
    this.map.setPaintProperty('hex-3d', 'fill-extrusion-height', this.hexHeight());
    if (this.city) {
      const labels = this.data.labels.features.map((f) => ({ ...f, properties: { ...f.properties, value: this.city.units[f.properties.u][key] ?? this.city.units[f.properties.u].score } }));
      this.setSource('hood-labels', { type: 'FeatureCollection', features: labels });
    }
  }

  set3D(on) {
    this.is3D = on;
    this.map.setLayoutProperty('hex-3d', 'visibility', on ? 'visible' : 'none');
    this.map.setLayoutProperty('hex-2d', 'visibility', on ? 'none' : 'visible');
    if (this.city) this.map.easeTo({ pitch: on ? 52 : 0, duration: 700 });
  }

  /** Nearest destinations around a scored spot. The grid goes flat and faint so they stay visible. */
  setSpot(points) {
    this.setSource('spot', { type: 'FeatureCollection', features: points });
    const on = points.length > 0;
    if (!this.map.getLayer('hex-2d')) return;
    this.map.setLayoutProperty('hex-3d', 'visibility', this.is3D && !on ? 'visible' : 'none');
    this.map.setLayoutProperty('hex-2d', 'visibility', !this.is3D || on ? 'visible' : 'none');
    this.map.setPaintProperty('hex-2d', 'fill-opacity', on ? 0.35 : ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.9]);
  }

  // ---- selection & camera ---------------------------------------------------------
  selectCountry(iso3) {
    this.selectedCountry = iso3;
    this.applySelection();
  }
  applySelection() {
    const m = this.map;
    if (!m.getSource('countries')) return;
    for (const f of this.data.countries.features) {
      const id = f.properties.iso3;
      m.setFeatureState({ source: 'countries', id }, { dim: !!this.selectedCountry && id !== this.selectedCountry, selected: id === this.selectedCountry });
    }
    this.highlightUnit(this.activeUnit);
  }
  /** Select a neighbourhood: outline it and dim the rest of the city. */
  highlightUnit(u) {
    this.activeUnit = u;
    if (!this.map.getLayer('hood-active')) return;
    this.map.setFilter('hood-active', ['==', ['get', 'u'], u ?? -2]);
    if (this.city) {
      this.city.hex.u.forEach((hu, i) => this.map.setFeatureState({ source: 'hexes', id: i }, { dim: u != null && hu !== u }));
    }
  }
  /** Hover preview of a neighbourhood: outline only. */
  previewUnit(u) {
    if (!this.map.getLayer('hood-active')) return;
    const show = u ?? this.activeUnit;
    this.map.setFilter('hood-active', ['==', ['get', 'u'], show ?? -2]);
  }

  setPadding() {
    const mobile = matchMedia('(max-width: 760px)').matches;
    const panel = document.getElementById('panel');
    const pad = mobile
      ? { left: 0, right: 0, top: 60, bottom: panel.offsetHeight }
      : { left: panel.offsetWidth + 24, right: 20, top: 20, bottom: 20 };
    this.map.setPadding(pad);
    return pad;
  }

  flyTo(opts) {
    this.setPadding();
    this.map.flyTo({ duration: 2200, essential: true, curve: 1.5, ...opts });
  }
  fitBounds(bounds, opts = {}) {
    this.setPadding();
    this.map.fitBounds(bounds, { padding: 40, duration: 2000, essential: true, maxZoom: 7, ...opts });
  }

  // Slow globe spin on the landing view, until the visitor touches the map.
  spin() {
    if (this.spinning || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.spinning = true;
    let last = performance.now();
    const step = (t) => {
      if (!this.spinning) return;
      const dt = Math.min(64, t - last); last = t;
      if (this.map.getZoom() < 3.2 && !this.map.isMoving()) {
        const c = this.map.getCenter();
        this.map.jumpTo({ center: [c.lng + dt * 0.0022, c.lat] });
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  stopSpin() { this.spinning = false; cancelAnimationFrame(this.raf); }

  // ---- interaction ------------------------------------------------------------------
  interactive() {
    return ['cities-dot', this.is3D ? 'hex-3d' : 'hex-2d', 'countries-fill'].filter((l) => this.map.getLayer(l));
  }
  pick(point) {
    const feats = this.map.queryRenderedFeatures(point, { layers: this.interactive() });
    const z = this.map.getZoom();
    for (const f of feats) {
      if (f.layer.id === 'cities-dot' && z < 10.3) return { kind: 'city', id: f.properties.id, f };
      if (f.layer.id.startsWith('hex-')) return { kind: 'hex', id: f.properties.i, f };
    }
    const c = feats.find((f) => f.layer.id === 'countries-fill');
    if (c && z < 6.5) return { kind: 'country', id: c.properties.iso3, f: c };
    return null;
  }
  handleMove(e) {
    const hit = this.pick(e.point);
    const key = hit ? hit.kind + ':' + hit.id : null;
    if (key !== this.hoverKey) {
      this.clearHoverState();
      this.hoverKey = key;
      if (hit) {
        const src = { city: 'cities', hex: 'hexes', country: 'countries' }[hit.kind];
        this.hoverRef = { source: src, id: hit.id };
        this.map.setFeatureState(this.hoverRef, { hover: true });
      }
    }
    this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
    this.onHover?.(hit, e.originalEvent);
  }
  clearHoverState() {
    if (this.hoverRef) this.map.setFeatureState(this.hoverRef, { hover: false });
    this.hoverRef = null;
  }
  clearHover() {
    this.clearHoverState();
    this.hoverKey = null;
    this.onHover?.(null);
  }
  handleClick(e) {
    const hit = this.pick(e.point);
    this.onClick?.(hit, e.lngLat, this.map.getZoom());
  }

  setTheme(mode) {
    this.map.setStyle(basemapStyle(mode), { diff: false });
  }
}

/** Join edge segments that share endpoints into longer polylines. */
function chain(segs) {
  const key = ([x, y]) => x.toFixed(6) + ',' + y.toFixed(6);
  const starts = new Map();
  segs.forEach((s, i) => {
    const k = key(s[0]);
    if (!starts.has(k)) starts.set(k, []);
    starts.get(k).push(i);
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segs[i][0], segs[i][1]];
    for (;;) {
      const next = (starts.get(key(line[line.length - 1])) || []).find((j) => !used[j]);
      if (next == null) break;
      used[next] = 1;
      line.push(segs[next][1]);
    }
    lines.push(line);
  }
  return lines;
}

function hatchImage(dark) {
  const n = 8, data = new Uint8Array(n * n * 4);
  const [r, g, b] = dark ? [255, 255, 255] : [20, 24, 30];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if ((x + y) % n === 0 || (x + y) % n === n - 1) {
      const o = (y * n + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = dark ? 70 : 60;
    }
  }
  return { width: n, height: n, data };
}
