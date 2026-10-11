// Small rendering helpers shared by every panel. Everything returns HTML strings.
import { scoreColor } from './colors.js';
import { tierOf, TIERS, SUBSCORES } from './model.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const round = (v) => (v == null ? '–' : Math.round(v));
export const fmt1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));

export function fmtPop(n) {
  if (n == null) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
export const fmtInt = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en'));
export const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th');

export function flag(iso2) {
  if (!iso2 || iso2.length !== 2) return '';
  return `<img class="flag" src="https://flagcdn.com/w40/${iso2.toLowerCase()}.png" alt="" loading="lazy" width="20" height="15" onerror="this.remove()">`;
}

export const dot = (score) => `<i class="dot" style="background:${scoreColor(score)}"></i>`;

export function scoreChip(score, { dim = false } = {}) {
  return `<span class="score-chip"${dim ? ' style="opacity:.55"' : ''}>${dot(score)}<span>${round(score)}</span></span>`;
}

export function tierBadge(score) {
  const t = tierOf(score);
  return `<span class="tier">${dot(score)}${esc(t.label)}</span>`;
}

/** Big score ring with count-up. */
export function ring(score, caption = 'of 100') {
  const r = 46, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<div class="ring" role="img" aria-label="Walkability score ${round(score)} out of 100">
    <svg viewBox="0 0 112 112"><circle class="ring-track" cx="56" cy="56" r="${r}"/>
    <circle class="ring-val" cx="56" cy="56" r="${r}" stroke="${scoreColor(score)}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-offset="${off}"/></svg>
    <div class="ring-num"><div><b data-count="${round(score)}">0</b><span>${esc(caption)}</span></div></div></div>`;
}

/** Animate rings and counters inside a freshly rendered container. */
export function animateIn(root) {
  requestAnimationFrame(() => {
    root.querySelectorAll('.ring-val').forEach((el) => { el.style.strokeDashoffset = el.dataset.offset; });
    root.querySelectorAll('[data-count]').forEach((el) => {
      const to = Number(el.dataset.count);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; return; }
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 900);
        el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    root.querySelectorAll('[data-width]').forEach((el) => { el.style.width = el.dataset.width + '%'; });
  });
}

/**
 * Horizontal bars for subscores. items: [{ label, hint, value, ref }] with values 0–100.
 * `ref` draws a comparison tick (e.g. the city or world average).
 */
export function bars(items) {
  return `<div class="bars">${items.map((it) => `
    <div class="bar-row" title="${esc(it.hint || '')}">
      <span class="bar-label">${esc(it.label)}</span>
      <span class="bar-val">${it.value == null ? '<span class="muted">n/a</span>' : round(it.value)}</span>
      ${it.value == null
        ? `<span class="bar-na">${esc(it.naText || 'Not scored here')}</span>`
        : `<span class="bar-track"><span class="bar-fill" data-width="${Math.max(1.5, it.value)}" style="width:0;background:${scoreColor(it.value)}"></span>${it.ref != null ? `<span class="bar-ref" style="left:${it.ref}%" title="${esc(it.refLabel || '')}: ${round(it.ref)}"></span>` : ''}</span>`}
    </div>`).join('')}</div>`;
}

export function subscoreBars(subs, ref, { transitMapped = true } = {}) {
  return bars(SUBSCORES.map((s, i) => ({
    label: s.label, hint: s.hint, value: s.key === 'transit' && !transitMapped ? null : subs[i],
    ref: ref ? ref[i] : null, naText: 'Stops barely mapped here — left out of the score',
  })));
}

/** Population share per tier as a stacked bar with a legend. shares: % per tier, best tier first. */
export function tierStack(shares) {
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  const segs = TIERS.map((t, i) => ({ t, v: shares[i] })).reverse();
  return `<div class="stack" role="img" aria-label="${segs.map((s) => `${s.t.label} ${Math.round(s.v)}%`).join(', ')}">
    ${segs.map((s) => (s.v > 0 ? `<span style="flex-grow:${s.v / total};background:${scoreColor(s.t.min + (s.t.min === 85 ? 10 : 8))}" title="${esc(s.t.label)}: ${Math.round(s.v)}%"></span>` : '')).join('')}
  </div>
  <div class="stack-legend">${TIERS.map((t, i) => `<div>${dot(t.min + (t.min === 85 ? 10 : 8))}${esc(t.label)}<b>${Math.round(shares[i])}%</b></div>`).join('')}</div>`;
}

/** A ranked list row. */
export function row({ rank, name, sub, score, href, lead = '', badge = '', attrs = '', dim = false }) {
  return `<li><a class="row" href="${href}" ${attrs}>
    <span class="rk">${rank ?? ''}</span>
    <span class="nm"><strong>${lead}${lead ? ' ' : ''}${esc(name)} ${badge}</strong>${sub ? `<small>${sub}</small>` : ''}
      <span class="mini"><span style="width:${Math.max(2, score)}%;background:${scoreColor(score)}"></span></span></span>
    ${scoreChip(score, { dim })}
  </a></li>`;
}

export const icons = {
  compare: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
  dice: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M10 22l2-7-3-3 1-4 4 3 3 1M9 8l-3 3v4"/></svg>',
};

export function note(html, kind = 'warn') {
  return `<div class="note ${kind === 'info' ? 'info' : ''}">${kind === 'info' ? icons.info : icons.warn}<div>${html}</div></div>`;
}

export const DATA_NOTES = {
  1: 'Map data here has <b>some gaps</b> — fewer shops and services are mapped than in comparable cities, so the score may be a little low.',
  2: '<b>Limited map data.</b> Open map data records only a fraction of the shops, services and stops that exist here, so this score understates real walkability. It is left out of the rankings.',
};
