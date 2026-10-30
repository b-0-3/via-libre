// Descarga los datos en tiempo real de Renfe Cercanías (GTFS-RT) y prepara
// los ficheros que lee la web. Lo ejecuta GitHub Actions cada 5 minutos.
// Sin dependencias: Node 20 trae fetch.
import fs from 'node:fs';
import path from 'node:path';

const FEED = 'https://gtfsrt.renfe.com/';
const SITE = (process.env.SITE_URL || '').replace(/\/?$/, '/');
const OUT = '_site';
const DATA = path.join(OUT, 'data');
const PREV = 'prev';

// Núcleos de Cercanías: centro aproximado para asignar cada tren por posición
const NUCLEOS = {
  madrid:       { nombre: 'Madrid',           c: [40.42, -3.70] },
  catalunya:    { nombre: 'Rodalies',         c: [41.45,  2.05] },
  valencia:     { nombre: 'Valencia',         c: [39.45, -0.45] },
  sevilla:      { nombre: 'Sevilla',          c: [37.40, -5.95] },
  malaga:       { nombre: 'Málaga',           c: [36.68, -4.55] },
  cadiz:        { nombre: 'Cádiz',            c: [36.55, -6.15] },
  bilbao:       { nombre: 'Bilbao',           c: [43.27, -2.95] },
  sansebastian: { nombre: 'San Sebastián',    c: [43.30, -2.00] },
  santander:    { nombre: 'Santander',        c: [43.40, -3.95] },
  asturias:     { nombre: 'Asturias',         c: [43.40, -5.80] },
  murcia:       { nombre: 'Murcia/Alicante',  c: [38.10, -1.00] },
  zaragoza:     { nombre: 'Zaragoza',         c: [41.65, -0.90] },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'user-agent': 'via-libre (github.com)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries) { console.warn('Fallo al leer', url, String(e)); return null; }
      await sleep(2000 * i);
    }
  }
}
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function nearestNucleo(lat, lon, linea) {
  if (/^R/.test(linea || '')) return 'catalunya';
  let best = null, bd = Infinity;
  for (const [k, n] of Object.entries(NUCLEOS)) {
    const d = Math.hypot(lat - n.c[0], (lon - n.c[1]) * Math.cos(lat * Math.PI / 180));
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
// tripId tipo "3002V23112C3": 2 cifras de núcleo, 2 de servicio, V, nº de tren, línea
function parseTrip(tripId = '') {
  const m = /^(\d{2})\d{2}V(\d+)([A-Z].*)$/.exec(tripId);
  return m ? { codigo: m[1], num: m[2], linea: m[3] } : { codigo: null, num: null, linea: null };
}
const dist = (a, b) => {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// CSV sencillo con comillas (para stops.txt)
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of ['index.html', 'app.js', 'app.css', 'favicon.svg']) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(OUT, f));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  // Datos de la ejecución anterior (desde la web ya publicada)
  const prevEstado = SITE ? await getJSON(SITE + 'data/estado.json', 1) : null;
  const prevPatrones = SITE ? await getJSON(SITE + 'data/patrones.json', 1) : null;
  const prevHist = SITE ? await getJSON(SITE + 'data/historial.json', 1) : null;

  // Paradas: de la web publicada o, si no hay, del GTFS estático descargado por el workflow
  let paradas = readJSON(path.join(PREV, 'paradas.json'), null);
  if (!paradas && fs.existsSync(path.join(PREV, 'stops.txt'))) {
    const rows = parseCSV(fs.readFileSync(path.join(PREV, 'stops.txt'), 'utf8').replace(/^﻿/, ''));
    const head = rows.shift().map(h => h.trim());
    const iId = head.indexOf('stop_id'), iN = head.indexOf('stop_name'), iLa = head.indexOf('stop_lat'), iLo = head.indexOf('stop_lon');
    paradas = {};
    for (const r of rows) if (r[iId]) paradas[r[iId].trim()] = [r[iN].trim(), +(+r[iLa]).toFixed(5), +(+r[iLo]).toFixed(5)];
    console.log('Paradas leídas del GTFS:', Object.keys(paradas).length);
  }
  paradas = paradas || {};
  fs.writeFileSync(path.join(DATA, 'paradas.json'), JSON.stringify(paradas));

  const [vp, tu, al] = await Promise.all(['vehicle_positions.json', 'trip_updates.json', 'alerts.json'].map(f => getJSON(FEED + f)));
  if (!vp) {
    // Si Renfe no responde, se vuelve a publicar lo anterior para no dejar la web vacía
    console.warn('Sin posiciones: se mantiene el estado anterior');
    if (prevEstado) fs.writeFileSync(path.join(DATA, 'estado.json'), JSON.stringify({ ...prevEstado, error: 'Renfe no respondió en la última actualización' }));
    if (prevPatrones) fs.writeFileSync(path.join(DATA, 'patrones.json'), JSON.stringify(prevPatrones));
    if (prevHist) fs.writeFileSync(path.join(DATA, 'historial.json'), JSON.stringify(prevHist));
    return;
  }

  // Retrasos y cancelaciones por tripId
  const retraso = {}, cancelados = [];
  for (const e of tu?.entity || []) {
    const u = e.tripUpdate; if (!u?.trip?.tripId) continue;
    if (u.trip.scheduleRelationship === 'CANCELED') { cancelados.push(u.trip.tripId); continue; }
    const d = u.delay ?? u.stopTimeUpdate?.[0]?.arrival?.delay ?? u.stopTimeUpdate?.[0]?.departure?.delay;
    if (typeof d === 'number') retraso[u.trip.tripId] = d;
  }

  // Posiciones anteriores, para saber quién lleva 5+ minutos sin moverse
  const prevPos = {};
  for (const t of prevEstado?.trenes || []) prevPos[t.id] = t;
  const prevT = prevEstado?.t || 0;

  const codigoVotos = {};
  const trenes = [];
  for (const e of vp.entity || []) {
    const v = e.vehicle; if (!v?.position) continue;
    const label = v.vehicle?.label || '';
    const trip = parseTrip(v.trip?.tripId);
    const linea = label.split('-')[0] || trip.linea || '?';
    const lat = +v.position.latitude.toFixed(5), lon = +v.position.longitude.toFixed(5);
    const nucleo = nearestNucleo(lat, lon, linea);
    if (trip.codigo) { const k = trip.codigo; (codigoVotos[k] ||= {})[nucleo] = (codigoVotos[k][nucleo] || 0) + 1; }
    const id = v.vehicle?.id || trip.num || e.id;
    const r = retraso[v.trip?.tripId];
    const anda = (label.match(/PLATF\.\((\w+)\)/) || [])[1] || null;
    const t = { id, num: trip.num || id, linea, nucleo, lat, lon, estado: v.currentStatus || null, parada: v.stopId || null, via: anda, retraso: typeof r === 'number' ? r : null, ts: +v.timestamp * 1000 || null };
    const p = prevPos[id];
    if (p && p.ts !== t.ts) { // solo si Renfe ha mandado una posición nueva
      const m = dist([p.lat, p.lon], [lat, lon]);
      // Parado fuera de estación: no se ha movido y no figura detenido en una parada
      if (m < 80 && t.estado !== 'STOPPED_AT' && p.estado !== 'STOPPED_AT') t.paradoDesde = p.paradoDesde || prevT;
      else if (m < 80 && t.estado === 'STOPPED_AT' && p.estado === 'STOPPED_AT' && p.parada === t.parada) t.enAndenDesde = p.enAndenDesde || prevT;
    }
    trenes.push(t);
  }

  // Código de núcleo (prefijo de tripId / routeId) → núcleo, por mayoría
  const codigos = { ...(prevEstado?.codigos || {}) };
  for (const [k, votos] of Object.entries(codigoVotos)) codigos[k] = Object.entries(votos).sort((a, b) => b[1] - a[1])[0][0];

  const avisos = [];
  for (const e of al?.entity || []) {
    const a = e.alert; if (!a) continue;
    const texto = a.descriptionText?.translation?.find(x => x.language === 'es')?.text || a.descriptionText?.translation?.[0]?.text || a.headerText?.translation?.[0]?.text;
    if (!texto) continue;
    const lineas = new Set(), nucs = new Set();
    for (const ie of a.informedEntity || []) {
      const rid = ie.routeId || '';
      const m = /^(\d{2})T\d+(.+)$/.exec(rid);
      if (m) { lineas.add(m[2]); if (codigos[m[1]]) nucs.add(codigos[m[1]]); }
    }
    if (!nucs.size && /^#Mad/i.test(texto)) nucs.add('madrid');
    const ini = +a.activePeriod?.[0]?.start * 1000 || null, fin = +a.activePeriod?.[0]?.end * 1000 || null;
    avisos.push({ id: e.id, texto, lineas: [...lineas], nucleos: [...nucs], desde: ini, hasta: fin });
  }

  const canc = cancelados.map(id => { const p = parseTrip(id); return { tripId: id, num: p.num, linea: p.linea, nucleo: codigos[p.codigo] || null }; });

  const ahora = +vp.header?.timestamp * 1000 || Date.now();
  const estado = { t: ahora, generado: Date.now(), nucleos: NUCLEOS, codigos, trenes, cancelados: canc, avisos };
  fs.writeFileSync(path.join(DATA, 'estado.json'), JSON.stringify(estado));

  // ── Patrones: dónde y cuándo hay más retrasos (media con olvido, vida media ~3 días)
  const DECAY = Math.pow(0.5, 5 / (3 * 24 * 60)); // por ejecución de 5 min
  const pat = prevPatrones && prevPatrones.v === 1 ? prevPatrones : { v: 1, desde: Date.now(), lineas: {}, horas: {} };
  for (const o of Object.values(pat.lineas)) { o[0] *= DECAY; o[1] *= DECAY; o[2] *= DECAY; }
  for (const arr of Object.values(pat.horas)) for (const o of arr) { o[0] *= DECAY; o[1] *= DECAY; }
  const hora = +new Intl.DateTimeFormat('es-ES', { hour: 'numeric', hour12: false, timeZone: 'Europe/Madrid' }).format(new Date(ahora)) % 24;
  for (const t of trenes) {
    if (t.retraso == null || t.retraso > 7200 || t.retraso < -600) continue;
    const late = t.retraso >= 180 ? 1 : 0;
    const k = t.nucleo + ':' + t.linea;
    const o = (pat.lineas[k] ||= [0, 0, 0]); o[0] += 1; o[1] += late; o[2] += Math.max(0, t.retraso);
    const hs = (pat.horas[t.nucleo] ||= Array.from({ length: 24 }, () => [0, 0]));
    hs[hora][0] += 1; hs[hora][1] += late;
  }
  for (const [k, o] of Object.entries(pat.lineas)) { if (o[0] < 0.5) delete pat.lineas[k]; else pat.lineas[k] = o.map(x => +x.toFixed(2)); }
  for (const arr of Object.values(pat.horas)) arr.forEach((o, i) => arr[i] = o.map(x => +x.toFixed(2)));
  pat.actualizado = Date.now();
  fs.writeFileSync(path.join(DATA, 'patrones.json'), JSON.stringify(pat));

  // ── Historial de las últimas 24 h por núcleo (puntualidad cada 5 min)
  const hist = prevHist && Array.isArray(prevHist.p) ? prevHist : { p: [] };
  const punto = { t: ahora, n: {} };
  for (const t of trenes) {
    const o = (punto.n[t.nucleo] ||= [0, 0, 0]); // trenes, con dato, puntuales
    o[0]++;
    if (t.retraso != null && t.retraso <= 7200) { o[1]++; if (t.retraso < 180) o[2]++; }
  }
  hist.p.push(punto);
  hist.p = hist.p.filter(x => ahora - x.t < 24 * 3600 * 1000);
  fs.writeFileSync(path.join(DATA, 'historial.json'), JSON.stringify(hist));

  console.log(`OK: ${trenes.length} trenes, ${canc.length} cancelados, ${avisos.length} avisos, ${Object.keys(paradas).length} paradas`);
}

main().catch(e => { console.error(e); process.exit(1); });
