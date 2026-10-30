// Vía Libre — lee los datos que deja el robot en data/ y monta el puesto de mando.
(() => {
'use strict';

const $ = s => document.querySelector(s);
const REFRESH_MS = 60_000;
const DUDOSO = 7200;          // retrasos de más de 2 h suelen ser datos raros
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
};

// Colores oficiales aproximados de Cercanías Madrid; el resto, paleta estable por nombre
const MADRID = {C1:'#4aa9de',C2:'#1e9e4a',C3:'#8e3d97',C4:'#1f3e8c',C4a:'#1f3e8c',C4b:'#1f3e8c',C5:'#e0a800',C5a:'#e0a800',C7:'#e12b2b',C8:'#7d7f7f',C8a:'#7d7f7f',C8b:'#7d7f7f',C9:'#f08b1f',C10:'#8fb81b'};
const PALETTE = ['#1f6fb2','#2a9d55','#8e44ad','#d35400','#c0392b','#16a085','#b8860b','#2c3e50','#e84393','#6c5ce7','#00897b','#795548'];
function lineColor(nuc, linea){
  if (nuc === 'madrid' && MADRID[linea]) return MADRID[linea];
  let h = 0; for (const c of nuc + linea) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ── utilidades
function h(tag, attrs, ...kids){
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)){
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()){ if (k == null || k === false) continue; e.append(k instanceof Node ? k : document.createTextNode(String(k))); }
  return e;
}
const fmtClock = d => d.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
const fmtHM = d => new Date(d).toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});
function rel(ms){ const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'ahora mismo'; if (m < 60) return `hace ${m} min`; const hh = Math.floor(m / 60); if (hh < 24) return `hace ${hh} h`; return new Date(ms).toLocaleDateString('es-ES', {day:'numeric', month:'short'}); }
const mins = s => Math.round(s / 60);
let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

// ── estado
let estado = null, paradas = {}, patrones = null, historial = null;
let nucleo = location.hash.slice(1) || LS.get('vl-nucleo', 'madrid');
let lineFilter = null, selected = null;
const stopName = id => (paradas[id] && paradas[id][0]) || (id ? `parada ${id}` : '—');
const trenesNuc = () => (estado?.trenes || []).filter(t => t.nucleo === nucleo);
const valido = t => t.retraso != null && t.retraso <= DUDOSO;
function sev(t){
  const parado = t.paradoDesde && (estado.t - t.paradoDesde) >= 5 * 60000;
  if (parado) return 'crit';
  if (!valido(t)) return 'ok';
  if (t.retraso >= 600) return 'crit';
  if (t.retraso >= 180) return 'warn';
  return 'ok';
}
const SEVCOL = () => { const cs = getComputedStyle(document.documentElement); return {ok:cs.getPropertyValue('--ok').trim(), warn:cs.getPropertyValue('--warn').trim(), crit:cs.getPropertyValue('--crit').trim()}; };
function estadoTexto(t){
  const p = stopName(t.parada);
  if (t.paradoDesde) return `Parado fuera de estación desde las ${fmtHM(t.paradoDesde)} (camino de ${p})`;
  if (t.estado === 'STOPPED_AT') return `En ${p}${t.via ? ' · vía ' + t.via : ''}`;
  if (t.estado === 'INCOMING_AT') return `Llegando a ${p}`;
  return `Hacia ${p}`;
}

// ── datos
async function getJSON(path){
  const r = await fetch(path + '?_=' + Date.now(), {cache:'no-store'});
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function cargar(){
  try{
    estado = await getJSON('data/estado.json');
  }catch{
    $('#fresh').className = 'pill crit'; $('#fresh').textContent = 'Aún no hay datos';
    renderVacio(); return;
  }
  if (!Object.keys(paradas).length) { try{ paradas = await getJSON('data/paradas.json'); }catch{} }
  try{ patrones = await getJSON('data/patrones.json'); }catch{}
  try{ historial = await getJSON('data/historial.json'); }catch{}
  if (!estado.nucleos[nucleo]) nucleo = 'madrid';
  renderTodo(true);
}
function renderVacio(){
  $('#alertList').replaceChildren(h('div', {class:'empty'}, h('strong', null, 'Esperando al robot'), 'La primera descarga de datos de Renfe tarda unos minutos en aparecer.'));
}

// ── mapa
const map = L.map('map', {zoomControl:true, attributionControl:true, preferCanvas:true}).setView([40.42, -3.70], 10);
const dark = matchMedia('(prefers-color-scheme: dark)');
let tiles;
function setTiles(){
  if (tiles) map.removeLayer(tiles);
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19,
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Datos: Renfe'
  }).addTo(map);
  if (estado) renderMapa();
}
dark.addEventListener?.('change', setTiles);
setTiles();
const capa = L.layerGroup().addTo(map);
const markers = {};
let ultimoNucleoEncuadrado = null;
function renderMapa(){
  const col = SEVCOL();
  const vivos = new Set();
  for (const t of trenesNuc()){
    vivos.add(t.id);
    const s = sev(t), dim = lineFilter && t.linea !== lineFilter;
    const style = {radius: s === 'ok' ? 6 : 7.5, color: col[s], weight: s === 'ok' ? 2 : 3, fillColor: lineColor(nucleo, t.linea), fillOpacity: dim ? .15 : .95, opacity: dim ? .2 : 1};
    let m = markers[t.id];
    if (!m){
      m = markers[t.id] = L.circleMarker([t.lat, t.lon], style).addTo(capa);
      m.on('click', () => { selected = markers[t.id]._tid; renderFoot(); });
    } else { m.setLatLng([t.lat, t.lon]); m.setStyle(style); }
    m._tid = t.id;
    const r = valido(t) ? (mins(t.retraso) > 0 ? ` · +${mins(t.retraso)} min` : ' · puntual') : '';
    m.bindTooltip(`${t.linea} · ${t.num}${r}`, {className:'tt', direction:'top', offset:[0,-6]});
    if (selected === t.id) m.bringToFront();
  }
  for (const id of Object.keys(markers)) if (!vivos.has(id)) { capa.removeLayer(markers[id]); delete markers[id]; }
  if (ultimoNucleoEncuadrado !== nucleo){
    ultimoNucleoEncuadrado = nucleo;
    const pts = trenesNuc().map(t => [t.lat, t.lon]);
    if (pts.length > 1) map.fitBounds(pts, {padding:[30,30], maxZoom:11});
    else map.setView(estado.nucleos[nucleo].c, 10);
  }
}

// ── cabecera, núcleos, KPIs, líneas
function renderFresh(){
  const p = $('#fresh');
  if (!estado) return;
  const age = Math.round((Date.now() - estado.generado) / 60000);
  const cls = estado.error ? 'crit' : age <= 15 ? 'ok' : age <= 40 ? 'warn' : 'crit';
  p.className = 'pill ' + cls;
  p.textContent = estado.error ? 'Renfe no responde' : `Datos reales · ${age < 1 ? 'ahora mismo' : 'hace ' + age + ' min'}`;
  p.title = `Posiciones de Renfe de las ${fmtHM(estado.t)}. El robot actualiza cada 5 minutos.`;
}
function renderNucleos(){
  const nav = $('#nucleos'); nav.replaceChildren();
  const cuenta = {};
  for (const t of estado.trenes) cuenta[t.nucleo] = (cuenta[t.nucleo] || 0) + 1;
  Object.entries(estado.nucleos).filter(([k]) => cuenta[k] || k === nucleo).sort((a, b) => (cuenta[b[0]] || 0) - (cuenta[a[0]] || 0)).forEach(([k, n]) => {
    nav.append(h('button', {class:'nuc', type:'button', 'aria-pressed':String(k === nucleo), onclick:() => cambiarNucleo(k)}, n.nombre, h('span', {class:'n'}, cuenta[k] || 0)));
  });
}
function cambiarNucleo(k){
  nucleo = k; lineFilter = null; selected = null; LS.set('vl-nucleo', k);
  history.replaceState(null, '', '#' + k);
  renderTodo(true);
}
function renderKpis(){
  const ts = trenesNuc(), con = ts.filter(valido);
  $('#kTrains').textContent = ts.length;
  const parados = ts.filter(t => t.paradoDesde && estado.t - t.paradoDesde >= 5 * 60000).length;
  $('#kTrainsSub').textContent = parados ? `${parados} parado${parados > 1 ? 's' : ''} fuera de estación` : `${new Set(ts.map(t => t.linea)).size} líneas con trenes`;
  const kp = $('#kPunct');
  if (con.length){
    const pct = Math.round(100 * con.filter(t => t.retraso < 180).length / con.length);
    kp.replaceChildren(String(pct), h('small', null, '%'));
    kp.className = 'val ' + (pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'crit');
    const avg = con.reduce((a, t) => a + Math.max(0, t.retraso), 0) / con.length / 60;
    $('#kDelay').replaceChildren(avg.toFixed(1).replace('.', ','), h('small', null, 'min'));
    const peor = con.reduce((a, t) => t.retraso > a.retraso ? t : a, con[0]);
    $('#kDelaySub').textContent = peor.retraso >= 180 ? `máximo ${mins(peor.retraso)} min · ${peor.linea} ${peor.num}` : 'sin retrasos importantes';
  } else {
    kp.textContent = '–'; kp.className = 'val'; $('#kDelay').textContent = '–'; $('#kDelaySub').textContent = 'sin dato de retraso';
  }
  const canc = (estado.cancelados || []).filter(c => c.nucleo === nucleo);
  $('#kCanc').textContent = canc.length;
  $('#kCanc').className = 'val' + (canc.length >= 5 ? ' crit' : canc.length ? ' warn' : '');
  $('#kCancSub').textContent = canc.length ? [...new Set(canc.map(c => c.linea))].join(', ') : 'ninguno ahora mismo';
  $('#mapTitle').textContent = 'Mapa · ' + estado.nucleos[nucleo].nombre;
}
function renderLines(){
  const strip = $('#lineStrip'); strip.replaceChildren(h('span', {class:'lbl'}, 'Líneas'));
  const porLinea = {};
  for (const t of trenesNuc()) (porLinea[t.linea] ||= []).push(t);
  Object.keys(porLinea).sort((a, b) => a.localeCompare(b, 'es', {numeric:true})).forEach(l => {
    const ts = porLinea[l];
    const w = ts.some(t => sev(t) === 'crit') ? 'crit' : ts.some(t => sev(t) === 'warn') ? 'warn' : 'ok';
    strip.append(h('button', {class:'chip', type:'button', 'aria-pressed':String(lineFilter === l), title:w === 'ok' ? 'Servicio normal' : w === 'warn' ? 'Con retrasos' : 'Retrasos graves o trenes parados',
      onclick:() => { lineFilter = lineFilter === l ? null : l; renderLines(); renderMapa(); }},
      h('span', {class:'code', style:`background:${lineColor(nucleo, l)}`}, l), h('span', {class:'n'}, ts.length), h('i', {class:'dot ' + w})));
  });
}

// ── alertas automáticas
const incs = LS.get('vl-incidencias', []);
const incAbiertaDe = t => incs.find(i => i.trenId === t.id && i.nucleo === nucleo && i.estado !== 'resuelta');
function computeAlerts(){
  const out = [];
  const ts = trenesNuc();
  for (const t of ts){
    const p = stopName(t.parada);
    if (t.paradoDesde){
      const m = Math.round((estado.t - t.paradoDesde) / 60000);
      if (m >= 5) out.push({key:'parado-' + t.id, sev:m >= 10 ? 'crit' : 'warn', t, rank:3e6 + m, title:`Tren ${t.num} parado fuera de estación`, sub:`${t.linea} · lleva ${m} min sin moverse · camino de ${p}`});
    } else if (valido(t) && t.retraso >= 300){
      out.push({key:'ret-' + t.id, sev:t.retraso >= 600 ? 'crit' : 'warn', t, rank:1e6 + t.retraso, title:`Tren ${t.num} con ${mins(t.retraso)} min de retraso`, sub:`${t.linea} · ${estadoTexto(t)}`});
    }
  }
  const porLinea = {};
  for (const t of ts) if (valido(t) && t.retraso >= 300) (porLinea[t.linea] ||= []).push(t);
  for (const [l, arr] of Object.entries(porLinea)) if (arr.length >= 3)
    out.push({key:'linea-' + l, sev:'crit', rank:4e6 + arr.length, linea:l, title:`Retrasos generalizados en la ${l}`, sub:`${arr.length} trenes con más de 5 min de retraso a la vez`});
  const canc = (estado.cancelados || []).filter(c => c.nucleo === nucleo);
  const cl = {}; for (const c of canc) (cl[c.linea] ||= []).push(c.num);
  for (const [l, nums] of Object.entries(cl)) out.push({key:'canc-' + l, sev:nums.length >= 3 ? 'crit' : 'warn', rank:2e6 + nums.length, linea:l, title:`${nums.length} tren${nums.length > 1 ? 'es' : ''} cancelado${nums.length > 1 ? 's' : ''} en la ${l}`, sub:`Nº ${nums.slice(0, 6).join(', ')}${nums.length > 6 ? '…' : ''}`});
  return out.sort((a, b) => (b.sev === 'crit') - (a.sev === 'crit') || b.rank - a.rank);
}
function renderAlerts(){
  const list = $('#alertList'), al = computeAlerts();
  const c = $('#cAlerts'); c.textContent = al.length; c.classList.toggle('hot', al.some(a => a.sev === 'crit'));
  list.replaceChildren();
  if (!al.length){ list.append(h('div', {class:'empty'}, h('strong', null, 'Sin alertas'), 'Ningún tren parado ni con más de 5 minutos de retraso en este núcleo.')); return; }
  for (const a of al){
    const inc = a.t && incAbiertaDe(a.t);
    list.append(h('div', {class:'row'},
      h('div', {class:'sev ' + a.sev}, '!'),
      h('div', {class:'t'}, a.title),
      h('div', {class:'m'}, a.sub),
      h('div', {class:'a'},
        h('span', {class:'pill ' + a.sev}, a.sev === 'crit' ? 'Grave' : 'Aviso'),
        inc ? h('button', {class:'linkish', type:'button', onclick:() => openDetail(inc.id)}, 'Ver incidencia abierta →')
            : h('button', {class:'btn small', type:'button', onclick:() => openNew(a)}, 'Abrir incidencia'),
        a.t ? h('button', {class:'linkish', type:'button', onclick:() => verTren(a.t.id)}, 'Ver en el mapa') : null)));
  }
}
function verTren(id){
  const t = trenesNuc().find(x => x.id === id); if (!t) return;
  selected = id; renderFoot(); renderMapa();
  map.setView([t.lat, t.lon], Math.max(map.getZoom(), 13));
  markers[id]?.openTooltip();
  $('#map').scrollIntoView({behavior:'smooth', block:'nearest'});
}

// ── avisos oficiales
function renderAvisos(){
  const list = $('#avisoList');
  const av = (estado.avisos || []).filter(a => a.nucleos.includes(nucleo)).sort((a, b) => (b.desde || 0) - (a.desde || 0));
  $('#cAvisos').textContent = av.length;
  list.replaceChildren();
  if (!av.length){ list.append(h('div', {class:'empty'}, h('strong', null, 'Sin avisos de Renfe'), 'Renfe no ha publicado avisos para este núcleo.')); return; }
  for (const a of av){
    const texto = a.texto.replace(/^#\S+\s*/, '');
    list.append(h('div', {class:'row'},
      h('div', {class:'sev info'}, 'i'),
      h('div', {class:'a', style:'margin:0'}, ...a.lineas.slice(0, 8).map(l => h('span', {class:'code', style:`background:${lineColor(nucleo, l)}`}, l)), a.lineas.length > 8 ? h('span', {class:'m'}, `+${a.lineas.length - 8}`) : null),
      h('div', {class:'txt'}, texto),
      h('div', {class:'m'}, a.desde ? `Desde ${new Date(a.desde).toLocaleString('es-ES', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}` : '')));
  }
}

// ── patrones
function renderPatrones(){
  const box = $('#patBox'); box.replaceChildren();
  if (!patrones){ box.append(h('div', {class:'empty'}, h('strong', null, 'Aún sin patrones'), 'El robot necesita unas horas de datos.')); return; }
  const col = SEVCOL();
  const filas = Object.entries(patrones.lineas).filter(([k, o]) => k.startsWith(nucleo + ':') && o[0] >= 6)
    .map(([k, o]) => ({linea:k.split(':')[1], pct:o[1] / o[0], media:o[2] / o[0] / 60})).sort((a, b) => b.pct - a.pct).slice(0, 12);
  const dias = Math.max(1, Math.round((Date.now() - patrones.desde) / 86400000));
  box.append(h('div', null,
    h('h3', null, 'Líneas que más se retrasan'),
    h('p', {class:'m'}, `Porcentaje de veces que un tren iba con 3+ min de retraso. Pesa más lo reciente (últimos ~3 días); llevamos ${dias === 1 ? 'menos de 2 días' : dias + ' días'} midiendo.`),
    filas.length ? h('div', {class:'bars'}, ...filas.map(f => h('div', {class:'bar'},
      h('span', {class:'code', style:`background:${lineColor(nucleo, f.linea)};text-align:center`}, f.linea),
      h('div', {class:'track'}, h('div', {class:'fill', style:`width:${Math.max(2, f.pct * 100).toFixed(1)}%;background:${f.pct >= .25 ? col.crit : f.pct >= .1 ? col.warn : col.ok}`})),
      h('span', {class:'v'}, `${Math.round(f.pct * 100)}% · ${f.media.toFixed(1).replace('.', ',')} min`))))
    : h('p', {class:'m'}, 'Todavía no hay suficientes datos de este núcleo.')));

  const horas = patrones.horas[nucleo];
  if (horas){
    const W = 360, H = 120, pad = 18, bw = (W - pad) / 24;
    const vals = horas.map(o => o[0] >= 3 ? o[1] / o[0] : null);
    const max = Math.max(.1, ...vals.filter(v => v != null));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 16}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Porcentaje de trenes con retraso según la hora del día');
    let inner = `<line x1="${pad}" y1="${H}" x2="${W}" y2="${H}" stroke="var(--rule)"/>`;
    vals.forEach((v, i) => {
      const x = pad + i * bw + 1.5, w = bw - 3;
      if (v == null){ inner += `<rect x="${x}" y="${H - 2}" width="${w}" height="2" fill="var(--rule)"/>`; return; }
      const hh = Math.max(2, (v / max) * (H - 14));
      const c = v >= .25 ? col.crit : v >= .1 ? col.warn : col.ok;
      inner += `<rect x="${x}" y="${H - hh}" width="${w}" height="${hh}" rx="1.5" fill="${c}"><title>${String(i).padStart(2, '0')}:00 · ${Math.round(v * 100)}% con retraso</title></rect>`;
    });
    for (let i = 0; i < 24; i += 3) inner += `<text x="${pad + i * bw + bw / 2}" y="${H + 13}" text-anchor="middle">${String(i).padStart(2, '0')}h</text>`;
    inner += `<text x="0" y="10">${Math.round(max * 100)}%</text>`;
    svg.innerHTML = inner;
    box.append(h('div', null, h('h3', null, 'A qué hora hay más retrasos'), h('p', {class:'m'}, 'Hora peninsular. Barras grises: aún sin datos de esa hora.'), svg));
  }

  const pts = (historial?.p || []).map(p => ({t:p.t, o:p.n[nucleo]})).filter(p => p.o && p.o[1] >= 3);
  if (pts.length >= 3){
    const W = 360, H = 90, t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const X = t => 28 + (W - 32) * ((t - t0) / Math.max(1, t1 - t0)), Y = v => 6 + (H - 12) * (1 - v);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.o[2] / p.o[1]).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1], lv = last.o[2] / last.o[1];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 16}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Puntualidad en las últimas horas');
    svg.innerHTML = [1, .9, .75].map(v => `<line x1="28" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rule)" stroke-dasharray="${v === 1 ? '' : '3 3'}"/><text x="0" y="${Y(v) + 3}">${v * 100}%</text>`).join('')
      + `<path d="${line} L${X(t1)} ${Y(0)} L${X(t0)} ${Y(0)} Z" fill="var(--accent)" opacity=".10"/>`
      + `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`
      + `<circle cx="${X(t1)}" cy="${Y(lv)}" r="3.5" fill="var(--accent)"/>`
      + `<text x="28" y="${H + 13}">${fmtHM(t0)}</text><text x="${W}" y="${H + 13}" text-anchor="end">${fmtHM(t1)}</text>`;
    box.append(h('div', null, h('h3', null, 'Puntualidad en las últimas horas'), h('p', {class:'m'}, `Ahora: ${Math.round(lv * 100)}% de trenes con menos de 3 min de retraso.`), svg));
  }
}

// ── pie del mapa: tren seleccionado
function renderFoot(){
  const f = $('#boardFoot');
  const t = selected && trenesNuc().find(x => x.id === selected);
  f.replaceChildren();
  if (!t){ f.append(h('span', {class:'hint'}, 'Toca un tren para ver su estado y abrir una incidencia.')); return; }
  const s = sev(t), col = SEVCOL(), inc = incAbiertaDe(t);
  f.append(h('div', {class:'tcard'},
    h('span', {class:'code', style:`background:${lineColor(nucleo, t.linea)}`}, t.linea),
    h('span', {class:'num'}, t.num),
    h('dl', null,
      h('div', null, h('dt', null, 'Estado'), h('dd', null, estadoTexto(t))),
      h('div', null, h('dt', null, 'Retraso'), h('dd', {style:`color:${col[s]}`}, t.retraso == null ? 'Sin dato' : t.retraso > DUDOSO ? 'Dato dudoso' : mins(t.retraso) > 0 ? `+${mins(t.retraso)} min` : 'Puntual')),
      h('div', null, h('dt', null, 'Posición'), h('dd', null, t.ts ? rel(t.ts) : '—'))),
    h('div', {class:'actions'},
      inc ? h('button', {class:'btn small', type:'button', onclick:() => openDetail(inc.id)}, 'Ver incidencia')
          : h('button', {class:'btn small primary', type:'button', onclick:() => openNew({t, sev:s})}, 'Abrir incidencia'),
      h('button', {class:'btn small', type:'button', onclick:() => { selected = null; renderFoot(); renderMapa(); }}, 'Cerrar'))));
}

// ── incidencias (en este navegador)
const GRAV = {leve:['ok','Leve'], media:['warn','Media'], grave:['crit','Grave']};
const EST = {abierta:['crit','Abierta'], 'en curso':['warn','En curso'], resuelta:['ok','Resuelta']};
const TIPOS = ['Retraso','Tren parado','Avería de material','Infraestructura','Persona en la vía','Atención a viajeros','Vandalismo','Meteorología','Otra'];
let incFilter = 'activas';
const guardar = () => LS.set('vl-incidencias', incs);
$('#incFilter').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; incFilter = b.dataset.f; $('#incFilter').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderIncs(); });
function renderIncs(){
  const box = $('#incList');
  const delNuc = incs.filter(i => i.nucleo === nucleo);
  $('#cIncs').textContent = delNuc.filter(i => i.estado !== 'resuelta').length;
  const list = delNuc.filter(i => incFilter === 'resuelta' ? i.estado === 'resuelta' : i.estado !== 'resuelta').sort((a, b) => b.creada - a.creada);
  box.replaceChildren();
  if (!list.length){
    box.append(h('div', {class:'empty'}, h('strong', null, incFilter === 'resuelta' ? 'Aún no hay incidencias resueltas' : 'No hay incidencias activas'),
      incFilter === 'resuelta' ? 'Las cerradas aparecerán aquí con su historial.' : 'Ábrelas desde una alerta, desde un tren del mapa o con “+ Nueva”.'));
    return;
  }
  for (const i of list){
    const g = GRAV[i.gravedad] || GRAV.media, es = EST[i.estado] || EST.abierta;
    box.append(h('button', {class:'row incrow', type:'button', onclick:() => openDetail(i.id)},
      h('div', {class:'sev ' + g[0]}, '!'),
      h('div', {class:'t'}, i.titulo),
      h('div', {class:'m'}, [i.linea, i.tren && 'tren ' + i.tren, i.tramo].filter(Boolean).join(' · ')),
      h('div', {class:'a'}, h('span', {class:'pill ' + es[0]}, es[1]), h('span', {class:'m'}, rel(i.creada)))));
  }
}
const scrim = $('#scrim'), sheet = $('#sheet');
let lastFocus = null, abiertaId = null;
function openSheet(){ lastFocus = document.activeElement; scrim.hidden = false; setTimeout(() => sheet.querySelector('input,select,textarea,button:not(.x)')?.focus(), 30); }
function closeSheet(){ scrim.hidden = true; abiertaId = null; lastFocus?.focus?.(); }
scrim.addEventListener('click', e => { if (e.target === scrim) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !scrim.hidden) closeSheet(); });
const head = (title, meta) => h('div', {class:'sheet-head'}, h('div', null, h('h3', {id:'sheetTitle'}, title), meta ? h('div', {class:'m'}, meta) : null), h('button', {class:'x', type:'button', 'aria-label':'Cerrar', onclick:closeSheet}, '×'));

function openNew(a){
  a = a || {};
  const t = a.t || null;
  const linea = t ? t.linea : (a.linea || '');
  const titulo = t ? (t.paradoDesde ? `Tren ${t.num} parado fuera de estación` : `Retraso de ${mins(t.retraso || 0)} min · tren ${t.num}`) : (a.title || '');
  const tipo = t ? (t.paradoDesde ? 'Tren parado' : 'Retraso') : (a.key?.startsWith('canc') ? 'Otra' : 'Otra');
  let grav = a.sev === 'crit' ? 'grave' : 'media';
  const lineas = [...new Set(trenesNuc().map(x => x.linea))].sort((x, y) => x.localeCompare(y, 'es', {numeric:true}));
  const fTit = h('input', {id:'f-titulo', required:true, value:titulo, placeholder:'Qué ha pasado, en pocas palabras'});
  const fLin = h('select', {id:'f-linea'}, h('option', {value:''}, 'Sin línea concreta'), ...lineas.map(l => h('option', {value:l, selected:l === linea}, l)));
  const fTren = h('input', {id:'f-tren', value:t ? t.num : '', placeholder:'Nº de tren', inputmode:'numeric'});
  const fTramo = h('input', {id:'f-tramo', value:t ? stopName(t.parada) : '', placeholder:'Estación o tramo'});
  const fTipo = h('select', {id:'f-tipo'}, ...TIPOS.map(x => h('option', {value:x, selected:x === tipo}, x)));
  const fDesc = h('textarea', {id:'f-desc', placeholder:'Qué se sabe, a quién se ha avisado, qué se necesita'});
  const segG = h('div', {class:'seg', role:'group', 'aria-label':'Gravedad'}, ...Object.entries(GRAV).map(([k, [, lbl]]) => h('button', {type:'button', 'aria-pressed':String(k === grav), onclick:e => { grav = k; segG.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); }}, lbl)));
  const form = h('form', {class:'sheet-body', onsubmit:e => {
    e.preventDefault();
    if (!fTit.value.trim()){ fTit.focus(); return; }
    const inc = {id:'i' + Date.now().toString(36), nucleo, titulo:fTit.value.trim(), linea:fLin.value || null, tren:fTren.value.trim() || null, tramo:fTramo.value.trim() || null, tipo:fTipo.value, gravedad:grav, descripcion:fDesc.value.trim() || null, trenId:t ? t.id : null, estado:'abierta', creada:Date.now(), actualizada:Date.now(), notas:[]};
    incs.push(inc); guardar(); toast('Incidencia abierta'); selectTab('incs'); renderIncs(); renderAlerts(); renderFoot(); openDetail(inc.id);
  }},
    h('div', {class:'field'}, h('label', {for:'f-titulo'}, 'Título'), fTit),
    h('div', {class:'two'}, h('div', {class:'field'}, h('label', {for:'f-linea'}, 'Línea'), fLin), h('div', {class:'field'}, h('label', {for:'f-tren'}, 'Tren'), fTren)),
    h('div', {class:'two'}, h('div', {class:'field'}, h('label', {for:'f-tramo'}, 'Estación o tramo'), fTramo), h('div', {class:'field'}, h('label', {for:'f-tipo'}, 'Tipo'), fTipo)),
    h('div', {class:'field'}, h('span', {class:'lbl'}, 'Gravedad'), segG),
    h('div', {class:'field'}, h('label', {for:'f-desc'}, 'Descripción'), fDesc),
    h('div', {class:'foot-actions'}, h('button', {class:'btn', type:'button', onclick:closeSheet}, 'Cancelar'), h('button', {class:'btn primary', type:'submit'}, 'Abrir incidencia')));
  sheet.replaceChildren(head('Nueva incidencia', `${estado.nucleos[nucleo].nombre} · ${fmtHM(Date.now())}`), form);
  openSheet();
}
function openDetail(id){
  const i = incs.find(x => x.id === id); if (!i) return;
  abiertaId = id;
  const g = GRAV[i.gravedad] || GRAV.media;
  const t = i.trenId && (estado?.trenes || []).find(x => x.id === i.trenId);
  const notesUl = h('ul', {class:'notes'});
  const pintarNotas = () => { notesUl.replaceChildren(); if (!i.notas.length) notesUl.append(h('li', {style:'border:0;padding:0;color:var(--muted)'}, 'Aún no hay notas. Apunta avisos, llamadas o decisiones.')); i.notas.forEach(n => notesUl.append(h('li', null, h('div', null, n.texto), h('div', {class:'who'}, fmtHM(n.t))))); };
  pintarNotas();
  const nIn = h('input', {id:'n-text', placeholder:'Añadir nota (ej.: avisado el centro de control)'});
  const estSeg = h('div', {class:'seg', role:'group', 'aria-label':'Estado'}, ...Object.entries(EST).map(([k, [, lbl]]) => h('button', {type:'button', 'aria-pressed':String(k === i.estado), onclick:e => {
    if (k === i.estado) return;
    i.estado = k; i.actualizada = Date.now(); i.notas.push({t:Date.now(), texto:`Estado cambiado a “${lbl}”`}); guardar();
    estSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
    pintarNotas(); renderIncs(); renderAlerts(); toast(`Marcada como ${lbl.toLowerCase()}`);
  }}, lbl)));
  sheet.replaceChildren(
    head(i.titulo, `Abierta ${rel(i.creada)} · ${fmtHM(i.creada)}`),
    h('div', {class:'sheet-body'},
      h('div', {style:'display:flex;gap:8px;flex-wrap:wrap'}, h('span', {class:'pill ' + g[0]}, 'Gravedad ' + g[1].toLowerCase()), h('span', {class:'pill neutral'}, i.tipo || 'Otra')),
      h('dl', {class:'facts'},
        h('div', null, h('dt', null, 'Línea'), h('dd', null, i.linea || '—')),
        h('div', null, h('dt', null, 'Tren'), h('dd', null, i.tren || '—')),
        h('div', null, h('dt', null, 'Estación o tramo'), h('dd', null, i.tramo || '—')),
        h('div', null, h('dt', null, 'Tren ahora'), h('dd', null, t ? `${estadoTexto(t)}${valido(t) ? ` · +${mins(t.retraso)} min` : ''}` : 'Ya no aparece en los datos'))),
      i.descripcion ? h('p', {style:'margin:0;max-width:65ch'}, i.descripcion) : null,
      h('div', {class:'field'}, h('span', {class:'lbl'}, 'Estado'), estSeg),
      h('div', {class:'field'}, h('span', {class:'lbl'}, 'Notas'), notesUl,
        h('form', {class:'addnote', onsubmit:e => { e.preventDefault(); const v = nIn.value.trim(); if (!v) return; i.notas.push({t:Date.now(), texto:v}); i.actualizada = Date.now(); guardar(); nIn.value = ''; pintarNotas(); }}, nIn, h('button', {class:'btn', type:'submit'}, 'Añadir'))),
      h('div', {class:'foot-actions'}, h('button', {class:'btn', type:'button', onclick:() => { const k = incs.indexOf(i); if (k >= 0) incs.splice(k, 1); guardar(); closeSheet(); renderIncs(); renderAlerts(); toast('Incidencia borrada'); }}, 'Borrar incidencia'))));
  if (scrim.hidden) openSheet();
}
$('#newInc').addEventListener('click', () => estado && openNew(null));

// ── pestañas
function selectTab(name){
  ['alerts', 'avisos', 'incs', 'pat'].forEach(n => { const on = n === name; $('#tab-' + n).setAttribute('aria-selected', String(on)); $('#pane-' + n).hidden = !on; });
  LS.set('vl-tab', name);
}
['alerts', 'avisos', 'incs', 'pat'].forEach(n => $('#tab-' + n).addEventListener('click', () => selectTab(n)));
selectTab(LS.get('vl-tab', 'alerts'));

function renderTodo(){
  if (!estado) return;
  renderFresh(); renderNucleos(); renderKpis(); renderLines(); renderMapa(); renderAlerts(); renderAvisos(); renderIncs(); renderPatrones(); renderFoot();
}
window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (estado?.nucleos[k] && k !== nucleo) cambiarNucleo(k); });

setInterval(() => { $('#clock').textContent = fmtClock(new Date()); }, 1000);
$('#clock').textContent = fmtClock(new Date());
setInterval(renderFresh, 30_000);
setInterval(() => { if (!document.hidden) cargar(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) cargar(); });
cargar();
})();
