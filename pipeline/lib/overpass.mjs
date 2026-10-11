// Polite Overpass API client: one request at a time per endpoint, exponential
// backoff on overload, endpoint rotation, and a running byte tally.
import { sleep } from './util.mjs';

const UA = 'WalkablePlaces/1.0 (+https://github.com/keyfive5/WalkablePlaces)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const downUntil = new Map();
export const stats = { bytes: 0, queries: 0, failures: 0 };

export const bboxStr = ({ s, w, n, e }) => [s, w, n, e].map((v) => v.toFixed(5)).join(',');

function looksLikeError(text) {
  const head = text.slice(0, 600);
  return head.includes('<html') || head.includes('<?xml') || /runtime error|rate_limited|Dispatcher_Client/.test(head);
}

/** Run a query; resolves to the response text. Retries until it succeeds or `maxTries` runs out. */
export async function overpass(query, { maxTries = 12, label = '' } = {}) {
  let delay = 20000;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const now = Date.now();
    const ep = ENDPOINTS.find((e) => (downUntil.get(e) || 0) <= now) || ENDPOINTS[0];
    const t0 = Date.now();
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(900_000),
      });
      const text = await res.text();
      if (res.ok && !looksLikeError(text)) {
        stats.bytes += text.length; stats.queries++;
        return { text, endpoint: ep, ms: Date.now() - t0 };
      }
      const why = res.status + ' ' + (text.match(/Error<\/strong>: ([^<]{0,140})/)?.[1] || text.slice(0, 80).replace(/\s+/g, ' '));
      console.warn(`  ! ${label} attempt ${attempt} @ ${new URL(ep).host}: ${why}`);
      // Servers that answer instantly with 5xx are down; park them for a while.
      if (res.status >= 500 && Date.now() - t0 < 3000) downUntil.set(ep, Date.now() + 10 * 60_000);
      if (/out of memory|timed out after/.test(text)) throw Object.assign(new Error('query too large'), { fatal: true });
    } catch (err) {
      if (err.fatal) throw err;
      console.warn(`  ! ${label} attempt ${attempt} @ ${new URL(ep).host}: ${err.message}`);
    }
    stats.failures++;
    await sleep(delay);
    delay = Math.min(delay * 1.6, 300_000);
  }
  throw new Error(`Overpass failed after ${maxTries} tries: ${label}`);
}
