/* ===================================================================
   AgroNav — Navegação Aérea
   Vanilla JS + Leaflet + localStorage
   =================================================================== */
(function () {
'use strict';

const APP_VERSION = 'v16';

/* ---------- Storage helpers ---------- */
const LS = {
  get(k, def) { try { const v = localStorage.getItem('agronav_' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { localStorage.setItem('agronav_' + k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem('agronav_' + k); }
};

/* ---------- App state ---------- */
const state = {
  cfg: LS.get('cfg', { tail:'', model:'', tas:110, ff:120, var:-21, area:'ha' }),
  route: LS.get('route', []),          // [{name, lat, lon}]
  savedRoutes: LS.get('savedRoutes', []),
  fields: LS.get('fields', []),        // [{id, name, coords:[[lat,lon]...], area}]
  follow: true,
  tracking: false,
  track: [],
  addWpMode: false,
  drawMode: false,
  drawPts: [],
  watchId: null,
  layerIdx: 0,
  pos: null,
  activeNavIdx: 0,
  showAirports: true,
  gotoTarget: null,
  legendHidden: LS.get('legendHidden', false)
};

/* ---------- Geo math ---------- */
const R_NM = 3440.065; // Earth radius in nautical miles
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversineNM(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearingTrue(a, b) {
  const la1 = toRad(a.lat), la2 = toRad(b.lat), dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// magnetic = true - variation. variation negative = West.
function toMag(trueBrg) { return ((trueBrg - Number(state.cfg.var)) % 360 + 360) % 360; }

function fmtHM(hours) {
  if (!isFinite(hours) || hours < 0) return '--';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return (h > 0 ? h + 'h' : '') + String(m).padStart(h>0?2:1, '0') + 'min';
}
function fmtDeg(d) { return String(Math.round(d)).padStart(3, '0'); }

/* ---------- DOM helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 2800);
}

/* ===================================================================
   NAVIGATION (SPA)
   =================================================================== */
function showPage(name) {
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  closeSidebar();
  if (name === 'map' && map) setTimeout(() => map.invalidateSize(), 60);
  if (name === 'route') renderRoute();
  if (name === 'fields') renderFields();
  if (name === 'aero') renderAero();
}
$$('.nav-item').forEach(n => n.addEventListener('click', () => showPage(n.dataset.page)));

/* Mobile sidebar */
function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebarOverlay').style.display = 'block'; }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebarOverlay').style.display = 'none'; }
$('#menuToggle').addEventListener('click', openSidebar);
$('#sidebarOverlay').addEventListener('click', closeSidebar);

/* ===================================================================
   MAP
   =================================================================== */
let map, posMarker, posAccCircle, trackLine, routeLine, drawLine, gotoLine, airportGroup;
const wpMarkers = [];
const fieldLayers = [];
const AIRPORT_MIN_ZOOM = 8;   // abaixo disso são muitos aeródromos — não plota
const AIRPORT_MAX_MARKERS = 600;

const baseLayers = [
  { name:'Mapa', layer:() => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap' }) },
  { name:'Satélite', layer:() => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'© Esri' }) },
  { name:'Topo', layer:() => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom:17, attribution:'© OpenTopoMap' }) }
];
let currentBaseLayer;

function initMap() {
  map = L.map('map', { zoomControl:false, attributionControl:true }).setView([-15.78, -47.92], 5);
  L.control.zoom({ position:'bottomright' }).addTo(map);
  currentBaseLayer = baseLayers[0].layer().addTo(map);

  routeLine = L.polyline([], { color:'#06b6d4', weight:3, dashArray:'1', opacity:.9 }).addTo(map);
  trackLine = L.polyline([], { color:'#22c55e', weight:3, opacity:.85 }).addTo(map);
  drawLine = L.polygon([], { color:'#f59e0b', weight:2, fillOpacity:.15 }).addTo(map);
  gotoLine = L.polyline([], { color:'#f59e0b', weight:3, dashArray:'8,7', opacity:.9 }).addTo(map);
  airportGroup = L.layerGroup().addTo(map);

  map.on('click', onMapClick);
  map.on('moveend', renderAirportMarkers);
  drawRouteOnMap();
  drawFieldsOnMap();
}

/* ---------- Aeródromos no mapa ---------- */
// cor por piso: asf=asfalto, terra=terra/cascalho, grama=grama, outro/desconhecido
const SURF_COLOR = { asf: '#64748b', terra: '#b45309', grama: '#22c55e', outro: '#9ca3af', '': '#9ca3af' };
const SURF_LABEL = { asf: 'Asfalto', terra: 'Terra', grama: 'Grama', outro: 'Outro' };
function surfColor(s) { return SURF_COLOR[s] || '#9ca3af'; }
// PORTE do aeródromo (tipo): controla o TAMANHO do símbolo (3=grande,2=médio,1=peq,0=hidro)
// símbolo de pista (comprimento x espessura, em px) quando não há geometria real / zoom baixo
// SYM_SCALE = fator de tamanho dos ícones de pista (1.2 = 120%)
const SYM_SCALE = 1.2;
const _SL = { 3: 24, 2: 16, 1: 10, 0: 14 };
const _SH = { 3: 7, 2: 5, 1: 4, 0: 5 };
const _RW = { 3: 9, 2: 5.5, 1: 3, 0: 5 };     // espessura da pista geográfica (zoom alto)
const SYM_LEN = {}, SYM_H = {}, RWY_W = {};
for (const k in _SL) SYM_LEN[k] = Math.round(_SL[k] * SYM_SCALE);
for (const k in _SH) SYM_H[k] = Math.round(_SH[k] * SYM_SCALE * 10) / 10;
for (const k in _RW) RWY_W[k] = Math.round(_RW[k] * SYM_SCALE * 10) / 10;
const RUNWAY_ZOOM = 12;                        // >= isto: pista geográfica real; abaixo: ícone inclinado
const RWYID_ZOOM = 12;                          // >= isto: cabeceiras na pista geográfica
const GLYPH_ID_ZOOM = 10;                       // >= isto: cabeceiras no ícone inclinado (zoom afastado)
let RUNWAYS = new Map();                        // ICAO -> [[le_lat,le_lon,he_lat,he_lon,surf,len_ft], ...]

// mostra a legenda, ou o botão "Legenda" se o usuário a escondeu
function updateLegendUI(canShow) {
  const legend = $('#aptLegend'), restore = $('#legRestore');
  if (!legend) return;
  if (!canShow) { legend.classList.add('hidden'); if (restore) restore.classList.add('hidden'); return; }
  if (state.legendHidden) {
    legend.classList.add('hidden');
    if (restore) restore.classList.remove('hidden');
  } else {
    legend.classList.remove('hidden');
    if (restore) restore.classList.add('hidden');
  }
}

function rwyLabel(ll, txt) {
  return L.marker(ll, {
    icon: L.divIcon({ className: '', html: `<span class="rwy-id">${txt}</span>`, iconSize: [0, 0] }),
    interactive: false, keyboard: false
  });
}

// pista mais longa de um aeródromo (para o glifo)
function primaryRunway(rws) { return rws.reduce((m, x) => ((x[5] || 0) > (m[5] || 0) ? x : m), rws[0]); }

// ÍCONE de pista inclinada no rumo REAL (Norte p/ cima), comprimento = porte, cor = piso, c/ cabeceiras.
// Usado quando a geometria geográfica fica pequena demais (zoom afastado).
function runwayIcon(a, rws, showIds) {
  const rw = primaryRunway(rws);
  const hdg = bearingTrue({ lat: rw[0], lon: rw[1] }, { lat: rw[2], lon: rw[3] }); // le → he (verdadeiro)
  const len = SYM_LEN[a.t] || 12, h = SYM_H[a.t] || 4;
  const box = len + 30; // espaço p/ cabeceiras
  const col = surfColor(rw[4]);
  // topo do glifo (após rotacionar por hdg) aponta p/ a cabeceira HE; base = LE
  const nums = showIds
    ? `<span class="apt-rwy-id" style="top:0;transform:translateX(-50%) rotate(${-hdg}deg)">${rw[7] || ''}</span>`
    + `<span class="apt-rwy-id" style="bottom:0;transform:translateX(-50%) rotate(${-hdg}deg)">${rw[6] || ''}</span>`
    : '';
  const html = `<div class="apt-rwy" style="width:${box}px;height:${box}px;transform:rotate(${hdg}deg)">`
    + `<span class="apt-rwy-bar" style="width:${h}px;height:${len}px;background:${col}"></span>${nums}</div>`;
  return L.divIcon({ className: '', html, iconSize: [box, box], iconAnchor: [box / 2, box / 2] });
}

// símbolo simples (sem geometria/rumo): tracinho por porte + cor de piso
function aptSymbol(a) {
  const len = SYM_LEN[a.t] || 10, h = SYM_H[a.t] || 4;
  return L.divIcon({
    className: '',
    html: `<span class="apt-strip" style="width:${len}px;height:${h}px;background:${surfColor(a.s)}"></span>`,
    iconSize: [len, h], iconAnchor: [len / 2, h / 2]
  });
}

function renderAirportMarkers() {
  if (!airportGroup) return;
  airportGroup.clearLayers();
  const z = map.getZoom();
  const canShowLegend = state.showAirports && z >= AIRPORT_MIN_ZOOM;
  updateLegendUI(canShowLegend);
  if (!state.showAirports || z < AIRPORT_MIN_ZOOM) return;
  const b = map.getBounds();
  let n = 0;
  for (const a of AIRPORT_MAP.values()) {
    if (a.lat < b.getSouth() || a.lat > b.getNorth() || a.lon < b.getWest() || a.lon > b.getEast()) continue;
    const rws = RUNWAYS.get(a.icao);
    const hasGeo = rws && rws.some(r => r[8] === 1);   // geometria geográfica real
    if (rws && rws.length && z >= RUNWAY_ZOOM && hasGeo) {
      // zoom perto + geometria REAL: pista geográfica (orientação e comprimento exatos) + cabeceiras
      const w = RWY_W[a.t] || 4;
      const showIds = z >= RWYID_ZOOM;
      rws.filter(r => r[8] === 1).forEach(rw => {
        const pts = [[rw[0], rw[1]], [rw[2], rw[3]]];
        const casing = L.polyline(pts, { color: '#0b1219', weight: w + 3, opacity: .85, lineCap: 'butt' });
        const top = L.polyline(pts, { color: surfColor(rw[4]), weight: w, opacity: 1, lineCap: 'butt' });
        [casing, top].forEach(l => {
          l.bindTooltip(a.icao, { direction: 'top', sticky: true });
          l.bindPopup(() => airportPopup(a), { minWidth: 200 });
          airportGroup.addLayer(l);
        });
        if (showIds) {
          if (rw[6]) airportGroup.addLayer(rwyLabel([rw[0], rw[1]], rw[6]));
          if (rw[7]) airportGroup.addLayer(rwyLabel([rw[2], rw[3]], rw[7]));
        }
      });
    } else {
      // ícone de pista inclinada (orientação real ou deduzida do número) + cabeceiras; senão tracinho
      const icon = (rws && rws.length) ? runwayIcon(a, rws, z >= GLYPH_ID_ZOOM) : aptSymbol(a);
      const m = L.marker([a.lat, a.lon], { icon });
      m.bindTooltip(a.icao, { direction: 'top', offset: [0, -6] });
      m.bindPopup(() => airportPopup(a), { minWidth: 200 });
      airportGroup.addLayer(m);
    }
    if (++n >= AIRPORT_MAX_MARKERS) break;
  }
}

function airportPopup(a) {
  const div = document.createElement('div');
  div.className = 'apt-popup';
  let info = `<b>${a.icao}</b><br><span class="apt-name">${a.name}</span>`;
  if (a.city) info += `<br>${a.city}${a.uf ? '/' + a.uf : ''}`;
  const bits = [];
  if (a.elev != null) bits.push(`Elev ${a.elev} ft`);
  if (a.rwy) bits.push(`Pista ${a.rwy}`);
  else if (a.s && SURF_LABEL[a.s]) bits.push(`Piso ${SURF_LABEL[a.s]}`);
  if (a.freq) bits.push(`Freq ${a.freq.toFixed(2)}`);
  if (bits.length) info += `<br><span class="apt-meta">${bits.join(' · ')}</span>`;
  div.innerHTML = `<div class="apt-info">${info}</div>
    <div class="apt-actions">
      <button class="btn btn-primary apt-goto"><i class="fas fa-diamond-turn-right"></i> Navegar até</button>
      <button class="btn btn-ghost apt-add"><i class="fas fa-plus"></i> Rota</button>
    </div>`;
  div.querySelector('.apt-goto').addEventListener('click', () => { directTo(a); map.closePopup(); });
  div.querySelector('.apt-add').addEventListener('click', () => {
    addWaypoint({ name: a.icao, lat: a.lat, lon: a.lon });
    toast(a.icao + ' adicionado à rota'); map.closePopup();
  });
  return div;
}

/* ---------- Navegação direta (Direct-To) ---------- */
function directTo(a) {
  state.gotoTarget = { name: a.icao || a.name, lat: a.lat, lon: a.lon };
  updateNavBanner();
  if (state.watchId === null) toast('Navegando até ' + state.gotoTarget.name + ' — ative o GPS p/ dados ao vivo');
  else toast('Navegando até ' + state.gotoTarget.name);
}
function clearGoto() {
  state.gotoTarget = null;
  gotoLine.setLatLngs([]);
  updateNavBanner();
}

function switchLayer() {
  state.layerIdx = (state.layerIdx + 1) % baseLayers.length;
  map.removeLayer(currentBaseLayer);
  currentBaseLayer = baseLayers[state.layerIdx].layer().addTo(map);
  toast('Camada: ' + baseLayers[state.layerIdx].name);
}

function onMapClick(e) {
  const { lat, lng } = e.latlng;
  if (state.drawMode) {
    state.drawPts.push([lat, lng]);
    drawLine.setLatLngs(state.drawPts);
    updateDrawPreview();
    return;
  }
  if (state.addWpMode) {
    addWaypoint({ name:'WP' + (state.route.length + 1), lat:+lat.toFixed(5), lon:+lng.toFixed(5) });
    toast('Waypoint adicionado');
  }
}

/* ---------- GPS ---------- */
function setGpsBadge(cls, txt) {
  const b = $('#gps-status-badge');
  b.className = 'gps-badge ' + cls;
  b.innerHTML = '<i class="fas fa-circle"></i> ' + txt;
}

function toggleGPS() {
  if (state.watchId !== null) { stopGPS(); return; }
  if (!('geolocation' in navigator)) { toast('GPS não suportado neste dispositivo', true); return; }
  setGpsBadge('gps-on', 'buscando...');
  state.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy:true, maximumAge:1000, timeout:15000
  });
  $('#btnLocate').classList.add('active');
}
function stopGPS() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $('#btnLocate').classList.remove('active');
  setGpsBadge('gps-off', 'GPS off');
}
function onPosErr(err) {
  setGpsBadge('gps-err', 'erro GPS');
  toast('Erro de GPS: ' + err.message, true);
}
function onPos(p) {
  const c = p.coords;
  state.pos = { lat:c.latitude, lon:c.longitude };
  setGpsBadge('gps-on', 'ativo');

  const gsKt = c.speed != null ? c.speed * 1.94384 : null;       // m/s → kt
  state.lastGsKt = gsKt;
  const trk = c.heading != null && !isNaN(c.heading) ? c.heading : null;
  const altFt = c.altitude != null ? c.altitude * 3.28084 : null;

  $('#hud-gs').textContent  = gsKt != null ? Math.round(gsKt) : '--';
  $('#hud-trk').textContent = trk != null ? fmtDeg(trk) : '--';
  $('#hud-alt').textContent = altFt != null ? Math.round(altFt) : '--';
  $('#hud-lat').textContent = c.latitude.toFixed(4);
  $('#hud-lon').textContent = c.longitude.toFixed(4);

  const ll = [c.latitude, c.longitude];
  if (!posMarker) {
    posMarker = L.marker(ll, { icon: planeIcon(trk || 0) }).addTo(map);
    posAccCircle = L.circle(ll, { radius:c.accuracy || 0, color:'#06b6d4', weight:1, fillOpacity:.08 }).addTo(map);
  } else {
    posMarker.setLatLng(ll);
    posMarker.setIcon(planeIcon(trk || 0));
    posAccCircle.setLatLng(ll).setRadius(c.accuracy || 0);
  }
  if (state.follow) map.setView(ll, Math.max(map.getZoom(), 12));

  if (state.tracking) { state.track.push(ll); trackLine.setLatLngs(state.track); }

  updateNavBanner();
}
const PLANE_SVG =
  '<svg viewBox="0 0 64 64" width="42" height="42" xmlns="http://www.w3.org/2000/svg">'
  + '<rect x="21" y="5" width="22" height="3" rx="1.5" fill="#1a1a1a"/>'                                  // hélice
  + '<path d="M4 35 L60 35 L60 30 L35 25 L29 25 L4 30 Z" fill="#F2C200" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>'  // asas
  + '<rect x="2.5" y="28.5" width="8" height="7" rx="2.5" fill="#2a6cd6"/>'                                // ponta asa esq (azul)
  + '<rect x="53.5" y="28.5" width="8" height="7" rx="2.5" fill="#2a6cd6"/>'                               // ponta asa dir (azul)
  + '<path d="M32 7 C35.5 7 38 11 38 18 L38 48 C38 54 35.5 58 32 58 C28.5 58 26 54 26 48 L26 18 C26 11 28.5 7 32 7 Z" fill="#F2C200" stroke="#1a1a1a" stroke-width="2"/>'  // fuselagem
  + '<path d="M19 53 L45 53 L45 50 L36 47.5 L28 47.5 L19 50 Z" fill="#F2C200" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>'  // estabilizador
  + '<ellipse cx="32" cy="23" rx="3.6" ry="6" fill="#143a5f"/>'                                            // cabine
  + '</svg>';

function planeIcon(heading) {
  return L.divIcon({
    className: '',
    html: `<div class="plane-icon" style="transform:rotate(${heading}deg)">${PLANE_SVG}</div>`,
    iconSize: [42, 42], iconAnchor: [21, 21]
  });
}

/* ---------- Nav banner (to next waypoint) ---------- */
function updateNavBanner() {
  const banner = $('#navBanner');
  // "Navegar até" (direct-to) tem prioridade; senão segue a rota
  const target = state.gotoTarget
    || (state.route.length ? state.route[Math.min(state.activeNavIdx, state.route.length - 1)] : null);
  if (!target) { banner.classList.add('hidden'); if (gotoLine) gotoLine.setLatLngs([]); return; }
  banner.classList.remove('hidden');
  $('#nav-to-name').textContent = target.name;
  if (!state.pos) {                 // sem GPS: mostra destino, pede GPS
    $('#nav-dist').textContent = '--';
    $('#nav-brg').textContent = '--';
    $('#nav-ete').textContent = 'GPS?';
    if (state.gotoTarget) gotoLine.setLatLngs([]);
    return;
  }
  const dist = haversineNM(state.pos, target);
  const brg = toMag(bearingTrue(state.pos, target));
  $('#nav-dist').textContent = dist.toFixed(1);
  $('#nav-brg').textContent = fmtDeg(brg);
  const gs = (state.lastGsKt && state.lastGsKt > 5) ? state.lastGsKt : (Number(state.cfg.tas) || 110);
  $('#nav-ete').textContent = fmtHM(dist / gs);
  if (state.gotoTarget) gotoLine.setLatLngs([[state.pos.lat, state.pos.lon], [target.lat, target.lon]]);
  // auto-avança waypoint só quando navegando uma rota
  if (!state.gotoTarget && dist < 0.5 && state.activeNavIdx < state.route.length - 1) state.activeNavIdx++;
}

/* ===================================================================
   WAYPOINTS / ROUTE
   =================================================================== */
function addWaypoint(wp) {
  state.route.push(wp);
  LS.set('route', state.route);
  drawRouteOnMap();
  renderRoute();
}
function removeWaypoint(i) {
  state.route.splice(i, 1);
  LS.set('route', state.route);
  state.activeNavIdx = 0;
  drawRouteOnMap();
  renderRoute();
}
function clearRoute() {
  state.route = []; state.activeNavIdx = 0;
  LS.set('route', state.route);
  drawRouteOnMap(); renderRoute();
}
function reverseRoute() {
  state.route.reverse();
  LS.set('route', state.route);
  drawRouteOnMap(); renderRoute();
}

function drawRouteOnMap() {
  wpMarkers.forEach(m => map.removeLayer(m));
  wpMarkers.length = 0;
  const pts = state.route.map(w => [w.lat, w.lon]);
  routeLine.setLatLngs(pts);
  state.route.forEach((w, i) => {
    const m = L.marker([w.lat, w.lon], {
      icon: L.divIcon({ className:'', html:`<div class="wp-label">${i+1}. ${w.name}</div>`, iconSize:[0,0] })
    }).addTo(map);
    const dot = L.circleMarker([w.lat, w.lon], { radius:5, color:'#06b6d4', fillColor:'#06b6d4', fillOpacity:1 }).addTo(map);
    wpMarkers.push(m, dot);
  });
}

function renderRoute() {
  const tb = $('#routeTable tbody');
  tb.innerHTML = '';
  const gs = Number($('#routeGS').value) || 110;
  const ff = Number($('#routeFF').value) || 0;
  let totDist = 0, totTime = 0, totFuel = 0;

  state.route.forEach((w, i) => {
    let brgM = '--', dist = 0;
    if (i > 0) {
      const prev = state.route[i-1];
      dist = haversineNM(prev, w);
      brgM = fmtDeg(toMag(bearingTrue(prev, w)));
      totDist += dist;
    }
    const t = i > 0 ? dist / gs : 0;
    const fuel = t * ff;
    if (i > 0) { totTime += t; totFuel += fuel; }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i+1}</td><td>${w.name}</td><td>${brgM}${i>0?'°':''}</td>`
      + `<td>${i>0?dist.toFixed(1):'—'}</td><td>${i>0?fmtHM(t):'—'}</td>`
      + `<td>${i>0?fuel.toFixed(0):'—'}</td>`
      + `<td><button class="row-btn" data-rm="${i}"><i class="fas fa-xmark"></i></button></td>`;
    tb.appendChild(tr);
  });
  $('#rt-total-dist').textContent = totDist.toFixed(1);
  $('#rt-total-ete').textContent = fmtHM(totTime);
  $('#rt-total-fuel').textContent = totFuel.toFixed(0);

  tb.querySelectorAll('[data-rm]').forEach(b =>
    b.addEventListener('click', () => removeWaypoint(+b.dataset.rm)));

  renderSavedRoutes();
}

function renderSavedRoutes() {
  const box = $('#savedRoutesList');
  if (!state.savedRoutes.length) { box.innerHTML = '<p class="empty">Nenhum plano salvo.</p>'; return; }
  box.innerHTML = '';
  state.savedRoutes.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'saved-item';
    div.innerHTML = `<div class="si-info"><span class="si-name">${r.name}</span>`
      + `<span class="si-meta">${r.points.length} pontos</span></div>`
      + `<div class="si-actions">`
      + `<button class="row-btn go" data-load="${i}" title="Carregar"><i class="fas fa-folder-open"></i></button>`
      + `<button class="row-btn" data-del="${i}" title="Excluir"><i class="fas fa-trash"></i></button></div>`;
    box.appendChild(div);
  });
  box.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => {
    state.route = JSON.parse(JSON.stringify(state.savedRoutes[+b.dataset.load].points));
    state.activeNavIdx = 0;
    LS.set('route', state.route);
    drawRouteOnMap(); renderRoute();
    toast('Plano carregado');
  }));
  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    state.savedRoutes.splice(+b.dataset.del, 1);
    LS.set('savedRoutes', state.savedRoutes);
    renderSavedRoutes();
  }));
}

/* ===================================================================
   FIELDS / TALHÕES
   =================================================================== */
function toggleDraw() {
  state.drawMode = !state.drawMode;
  $('#btnAddWp').classList.remove('active'); state.addWpMode = false;
  if (state.drawMode) {
    state.drawPts = [];
    drawLine.setLatLngs([]);
    toast('Modo desenho: toque nos vértices do talhão');
  } else if (state.drawPts.length >= 3) {
    openFieldModal();
  } else {
    drawLine.setLatLngs([]);
  }
}
function updateDrawPreview() {
  if (state.drawPts.length >= 3) {
    const a = polygonAreaHa(state.drawPts);
    toast(state.drawPts.length + ' vértices · ' + fmtArea(a));
  }
}

// Shoelace on spherical approx → hectares
function polygonAreaHa(coords) {
  if (coords.length < 3) return 0;
  const Rm = 6378137; // m
  let area = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lat1, lon1] = coords[i];
    const [lat2, lon2] = coords[(i + 1) % coords.length];
    area += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  area = Math.abs(area * Rm * Rm / 2);
  return area / 10000; // m² → ha
}
function fmtArea(ha) {
  const u = state.cfg.area;
  if (u === 'ac') return (ha * 2.47105).toFixed(1) + ' ac';
  if (u === 'km2') return (ha / 100).toFixed(3) + ' km²';
  return ha.toFixed(2) + ' ha';
}

function openFieldModal() {
  $('#fieldAreaPreview').textContent = fmtArea(polygonAreaHa(state.drawPts));
  $('#fieldNameInput').value = 'Talhão ' + (state.fields.length + 1);
  $('#fieldModal').classList.remove('hidden');
}
function saveField() {
  const name = $('#fieldNameInput').value.trim() || 'Talhão';
  const area = polygonAreaHa(state.drawPts);
  state.fields.push({ id: Date.now(), name, coords: state.drawPts.slice(), area });
  LS.set('fields', state.fields);
  $('#fieldModal').classList.add('hidden');
  state.drawPts = []; drawLine.setLatLngs([]);
  drawFieldsOnMap(); renderFields();
  toast('Talhão salvo: ' + name);
}

function drawFieldsOnMap() {
  fieldLayers.forEach(l => map.removeLayer(l));
  fieldLayers.length = 0;
  state.fields.forEach(f => {
    const poly = L.polygon(f.coords, { color:'#22c55e', weight:2, fillOpacity:.12 })
      .bindTooltip(`${f.name} · ${fmtArea(f.area)}`, { permanent:false });
    poly.addTo(map);
    fieldLayers.push(poly);
  });
}

function renderFields() {
  const box = $('#fieldsList');
  if (!state.fields.length) { box.innerHTML = '<p class="empty">Nenhum talhão salvo.</p>'; return; }
  box.innerHTML = '';
  state.fields.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'saved-item';
    div.innerHTML = `<div class="si-info"><span class="si-name">${f.name}</span>`
      + `<span class="si-meta">${fmtArea(f.area)} · ${f.coords.length} vértices</span></div>`
      + `<div class="si-actions">`
      + `<button class="row-btn go" data-goto="${i}" title="Ver no mapa"><i class="fas fa-location-dot"></i></button>`
      + `<button class="row-btn" data-delf="${i}" title="Excluir"><i class="fas fa-trash"></i></button></div>`;
    box.appendChild(div);
  });
  box.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
    const f = state.fields[+b.dataset.goto];
    showPage('map');
    setTimeout(() => map.fitBounds(L.polygon(f.coords).getBounds(), { padding:[40,40] }), 120);
  }));
  box.querySelectorAll('[data-delf]').forEach(b => b.addEventListener('click', () => {
    state.fields.splice(+b.dataset.delf, 1);
    LS.set('fields', state.fields);
    drawFieldsOnMap(); renderFields();
  }));
}

/* ===================================================================
   AERODROMES — base completa BR (OurAirports) + base rica local (freq/pista)
   =================================================================== */
const AIRPORT_MAP = new Map();   // ICAO -> {icao,name,city,uf,lat,lon,elev,rwy?,freq?}
let airportsLoaded = false;

function buildAirportIndex(brData) {
  AIRPORT_MAP.clear();
  // 1) base ampla (BR inteira)
  (brData || []).forEach(r => {
    const [icao, name, city, uf, lat, lon, elev, t, s] = r;
    AIRPORT_MAP.set(icao, { icao, name, city, uf, lat, lon, elev, t, s });
  });
  // 2) base local rica: adiciona/sobrepõe pista + frequência
  AERODROMES.forEach(a => {
    const ex = AIRPORT_MAP.get(a.icao) || {};
    AIRPORT_MAP.set(a.icao, Object.assign({}, ex, a));
  });
}

function loadAirportsOnline() {
  const hint = $('#wpLookupHint');
  buildAirportIndex(null);            // começa só com a base local (offline garantido)
  renderAero($('#aeroSearch').value);
  if (hint) { hint.className = 'lookup-hint loading'; hint.textContent = 'Baixando base de aeródromos…'; }
  fetch('data/br-airports.json', { cache: 'force-cache' })
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(j => {
      buildAirportIndex(j.data);
      airportsLoaded = true;
      renderAero($('#aeroSearch').value);
      renderAirportMarkers();
      if (hint) { hint.className = 'lookup-hint'; hint.textContent = ''; }
      // carrega geometria das pistas (desenho por piso) — não bloqueia o resto
      fetch('data/br-runways.json', { cache: 'force-cache' })
        .then(r => r.ok ? r.json() : null)
        .then(rj => { if (rj && rj.data) { RUNWAYS = new Map(Object.entries(rj.data)); renderAirportMarkers(); } })
        .catch(() => {});
    })
    .catch(() => {
      if (hint) { hint.className = 'lookup-hint miss'; hint.textContent = 'Sem internet — usando base local (' + AERODROMES.length + ' aeródromos).'; }
    });
}

function findAirport(code) { return AIRPORT_MAP.get((code || '').trim().toUpperCase()); }

function renderAero(filter) {
  const q = (filter || '').trim().toUpperCase();
  const tb = $('#aeroTable tbody');
  const all = [...AIRPORT_MAP.values()];
  let list = q
    ? all.filter(a => a.icao.includes(q) || a.name.toUpperCase().includes(q)
        || (a.city || '').toUpperCase().includes(q) || (a.uf || '') === q)
    : all;
  const total = list.length;
  const CAP = 200;
  list = list.slice(0, CAP);
  tb.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="icao-tag">${a.icao}</td><td>${a.name}</td>`
      + `<td>${a.city || '—'}${a.uf ? '/' + a.uf : ''}</td><td>${a.rwy || '—'}</td>`
      + `<td style="white-space:nowrap">`
      + `<button class="row-btn go" data-map="${a.icao}" title="Ver no mapa"><i class="fas fa-map-location-dot"></i></button>`
      + `<button class="row-btn go" data-route="${a.icao}" title="Adicionar à rota"><i class="fas fa-plus"></i></button></td>`;
    frag.appendChild(tr);
  });
  tb.appendChild(frag);
  $('#aeroCount').textContent = total + ' aeródromo(s)' + (total > CAP ? ' — mostrando ' + CAP + ', refine a busca' : '');
  tb.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => {
    const a = findAirport(b.dataset.map); if (!a) return;
    showPage('map');
    setTimeout(() => {
      map.setView([a.lat, a.lon], 13);
      let html = `<b>${a.icao}</b> — ${a.name}<br>${a.city || ''}${a.uf ? '/' + a.uf : ''}`;
      if (a.elev != null) html += `<br>Elev ${a.elev} ft`;
      if (a.rwy) html += ` · Pista ${a.rwy}`;
      if (a.freq) html += `<br>Freq ${a.freq.toFixed(2)}`;
      L.popup().setLatLng([a.lat, a.lon]).setContent(html).openOn(map);
    }, 120);
  }));
  tb.querySelectorAll('[data-route]').forEach(b => b.addEventListener('click', () => {
    const a = findAirport(b.dataset.route); if (!a) return;
    addWaypoint({ name: a.icao, lat: a.lat, lon: a.lon });
    toast(a.icao + ' adicionado à rota');
  }));
}

/* ---------- Autocomplete ICAO no campo "Adicionar ponto" ---------- */
function wireIcaoLookup() {
  const input = $('#wpName'), dl = $('#icaoList'), hint = $('#wpLookupHint');
  let t;
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    const code = raw.toUpperCase();
    const exact = AIRPORT_MAP.get(code);
    if (exact) {
      $('#wpLat').value = exact.lat;
      $('#wpLon').value = exact.lon;
      hint.className = 'lookup-hint ok';
      hint.textContent = `✔ ${exact.name}${exact.city ? ' — ' + exact.city + '/' + exact.uf : ''}`;
    } else {
      hint.className = 'lookup-hint';
      hint.textContent = '';
    }
    clearTimeout(t);
    t = setTimeout(() => buildIcaoSuggestions(code), 130);
  });
}
function buildIcaoSuggestions(code) {
  const dl = $('#icaoList');
  dl.innerHTML = '';
  if (!/^[A-Z0-9]{2,4}$/.test(code)) return;
  let n = 0;
  const frag = document.createDocumentFragment();
  for (const a of AIRPORT_MAP.values()) {
    if (a.icao.startsWith(code)) {
      const o = document.createElement('option');
      o.value = a.icao;
      o.label = `${a.name}${a.city ? ' — ' + a.city + '/' + a.uf : ''}`;
      frag.appendChild(o);
      if (++n >= 12) break;
    }
  }
  dl.appendChild(frag);
}

/* ===================================================================
   E6B CALCULATIONS
   =================================================================== */
function calcWindTriangle() {
  const tc = toRad(+$('#e6b-tc').value), tas = +$('#e6b-tas').value;
  const wdir = toRad(+$('#e6b-wdir').value), wspd = +$('#e6b-wspd').value;
  if (!tas) return;
  // wind angle relative to course
  const wta = wdir - tc;
  const swc = (wspd / tas) * Math.sin(wta);
  if (Math.abs(swc) > 1) { $('#e6b-wca').textContent = '∞'; $('#e6b-th').textContent='--'; $('#e6b-gs').textContent='0'; return; }
  const wca = Math.asin(swc);
  const th = (toDeg(tc + wca) + 360) % 360;
  const gs = tas * Math.sqrt(1 - swc*swc) - wspd * Math.cos(wta);
  $('#e6b-wca').textContent = (toDeg(wca) >= 0 ? '+' : '') + Math.round(toDeg(wca)) + '°';
  $('#e6b-th').textContent = fmtDeg(th) + '°';
  $('#e6b-gs').textContent = Math.round(gs) + ' kt';
}
function calcRunwayWind() {
  const rh = +$('#rw-hdg').value, wd = +$('#rw-wdir').value, ws = +$('#rw-wspd').value;
  const ang = toRad(wd - rh);
  const head = ws * Math.cos(ang);
  const cross = ws * Math.sin(ang);
  $('#rw-head').textContent = (head >= 0 ? Math.round(head) + ' kt proa' : Math.round(-head) + ' kt cauda');
  $('#rw-cross').textContent = Math.abs(Math.round(cross)) + ' kt ' + (cross >= 0 ? 'dir →' : 'esq ←');
}
function calcTSD() {
  const dist = +$('#tsd-dist').value, gs = +$('#tsd-gs').value, ff = +$('#tsd-ff').value;
  if (!gs) { $('#tsd-time').textContent='--'; $('#tsd-fuel').textContent='--'; return; }
  const t = dist / gs;
  $('#tsd-time').textContent = fmtHM(t);
  $('#tsd-fuel').textContent = (t * ff).toFixed(0) + ' L';
}
function calcDensityAlt() {
  const palt = +$('#da-palt').value, oat = +$('#da-oat').value;
  const isaTemp = 15 - 0.001981 * palt;       // ISA temp at pressure altitude (°C)
  const da = palt + 118.8 * (oat - isaTemp);  // approx ft
  $('#da-out').textContent = Math.round(da) + ' ft';
  $('#da-isa').textContent = isaTemp.toFixed(1) + ' °C';
}
function calcConvert() {
  const v = +$('#cv-input').value, type = $('#cv-type').value;
  const f = {
    kt_kmh:x=>x*1.852, kmh_kt:x=>x/1.852, kt_mph:x=>x*1.15078,
    nm_km:x=>x*1.852, km_nm:x=>x/1.852, nm_sm:x=>x*1.15078,
    ft_m:x=>x*0.3048, m_ft:x=>x/0.3048,
    l_gal:x=>x*0.264172, gal_l:x=>x/0.264172,
    inhg_hpa:x=>x*33.8639, hpa_inhg:x=>x/33.8639,
    c_f:x=>x*9/5+32, f_c:x=>(x-32)*5/9
  }[type];
  $('#cv-out').textContent = f ? (Math.round(f(v) * 100) / 100) : '--';
}

/* ===================================================================
   SETTINGS / DATA
   =================================================================== */
function loadCfgUI() {
  $('#cfg-tail').value = state.cfg.tail || '';
  $('#cfg-model').value = state.cfg.model || '';
  $('#cfg-tas').value = state.cfg.tas;
  $('#cfg-ff').value = state.cfg.ff;
  $('#cfg-var').value = state.cfg.var;
  $('#cfg-area').value = state.cfg.area;
  $('#routeGS').value = state.cfg.tas;
  $('#routeFF').value = state.cfg.ff;
  $('#routeVar').value = state.cfg.var;
  const vl = $('#appVersionLine'); if (vl) vl.textContent = 'Versão ' + APP_VERSION;
}
function saveCfg() {
  state.cfg = {
    tail:$('#cfg-tail').value.trim(), model:$('#cfg-model').value.trim(),
    tas:+$('#cfg-tas').value || 110, ff:+$('#cfg-ff').value || 120,
    var:+$('#cfg-var').value || 0, area:$('#cfg-area').value
  };
  LS.set('cfg', state.cfg);
  loadCfgUI(); drawFieldsOnMap(); renderFields();
  toast('Configurações salvas');
}
async function forceUpdate() {
  toast('Buscando versão nova…');
  try {
    if ('serviceWorker' in navigator) {
      const rs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map(r => r.unregister()));
    }
    if (window.caches) {
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
    }
  } catch (e) { /* segue mesmo assim */ }
  // recarrega forçando ignorar cache
  location.replace(location.pathname + '?u=' + Date.now());
}

function exportAll() {
  const data = { _app:'AgroNav', _ver:1, cfg:state.cfg, route:state.route, savedRoutes:state.savedRoutes, fields:state.fields };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'agronav-backup.json'; a.click();
  URL.revokeObjectURL(url);
}
function importAll(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (d.cfg) { state.cfg = d.cfg; LS.set('cfg', d.cfg); }
      if (d.route) { state.route = d.route; LS.set('route', d.route); }
      if (d.savedRoutes) { state.savedRoutes = d.savedRoutes; LS.set('savedRoutes', d.savedRoutes); }
      if (d.fields) { state.fields = d.fields; LS.set('fields', d.fields); }
      loadCfgUI(); drawRouteOnMap(); renderRoute(); drawFieldsOnMap(); renderFields();
      toast('Dados importados');
    } catch { toast('Arquivo inválido', true); }
  };
  reader.readAsText(file);
}

/* ===================================================================
   EVENT WIRING
   =================================================================== */
function wire() {
  // Map controls
  $('#btnLocate').addEventListener('click', toggleGPS);
  $('#btnFollow').addEventListener('click', () => {
    state.follow = !state.follow;
    $('#btnFollow').classList.toggle('active', state.follow);
    if (state.follow && state.pos) map.setView([state.pos.lat, state.pos.lon]);
  });
  $('#btnFollow').classList.toggle('active', state.follow);
  $('#btnLayer').addEventListener('click', switchLayer);
  $('#navClose').addEventListener('click', clearGoto);
  $('#legClose').addEventListener('click', () => { state.legendHidden = true; LS.set('legendHidden', true); renderAirportMarkers(); });
  $('#legRestore').addEventListener('click', () => { state.legendHidden = false; LS.set('legendHidden', false); renderAirportMarkers(); });
  $('#btnTrack').addEventListener('click', () => {
    state.tracking = !state.tracking;
    $('#btnTrack').classList.toggle('active', state.tracking);
    if (state.tracking) { state.track = []; trackLine.setLatLngs([]); toast('Gravando trilha'); }
    else toast('Trilha parada');
  });
  $('#btnAddWp').addEventListener('click', () => {
    state.addWpMode = !state.addWpMode;
    if (state.drawMode) toggleDraw();
    $('#btnAddWp').classList.toggle('active', state.addWpMode);
    toast(state.addWpMode ? 'Toque no mapa p/ adicionar waypoint' : 'Modo waypoint off');
  });

  // Route page
  $('#btnAddRoutePt').addEventListener('click', () => {
    const name = $('#wpName').value.trim() || 'WP' + (state.route.length + 1);
    const lat = +$('#wpLat').value, lon = +$('#wpLon').value;
    if (isNaN(lat) || isNaN(lon)) { toast('Coordenadas inválidas', true); return; }
    addWaypoint({ name, lat, lon });
    $('#wpName').value = $('#wpLat').value = $('#wpLon').value = '';
  });
  $('#btnClearRoute').addEventListener('click', clearRoute);
  $('#btnReverseRoute').addEventListener('click', reverseRoute);
  ['routeGS','routeFF','routeVar'].forEach(id => $('#'+id).addEventListener('input', renderRoute));
  $('#btnSaveRoute').addEventListener('click', () => {
    if (!state.route.length) { toast('Rota vazia', true); return; }
    const name = $('#routeSaveName').value.trim() || 'Plano ' + (state.savedRoutes.length + 1);
    state.savedRoutes.push({ name, points: JSON.parse(JSON.stringify(state.route)) });
    LS.set('savedRoutes', state.savedRoutes);
    $('#routeSaveName').value = '';
    renderSavedRoutes();
    toast('Plano salvo');
  });

  // E6B
  ['e6b-tc','e6b-tas','e6b-wdir','e6b-wspd'].forEach(id => $('#'+id).addEventListener('input', calcWindTriangle));
  ['rw-hdg','rw-wdir','rw-wspd'].forEach(id => $('#'+id).addEventListener('input', calcRunwayWind));
  ['tsd-dist','tsd-gs','tsd-ff'].forEach(id => $('#'+id).addEventListener('input', calcTSD));
  ['da-palt','da-oat'].forEach(id => $('#'+id).addEventListener('input', calcDensityAlt));
  ['cv-input','cv-type'].forEach(id => $('#'+id).addEventListener('input', calcConvert));

  // Fields
  $('#btnGoDrawField').addEventListener('click', () => { showPage('map'); if (!state.drawMode) toggleDraw(); });
  $('#fieldCancel').addEventListener('click', () => { $('#fieldModal').classList.add('hidden'); state.drawPts=[]; drawLine.setLatLngs([]); });
  $('#fieldSave').addEventListener('click', saveField);

  // Aero search
  $('#aeroSearch').addEventListener('input', e => renderAero(e.target.value));

  // Settings
  $('#btnSaveCfg').addEventListener('click', saveCfg);
  $('#btnForceUpdate').addEventListener('click', forceUpdate);
  $('#btnExport').addEventListener('click', exportAll);
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importAll(e.target.files[0]); });
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('Apagar TODOS os dados do Nave Corvino (rotas, talhões, config)?')) return;
    ['cfg','route','savedRoutes','fields'].forEach(LS.del);
    location.reload();
  });
}

/* ---------- Add draw button to map controls dynamically ---------- */
function addDrawButton() {
  const btn = document.createElement('button');
  btn.className = 'map-btn'; btn.id = 'btnDraw'; btn.title = 'Desenhar talhão';
  btn.innerHTML = '<i class="fas fa-draw-polygon"></i>';
  btn.addEventListener('click', () => { toggleDraw(); btn.classList.toggle('active', state.drawMode); });
  $('.map-controls').appendChild(btn);

  // botão liga/desliga aeródromos no mapa
  const aptBtn = document.createElement('button');
  aptBtn.className = 'map-btn' + (state.showAirports ? ' active' : '');
  aptBtn.id = 'btnAirports'; aptBtn.title = 'Mostrar/ocultar aeródromos';
  aptBtn.innerHTML = '<i class="fas fa-tower-control"></i>';
  aptBtn.addEventListener('click', () => {
    state.showAirports = !state.showAirports;
    aptBtn.classList.toggle('active', state.showAirports);
    renderAirportMarkers();
    toast(state.showAirports ? 'Aeródromos no mapa: ligado (dê zoom p/ ver)' : 'Aeródromos no mapa: desligado');
  });
  $('.map-controls').appendChild(aptBtn);
}

/* ===================================================================
   INIT
   =================================================================== */
function init() {
  initMap();
  addDrawButton();
  wire();
  wireIcaoLookup();
  loadCfgUI();
  renderRoute();
  renderFields();
  loadAirportsOnline();
  // run E6B defaults
  calcWindTriangle(); calcRunwayWind(); calcTSD(); calcDensityAlt(); calcConvert();
}
document.addEventListener('DOMContentLoaded', init);

})();
