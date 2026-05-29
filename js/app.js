/* ===================================================================
   AgroNav — Navegação Aérea
   Vanilla JS + Leaflet + localStorage
   =================================================================== */
(function () {
'use strict';

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
  activeNavIdx: 0
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
let map, posMarker, posAccCircle, trackLine, routeLine, drawLine;
const wpMarkers = [];
const fieldLayers = [];

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

  map.on('click', onMapClick);
  drawRouteOnMap();
  drawFieldsOnMap();
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
function planeIcon(heading) {
  return L.divIcon({
    className:'',
    html:`<div class="plane-icon" style="transform:rotate(${heading}deg)"><i class="fas fa-location-arrow"></i></div>`,
    iconSize:[26,26], iconAnchor:[13,13]
  });
}

/* ---------- Nav banner (to next waypoint) ---------- */
function updateNavBanner() {
  const banner = $('#navBanner');
  if (!state.pos || state.route.length === 0) { banner.classList.add('hidden'); return; }
  // target = first route point ahead (simple: nearest of remaining), default first
  const target = state.route[Math.min(state.activeNavIdx, state.route.length - 1)];
  const dist = haversineNM(state.pos, target);
  const brg = toMag(bearingTrue(state.pos, target));
  banner.classList.remove('hidden');
  $('#nav-to-name').textContent = target.name;
  $('#nav-dist').textContent = dist.toFixed(1);
  $('#nav-brg').textContent = fmtDeg(brg);
  const gs = Number(state.cfg.tas) || 110;
  $('#nav-ete').textContent = fmtHM(dist / gs);
  // auto-advance when within 0.5 NM
  if (dist < 0.5 && state.activeNavIdx < state.route.length - 1) state.activeNavIdx++;
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
    const [icao, name, city, uf, lat, lon, elev] = r;
    AIRPORT_MAP.set(icao, { icao, name, city, uf, lat, lon, elev });
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
      if (hint) { hint.className = 'lookup-hint'; hint.textContent = ''; }
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
  $('#btnExport').addEventListener('click', exportAll);
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importAll(e.target.files[0]); });
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('Apagar TODOS os dados do AgroNav (rotas, talhões, config)?')) return;
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
