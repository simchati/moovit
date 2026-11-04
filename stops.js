// Noms des stations : l'API SIRI ne renvoie que des numéros (stop_code).
// Les noms viennent du GTFS du ministère (stops.txt), téléchargé une fois par jour.
// Nécessite la commande `unzip` (apt install unzip).
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const GTFS_URL = process.env.GTFS_URL || 'https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip';
const MAX_AGE_MS = 24 * 3600 * 1000;
const run = promisify(execFile);

let stops = new Map(); // stop_code -> { name, city }
let dataDir;

// Découpe une ligne CSV (gère les champs entre guillemets).
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseStops(csv) {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const head = splitCsv(lines[0]);
  const iCode = head.indexOf('stop_code'), iName = head.indexOf('stop_name'), iDesc = head.indexOf('stop_desc');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = splitCsv(lines[i]);
    const code = f[iCode];
    if (!code) continue;
    const city = (f[iDesc] || '').match(/עיר:\s*(.*?)\s*(?:רציף:|$)/)?.[1] || '';
    map[code] = { name: f[iName].replace(/''/g, '"'), city };
  }
  return map;
}

async function download() {
  const zip = join(dataDir, 'gtfs.zip');
  console.log('GTFS : téléchargement des noms de stations…');
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  try {
    const { stdout } = await run('unzip', ['-p', zip, 'stops.txt'], { maxBuffer: 64 * 1024 * 1024 });
    const map = parseStops(stdout);
    if (Object.keys(map).length < 1000) throw new Error('stops.txt semble incomplet');
    await writeFile(join(dataDir, 'stops.json'), JSON.stringify(map));
    return map;
  } finally {
    await rm(zip, { force: true }); // le zip fait ~150 Mo, on ne garde que stops.json
  }
}

async function refresh() {
  const file = join(dataDir, 'stops.json');
  try {
    const age = Date.now() - (await stat(file)).mtimeMs;
    if (!stops.size) stops = new Map(Object.entries(JSON.parse(await readFile(file, 'utf8'))));
    if (age < MAX_AGE_MS) return;
  } catch { /* pas encore de cache */ }
  try {
    stops = new Map(Object.entries(await download()));
    console.log(`GTFS : ${stops.size} stations chargées`);
  } catch (e) {
    console.error('GTFS : échec du téléchargement —', e.message, stops.size ? '(ancienne liste conservée)' : '');
  }
}

export async function initStops(dir) {
  dataDir = dir;
  await mkdir(dataDir, { recursive: true });
  refresh(); // en arrière-plan : le serveur démarre sans attendre
  setInterval(refresh, 3600 * 1000).unref(); // vérifie toutes les heures, retélécharge si > 24 h
}

export const stopsLoaded = () => stops.size > 0;
export const stopInfo = (code) => (code == null ? null : stops.get(String(code)) || null);
