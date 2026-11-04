// Serveur Node sans dépendance : sert public/ et /api/arrivals?stop=XXXXX
// qui interroge l'API SIRI-SM 2.8 du ministère des Transports.
//
// On utilise node:http et pas fetch(), car fetch() (undici) bloque le port 110.
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStops, stopInfo, stopsLoaded } from './stops.js';

const PORT = Number(process.env.PORT) || 3000;
const MOCK = process.env.MOT_MOCK === '1';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
initStops(join(ROOT, 'data'));
const WINDOW_MIN = 30;
const TIMEOUT_MS = 10000;

// ---------- Logs ----------
// Une ligne par erreur, lisible dans `journalctl -u bus-arrivals`. La clé API est toujours masquée.
const maskKey = (s) => String(s).replace(/(Key=)[^&\s]+/gi, '$1***');
function logError(scope, msg, fields = {}) {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${JSON.stringify(maskKey(v))}`)
    .join(' ');
  console.error(`${new Date().toISOString()} ERROR [${scope}] ${maskKey(msg)}${kv ? ' ' + kv : ''}`);
}
const snippet = (body) => String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);

// ---------- Appel à l'API MOT ----------
// En cas d'échec, l'erreur porte des détails pour les logs : httpStatus, code (ECONNREFUSED…), body.
function fail(message, extra) { return Object.assign(new Error(message), extra); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'Accept-Encoding': 'gzip' }, timeout: TIMEOUT_MS }, (res) => {
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c) => (body += c));
      stream.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(fail(`HTTP ${res.statusCode}`, { httpStatus: res.statusCode, body: snippet(body) }));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(fail('Réponse invalide du serveur MOT', { httpStatus: 200, cause: 'invalid JSON', body: snippet(body) })); }
      });
      stream.on('error', (e) => reject(fail('Réponse illisible du serveur MOT', { code: e.code, cause: e.message })));
    });
    req.on('timeout', () => req.destroy(fail('Délai dépassé (IP non autorisée par le ministère ?)', { code: 'TIMEOUT', cause: `no response after ${TIMEOUT_MS} ms` })));
    req.on('error', (e) => reject(e.code === 'TIMEOUT' ? e : fail(`Serveur MOT injoignable (${e.code || e.message})`, { code: e.code, cause: e.message })));
  });
}

function mockData(stop) {
  const t = (m) => new Date(Date.now() + m * 60000).toISOString();
  const visit = (line, dest, min, started = true) => ({
    MonitoringRef: stop,
    MonitoredVehicleJourney: {
      LineRef: '1' + line, PublishedLineName: line, DestinationRef: dest,
      MonitoredCall: { StopPointRef: stop, ExpectedArrivalTime: t(min), ...(started ? {} : { AimedArrivalTime: t(min) }) },
    },
  });
  return { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{ MonitoredStopVisit: [
    visit('18', '20012', 2), visit('5א', '20013', 7, false), visit('480', '30001', 14), visit('18', '20012', 22),
  ] }] } } };
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);

// Cache par station : protège l'API si plusieurs écrans / appuis sur ⟳ arrivent en même temps.
const CACHE_MS = 15000;
const cache = new Map(); // stop -> { at, promise }

function getArrivals(stop) {
  if (!/^\d{1,6}$/.test(stop)) return Promise.resolve([400, { error: 'Numéro de station invalide' }]);
  const info = stopInfo(stop);
  if (!info && stopsLoaded()) return Promise.resolve([404, { error: 'Station inconnue' }]);
  const hit = cache.get(stop);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const names = { stopName: info?.name ?? null, stopCity: info?.city ?? null };
  const promise = fetchArrivals(stop)
    .then(([status, body]) => [status, { ...names, ...body }])
    .catch((e) => {
      cache.delete(stop);
      if (!e.logged) logError('arrivals', 'Unexpected error', { stop, cause: e.stack || e.message });
      return [502, { ...names, error: e.message || 'Erreur réseau' }];
    });
  cache.set(stop, { at: Date.now(), promise });
  return promise;
}

async function fetchArrivals(stop) {

  let data;
  if (MOCK) {
    data = mockData(stop);
  } else {
    const { MOT_KEY: key, MOT_BASE_URL: base } = process.env;
    if (!key || !base) {
      logError('config', 'MOT_KEY / MOT_BASE_URL missing in .env');
      return [500, { error: 'MOT_KEY / MOT_BASE_URL non configurés' }];
    }
    const url = `${base.replace(/\/$/, '')}/json?Key=${encodeURIComponent(key)}&MonitoringRef=${stop}&PreviewInterval=PT${WINDOW_MIN}M`;
    const t0 = Date.now();
    try {
      data = await getJson(url);
    } catch (e) {
      logError('MOT', e.message, { stop, ms: Date.now() - t0, http: e.httpStatus, code: e.code, cause: e.cause, body: e.body, url });
      e.logged = true;
      throw e;
    }
  }

  const deliveries = asArray(data?.Siri?.ServiceDelivery?.StopMonitoringDelivery);
  const err = deliveries.map((d) => text(d?.ErrorCondition?.OtherError?.ErrorText)).find(Boolean);
  if (err) {
    logError('MOT', 'API returned an ErrorCondition', { stop, errorText: err });
    return [502, { error: err }];
  }
  if (!data?.Siri?.ServiceDelivery) {
    logError('MOT', 'Unexpected response shape (no Siri.ServiceDelivery)', { stop, body: snippet(JSON.stringify(data)) });
  }

  const now = Date.now();
  const buses = deliveries
    .flatMap((d) => asArray(d.MonitoredStopVisit))
    .map((v) => {
      const j = v.MonitoredVehicleJourney || {};
      const call = j.MonitoredCall || {};
      const t = call.ExpectedArrivalTime || call.AimedArrivalTime;
      const ms = t ? Date.parse(t) : NaN;
      return {
        line: String(text(j.PublishedLineName) ?? j.LineRef ?? ''),
        destination: j.DestinationRef ?? null,
        destinationName: stopInfo(j.DestinationRef)?.name ?? null,
        expected: t || null,
        minutes: Number.isNaN(ms) ? null : Math.max(0, Math.round((ms - now) / 60000)),
        realtime: !call.AimedArrivalTime, // AimedArrivalTime n'existe que si le bus n'est pas encore parti
      };
    })
    .filter((b) => b.minutes !== null && b.minutes <= WINDOW_MIN)
    .sort((a, b) => a.minutes - b.minutes);

  return [200, { stop, updated: new Date().toISOString(), buses }];
}

// ---------- Mot de passe ----------
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) { console.error('APP_PASSWORD manquant dans .env'); process.exit(1); }
// Jeton de session dérivé du mot de passe : survit aux redémarrages, invalidé si le mot de passe change.
const SESSION = crypto.createHmac('sha256', PASSWORD).update('bus-arrivals-session').digest('hex');
const COOKIE_MAX_AGE = 365 * 24 * 3600; // la tablette reste connectée 1 an
const MAX_FAILS = 5, LOCK_MS = 5 * 60000;
const fails = new Map(); // ip -> { n, until }

const isAuthed = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`session=${SESSION}`);
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(b)));
    req.on('error', reject);
  });
}

async function handleLogin(req, res, url) {
  if (req.method !== 'POST') {
    const page = await readFile(join(ROOT, 'views', 'login.html'), 'utf8');
    return send(res, 200, page, TYPES['.html']);
  }
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip);
  const next = safeNext(url.searchParams.get('next'));
  if (f && f.until > Date.now()) return redirect(res, `/login?error=locked&next=${encodeURIComponent(next)}`);
  const body = await readBody(req);
  if (safeEqual(body.get('password') || '', PASSWORD)) {
    fails.delete(ip);
    res.setHeader('Set-Cookie', `session=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
    return redirect(res, next);
  }
  const n = (f && f.until <= Date.now() && f.until ? 0 : f?.n || 0) + 1;
  fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
  console.warn(`Mot de passe incorrect depuis ${ip} (${n})`);
  redirect(res, `/login?error=${n >= MAX_FAILS ? 'locked' : 'bad'}&next=${encodeURIComponent(next)}`);
}

function redirect(res, location) { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }

// ---------- Serveur HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/login') return await handleLogin(req, res, url);
    if (url.pathname === '/logout') {
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return redirect(res, '/login');
    }
    if (!isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Non connecté' });
      return redirect(res, '/login?next=' + encodeURIComponent(url.pathname + url.search));
    }

    if (url.pathname === '/api/arrivals') {
      const [status, body] = await getArrivals((url.searchParams.get('stop') || '').trim());
      return send(res, status, body);
    }
    const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = await readFile(join(PUBLIC_DIR, path));
    send(res, 200, file, TYPES[extname(path)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, 'Not found', 'text/plain');
    logError('http', e.message, { method: req.method, path: url.pathname, cause: e.stack });
    send(res, 502, { error: e.message || 'Erreur' });
  }
}).listen(PORT, () => console.log(`Bus arrivals sur http://localhost:${PORT}${MOCK ? '  (mode MOCK, fausses données)' : ''}`));
