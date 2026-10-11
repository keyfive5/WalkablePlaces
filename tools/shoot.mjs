// Visual check: drives headless Edge/Chrome over the DevTools protocol, waits for
// the map to finish rendering, and saves screenshots.
//   node tools/shoot.mjs <outDir> <url>[|width x height] ...
// Each shot waits until the map is idle; append "!js code" to run code first.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
const exe = BROWSERS.find(existsSync);
const [outDir, ...shots] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--window-size=1440,900', '--no-first-run', `--user-data-dir=${outDir}/.profile`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');
await send('Page.enable');

for (const [i, spec] of shots.entries()) {
  const [urlPart, js] = spec.split('!');
  const [url, size] = urlPart.split('|');
  const [w, h] = (size || '1440x900').split('x').map(Number);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  await send('Page.navigate', { url });
  await sleep(1500);
  // wait for the map to settle (style loaded, tiles loaded, not moving)
  for (let k = 0; k < 120; k++) {
    const ok = await evaluate(`(() => { const m = window.__wp?.map?.map; return !!(m && m.isStyleLoaded() && m.loaded() && !m.isMoving()); })()`);
    if (ok) break;
    await sleep(500);
  }
  if (js) { await evaluate(js); await sleep(2500); for (let k = 0; k < 60; k++) { if (await evaluate(`(() => { const m = window.__wp?.map?.map; return !!(m && m.loaded() && !m.isMoving()); })()`)) break; await sleep(500); } }
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${outDir}/shot-${i + 1}.png`;
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', file, url);
}
if (logs.length) console.log('console:\n' + [...new Set(logs)].slice(0, 20).join('\n'));
ws.close();
proc.kill();
process.exit(0);
