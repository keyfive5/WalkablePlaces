// Score colours: a diverging ramp (red = car-dependent, neutral grey at 50,
// blue = walkable), computed in OKLab with monotone lightness on each arm.
// Light and dark modes have their own steps — dark mode is not an inversion.
import { TIERS } from './model.js';

export const RAMP = {
  light: ['#a51e24', '#b9514b', '#ca7972', '#d9a199', '#e6c8c2', '#f0efec', '#c4cfdf', '#99b0d1', '#7091c2', '#4772b2', '#1a52a1'],
  dark: ['#fa6863', '#d2615a', '#ab5952', '#845049', '#5f4540', '#3a3a37', '#44535c', '#4d6e83', '#5589ab', '#5ba5d6', '#60c2ff'],
};

// Categorical slots for comparing up to four places (validated default palette).
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500'],
};

export const theme = () => document.documentElement.dataset.resolvedTheme || 'dark';

function hexToRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Colour for a 0–100 score in the current theme. */
export function scoreColor(score, mode = theme()) {
  const ramp = RAMP[mode];
  if (score == null || Number.isNaN(score)) return mode === 'dark' ? '#2a2d33' : '#d7d6d1';
  const t = Math.max(0, Math.min(100, score)) / 10;
  const i = Math.min(9, Math.floor(t)), f = t - i;
  const a = hexToRgb(ramp[i]), b = hexToRgb(ramp[i + 1]);
  return toHex(a.map((v, k) => v + (b[k] - v) * f));
}

/** MapLibre expression colouring by a numeric property (0–100). */
export function scoreExpression(prop, mode = theme()) {
  const ramp = RAMP[mode];
  const stops = ramp.flatMap((c, i) => [i * 10, c]);
  return ['interpolate', ['linear'], ['to-number', ['get', prop], 0], ...stops];
}

export const tierColor = (tier, mode = theme()) => scoreColor(Math.min(100, tier.min + (tier.min === 85 ? 10 : 8)), mode);

export const TIER_LIST = TIERS;
