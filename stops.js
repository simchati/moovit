// Noms des stations : l'API SIRI ne renvoie que des numéros (stop_code).
// Les noms viennent du GTFS du ministère (stops.txt), téléchargé une fois par jour.
// Aucune dépendance système : le zip est lu directement en Node.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rm, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';

const GTFS_URL = process.env.GTFS_URL || 'https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip';
const MAX_AGE_MS = 24 * 3600 * 1000;

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

// Extrait un seul fichier d'une archive zip sans la charger en entier en mémoire
// (le GTFS fait ~150 Mo, stops.txt ~5 Mo). Gère les archives Zip64.
async function extractFromZip(zipPath, wanted) {
  const fh = await open(zipPath, 'r');
  try {
    const read = async (pos, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    const size = (await fh.stat()).size;

    // 1. Fin du répertoire central (EOCD), dans les derniers 64 Ko
    const tailLen = Math.min(size, 65557);
    const tail = await read(size - tailLen, tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('zip invalide (EOCD introuvable)');
    let cdCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // Zip64 : le localisateur se trouve juste avant l'EOCD
    if (cdOffset === 0xffffffff || cdCount === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 invalide');
      const z64 = await read(Number(tail.readBigUInt64LE(loc + 8)), 56);
      cdCount = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }

    // 2. Répertoire central : chercher l'entrée voulue
    const cd = await read(cdOffset, cdSize);
    for (let p = 0, i = 0; i < cdCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip invalide (répertoire central)');
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

      if (name === wanted) {
        // Tailles / offset en Zip64 : dans le champ extra 0x0001, dans cet ordre
        let e = p + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
          const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); }
          }
          e += 4 + len;
        }
        // 3. En-tête local (sa longueur de nom/extra peut différer du répertoire central)
        const lh = await read(localOffset, 30);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip invalide (en-tête local)');
        const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const data = await read(dataStart, compSize);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data);
        throw new Error(`méthode de compression ${method} non gérée`);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(`${wanted} absent de l'archive`);
  } finally {
    await fh.close();
  }
}

async function download() {
  const zip = join(dataDir, 'gtfs.zip');
  console.log('GTFS : téléchargement des noms de stations…');
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  try {
    const map = parseStops((await extractFromZip(zip, 'stops.txt')).toString('utf8'));
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
