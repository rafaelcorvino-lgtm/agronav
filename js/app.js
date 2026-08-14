/* ===================================================================
   AgroNav — Navegação Aérea
   Vanilla JS + Leaflet + localStorage
   =================================================================== */
(function () {
'use strict';

const APP_VERSION = 'v52';

/* ---------- Storage helpers ---------- */
const LS = {
  get(k, def) { try { const v = localStorage.getItem('agronav_' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { localStorage.setItem('agronav_' + k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem('agronav_' + k); }
};

/* ---------- App state ---------- */
const state = {
  cfg: LS.get('cfg', { tail:'', model:'', tas:110, ff:120, var:-21, area:'ha', speedU:'kt', distU:'nm', altU:'ft', fuelU:'l' }),
  route: LS.get('route', []),          // [{name, lat, lon}]
  savedRoutes: LS.get('savedRoutes', []),
  fields: LS.get('fields', []),        // [{id, name, coords:[[lat,lon]...], area}]
  followMode: 1,   // 0=livre, 1=norte acima (seguir), 2=proa acima (track-up)
  curBearing: 0,
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
  legendHidden: LS.get('legendHidden', false),
  showAirspace: LS.get('showAirspace', false),
  hsiWidgets: LS.get('hsiWidgets', null),
  hudWidgets: LS.get('hudWidgets', null),
  pedidos: LS.get('pedidos', []),
  navData: {}
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

/* ---------- Unidades (conversão a partir da base: kt / NM / ft / L) ---------- */
const SPEED_F = { kt:1, kmh:1.852, mph:1.15078 }, SPEED_L = { kt:'kt', kmh:'km/h', mph:'mph' };
const DIST_F  = { nm:1, km:1.852, mi:1.15078 },  DIST_L  = { nm:'NM', km:'km', mi:'mi' };
const ALT_F   = { ft:1, m:0.3048 },              ALT_L   = { ft:'ft', m:'m' };
const FUEL_F  = { l:1, gal:0.264172 },           FUEL_L  = { l:'L', gal:'gal' };
const uSpeed = () => SPEED_L[state.cfg.speedU] || 'kt';
const cSpeed = kt => (kt == null ? null : kt * (SPEED_F[state.cfg.speedU] || 1));
const uDist  = () => DIST_L[state.cfg.distU] || 'NM';
const cDist  = nm => nm * (DIST_F[state.cfg.distU] || 1);
const uAlt   = () => ALT_L[state.cfg.altU] || 'ft';
const cAlt   = ft => (ft == null ? null : ft * (ALT_F[state.cfg.altU] || 1));
const uFuel  = () => FUEL_L[state.cfg.fuelU] || 'L';
const cFuel  = l => l * (FUEL_F[state.cfg.fuelU] || 1);

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
  if (name === 'pedidos') renderPedidos();
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
let airspaceLayer = null, aspRenderer = null;
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
  map = L.map('map', { zoomControl:false, attributionControl:true, rotate:true, touchRotate:false, shiftKeyRotate:false, rotateControl:false, bearing:0 }).setView([-15.78, -47.92], 5);
  L.control.zoom({ position:'bottomright' }).addTo(map);
  currentBaseLayer = baseLayers[0].layer().addTo(map);

  routeLine = L.polyline([], { color:'#06b6d4', weight:3, dashArray:'1', opacity:.9 }).addTo(map);
  trackLine = L.polyline([], { color:'#22c55e', weight:3, opacity:.85 }).addTo(map);
  drawLine = L.polygon([], { color:'#f59e0b', weight:2, fillOpacity:.15 }).addTo(map);
  gotoLine = L.polyline([], { color:'#f59e0b', weight:3, dashArray:'8,7', opacity:.9 }).addTo(map);
  airportGroup = L.layerGroup().addTo(map);

  map.on('click', onMapClick);
  map.on('moveend', renderAirportMarkers);
  // ao girar a tela, reposiciona o avião (HSI muda a área visível)
  window.addEventListener('resize', () => {
    updateOrient();
    setTimeout(() => { if (map) map.invalidateSize({ animate: false }); if (state.followMode && state.pos) recenterFollow([state.pos.lat, state.pos.lon]); }, 150);
  });
  updateOrient();
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

/* ===================================================================
   ESPAÇO AÉREO (DECEA) — overlay de referência
   =================================================================== */
const ASP_STYLE = {
  CTR:   { color: '#3b82f6', fill: .10, w: 1.6 },
  TMA:   { color: '#8b5cf6', fill: .07, w: 1.4 },
  CTA:   { color: '#0ea5e9', fill: .05, w: 1.2 },
  CTA_P: { color: '#0ea5e9', fill: .05, w: 1.2 },
  P:     { color: '#dc2626', fill: .20, w: 1.8 },
  R:     { color: '#ef4444', fill: .12, w: 1.6 },
  D:     { color: '#f59e0b', fill: .12, w: 1.6 }
};
const ASP_LABEL = {
  CTR: 'Zona de Controle (CTR)', TMA: 'Terminal (TMA)', CTA: 'Área de Controle (CTA)',
  CTA_P: 'Área de Controle', P: 'Área PROIBIDA (P)', R: 'Área RESTRITA (R)', D: 'Área PERIGOSA (D)'
};
const ASP_PRIORITY = { CTA: 0, CTA_P: 0, TMA: 1, CTR: 2, D: 3, R: 4, P: 5 };
function aspStyle(f) {
  const s = ASP_STYLE[f.properties.t] || { color: '#94a3b8', fill: .06, w: 1.2 };
  return { color: s.color, weight: s.w, fillColor: s.color, fillOpacity: s.fill, opacity: .9 };
}
function aspPopup(f) {
  const p = f.properties;
  const lbl = ASP_LABEL[p.t] || p.t;
  let h = `<b>${p.id || ''}</b> ${p.nm ? '— ' + p.nm : ''}<br><span class="apt-meta">${lbl}</span>`;
  if (p.lo || p.up) h += `<br>Vert: <b>${p.lo || '?'} → ${p.up || '?'}</b>`;
  return h;
}
function loadAirspace() {
  fetch('data/br-airspace.json', { cache: 'force-cache' })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(geo => {
      if (geo && Array.isArray(geo.features)) {
        // áreas mais específicas (P/R/D) por cima das genéricas (CTR/TMA/CTA) p/ clique pegar a certa quando sobrepostas
        geo.features.sort((a, b) => (ASP_PRIORITY[a.properties.t] || 0) - (ASP_PRIORITY[b.properties.t] || 0));
      }
      aspRenderer = L.canvas({ padding: 0.5 });
      airspaceLayer = L.geoJSON(geo, {
        renderer: aspRenderer,
        style: aspStyle,
        onEachFeature: (f, layer) => layer.bindPopup(() => aspPopup(f), { minWidth: 200 })
      });
      if (state.showAirspace) airspaceLayer.addTo(map);
      const btn = $('#btnAirspace'); if (btn) btn.classList.toggle('active', state.showAirspace);
    })
    .catch(() => {});
}
function toggleAirspace() {
  state.showAirspace = !state.showAirspace;
  LS.set('showAirspace', state.showAirspace);
  const btn = $('#btnAirspace'); if (btn) btn.classList.toggle('active', state.showAirspace);
  if (!airspaceLayer) { toast('Carregando espaços aéreos…'); return; }
  if (state.showAirspace) { airspaceLayer.addTo(map); toast('Espaço aéreo: ligado (referência — confira AIP/NOTAM)'); }
  else { map.removeLayer(airspaceLayer); toast('Espaço aéreo: desligado'); }
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
  state.navStart = state.pos ? { lat: state.pos.lat, lon: state.pos.lon } : null;
  updateNavBanner();
  if (state.watchId === null) toast('Navegando até ' + state.gotoTarget.name + ' — ative o GPS p/ dados ao vivo');
  else toast('Navegando até ' + state.gotoTarget.name);
}
function clearGoto() {
  state.gotoTarget = null;
  state.navStart = null;
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

let gpsAgeTimer = null, wakeLock = null;

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
// re-adquire o wake lock ao voltar pro app (o SO solta quando vai p/ segundo plano)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.watchId !== null && !wakeLock) requestWakeLock();
});

let lowAccTried = false;
function gpsInfoMsg(cls, txt) {
  const info = $('#gpsInfo');
  if (info) { info.classList.remove('hidden'); info.className = 'gps-info' + (cls ? ' ' + cls : ''); info.textContent = txt; }
}
function toggleGPS() {
  if (state.watchId !== null) { stopGPS(); return; }
  if (!('geolocation' in navigator)) { toast('GPS não suportado neste dispositivo', true); return; }
  if (!window.isSecureContext) { toast('GPS exige HTTPS (abra pelo link https://)', true); }
  setGpsBadge('gps-on', 'buscando...');
  gpsInfoMsg('', 'GPS: permita a localização quando o navegador pedir…');
  state.gpsFixes = 0; state.lastFixTime = 0;
  requestWakeLock();
  // aviso proativo se a permissão já estiver bloqueada
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(p => {
      if (p.state === 'denied') gpsInfoMsg('warn', 'GPS bloqueado — libere a localização nas configurações do navegador');
    }).catch(() => {});
  }
  // SEMPRE alta precisão (GPS real). Não degrada p/ rede — posição de rede erra muito.
  state.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  if (!gpsAgeTimer) gpsAgeTimer = setInterval(updateGpsAge, 2000);
}
function stopGPS() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  setGpsBadge('gps-off', 'GPS off');
  const info = $('#gpsInfo'); if (info) info.classList.add('hidden');
  releaseWakeLock();
  if (gpsAgeTimer) { clearInterval(gpsAgeTimer); gpsAgeTimer = null; }
}
function onPosErr(err) {
  let msg;
  if (err.code === 1) { msg = 'Permissão negada — libere a localização do site/navegador'; setGpsBadge('gps-err', 'bloqueado'); }
  else if (err.code === 2) { msg = 'Posição indisponível — ligue a Localização do aparelho (Alta precisão)'; setGpsBadge('gps-on', 'buscando...'); }
  else { msg = 'Buscando GPS… a céu aberto pega mais rápido'; setGpsBadge('gps-on', 'buscando...'); }
  gpsInfoMsg('warn', 'GPS: ' + msg);
}
let lastWatchRestart = 0;
function restartWatch() {                 // reinicia o watch só se ele "morrer" de vez
  if (state.watchId === null) return;
  const now = Date.now();
  if (now - lastWatchRestart < 20000) return;
  lastWatchRestart = now;
  try { navigator.geolocation.clearWatch(state.watchId); } catch (e) {}
  state.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function updateGpsAge() {
  const el = $('#gpsInfo');
  if (!el || state.watchId === null || !state.lastFixTime) return;
  const age = Math.round((Date.now() - state.lastFixTime) / 1000);
  const acc = state.lastAcc != null ? '±' + Math.round(state.lastAcc) + 'm' : '';
  if (age > 30) restartWatch();           // só reinicia após 30s parado (GPS pode demorar p/ travar)
  if (age > 8) { el.className = 'gps-info warn'; el.textContent = `GPS ${acc} · sem atualizar há ${age}s (tela acesa? céu aberto?)`; }
  else if (state.lastAcc != null && state.lastAcc > 150) { el.className = 'gps-info warn'; el.textContent = `Aproximada ${acc} — ligue a Localização PRECISA`; }
  else { el.className = 'gps-info ok'; el.textContent = `GPS ${acc} · ${state.gpsFixes} fix · ${age}s`; }
}
function onPos(p) {
  const c = p.coords;
  state.pos = { lat:c.latitude, lon:c.longitude };
  if (state.gotoTarget && !state.navStart) state.navStart = { lat:c.latitude, lon:c.longitude };
  setGpsBadge('gps-on', 'ativo');
  state.gpsFixes = (state.gpsFixes || 0) + 1;
  state.lastFixTime = Date.now();
  state.lastAcc = c.accuracy;
  const gi = $('#gpsInfo');
  if (gi) {
    gi.classList.remove('hidden');
    if (c.accuracy != null && c.accuracy > 150) {     // posição de rede/aproximada — não é GPS preciso
      gi.className = 'gps-info warn';
      gi.textContent = `Aproximada ±${Math.round(c.accuracy)}m — ligue a Localização PRECISA`;
    } else {
      gi.className = 'gps-info ok';
      gi.textContent = `GPS ±${Math.round(c.accuracy || 0)}m · ${state.gpsFixes} fix`;
    }
  }

  // GS e rumo: usa o do GPS; se o aparelho não reportar, CALCULA pela diferença de posições
  let gsKt = (c.speed != null && !isNaN(c.speed)) ? c.speed * 1.94384 : null;
  let trk = (c.heading != null && !isNaN(c.heading)) ? c.heading : null;
  const nowMs = state.lastFixTime;
  if ((gsKt == null || trk == null) && state.prevFix) {
    const dtH = (nowMs - state.prevFix.t) / 3600000;
    const dNm = haversineNM(state.prevFix, state.pos);
    if (dtH > 0) {
      const calcGs = dNm / dtH;
      if (gsKt == null) gsKt = calcGs;
      if (trk == null && calcGs > 2 && dNm > 0.004) trk = bearingTrue(state.prevFix, state.pos); // só com movimento real (~7m)
    }
  }
  state.prevFix = { lat: c.latitude, lon: c.longitude, t: nowMs };
  state.lastGsKt = gsKt;
  state.lastAltM = (c.altitude != null && !isNaN(c.altitude)) ? c.altitude : null;
  maybeQueryTerrain(c.latitude, c.longitude);
  if (trk != null) state.lastTrk = trk;     // mantém o último rumo válido quando parado
  const altFt = c.altitude != null ? c.altitude * 3.28084 : null;
  // velocidade vertical (razão de subida) em ft/min, pela variação de altitude (suavizada)
  if (altFt != null) {
    if (state.prevAlt) {
      const dtMin = (nowMs - state.prevAlt.t) / 60000;
      if (dtMin >= 0.02) {                  // ~1,2 s mínimo
        const vs = (altFt - state.prevAlt.ft) / dtMin;
        state.lastVs = (state.lastVs == null) ? vs : state.lastVs * 0.6 + vs * 0.4;
        state.prevAlt = { ft: altFt, t: nowMs };
      }
    } else {
      state.prevAlt = { ft: altFt, t: nowMs };
    }
  }

  // dados de voo "estado da aeronave" (sempre disponíveis, p/ HUD e HSI)
  const aglNow = aglFt();
  state.navData = state.navData || {};
  Object.assign(state.navData, {
    gs: gsKt != null ? cSpeed(gsKt) : null,
    trk: state.lastTrk != null ? toMag(state.lastTrk) : null,
    alt: altFt != null ? cAlt(altFt) : null,
    agl: aglNow != null ? cAlt(aglNow) : null,
    vs: state.lastVs,
    lat: c.latitude.toFixed(4), lon: c.longitude.toFixed(4)
  });
  renderWidgets();

  const ll = [c.latitude, c.longitude];
  if (!posMarker) {
    posMarker = L.marker(ll, { icon: planeIcon(0) }).addTo(map);
    posAccCircle = L.circle(ll, { radius:c.accuracy || 0, color:'#06b6d4', weight:1, fillOpacity:.08 }).addTo(map);
  } else {
    posMarker.setLatLng(ll);
    posAccCircle.setLatLng(ll).setRadius(c.accuracy || 0);
  }
  if (state.followMode) recenterFollow(ll);
  // ícone do avião: rumo + rotação do mapa (o plugin mantém os marcadores "em pé").
  // No track-up isso dá ~0 = avião travado pra cima; no norte-acima mostra o rumo real.
  posMarker.setIcon(planeIcon((state.lastTrk || 0) + (state.curBearing || 0)));

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

function isPortrait() { return window.innerHeight >= window.innerWidth; }
function updateOrient() {
  const p = isPortrait();
  document.body.classList.toggle('is-portrait', p);
  document.body.classList.toggle('is-landscape', !p);
}
// recentra o mapa no avião; modo 2 (track-up) gira o mapa pela proa
function recenterFollow(ll) {
  if (!map) return;
  const z = map.getZoom();          // mantém o zoom escolhido pelo piloto (sem zoom automático)
  if (map.setBearing) {
    if (state.followMode === 2) {
      // proa pra cima: usa o rumo (já vem só com movimento real do onPos)
      if (state.lastTrk != null) state.curBearing = -state.lastTrk;
      map.setBearing(state.curBearing || 0);
    } else {
      state.curBearing = 0;
      map.setBearing(0);
    }
  }
  map.setView(ll, z, { animate: false });
}
function updateFollowBtn() {
  const b = $('#btnFollow'); if (!b) return;
  const i = b.querySelector('i');
  b.classList.toggle('active', state.followMode > 0);
  if (state.followMode === 2) { i.className = 'fas fa-location-arrow'; b.title = 'Seguindo: proa pra cima — toque p/ livre'; }
  else if (state.followMode === 1) { i.className = 'fas fa-crosshairs'; b.title = 'Seguindo: norte acima — toque p/ proa pra cima'; }
  else { i.className = 'fas fa-crosshairs'; b.title = 'Livre — toque p/ seguir'; }
}

function planeIcon(heading) {
  return L.divIcon({
    className: '',
    html: `<div class="plane-icon" style="transform:rotate(${heading}deg)">${PLANE_SVG}</div>`,
    iconSize: [42, 42], iconAnchor: [21, 21]
  });
}

/* ---------- Elevação do terreno (p/ altura AGL) ---------- */
let terrainBusy = false, lastTerrainPt = null, lastTerrainTime = 0;
function maybeQueryTerrain(lat, lon) {
  if (terrainBusy) return;
  const now = Date.now();
  if (lastTerrainPt) {
    const d = haversineNM(lastTerrainPt, { lat, lon });
    if (d < 0.08 && (now - lastTerrainTime) < 12000) return;   // ~<150 m e <12 s: reaproveita
  }
  terrainBusy = true;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${lat.toFixed(5)},${lon.toFixed(5)}`, { signal: ctrl.signal })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(j => {
      const e = j && j.results && j.results[0] && j.results[0].elevation;
      if (typeof e === 'number') { state.terrainM = e; lastTerrainPt = { lat, lon }; lastTerrainTime = Date.now(); }
    })
    .catch(() => {})
    .then(() => { clearTimeout(to); terrainBusy = false; });
}
function aglFt() {
  if (state.lastAltM == null || state.terrainM == null) return null;
  return (state.lastAltM - state.terrainM) * 3.28084;
}
function fmtClock(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ---------- Nav banner (to next waypoint) ---------- */
// desvio lateral (cross-track) em NM da perna start→end, na posição pos. + = direita do curso
function crossTrackNm(start, end, pos) {
  if (!start || !end || !pos) return 0;
  const d13 = haversineNM(start, pos) / R_NM;             // distância angular
  const th13 = toRad(bearingTrue(start, pos));
  const th12 = toRad(bearingTrue(start, end));
  return Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(th13 - th12)))) * R_NM;
}

// gera a rosa dos ventos do HSI (uma vez)
function buildHsiCard() {
  const card = $('#hsi-card');
  if (!card || card.childNodes.length) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  for (let a = 0; a < 360; a += 5) {
    const maj = a % 10 === 0;
    const rad = (a - 90) * Math.PI / 180;
    const r1 = 93, r2 = maj ? 84 : 88;
    const ln = document.createElementNS(SVGNS, 'line');
    ln.setAttribute('x1', (100 + r1 * Math.cos(rad)).toFixed(1));
    ln.setAttribute('y1', (100 + r1 * Math.sin(rad)).toFixed(1));
    ln.setAttribute('x2', (100 + r2 * Math.cos(rad)).toFixed(1));
    ln.setAttribute('y2', (100 + r2 * Math.sin(rad)).toFixed(1));
    ln.setAttribute('class', 'hsi-tick' + (maj ? ' maj' : ''));
    card.appendChild(ln);
    if (a % 30 === 0) {
      const letter = { 0:'N', 90:'E', 180:'S', 270:'W' }[a];
      const t = document.createElementNS(SVGNS, 'text');
      const rt = 74, tx = 100 + rt * Math.cos(rad), ty = 100 + rt * Math.sin(rad);
      t.setAttribute('x', tx.toFixed(1));
      t.setAttribute('y', (ty + 4).toFixed(1));
      t.setAttribute('transform', `rotate(${a} ${tx.toFixed(1)} ${ty.toFixed(1)})`);
      t.setAttribute('class', letter ? 'hsi-cardltr' : 'hsi-cardnum');
      t.textContent = letter || String(a / 10);
      card.appendChild(t);
    }
  }
}

function updateHSI(d) {
  const card = $('#hsi-card'); if (!card) return;
  $('#hsi-card').setAttribute('transform', `rotate(${(-d.trkMag).toFixed(1)} 100 100)`);
  $('#hsi-course').setAttribute('transform', `rotate(${(d.courseMag - d.trkMag).toFixed(1)} 100 100)`);
  // ponteiro de marcação (bearing direto ao waypoint)
  if (d.brgMag != null) $('#hsi-brg').setAttribute('transform', `rotate(${(d.brgMag - d.trkMag).toFixed(1)} 100 100)`);
  // bandeira TO/FROM (FROM se já passou o waypoint)
  const delta = ((d.brgMag - d.courseMag + 540) % 360) - 180;
  $('#hsi-toflag').setAttribute('transform', Math.abs(delta) <= 90 ? '' : 'rotate(180 100 100)');
  const FULL = 2, MAXPX = 38;                              // escala cheia = 2 NM
  const defl = Math.max(-1, Math.min(1, (d.xtk || 0) / FULL)) * MAXPX;
  $('#hsi-cdi').setAttribute('transform', `translate(${(-defl).toFixed(1)} 0)`);  // dir do curso → barra à esq
  const lb = $('#hsi-trk'); if (lb) lb.textContent = d.trkMag != null ? fmtDeg(d.trkMag) : '---';  // lubber
  // métricas de navegação (gs/trk/alt/agl/vs/lat/lon vêm do onPos — só mescla as de rota)
  state.navData = state.navData || {};
  Object.assign(state.navData, {
    dist: cDist(d.dist),
    crs: d.courseMag, rmo: d.brgMag,
    ete: fmtHM(d.eteH), eta: d.eta,
    xtk: cDist(Math.abs(d.xtk)), xtkSide: d.xtk > 0.02 ? '▶' : (d.xtk < -0.02 ? '◀' : '')
  });
  renderWidgets();
}

function updateNavBanner() {
  const target = state.gotoTarget
    || (state.route.length ? state.route[Math.min(state.activeNavIdx, state.route.length - 1)] : null);
  const isNav = !!target, wasNav = document.body.classList.contains('nav-on');
  document.body.classList.toggle('nav-on', isNav);
  if (wasNav !== isNav && map) setTimeout(() => { map.invalidateSize({ animate: false }); if (state.followMode && state.pos) recenterFollow([state.pos.lat, state.pos.lon]); }, 80);
  if (!target) {
    if (gotoLine) gotoLine.setLatLngs([]);
    if (state.navData) { Object.assign(state.navData, { dist:null, crs:null, rmo:null, ete:null, eta:null, xtk:null, xtkSide:'' }); renderWidgets(); }
    return;
  }
  const nm = target.name;
  $('#nav-to-name').textContent = nm; const ht = $('#hsi-to'); if (ht) ht.textContent = nm;

  if (!state.pos) {                 // sem GPS
    ['nav-gs','nav-agl','nav-dist','nav-brg','nav-eta'].forEach(id => { const e = $('#' + id); if (e) e.textContent = '--'; });
    $('#nav-ete').textContent = 'GPS?';
    const lb = $('#hsi-trk'); if (lb) lb.textContent = '---';
    state.navData = state.navData || {};
    Object.assign(state.navData, { dist:null, crs:null, rmo:null, ete:'GPS?', eta:null, xtk:null, xtkSide:'' });
    renderWidgets();
    if (state.gotoTarget) gotoLine.setLatLngs([]);
    return;
  }

  // início da perna (p/ curso e desvio): direct-to = ativação; rota = waypoint anterior
  let legStart = state.gotoTarget ? state.navStart
    : (state.activeNavIdx > 0 ? state.route[state.activeNavIdx - 1] : null);
  legStart = legStart || state.pos;

  const dist = haversineNM(state.pos, target);
  const brgMag = toMag(bearingTrue(state.pos, target));
  const courseTrue = bearingTrue(legStart, target);
  const trkTrue = (state.lastTrk != null) ? state.lastTrk : courseTrue;
  const xtk = crossTrackNm(legStart, target, state.pos);
  const agl = aglFt();
  const gsRaw = state.lastGsKt;
  const gsForEte = (gsRaw && gsRaw > 5) ? gsRaw : (Number(state.cfg.tas) || 110);
  const eteH = dist / gsForEte;
  const eta = isFinite(eteH) ? fmtClock(new Date(Date.now() + eteH * 3600000)) : '--';

  // painel (paisagem)
  $('#nav-gs').textContent = gsRaw != null ? Math.round(cSpeed(gsRaw)) : '--';
  $('#nav-agl').textContent = agl != null ? Math.round(cAlt(agl)) : '--';
  $('#nav-dist').textContent = cDist(dist).toFixed(1);
  $('#nav-brg').textContent = fmtDeg(brgMag);
  $('#nav-ete').textContent = fmtHM(eteH);
  $('#nav-eta').textContent = eta;

  // HSI (retrato)
  updateHSI({ trkTrue, trkMag: toMag(trkTrue), courseTrue, courseMag: toMag(courseTrue), brgMag, xtk, dist, agl, gsRaw, eteH, eta });

  if (state.gotoTarget) gotoLine.setLatLngs([[state.pos.lat, state.pos.lon], [target.lat, target.lon]]);
  if (!state.gotoTarget && dist < 0.5 && state.activeNavIdx < state.route.length - 1) { state.activeNavIdx++; state.navStart = null; }
}

/* ---------- Widgets editáveis/arrastáveis (HSI + HUD) ---------- */
const HSI_METRICS = {
  gs:{l:'GS',u:()=>uSpeed()}, trk:{l:'PROA',u:()=>'°'}, alt:{l:'ALT',u:()=>uAlt()},
  agl:{l:'AGL',u:()=>uAlt()}, vs:{l:'V.VERT',u:()=>state.cfg.altU === 'm' ? 'm/s' : 'fpm'},
  dist:{l:'DIST',u:()=>uDist()}, crs:{l:'CURSO',u:()=>'°'}, rmo:{l:'RUMO',u:()=>'°'},
  ete:{l:'ETE',u:()=>''}, eta:{l:'ETA',u:()=>''}, xtk:{l:'DESVIO',u:()=>''},
  lat:{l:'LAT',u:()=>''}, lon:{l:'LON',u:()=>''}
};
const HSI_METRIC_ORDER = ['gs','trk','alt','agl','vs','dist','crs','rmo','ete','eta','xtk','lat','lon'];
const DEFAULT_HSI_WIDGETS = [
  {m:'gs',x:.13,y:.84},{m:'dist',x:.38,y:.84},{m:'crs',x:.63,y:.84},{m:'agl',x:.87,y:.84},
  {m:'ete',x:.2,y:.94},{m:'eta',x:.5,y:.94},{m:'xtk',x:.8,y:.94}
];
const DEFAULT_HUD_WIDGETS = [
  {m:'gs',x:.28,y:.03},{m:'trk',x:.55,y:.03},{m:'alt',x:.82,y:.03}
];
const WIDGET_LAYERS = {
  hsiWidgets: { cont:'#hsi-widgets', bounds:'#hsi', def:DEFAULT_HSI_WIDGETS },
  hudWidgets: { cont:'#hud-widgets', bounds:'#hud-widgets', def:DEFAULT_HUD_WIDGETS }
};
function getWidgets(list) { if (!state[list]) state[list] = JSON.parse(JSON.stringify(WIDGET_LAYERS[list].def)); return state[list]; }
function saveWidgets(list) { LS.set(list, state[list]); }

function metricStr(m) {
  const d = state.navData || {};
  const map = {
    gs: d.gs != null ? Math.round(d.gs) : '--', dist: d.dist != null ? d.dist.toFixed(1) : '--',
    crs: d.crs != null ? fmtDeg(d.crs) : '--', rmo: d.rmo != null ? fmtDeg(d.rmo) : '--',
    trk: d.trk != null ? fmtDeg(d.trk) : '--', agl: d.agl != null ? Math.round(d.agl) : '--',
    alt: d.alt != null ? Math.round(d.alt) : '--', ete: d.ete || '--', eta: d.eta || '--',
    xtk: d.xtk != null ? d.xtk.toFixed(2) : '--',
    vs: d.vs != null ? (state.cfg.altU === 'm' ? (d.vs * 0.00508).toFixed(1) : String(Math.round(d.vs / 10) * 10)) : '--',
    lat: d.lat || '--', lon: d.lon || '--'
  };
  const unit = m === 'xtk' ? (d.xtkSide || '') : (HSI_METRICS[m] ? HSI_METRICS[m].u() : '');
  return [map[m] != null ? map[m] : '--', unit];
}

function buildWidgets(list) {
  const L = WIDGET_LAYERS[list], cont = $(L.cont); if (!cont) return;
  cont.innerHTML = '';
  getWidgets(list).forEach((w, i) => {
    const el = document.createElement('div');
    el.className = 'hsi-w'; el.dataset.i = i; el.dataset.list = list;
    el.style.left = (w.x * 100) + '%'; el.style.top = (w.y * 100) + '%';
    el.innerHTML = `<span class="hsi-w-l">${HSI_METRICS[w.m] ? HSI_METRICS[w.m].l : '?'}</span><b class="hsi-w-v">--</b><span class="hsi-w-u"></span>`;
    attachWidget(el, list, i);
    cont.appendChild(el);
  });
  renderWidgets();
}
function buildHsiWidgets() { buildWidgets('hsiWidgets'); buildWidgets('hudWidgets'); }

function renderWidgets() {
  document.querySelectorAll('.hsi-w').forEach(el => {
    const list = el.dataset.list, i = +el.dataset.i, w = state[list] && state[list][i]; if (!w) return;
    const [v, u] = metricStr(w.m);
    el.querySelector('.hsi-w-v').textContent = v;
    el.querySelector('.hsi-w-u').textContent = u;
  });
  renderVsi();
}
const renderHsiWidgets = renderWidgets;

// variômetro gráfico (barra de velocidade vertical)
function renderVsi() {
  const fill = $('#vsiFill'), valEl = $('#vsiVal'); if (!fill) return;
  const vs = state.lastVs, SCALE = 2000;          // fundo de escala ±2000 fpm
  const v = vs == null ? 0 : Math.max(-SCALE, Math.min(SCALE, vs));
  const pct = (v / SCALE) * 45;                   // % a partir do centro
  if (v >= 0) { fill.style.top = (50 - pct) + '%'; fill.style.height = pct + '%'; fill.classList.remove('down'); }
  else { fill.style.top = '50%'; fill.style.height = (-pct) + '%'; fill.classList.add('down'); }
  if (valEl) {
    if (vs == null) valEl.textContent = '--';
    else if (state.cfg.altU === 'm') valEl.textContent = (vs >= 0 ? '+' : '') + (vs * 0.00508).toFixed(1);
    else valEl.textContent = (vs >= 0 ? '+' : '') + (Math.round(vs / 50) * 50);
    valEl.style.color = (vs != null && vs < -50) ? 'var(--accent-orange)' : 'var(--accent-green)';
  }
}

function attachWidget(el, list, i) {
  const boundsSel = WIDGET_LAYERS[list].bounds;
  let lp = null, dragMode = false, sx = 0, sy = 0, moved = false, pid = null;

  // SEGURAR (long-press) p/ arrastar · TOCAR p/ trocar a informação.
  // Os listeners de movimento ficam no document: assim o arrasto funciona mesmo
  // passando o dedo POR CIMA DO MAPA (onde a captura de ponteiro do chip falha).
  function onMove(e) {
    if (pid !== null && e.pointerId !== pid) return;
    if (!moved && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) {
      moved = true;
      if (!dragMode) clearTimeout(lp);   // moveu antes de "armar" → trata como gesto/scroll, não arrasta
    }
    if (!dragMode) return;
    if (e.cancelable) e.preventDefault();
    const r = $(boundsSel).getBoundingClientRect();
    const fx = Math.max(.04, Math.min(.96, (e.clientX - r.left) / r.width));
    const fy = Math.max(.015, Math.min(.97, (e.clientY - r.top) / r.height));
    state[list][i].x = fx; state[list][i].y = fy;
    el.style.left = (fx * 100) + '%'; el.style.top = (fy * 100) + '%';
  }
  function cleanup() {
    clearTimeout(lp);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    el.classList.remove('dragging');
    pid = null;
  }
  function onUp(e) {
    if (pid !== null && e.pointerId !== pid) return;
    const wasDrag = dragMode;
    cleanup();
    if (wasDrag) saveWidgets(list);                 // soltou após arrastar
    else if (!moved) openMetricPicker(list, i);     // toque limpo → seletor
    dragMode = false;
  }
  function onCancel(e) {
    if (pid !== null && e.pointerId !== pid) return;
    cleanup(); dragMode = false;
  }
  el.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; moved = false; dragMode = false;
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    lp = setTimeout(() => {
      if (moved) return;                            // já saiu do lugar → não arma arrasto
      dragMode = true; el.classList.add('dragging');
      if (navigator.vibrate) navigator.vibrate(15);
    }, 320);
  });
}

function openMetricPicker(list, i) {
  const isAdd = i === -1;
  const ov = document.createElement('div'); ov.className = 'picker-ov';
  let html = `<div class="picker"><h3>${isAdd ? 'Adicionar informação' : 'Escolher informação'}</h3><div class="picker-grid">`;
  HSI_METRIC_ORDER.forEach(m => { html += `<button data-m="${m}">${HSI_METRICS[m].l}</button>`; });
  html += '</div>';
  if (!isAdd) html += '<button class="picker-del" data-del="1"><i class="fas fa-eye-slash"></i> Esconder este</button>';
  html += '<button class="picker-cancel">Cancelar</button></div>';
  ov.innerHTML = html;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  setTimeout(() => ov.addEventListener('click', e => { if (e.target === ov) close(); }), 80);
  ov.querySelector('.picker-cancel').addEventListener('click', close);
  ov.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
    if (isAdd) state[list].push({ m: b.dataset.m, x: .5, y: list === 'hudWidgets' ? .14 : .55 });
    else state[list][i].m = b.dataset.m;
    saveWidgets(list); buildWidgets(list); close();
  }));
  const del = ov.querySelector('[data-del]');
  if (del) del.addEventListener('click', () => { state[list].splice(i, 1); saveWidgets(list); buildWidgets(list); close(); });
}

/* ===================================================================
   PEDIDOS — chat de mudanças do app (envia p/ GitHub Issues)
   =================================================================== */
const PED_REPO = 'rafaelcorvino-lgtm/agronav';

function savePedidos() { LS.set('pedidos', state.pedidos); }

function renderPedidos() {
  const box = $('#pedList'); if (!box) return;
  if (!state.pedidos.length) {
    box.innerHTML = '<p class="ped-empty">Nenhum pedido ainda. Escreva abaixo o que você quer mudar. 👇</p>';
    return;
  }
  box.innerHTML = '';
  state.pedidos.forEach(p => {
    const el = document.createElement('div');
    el.className = 'ped-msg' + (p.cloud ? ' sent' : '');
    el.innerHTML =
      `<div class="ped-text"></div>` +
      `<div class="ped-meta"><span class="ped-status">${p.cloud ? '<i class="fas fa-check"></i> enviado' : '<i class="fas fa-clock"></i> enviando…'}</span>` +
      `<button class="ped-del" title="Apagar"><i class="fas fa-xmark"></i></button></div>`;
    el.querySelector('.ped-text').textContent = p.text;
    el.querySelector('.ped-del').addEventListener('click', () => {
      state.pedidos = state.pedidos.filter(x => x.id !== p.id); savePedidos(); renderPedidos();
    });
    box.appendChild(el);
  });
  box.scrollTop = box.scrollHeight;
}

function addPedido() {
  const inp = $('#pedInput'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  const id = Date.now();
  state.pedidos.push({ id, text, sent: false, cloud: false });
  savePedidos(); inp.value = ''; renderPedidos();
  pushPedidoCloud(text, id);              // sobe pra nuvem (Claude lê direto)
  toast(pedRtdb ? 'Pedido enviado ✔' : 'Pedido salvo (sobe ao reconectar)');
}

/* ---- Nuvem dos pedidos (Firebase RTDB, grupo compartilhado) ---- */
const NAVE_GROUP = 'nave-corvino';
let pedRtdb = null;
function pedDevId() { let d = LS.get('devid', null); if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); LS.set('devid', d); } return d; }
function initPedCloud() {
  try {
    if (typeof firebase === 'undefined' || !window.firebaseConfig) return;
    firebase.initializeApp(window.firebaseConfig);
    pedRtdb = firebase.database();
    pedRtdb.ref('grupos/' + NAVE_GROUP + '/chatlog').on('value', snap => renderPedHist(snap.val() || {}));
    pedRtdb.ref('.info/connected').on('value', s => { if (s.val()) flushPedidosCloud(); });
  } catch (e) { /* offline: segue local */ }
}
function pushPedidoCloud(text, localId) {
  if (!pedRtdb) return;
  try {
    pedRtdb.ref('grupos/' + NAVE_GROUP + '/chatlog').push({
      type: 'pedido', text: text, done: false, ver: APP_VERSION,
      ts: Date.now(), when: new Date().toISOString().slice(0, 19).replace('T', ' '), dev: pedDevId(), localId: localId || null
    }).then(() => { const p = state.pedidos.find(x => x.id === localId); if (p) { p.cloud = true; savePedidos(); } }).catch(() => {});
  } catch (_) {}
}
function flushPedidosCloud() { if (pedRtdb) state.pedidos.filter(p => !p.cloud).forEach(p => pushPedidoCloud(p.text, p.id)); }
function reloadPedHist() { if (pedRtdb) pedRtdb.ref('grupos/' + NAVE_GROUP + '/chatlog').get().then(s => renderPedHist(s.val() || {})).catch(() => {}); }
function renderPedHist(data) {
  const box = $('#pedHist'); if (!box) return;
  const items = Object.values(data || {}).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (!items.length) { box.innerHTML = '<p class="ped-empty">Sem histórico ainda. Seus pedidos e as respostas do Claude aparecem aqui.</p>'; return; }
  box.innerHTML = '';
  items.forEach(it => {
    const el = document.createElement('div');
    const body = document.createElement('div'); body.className = 'ph-body';
    const when = document.createElement('div'); when.className = 'ph-when';
    if (it.type === 'update') {
      el.className = 'ped-hist upd';
      const h = document.createElement('div'); h.className = 'ph-head';
      h.innerHTML = '<i class="fas fa-wrench"></i> '; h.appendChild(document.createTextNode('Atualização' + (it.ver ? ' — ' + it.ver : '')));
      body.textContent = it.changes || ''; when.textContent = it.when || '';
      el.appendChild(h); el.appendChild(body); el.appendChild(when);
    } else {
      el.className = 'ped-hist' + (it.done ? ' done' : '');
      body.textContent = '📝 ' + (it.text || it.q || '');
      when.textContent = (it.done ? '✓ feito · ' : '') + (it.when || '');
      el.appendChild(body); el.appendChild(when);
    }
    box.appendChild(el);
  });
  box.scrollTop = box.scrollHeight;
}

function copyPedidos() {
  if (!state.pedidos.length) { toast('Nada para copiar'); return; }
  const txt = state.pedidos.map(p => '- ' + p.text).join('\n');
  const done = () => toast('Pedidos copiados');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(() => { prompt('Copie os pedidos:', txt); });
  } else { prompt('Copie os pedidos:', txt); }
}

function clearSentPedidos() {
  const n = state.pedidos.filter(p => p.cloud).length;
  if (!n) { toast('Nenhum enviado para limpar'); return; }
  state.pedidos = state.pedidos.filter(p => !p.cloud); savePedidos(); renderPedidos();
  toast(n + ' enviado(s) removido(s) desta tela (o Claude ainda os vê na nuvem)');
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
/* ---- Editar um waypoint da rota (renomear / ajustar coordenadas; ex.: pista não homologada) ---- */
let editingWpIdx = -1;
function editWaypoint(i) {
  const w = state.route[i]; if (!w) return;
  editingWpIdx = i;
  $('#wpEditName').value = w.name || '';
  $('#wpEditLat').value = w.lat;
  $('#wpEditLon').value = w.lon;
  $('#wpEditModal').classList.remove('hidden');
  setTimeout(() => $('#wpEditName').focus(), 50);
}
function closeWpEdit() { editingWpIdx = -1; $('#wpEditModal').classList.add('hidden'); }
function saveWpEdit() {
  if (editingWpIdx < 0) return closeWpEdit();
  const name = $('#wpEditName').value.trim();
  const lat = +$('#wpEditLat').value, lon = +$('#wpEditLon').value;
  if (!name) { toast('Dê um nome ao ponto', true); return; }
  if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('Coordenadas inválidas', true); return; }
  state.route[editingWpIdx] = { ...state.route[editingWpIdx], name, lat, lon };
  LS.set('route', state.route);
  closeWpEdit();
  drawRouteOnMap(); renderRoute();
  toast('Ponto atualizado');
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
      + `<td>${i>0?cDist(dist).toFixed(1):'—'}</td><td>${i>0?fmtHM(t):'—'}</td>`
      + `<td>${i>0?cFuel(fuel).toFixed(0):'—'}</td>`
      + `<td class="rt-acts"><button class="row-btn" data-edit="${i}" title="Editar"><i class="fas fa-pen"></i></button>`
      + `<button class="row-btn" data-rm="${i}" title="Remover"><i class="fas fa-xmark"></i></button></td>`;
    tb.appendChild(tr);
  });
  $('#rt-total-dist').textContent = cDist(totDist).toFixed(1);
  $('#rt-total-ete').textContent = fmtHM(totTime);
  $('#rt-total-fuel').textContent = cFuel(totFuel).toFixed(0);

  tb.querySelectorAll('[data-rm]').forEach(b =>
    b.addEventListener('click', () => removeWaypoint(+b.dataset.rm)));
  tb.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => editWaypoint(+b.dataset.edit)));

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
  $('#cfg-speedU').value = state.cfg.speedU || 'kt';
  $('#cfg-distU').value = state.cfg.distU || 'nm';
  $('#cfg-altU').value = state.cfg.altU || 'ft';
  $('#cfg-fuelU').value = state.cfg.fuelU || 'l';
  $('#routeGS').value = state.cfg.tas;
  $('#routeFF').value = state.cfg.ff;
  $('#routeVar').value = state.cfg.var;
  const vl = $('#appVersionLine'); if (vl) vl.textContent = 'Versão ' + APP_VERSION;
}
function saveCfg() {
  state.cfg = {
    tail:$('#cfg-tail').value.trim(), model:$('#cfg-model').value.trim(),
    tas:+$('#cfg-tas').value || 110, ff:+$('#cfg-ff').value || 120,
    var:+$('#cfg-var').value || 0, area:$('#cfg-area').value,
    speedU:$('#cfg-speedU').value, distU:$('#cfg-distU').value,
    altU:$('#cfg-altU').value, fuelU:$('#cfg-fuelU').value
  };
  LS.set('cfg', state.cfg);
  loadCfgUI(); applyUnits(); drawFieldsOnMap(); renderFields();
  toast('Configurações salvas');
}

// atualiza os rótulos de unidade em todo o app
function applyUnits() {
  const set = (id, txt) => { const e = $('#' + id); if (e) e.textContent = txt; };
  set('u-gs', uSpeed()); set('u-alt', uAlt());
  set('u-nav-gs', uSpeed()); set('u-nav-agl', uAlt()); set('u-nav-dist', uDist());
  set('th-dist', 'Dist (' + uDist() + ')'); set('th-fuel', 'Comb (' + uFuel() + ')');
  renderRoute();
  updateNavBanner();
  renderHsiWidgets();
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
  $('#btnFollow').addEventListener('click', () => {
    state.followMode = (state.followMode + 1) % 3;   // 1→2→0→1
    updateFollowBtn();
    if (state.followMode === 0) { if (map.setBearing) map.setBearing(0); state.curBearing = 0; toast('Mapa livre'); }
    else { if (state.pos) recenterFollow([state.pos.lat, state.pos.lon]); toast(state.followMode === 2 ? 'Proa pra cima — o mapa gira ao se mover' : 'Norte acima'); }
  });
  updateFollowBtn();
  $('#btnLayer').addEventListener('click', switchLayer);
  $('#navClose').addEventListener('click', clearGoto);
  $('#hsiClose').addEventListener('click', clearGoto);
  $('#hsiAdd').addEventListener('click', () => openMetricPicker('hsiWidgets', -1));
  { const ha = $('#hudAdd'); if (ha) ha.addEventListener('click', () => openMetricPicker('hudWidgets', -1)); }
  // Pedidos (chat de mudanças)
  $('#pedAdd').addEventListener('click', addPedido);
  $('#pedInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addPedido(); } });
  $('#pedCopy').addEventListener('click', copyPedidos);
  $('#pedClear').addEventListener('click', clearSentPedidos);
  const phr = $('#pedHistReload'); if (phr) phr.addEventListener('click', reloadPedHist);
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
  // preencher o formulário de adicionar com a posição atual (GPS)
  $('#btnWpGps').addEventListener('click', () => {
    if (!state.pos) { toast('Sem GPS ainda — aguarde o sinal', true); return; }
    $('#wpLat').value = state.pos.lat.toFixed(5);
    $('#wpLon').value = state.pos.lon.toFixed(5);
    if (!$('#wpName').value.trim()) $('#wpName').value = 'Pista ' + (state.route.length + 1);
    toast('Coordenadas preenchidas com o GPS');
  });
  // modal de edição de ponto
  $('#wpEditSave').addEventListener('click', saveWpEdit);
  $('#wpEditCancel').addEventListener('click', closeWpEdit);
  $('#wpEditModal').addEventListener('click', e => { if (e.target.id === 'wpEditModal') closeWpEdit(); });
  $('#wpEditGps').addEventListener('click', () => {
    if (!state.pos) { toast('Sem GPS ainda — aguarde o sinal', true); return; }
    $('#wpEditLat').value = state.pos.lat.toFixed(5);
    $('#wpEditLon').value = state.pos.lon.toFixed(5);
    toast('Coordenadas atualizadas com o GPS');
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
  $('#btnSaveUnits').addEventListener('click', saveCfg);
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
  aptBtn.innerHTML = '<i class="fas fa-plane-up"></i>';
  aptBtn.addEventListener('click', () => {
    state.showAirports = !state.showAirports;
    aptBtn.classList.toggle('active', state.showAirports);
    renderAirportMarkers();
    toast(state.showAirports ? 'Aeródromos no mapa: ligado (dê zoom p/ ver)' : 'Aeródromos no mapa: desligado');
  });
  $('.map-controls').appendChild(aptBtn);

  // botão liga/desliga espaços aéreos (CTR/TMA/CTA/P/R/D)
  const aspBtn = document.createElement('button');
  aspBtn.className = 'map-btn' + (state.showAirspace ? ' active' : '');
  aspBtn.id = 'btnAirspace'; aspBtn.title = 'Espaços aéreos (CTR/TMA/áreas P/R/D)';
  aspBtn.innerHTML = '<i class="fas fa-shield-halved"></i>';
  aspBtn.addEventListener('click', toggleAirspace);
  $('.map-controls').appendChild(aspBtn);
}

/* ===================================================================
   INIT
   =================================================================== */
function init() {
  initMap();
  addDrawButton();
  buildHsiCard();
  buildHsiWidgets();
  wire();
  wireIcaoLookup();
  loadCfgUI();
  applyUnits();
  renderRoute();
  renderFields();
  loadAirportsOnline();
  loadAirspace();
  // run E6B defaults
  calcWindTriangle(); calcRunwayWind(); calcTSD(); calcDensityAlt(); calcConvert();
  // GPS automático ao abrir
  if (state.watchId === null) toggleGPS();
  initPedCloud();                     // nuvem dos pedidos (Firebase)
}
document.addEventListener('DOMContentLoaded', init);

})();
