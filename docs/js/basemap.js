// A quiet basemap on free OpenFreeMap vector tiles (OpenMapTiles schema),
// so the walkability colours carry the map. Dark and light variants.

const PALETTE = {
  dark: {
    space: '#05070c', land: '#12151b', water: '#0a0d12', waterLine: '#151a22', park: '#141c19', wood: '#131a17',
    residential: '#14171d', building: '#1b1f27', buildingTop: '#20252e',
    roadMinor: '#1e232c', roadMajor: '#272e39', roadMotor: '#313a47', rail: '#232832',
    boundary: '#3a4352', boundarySub: '#262c36',
    label: '#8d97a8', labelStrong: '#c4cad4', labelHalo: '#0b0e13', waterLabel: '#3d4a5c',
  },
  light: {
    space: '#e9ecf1', land: '#f4f3ef', water: '#dce3ea', waterLine: '#cdd6df', park: '#e6ebe1', wood: '#e3e8de',
    residential: '#efeee9', building: '#e5e3dd', buildingTop: '#ebe9e3',
    roadMinor: '#ffffff', roadMajor: '#ffffff', roadMotor: '#f7f1e6', rail: '#dddbd5',
    boundary: '#a9a59b', boundarySub: '#cfccc4',
    label: '#6b6a65', labelStrong: '#2d2c29', labelHalo: '#f8f7f3', waterLabel: '#8d9aa8',
  },
};

const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

export function basemapStyle(mode = 'dark') {
  const c = PALETTE[mode];
  return {
    version: 8,
    name: 'WalkablePlaces ' + mode,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: {
      'sky-color': c.space,
      'horizon-color': mode === 'dark' ? '#1b2a44' : '#cfd9e6',
      'fog-color': c.space,
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.9,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    },
    light: { anchor: 'viewport', color: '#ffffff', intensity: 0.35, position: [1.5, 200, 50] },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': c.land } },
      { id: 'landcover-wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]], paint: { 'fill-color': c.wood, 'fill-opacity': 0.8 } },
      { id: 'landuse-residential', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 9, filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood']]], paint: { 'fill-color': c.residential } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': c.park } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 8, paint: { 'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2] } },
      { id: 'water-outline', type: 'line', source: 'omt', 'source-layer': 'water', minzoom: 5, paint: { 'line-color': c.waterLine, 'line-width': 0.6 } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': c.building, 'fill-outline-color': c.buildingTop } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11, filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': c.rail, 'line-width': 1, 'line-dasharray': [3, 2] } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12, filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'track', 'path']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.roadMinor, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.5, 16, 4, 18, 10] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 7, filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.roadMajor, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 7, 0.4, 12, 1.2, 16, 7, 18, 16] } },
      { id: 'road-motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 5, filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.roadMotor, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 5, 0.4, 10, 1.4, 16, 9, 18, 20] } },
      { id: 'boundary-sub', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 3, filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': c.boundarySub, 'line-width': 0.6, 'line-dasharray': [3, 2] } },
      { id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': c.boundary, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1.2], 'line-dasharray': ['case', ['==', ['get', 'disputed'], 1], ['literal', [2, 2]], ['literal', [1, 0]]] } },
      { id: 'water-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 3, layout: { 'text-field': NAME, 'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-letter-spacing': 0.15, 'text-max-width': 6 }, paint: { 'text-color': c.waterLabel, 'text-halo-color': c.labelHalo, 'text-halo-width': 1 } },
      { id: 'label-suburb', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 12, filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood']]], layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08, 'text-max-width': 8 }, paint: { 'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.2 } },
      { id: 'label-town', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 8, filter: ['in', ['get', 'class'], ['literal', ['town', 'village']]], layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13], 'text-max-width': 8 }, paint: { 'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.2 } },
      { id: 'label-city', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4, filter: ['==', ['get', 'class'], 'city'], layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 15], 'text-max-width': 8 }, paint: { 'text-color': c.labelStrong, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.4 } },
      { id: 'label-country', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 7, filter: ['==', ['get', 'class'], 'country'], layout: { 'text-field': NAME, 'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 6, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.12, 'text-max-width': 7 }, paint: { 'text-color': c.label, 'text-halo-color': c.labelHalo, 'text-halo-width': 1.4 } },
    ],
  };
}

export const SPACE = { dark: PALETTE.dark.space, light: PALETTE.light.space };
// Layers our data goes beneath, so place names stay readable on top of hexes.
export const FIRST_LABEL_LAYER = 'water-label';
