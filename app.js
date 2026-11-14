/* Fobos Mini — web app pemantauan (Leaflet + OpenStreetMap + MQTT over WebSocket).
 * Tanpa server: semua berjalan di browser. Raw GNSS/IMU selama sesi disimpan di IndexedDB.
 * Format pesan: lihat PANDUAN.md bagian "Protokol". */
'use strict';

// ------------------------------------------------------------------ konfigurasi
const DEF = { mode: 'cloud', cloudUrl: 'wss://mqtt.flespi.io:443', cloudUser: '', cloudPass: '', remember: false, autoZip: true,
  localUrl: '', prefix: 'fobos', vibTh: '0.5,1,2', shockTh: '2', segLen: '20', refAcc: '3.3', wxOn: true, bmkgAdm4: '', osmOn: true };
function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('fobos.cfg') || '{}'); } catch (e) { c = {}; }
  const cfg = Object.assign({}, DEF, c);
  if (!cfg.localUrl && location.protocol === 'http:' && location.hostname) cfg.localUrl = `ws://${location.hostname}:9001`;
  if (!c.mode && location.protocol === 'http:') cfg.mode = 'local';
  return cfg;
}
function saveCfg(c) {
  const s = Object.assign({}, c); if (!s.remember) { s.cloudPass = ''; s.cloudUser = ''; }   // token/password hanya disimpan bila diizinkan
  try { localStorage.setItem('fobos.cfg', JSON.stringify(s)); } catch (e) { /* penyimpanan tidak tersedia */ }
}
let CFG = loadCfg();
let sessionPass = CFG.cloudPass;   // password/token yang tidak disimpan tetap berlaku selama tab terbuka
let sessionUser = CFG.cloudUser;

// ------------------------------------------------------------------ util
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), ms); }
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function utcStamp(d = new Date()) { return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`; }
function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function fmtDur(s) { s = Math.max(0, Math.round(s)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; }
function ranges(missing) {     // [3,4,5,9] -> "3-5, 9"
  const out = []; let a = null, b = null;
  for (const x of missing) { if (a === null) { a = b = x; } else if (x === b + 1) b = x; else { out.push(a === b ? `${a}` : `${a}-${b}`); a = b = x; } }
  if (a !== null) out.push(a === b ? `${a}` : `${a}-${b}`);
  return out.join(', ');
}

// ------------------------------------------------------------------ penyimpanan (IndexedDB, cadangan memori)
const Store = {
  db: null, mem: { chunks: [], sessions: new Map() }, ok: false,
  async open() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('fobos-mini', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          const c = d.createObjectStore('chunks', { keyPath: 'k', autoIncrement: true });
          c.createIndex('sess', 'sess');
          d.createObjectStore('sessions', { keyPath: 'sess' });
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      this.ok = true;
    } catch (e) { console.warn('IndexedDB tidak tersedia, memakai memori', e); this.ok = false; }
  },
  _tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, mode); const st = tx.objectStore(store);
      let out; const r = fn(st); if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  },
  async addChunk(c) {
    if (!this.ok) { this.mem.chunks.push(c); return; }
    try { await this._tx('chunks', 'readwrite', (s) => s.add(c)); }
    catch (e) { this.mem.chunks.push(c); console.warn('gagal simpan ke IndexedDB (penuh?)', e); }
  },
  async chunks(sess) {
    const memc = this.mem.chunks.filter((c) => c.sess === sess);
    if (!this.ok) return memc;
    const arr = await this._tx('chunks', 'readonly', (s) => s.index('sess').getAll(sess));
    return (arr || []).concat(memc);
  },
  async putSession(r) {
    if (!this.ok) { this.mem.sessions.set(r.sess, r); return; }
    await this._tx('sessions', 'readwrite', (s) => s.put(r));
  },
  async getSession(sess) {
    if (!this.ok) return this.mem.sessions.get(sess);
    return this._tx('sessions', 'readonly', (s) => s.get(sess));
  },
  async sessions() {
    if (!this.ok) return [...this.mem.sessions.values()];
    return (await this._tx('sessions', 'readonly', (s) => s.getAll())) || [];
  },
  async deleteSession(sess) {
    this.mem.chunks = this.mem.chunks.filter((c) => c.sess !== sess); this.mem.sessions.delete(sess);
    if (!this.ok) return;
    const keys = await this._tx('chunks', 'readonly', (s) => s.index('sess').getAllKeys(sess));
    await this._tx('chunks', 'readwrite', (s) => { for (const k of keys || []) s.delete(k); return null; });
    await this._tx('sessions', 'readwrite', (s) => s.delete(sess));
  },
};

// ------------------------------------------------------------------ peta
const map = L.map('map', { preferCanvas: true, zoomControl: false, maxZoom: 22 }).setView([-2.5, 118], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 22, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

const Q_INFO = { 4: ['RTK fix', '#1a9850'], 3: ['RTK float', '#f39c12'], 2: ['DGNSS', '#2c7fb8'], 1: ['Single', '#d73027'], 0: ['Tanpa fix', '#9e9e9e'] };
const V_COLORS = ['#1a9850', '#d9c800', '#f39c12', '#d73027'];
const DEV_COLORS = ['#1f5fbf', '#8e24aa', '#00897b', '#e65100', '#c2185b', '#455a64', '#6d4c41', '#0097a7'];
let colorMode = 'q';
function vibTh() { return CFG.vibTh.split(',').map(Number).filter((x) => !isNaN(x)).sort((a, b) => a - b); }
function vibClass(v) { if (v === null || v === undefined || isNaN(v)) return -1; const th = vibTh(); let i = 0; while (i < th.length && v >= th[i]) i++; return Math.min(i, V_COLORS.length - 1); }
const hasWx = () => typeof WX !== 'undefined';
function segColor(cls) { if (colorMode === 'w') return hasWx() ? WX.rainCol(cls) : '#9e9e9e'; return colorMode === 'q' ? Q_INFO[cls][1] : (cls < 0 ? '#9e9e9e' : V_COLORS[cls]); }
function wxCls(d, p) { return hasWx() ? WX.rainCls(WX.rainAt(d, p._t)) : -1; }
function ptClass(p) { return colorMode === 'q' ? p.q : vibClass(p.vib); }
function num(x) { if (x === '' || x === null || x === undefined) return null; const v = Number(x); return isFinite(v) ? v : null; }
function cfgNum(k, def) { const v = parseFloat(String(CFG[k]).replace(',', '.')); return isFinite(v) && v > 0 ? v : def; }
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const LEAP_S = 18;                       // GPS - UTC (detik), berlaku sejak 2017
function devTime(p) {                    // waktu perangkat (ms GPS) dari minggu + TOW
  if (p.wk && p.tow !== undefined && p.tow !== null) return p.wk * 604800000 + p.tow;
  return p.tow ?? Date.now();
}
function clockLabel(t) {                 // ms GPS -> jam lokal browser
  if (t > 1e11) return new Date(GPS_EPOCH_MS + t - LEAP_S * 1000).toLocaleTimeString('id-ID', { hour12: false });
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}
function haversine(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function fmtAcc(m) { if (m === null || m === undefined || !isFinite(m)) return '–'; return m < 1 ? (m * 100).toFixed(m < 0.1 ? 1 : 0) + ' cm' : m.toFixed(2) + ' m'; }
function fmtDist(m) { return m < 1000 ? m.toFixed(0) + ' m' : (m / 1000).toFixed(2) + ' km'; }
function newStats() { return { n: 0, nFix: 0, dist: 0, t0: null, t1: null, spdMax: 0, vibSum: 0, vibN: 0, vibMax: 0 }; }
function renderLegend() {
  let h = '';
  if (colorMode === 'q') for (const q of [4, 3, 2, 1, 0]) h += `<div class="lg"><i style="background:${Q_INFO[q][1]}"></i>${Q_INFO[q][0]}</div>`;
  else if (colorMode === 'w') {
    h += '<div class="small muted" style="margin-bottom:3px">curah hujan model di sepanjang jejak</div>';
    if (hasWx()) WX.RAIN.forEach((r) => { h += `<div class="lg"><i style="background:${r[1]}"></i>${r[0]}</div>`; });
    h += '<div class="lg"><i style="background:#d0d4d9"></i>belum ada data</div>';
  } else {
    if (colorMode === 's') h += `<div class="small muted" style="margin-bottom:3px">rata-rata getaran per ${cfgNum('segLen', 20)} m lintasan</div>`;
    const th = vibTh(); const lab = ['< ' + th[0]]; for (let i = 0; i < th.length - 1; i++) lab.push(`${th[i]}–${th[i + 1]}`); lab.push('≥ ' + th[th.length - 1]);
    lab.forEach((l, i) => { h += `<div class="lg"><i style="background:${V_COLORS[Math.min(i, 3)]}"></i>${l} m/s²</div>`; });
    h += '<div class="lg"><i style="background:#9e9e9e"></i>tanpa data</div>';
  }
  $('#legendBody').innerHTML = h;
}
document.querySelectorAll('#legend .seg button').forEach((b) => b.onclick = () => {
  colorMode = b.dataset.mode; document.querySelectorAll('#legend .seg button').forEach((x) => x.classList.toggle('on', x === b));
  renderLegend(); for (const d of devices.values()) redrawTrack(d);
  saveUi();
});

// ------------------------------------------------------------------ perangkat
const devices = new Map();
let selected = null;
const dn = (d) => (d && (d.label || d.id)) || '';
function dev(id, opt) {
  let d = devices.get(id);
  if (d) return d;
  const used = new Set([...devices.values()].map((x) => x.color));
  const color = DEV_COLORS.find((c) => !used.has(c)) || DEV_COLORS[devices.size % DEV_COLORS.length];
  d = { id, color, pts: [], segs: [], cur: null, marker: null, status: null, last: null, lastRx: 0, vib: [],
        sess: '', rec: null, pvtBuf: [], imuBuf: [], imu: null, imuRx: 0,
        shocks: [], st: newStats(), sg: null, lastShockT: -1e15, vibSec: null, replay: !!(opt && opt.replay) };
  d.layer = L.layerGroup().addTo(map);
  d.shockLayer = L.layerGroup().addTo(map);
  devices.set(id, d);
  if (!selected || (opt && opt.select)) selected = id;
  renderDevices();
  return d;
}
function updStats(d, p, prev, gap) {
  const st = d.st; const t = p._t;
  st.n++; if (p.q === 4) st.nFix++;
  if (st.t0 === null) st.t0 = t; st.t1 = t;
  if (prev && !gap && prev.q > 0) { const dd = haversine(prev, p); if (dd < 200) st.dist += dd; }
  if (p.spd != null && p.spd > st.spdMax && p.spd < 70) st.spdMax = p.spd;
  if (p.vib != null) { st.vibSum += p.vib; st.vibN++; if (p.vib > st.vibMax) st.vibMax = p.vib; }
}
// mode "Segmen": lintasan dipotong tiap N meter; warna = rata-rata indeks getaran titik-titik di dalamnya
function segAdd(d, p, prev, gap) {
  const L0 = cfgNum('segLen', 20);
  if (!d.sg || gap) d.sg = { pts: [[p.lat, p.lon]], len: 0, sum: 0, n: 0, fix: 0, cnt: 0, pl: null };
  else { d.sg.pts.push([p.lat, p.lon]); d.sg.len += haversine(prev, p); }
  const g = d.sg; g.cnt++; if (p.q === 4) g.fix++;
  if (p.vib != null) { g.sum += p.vib; g.n++; }
  const mean = g.n ? g.sum / g.n : null; const cls = vibClass(mean);
  const col = cls < 0 ? '#9e9e9e' : V_COLORS[cls];
  const tip = `Segmen ${g.len.toFixed(0)} m · getaran rata-rata ${mean === null ? '–' : mean.toFixed(2) + ' m/s²'} · RTK fix ${Math.round(100 * g.fix / g.cnt)}%`;
  if (!g.pl) { g.pl = L.polyline(g.pts, { color: col, weight: 9, opacity: 0.92, lineCap: 'butt' }).addTo(d.layer); g.pl.bindTooltip(tip, { sticky: true }); d.segs.push(g.pl); }
  else { g.pl.setLatLngs(g.pts); g.pl.setStyle({ color: col }); g.pl.setTooltipContent(tip); }
  if (g.len >= L0) d.sg = { pts: [[p.lat, p.lon]], len: 0, sum: 0, n: 0, fix: 0, cnt: 0, pl: null };
}
function addPoint(d, p) {
  if (p._t === undefined) p._t = devTime(p);
  d.pts.push(p);
  const prev = d.pts.length > 1 ? d.pts[d.pts.length - 2] : null;
  const gap = !prev || (Math.abs(p._t - prev._t) > 5000);
  updStats(d, p, prev, gap); p._d = d.st.dist;
  if (typeof TRIP !== 'undefined') TRIP.point(d, p);
  if (colorMode === 's') { segAdd(d, p, prev, gap); return; }
  const cls = colorMode === 'w' ? wxCls(d, p) : ptClass(p);
  if (!d.cur || d.cur.cls !== cls || gap) {
    const ll = (prev && !gap) ? [[prev.lat, prev.lon], [p.lat, p.lon]] : [[p.lat, p.lon]];
    const pl = L.polyline(ll, { color: segColor(cls), weight: 5, opacity: 0.9 }).addTo(d.layer);
    d.cur = { cls, pl }; d.segs.push(pl);
  } else d.cur.pl.addLatLng([p.lat, p.lon]);
}
function redrawTrack(d) {
  d.layer.clearLayers(); d.segs = []; d.cur = null; d.marker = null; d.sg = null; d.st = newStats();
  const pts = d.pts; d.pts = [];
  for (const p of pts) addPoint(d, p);
  if (d.last) placeMarker(d, d.last);
  drawShocks(d);
}
function placeMarker(d, p) {
  if (!d.marker) {
    d.marker = L.circleMarker([p.lat, p.lon], { radius: markerR(), color: '#fff', weight: 2, fillColor: d.color, fillOpacity: 1 }).addTo(d.layer);
    d.marker.bindTooltip(dn(d), { permanent: true, direction: 'top', offset: [0, -8] });
    d.marker.on('click', () => selectDevice(d.id));
  } else d.marker.setLatLng([p.lat, p.lon]);
  if (d.id === selected) updAccCircles(d, p);
}
function clearTrack(id) {
  const d = devices.get(id); if (!d) return;
  d.pts = []; d.layer.clearLayers(); d.segs = []; d.cur = null; d.marker = null; d.sg = null; d.st = newStats();
  d.shocks = []; d.shockLayer.clearLayers();
  if (d.last && d.last.q > 0) placeMarker(d, d.last);
  scheduleRender();
}
function removeDevice(id) {
  const d = devices.get(id); if (!d) return;
  map.removeLayer(d.layer); map.removeLayer(d.shockLayer); devices.delete(id);
  if (selected === id) { selected = devices.size ? devices.keys().next().value : null; accLayer.clearLayers(); }
  renderDevices(); drawVib();
}

// ------------------------------------------------------------------ lingkaran ketelitian (C)
// Dua lingkaran di sekitar perangkat terpilih: rujukan GNSS standar (bawaan 3,3 m) dan perkiraan akurasi horizontal penerima saat ini.
const accLayer = L.layerGroup().addTo(map);
let accRef = null, accNow = null;
function updAccCircles(d, p) {
  if (!$('#chkAcc').checked || !p || !(p.q > 0) || map.getZoom() < 19) { accLayer.clearLayers(); accRef = accNow = null; return; }
  const ref = cfgNum('refAcc', 3.3);
  const acc = p.hacc != null ? Math.max(p.hacc, 0.005) : null;
  const ll = [p.lat, p.lon];
  if (!accRef) {
    accRef = L.circle(ll, { radius: ref, color: '#d73027', weight: 2, dashArray: '6 5', fill: false, interactive: false }).addTo(accLayer);
    accRef.bindTooltip(`GNSS standar ±${String(ref).replace('.', ',')} m`, { permanent: true, direction: 'right', className: 'acc-label', offset: [0, 0] });
  } else { accRef.setLatLng(ll); accRef.setRadius(ref); }
  if (acc !== null) {
    const col = p.q === 4 ? '#1a9850' : p.q === 3 ? '#f39c12' : '#2c7fb8';
    if (!accNow) accNow = L.circle(ll, { radius: acc, color: col, weight: 2, fillColor: col, fillOpacity: 0.35, interactive: false }).addTo(accLayer);
    else { accNow.setLatLng(ll); accNow.setRadius(acc); accNow.setStyle({ color: col, fillColor: col }); }
  }
  // label lingkaran rujukan menempel di tepi kanannya
  const tt = accRef.getTooltip(); if (tt) tt.setLatLng(L.latLng(p.lat, p.lon + ref / (111320 * Math.cos(p.lat * Math.PI / 180))));
}
function markerR() { return map.getZoom() >= 20 ? 5 : 8; }
map.on('zoomend', () => {
  for (const x of devices.values()) if (x.marker) x.marker.setRadius(markerR());
  const d = devices.get(selected); updAccCircles(d, d && d.last);
});

// ------------------------------------------------------------------ penanda guncangan (D)
function shockIcon(fresh) { return L.divIcon({ className: 'shock' + (fresh ? ' new' : ''), html: '<b></b><i></i>', iconSize: [18, 18], iconAnchor: [9, 9] }); }
function shockMarker(d, s, fresh) {
  if (!$('#chkShock').checked) return;
  const m = L.marker([s.lat, s.lon], { icon: shockIcon(fresh), keyboard: false }).addTo(d.shockLayer);
  m.bindPopup(`<b>Guncangan ${s.v.toFixed(2)} m/s²</b><br>${esc(dn(d))} · ${esc(s.clock)}<br>posisi ${esc(qName(s.q))}${s.hacc != null ? ' ±' + fmtAcc(s.hacc) : ''}`);
  if (fresh) setTimeout(() => m.setIcon(shockIcon(false)), 6000);
}
function drawShocks(d) { d.shockLayer.clearLayers(); for (const s of d.shocks) shockMarker(d, s, false); }
// dipanggil sekali per detik indeks getaran baru
function evalShock(d, v, t) {
  if (v === null || v === undefined || !(v >= cfgNum('shockTh', 2))) return;
  const p = d.last; if (!p || !(p.q > 0)) return;
  if (t - d.lastShockT < 3000) return;            // satu penanda per guncangan (jeda min. 3 s)
  d.lastShockT = t;
  const s = { lat: p.lat, lon: p.lon, v, q: p.q, hacc: p.hacc, t, clock: clockLabel(p._t ?? devTime(p)) };
  d.shocks.push(s); shockMarker(d, s, true);
  if (!RP.quiet && (document.body.classList.contains('expo') || d.id === selected)) toast(`⚡ ${dn(d)}: guncangan ${v.toFixed(2)} m/s² terdeteksi`, 2500);
}

// ------------------------------------------------------------------ MQTT
let client = null;
function topic(...p) { return [CFG.prefix, ...p].join('/'); }
function connect() {
  if (client) { client.end(true); client = null; setBadge('off', 'Terputus'); $('#btnConnect').textContent = 'Sambungkan'; return; }
  const local = CFG.mode === 'local';
  const url = local ? CFG.localUrl : CFG.cloudUrl;
  if (!url) { toast('Isi URL broker di Pengaturan dulu.'); openSettings(); return; }
  if (location.protocol === 'https:' && url.startsWith('ws://')) { toast('Halaman https tidak boleh memakai ws:// — buka web app dari laptop (http://IP-laptop:8000) untuk mode lokal.', 7000); return; }
  const opts = { clientId: 'fobos-web-' + Math.random().toString(16).slice(2, 10), clean: true, reconnectPeriod: 2000,
    connectTimeout: 8000, protocolVersion: 4 };
  if (!local) {
    opts.username = (sessionUser || CFG.cloudUser || '').trim();
    const pw = sessionPass || CFG.cloudPass; if (pw) opts.password = pw;   // flespi: token di username, password kosong
    if (!opts.username && !pw) { toast('Isi token flespi (atau username) di Pengaturan dulu.'); openSettings(); client = null; setBadge('off', 'Terputus'); $('#btnConnect').textContent = 'Sambungkan'; return; }
  }
  setBadge('wait', 'Menyambung…');
  client = mqtt.connect(url, opts);
  client.on('close', () => { if (client && !client.connected) setBadge('wait', 'Menyambung ulang…'); });
  $('#btnConnect').textContent = 'Putuskan';
  client.on('connect', () => {
    setBadge('on', local ? 'Tersambung (lokal)' : 'Tersambung (cloud)');
    client.subscribe([topic('+', 'pvt'), topic('+', 'status'), topic('+', 'ack'), topic('+', 'imu'), topic('+', 'raw')], { qos: 0 });
  });
  client.on('reconnect', () => setBadge('wait', 'Menyambung ulang…'));
  client.on('offline', () => setBadge('wait', 'Offline'));
  client.on('error', (e) => { setBadge('off', 'Galat'); toast('MQTT: ' + (e && e.message ? e.message : e)); });
  client.on('message', onMessage);
}
function setBadge(cls, text) { const b = $('#connBadge'); b.className = 'badge ' + cls; b.textContent = text; }
function send(id, obj) {
  if (!client || !client.connected) { toast('Belum tersambung ke broker.'); return false; }
  client.publish(topic(id, 'cmd'), JSON.stringify(obj), { qos: 1 });
  return true;
}

function onMessage(t, msg) {
  const parts = t.split('/'); const kind = parts[parts.length - 1]; const id = parts[parts.length - 2];
  if (!id) return;
  try {
    if (kind === 'raw') { onRaw(id, msg); return; }
    const obj = JSON.parse(new TextDecoder().decode(msg));
    if (kind === 'pvt') onPvt(id, obj);
    else if (kind === 'imu') onImu(id, obj);
    else if (kind === 'status') onStatus(id, obj);
    else if (kind === 'ack') onAck(id, obj);
  } catch (e) { console.warn('pesan tidak terbaca', t, e); }
}

function pushVib(d, v, t) {
  if (v === null || v === undefined) return;
  d.vib.push({ t: t ?? Date.now(), v }); if (d.vib.length > 1200) d.vib.shift();
}
function followTo(d, p) {
  if (selected !== d.id || !$('#chkFollow').checked) return;
  if (!d._zoomed) { map.setView([p.lat, p.lon], 18); d._zoomed = true; }
  else if (!map.getBounds().pad(-0.2).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon], { animate: !d.replay });
}
function onPvt(id, p) {
  const d = dev(id);
  if (d.replay) return;                     // nama perangkat bentrok dengan putar ulang
  p._t = devTime(p);
  if (p.vib == null && d.imu && Date.now() - d.imuRx < 2500) p.vib = d.imu.vib;   // indeks getaran dari pesan IMU
  d.last = p; d.lastRx = Date.now();
  if (p.sess !== undefined) syncSession(d, p.sess);
  if (p.q > 0 && isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0)) {
    addPoint(d, p); placeMarker(d, p); followTo(d, p);
  }
  // grafik getaran & guncangan dari PVT hanya bila pesan IMU tidak datang
  const sec = Math.floor(p.tow / 1000);
  if (Date.now() - (d.imuRx || 0) > 3000 && sec !== d.vibSec) { d.vibSec = sec; pushVib(d, p.vib); evalShock(d, p.vib, p._t); }
  if (d.rec) { d.pvtBuf.push(p); d.rec.n.pvt++; d.rec.seq.pvt.push(p.seq); }
  scheduleRender();
}
// ringkasan IMU 5 Hz: rata-rata 200 ms + indeks getaran per detik
function onImu(id, m) {
  const d = dev(id);
  if (d.replay) return;
  d.imu = m; d.imuRx = Date.now(); d.lastRx = Date.now();
  pushVib(d, m.vib);
  const sec = Math.floor(m.tow); if (sec !== d.vibSec) { d.vibSec = sec; evalShock(d, m.vib, (m.wk || 0) * 604800000 + m.tow * 1000); }
  if (d.rec) { d.imuBuf.push(m); d.rec.n.imu++; d.rec.seq.imu.push(m.seq); }
}
function onStatus(id, s) {
  const d = dev(id); d.status = s; d.statusRx = Date.now();
  if (s.online && s.sess !== undefined) syncSession(d, s.sess);
  scheduleRender();
}
async function onAck(id, a) {
  const d = dev(id);
  if (a.cmd === 'start') {
    if (a.ok) { toast(`${id}: Record ${a.sess} dimulai (penanda ditulis di SD ${a.file || ''})${a.sd ? '' : ' — PERINGATAN: kartu SD tidak merekam'}`, 5000); syncSession(d, a.sess, a); }
    else toast(`${id}: gagal mulai — ${a.msg || ''}`);
  } else if (a.cmd === 'rate') {
    toast(`${id}: laju posisi ke web sekarang ${a.pvt_hz} Hz (SD tetap semua epoch)`);
  } else if (a.cmd === 'stop') {
    if (a.ok) {
      const rec = (d.rec && d.rec.sess === a.sess) ? d.rec : null;
      if (rec) await flushRec(d);
      const r = await updateSession(a.sess, (r0) => {
        const r1 = r0 || newSessRec(d, a.sess, true);
        r1.stopAck = a; r1.stopped = Date.now(); if (rec) mergeCounts(r1, rec); return r1;
      });
      if (rec && d.rec === rec) d.rec = null;
      d.sess = '';
      const rep = completeness(r);
      toast(`${id}: Record ${a.sess} selesai. Posisi ${rep.pvt}, IMU ${rep.imu}, raw ${rep.raw}.`, 7000);
      if (CFG.autoZip !== false) exportSession(a.sess, 'zip');
    } else toast(`${id}: ${a.msg || 'gagal stop'}`);
  }
  scheduleRender();
}

// ------------------------------------------------------------------ sesi & perekaman
// Semua baca-ubah-tulis catatan sesi diserialkan per sesi agar ack/penghitung tidak saling menimpa.
const sessLocks = new Map();
function updateSession(sess, fn) {
  const prev = sessLocks.get(sess) || Promise.resolve();
  const p = prev.then(async () => { const r = await Store.getSession(sess); const r2 = await fn(r); if (r2) await Store.putSession(r2); return r2; })
    .catch((e) => { console.warn('updateSession', e); });
  sessLocks.set(sess, p);
  return p;
}
const ZERO_N = () => ({ imu: 0, raw: 0, pvt: 0, rawBytes: 0 });
const ZERO_SEQ = () => ({ imu: [], raw: [], pvt: [] });
function newSessRec(d, sess, partial) {
  return { sess, dev: d.id, created: Date.now(), partial: !!partial, startAck: null, stopAck: null, stopped: null, n: ZERO_N(), seq: ZERO_SEQ() };
}
function mergeCounts(r, rec) { r.n = Object.assign({}, rec.n); r.seq = { imu: rec.seq.imu.slice(), raw: rec.seq.raw.slice(), pvt: rec.seq.pvt.slice() }; }
async function syncSession(d, sess, ack) {
  if (!sess) {                              // perangkat melapor tidak ada sesi
    if (d.rec && Date.now() - d.rec.since > 5000) {
      const rec = d.rec; await flushRec(d);
      if (d.rec === rec) { d.rec = null; d.sess = ''; }
      updateSession(rec.sess, (r) => { if (r) mergeCounts(r, rec); return r; });
      scheduleRender();
    }
    return;
  }
  if (d.rec && d.rec.sess === sess) { if (ack) updateSession(sess, (r) => { if (r) r.startAck = ack; return r; }); return; }
  // buat penampung rekaman SEKETIKA agar pesan pertama tidak terlewat; gabungkan dengan catatan lama (bila ada)
  const prevRec = d.rec;
  d.rec = { sess, since: Date.now(), n: ZERO_N(), seq: ZERO_SEQ(), chunkSeq: 0 };
  d.sess = sess; d.pvtBuf = []; d.imuBuf = [];
  if (prevRec && prevRec.sess !== sess) updateSession(prevRec.sess, (pr) => { if (pr) mergeCounts(pr, prevRec); return pr; });
  const rec = d.rec;
  await updateSession(sess, (r) => {
    if (!r) { r = newSessRec(d, sess, !ack); r.startAck = ack || null; return r; }
    // dibuka ulang di tengah sesi (mis. halaman dimuat ulang): lanjutkan hitungan lama
    for (const k of Object.keys(rec.n)) rec.n[k] += (r.n && r.n[k]) || 0;
    for (const k of ['imu', 'raw', 'pvt']) rec.seq[k] = ((r.seq && r.seq[k]) || []).concat(rec.seq[k]);
    rec.chunkSeq = 100000 + Math.floor(Date.now() / 1000) % 100000;   // urutan chunk tetap unik
    if (ack) r.startAck = ack;
    r.reopened = (r.reopened || 0) + 1;
    mergeCounts(r, rec);
    return r;
  });
  scheduleRender();
}
function onRaw(id, msg) {
  const d = dev(id);
  const u8 = new Uint8Array(msg); if (u8.length < 16) return;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'FOBR') return;
  const seq = dv.getUint32(8, true);
  if (!d.rec) return;                      // paket di luar sesi yang dikenal
  Store.addChunk({ sess: d.rec.sess, dev: id, kind: 'raw', seq, data: u8.slice().buffer, rx: Date.now() });
  d.rec.n.raw++; d.rec.n.rawBytes += u8.length; d.rec.seq.raw.push(seq);
}
async function flushRec(d) {
  if (!d.rec) return;
  const rec = d.rec;
  if (d.pvtBuf.length) { const arr = d.pvtBuf; d.pvtBuf = []; await Store.addChunk({ sess: rec.sess, dev: d.id, kind: 'pvt', seq: rec.chunkSeq++, data: JSON.stringify(arr), rx: Date.now() }); }
  if (d.imuBuf.length) { const arr = d.imuBuf; d.imuBuf = []; await Store.addChunk({ sess: rec.sess, dev: d.id, kind: 'imu', seq: rec.chunkSeq++, data: JSON.stringify(arr), rx: Date.now() }); }
}
setInterval(async () => {          // simpan posisi/IMU & hitungan tiap 2 s
  for (const d of devices.values()) {
    if (!d.rec) continue;
    const rec = d.rec; await flushRec(d);
    updateSession(rec.sess, (r) => { if (r) mergeCounts(r, rec); return r; });
  }
}, 2000);

function startSession(id) {
  const name = `${id}_${utcStamp()}`;
  if (send(id, { cmd: 'start', sess: name })) toast(`${id}: meminta mulai Record ${name}…`);
}
function stopSession(id) {
  if (!window.confirm(`Selesaikan Record ${id}? Rekaman di browser berhenti; kartu SD tetap merekam.`)) return;
  if (send(id, { cmd: 'stop' })) toast(`${id}: meminta selesai Record…`);
}

function missingRange(seqs, from, to) {      // nomor urut yang hilang dalam [from, to)
  const set = new Set(seqs); const miss = [];
  if (from === undefined || to === undefined) {
    if (!seqs.length) return { exp: 0, miss };
    from = Math.min(...seqs); to = Math.max(...seqs) + 1;
  }
  for (let i = from; i < to; i++) if (!set.has(i)) miss.push(i);
  return { exp: to - from, miss };
}
function completeness(r) {
  const a0 = r.startAck || {}, a1 = r.stopAck || {};
  const raw = missingRange(r.seq.raw || [], 0, a1.raw_pkts);
  const pvt = missingRange(r.seq.pvt || [], a1.pvt_seq0 ?? a0.pvt_seq0, a1.pvt_seq1);
  const imu = missingRange(r.seq.imu || [], a1.imu_seq0 ?? a0.imu_seq0, a1.imu_seq1);
  const pct = (m) => m.exp ? `${m.exp - m.miss.length}/${m.exp} (${(100 * (m.exp - m.miss.length) / m.exp).toFixed(1)}%)` : '0';
  return { raw: pct(raw), pvt: pct(pvt), imu: pct(imu), rawMiss: raw.miss, pvtMiss: pvt.miss, imuMiss: imu.miss };
}

// ------------------------------------------------------------------ ekspor
const STATUS = { 4: 'FIX', 3: 'FLOAT', 2: 'DGNSS', 1: 'SINGLE', 0: 'TANPA_FIX' };
// kolom sama dengan _pos.csv di kartu SD (+ vib, seq)
const POS_COLS = [['utc', 'utc'], ['gps_week', 'wk'], ['tow_s', (p) => (p.tow / 1000).toFixed(3)], ['lat', 'lat'], ['lon', 'lon'], ['h_msl', 'h'], ['h_ell', 'hae'],
  ['q', 'q'], ['status', (p) => STATUS[p.q] ?? ''], ['fix_type', 'fix'], ['carr_soln', 'carr'], ['num_sv', 'sv'], ['h_acc', 'hacc'], ['v_acc', 'vacc'],
  ['std_lat', 'slat'], ['std_lon', 'slon'], ['std_alt', 'salt'], ['hdop', 'hdop'], ['diff_age', 'age'], ['speed', 'spd'], ['heading', 'hdg'],
  ['pdop', 'pdop'], ['vib', 'vib'], ['seq', 'seq']];
function cell(p, f) { const v = typeof f === 'function' ? f(p) : p[f]; return v === null || v === undefined ? '' : v; }
function trackCsv(pts) {
  return POS_COLS.map((c) => c[0]).join(',') + '\n' + pts.map((p) => POS_COLS.map((c) => cell(p, c[1])).join(',')).join('\n') + '\n';
}
const IMU_COLS = [['gps_week', 'wk'], ['tow_s', 'tow'], ['ax', 'ax'], ['ay', 'ay'], ['az', 'az'], ['gx', 'gx'], ['gy', 'gy'], ['gz', 'gz'],
  ['n_avg', 'n'], ['vib', 'vib'], ['tflag', 'tflag'], ['seq', 'seq']];
function imuCsv(rows) {
  return IMU_COLS.map((c) => c[0]).join(',') + '\n' + rows.map((m) => IMU_COLS.map((c) => cell(m, c[1])).join(',')).join('\n') + '\n';
}
function qName(q) { return (Q_INFO[q] || ['?'])[0]; }
function trackGeoJson(pts, id) {
  // titik per epoch + garis per kelas kualitas berurutan
  const feats = pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat, p.hae] },
    properties: Object.assign({}, p, { kualitas: qName(p.q) }) }));
  let seg = null;
  for (const p of pts) {
    if (!seg || seg.properties.q !== p.q) { if (seg && seg.geometry.coordinates.length > 1) feats.push(seg); seg = { type: 'Feature', geometry: { type: 'LineString', coordinates: seg ? [seg.geometry.coordinates.at(-1)] : [] }, properties: { id, q: p.q, kualitas: qName(p.q), jenis: 'segmen' } }; }
    seg.geometry.coordinates.push([p.lon, p.lat]);
  }
  if (seg && seg.geometry.coordinates.length > 1) feats.push(seg);
  return JSON.stringify({ type: 'FeatureCollection', name: id, features: feats });
}
function concat(chunks, skip = 0) {
  const total = chunks.reduce((s, c) => s + c.byteLength - skip, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(new Uint8Array(c, skip), o); o += c.byteLength - skip; }
  return out;
}
function sortUnique(chunks) {
  const m = new Map(); for (const c of chunks) if (!m.has(c.seq)) m.set(c.seq, c);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
}
function uniqBySeq(rows) {
  const m = new Map(); for (const r of rows) if (!m.has(r.seq)) m.set(r.seq, r);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
}
// ZIP tanpa kompresi (metode "store") — cukup untuk mengemas file sesi jadi satu unduhan
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(); const parts = [], central = []; let off = 0;
  const d = new Date();
  const dosT = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosD = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  for (const f of files) {
    const nm = enc.encode(f.name); const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data; const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosT, true); h.setUint16(12, dosD, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nm, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosT, true); c.setUint16(14, dosD, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
async function sessionFiles(sess) {
  const all = await Store.chunks(sess);
  const raw = sortUnique(all.filter((c) => c.kind === 'raw'));
  const pts = uniqBySeq(all.filter((c) => c.kind === 'pvt').flatMap((c) => JSON.parse(c.data)));
  const imu = uniqBySeq(all.filter((c) => c.kind === 'imu').flatMap((c) => JSON.parse(c.data)));
  const r = await Store.getSession(sess); const c = completeness(r);
  const rep = { sesi: sess, perangkat: r.dev, dibuat_browser: new Date(r.created).toISOString(), sebagian: r.partial,
    dimuat_ulang: r.reopened || 0, ack_mulai: r.startAck, ack_selesai: r.stopAck, diterima: r.n,
    kelengkapan: { posisi: c.pvt, imu_5hz: c.imu, raw_ubx: c.raw },
    posisi_hilang_seq: ranges(c.pvtMiss), imu_hilang_seq: ranges(c.imuMiss), raw_hilang_seq: ranges(c.rawMiss),
    file_sd: (r.startAck && r.startAck.file) || (r.stopAck && r.stopAck.file) || null,
    catatan: 'Salinan lengkap ada di kartu SD (<file>_raw.ubx RAWX penuh, <file>_imu.csv 200 Hz, <file>_pos.csv). '
           + 'Potong bagian sesi ini dengan: python fobos_post.py cut <folder SD> --sess ' + sess };
  return { raw, pts, imu, rep };
}
async function exportSession(sess, what) {
  const f = await sessionFiles(sess);
  const ubx = () => concat(f.raw.map((x) => x.data), 16);
  if (what === 'zip') {
    const files = [{ name: `${sess}_web_posisi.csv`, data: trackCsv(f.pts) }, { name: `${sess}_web_imu5hz.csv`, data: imuCsv(f.imu) },
      { name: `${sess}_web_rawx1hz.ubx`, data: ubx() }, { name: `${sess}_web_jejak.geojson`, data: trackGeoJson(f.pts.filter((p) => p.q > 0), sess) },
      { name: `${sess}_laporan.json`, data: JSON.stringify(f.rep, null, 2) }];
    if ((typeof WX !== 'undefined' && WX) && WX.logs[sess] && WX.logs[sess].length) files.push({ name: `${sess}_cuaca.json`, data: JSON.stringify({ sumber: 'Open-Meteo (CC BY 4.0), dicatat peramban selama sesi', catatan: WX.logs[sess] }, null, 2) });
    download(`${sess}_web.zip`, makeZip(files));
  } else if (what === 'ubx') { if (!f.raw.length) return toast('Tidak ada data raw GNSS pada sesi ini.'); download(`${sess}_web_rawx1hz.ubx`, ubx()); }
  else if (what === 'imucsv') { if (!f.imu.length) return toast('Tidak ada data IMU.'); download(`${sess}_web_imu5hz.csv`, imuCsv(f.imu), 'text/csv'); }
  else if (what === 'csv') { if (!f.pts.length) return toast('Tidak ada titik posisi.'); download(`${sess}_web_posisi.csv`, trackCsv(f.pts), 'text/csv'); }
  else if (what === 'geojson') { const p = f.pts.filter((x) => x.q > 0); if (!p.length) return toast('Tidak ada titik posisi.'); download(`${sess}_web_jejak.geojson`, trackGeoJson(p, sess), 'application/geo+json'); }
  else if (what === 'report') download(`${sess}_laporan.json`, JSON.stringify(f.rep, null, 2), 'application/json');
}
function exportTrack(id, fmt) {
  const d = devices.get(id); if (!d || !d.pts.length) return toast('Belum ada jejak.');
  const name = `${id}_jejak_tampil_${utcStamp()}`;
  if (fmt === 'csv') download(name + '.csv', trackCsv(d.pts), 'text/csv');
  else download(name + '.geojson', trackGeoJson(d.pts, id), 'application/geo+json');
}

// ------------------------------------------------------------------ tampilan perangkat
const EMPTY_LIST = $('#devList').innerHTML;
let renderPending = false;
function scheduleRender() { if (!renderPending) { renderPending = true; requestAnimationFrame(() => { renderPending = false; renderDevices(); }); } }
function renderDevices() {
  const list = $('#devList'); $('#devCount').textContent = devices.size; $('#devCount2').textContent = devices.size;
  renderSheetSum(); renderSummary(); renderHud();
  renderRpMaster();
  const ae = document.activeElement;
  if (ae && /^(SELECT|INPUT)$/.test(ae.tagName) && list.contains(ae) && ae.type !== 'checkbox') return;   // jangan ganggu pilihan/isian yang sedang dipakai
  if (listPointer) { listDirty = true; return; }                                                              // tunda selama jari/mouse menekan daftar
  if (!devices.size) { list.innerHTML = EMPTY_LIST; return; }
  const now = Date.now(); let h = '';
  for (const d of devices.values()) {
    const p = d.last || {}; const s = d.status || {};
    if (d.replay) { h += replayCard(d, p); continue; }
    const online = s.online !== false && (now - Math.max(d.lastRx, d.statusRx || 0) < 6000);
    const q = p.q ?? 0; const nt = s.ntrip || {}; const imu = s.imu || {}; const sd = s.sd || {}; const tm = s.time || {};
    const sessOn = !!(s.sess || d.sess);
    const recInfo = d.rec ? `<span class="rec">● RECORD</span> ${esc(d.rec.sess)} · ${fmtDur(s.sess_s ?? (now - d.rec.since) / 1000)} · posisi ${d.rec.n.pvt} · IMU ${d.rec.n.imu} · UBX ${d.rec.n.raw}` : '';
    const g = s.gnss || {}; const portal = s.ip && s.ip !== '0.0.0.0' ? `http://${s.ip}/` : '';
    h += `<div class="card ${selected === d.id ? 'sel' : ''}" data-id="${esc(d.id)}">
      <h4><span><i class="dot" style="background:${d.color}"></i>${esc(d.id)}</span>
        <span class="badge ${online ? 'on' : 'off'}">${online ? 'online' : 'offline'}</span></h4>
      <div class="kv">
        <span>Posisi</span><span class="q${q}">${qName(q)}</span>
        <span>Satelit / akurasi</span><span>${p.sv ?? '–'} · ±${p.hacc !== undefined ? (p.hacc < 1 ? (p.hacc * 100).toFixed(1) + ' cm' : p.hacc.toFixed(2) + ' m') : '–'}${p.slat != null ? ` (GST σN ${(p.slat * 100).toFixed(1)} σE ${(p.slon * 100).toFixed(1)} cm)` : ''}</span>
        <span>Kecepatan</span><span>${p.spd !== undefined ? (p.spd * 3.6).toFixed(1) + ' km/j' : '–'}</span>
        <span>Getaran</span><span>${d.imu && d.imu.vib != null ? d.imu.vib.toFixed(2) + ' m/s²' : (p.vib != null ? p.vib.toFixed(2) + ' m/s²' : '–')}</span>
        <span>NTRIP</span><span>${nt.en === false ? 'nonaktif' : (nt.ok ? 'OK, umur ' + (nt.age ?? 0).toFixed(1) + ' s' : (nt.err ? esc(nt.err) : 'menunggu'))}</span>
        <span>GNSS</span><span>${s.gnss ? 'UART1 PVT ' + (g.hz ?? 0).toFixed(1) + ' Hz · UART2 RAWX ' + (g.rawx_hz ?? 0).toFixed(1) + ' Hz' : '–'}</span>
        <span>IMU</span><span>${imu.ok ? (imu.hz ?? 0).toFixed(0) + ' Hz · jeda maks ' + (imu.maxdt ?? 0).toFixed(1) + ' ms' : (s.imu ? 'TIDAK TERDETEKSI' : '–')}</span>
        <span>Waktu IMU</span><span>${tm.valid ? (tm.pps ? 'GPS + PPS' : 'GPS (tanpa PPS)') : 'belum sinkron'}</span>
        <span>Kartu SD</span><span>${s.sd ? (sd.ok ? `OK · file <b>${esc(s.file || '')}</b> · ${sd.free_mb} MB kosong` : 'TIDAK ADA') : '–'}</span>
        <span>Jaringan</span><span>${s.broker ? esc(s.ssid || '') + ' · RSSI ' + s.rssi + ' dBm · broker ' + esc(s.broker) : '–'}</span>
        <span>Portal ESP32</span><span>${portal ? `<a href="${esc(portal)}" target="_blank" rel="noopener">${esc(portal)}</a>` : '–'}${s.ap ? ' · AP aktif' : ''}</span>
      </div>
      <div class="small" style="margin-top:4px">${recInfo}</div>
      <div class="actions">
        ${sessOn ? `<button class="danger" data-act="stop">■ Stop Record</button>` : `<button class="primary" data-act="start">● Record</button>`}
        <button data-act="csv">Jejak CSV</button><button data-act="geojson">GeoJSON</button>
        <button data-act="zoom">Ke perangkat</button><button data-act="clear">Hapus jejak</button>
        <select data-act="rate" title="Laju posisi yang dikirim perangkat ke web">${[10, 5, 2, 1].map((hz) => `<option value="${hz}"${(s.pvt_hz ?? 10) === hz ? ' selected' : ''}>posisi ${hz} Hz</option>`).join('')}</select>
      </div></div>`;
  }
  list.innerHTML = h;
}
$('#devList').addEventListener('click', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const id = card.dataset.id; const act = e.target.dataset.act;
  if (!act) { selectDevice(id); return; }
  if (act === 'start') startSession(id);
  else if (act === 'stop') stopSession(id);
  else if (act === 'csv' || act === 'geojson') exportTrack(id, act);
  else if (act === 'zoom') { const d = devices.get(id); if (d && d.last) map.setView([d.last.lat, d.last.lon], 18); selectDevice(id); if (isPhone()) setSheet('min'); }
  else if (act === 'clear') clearTrack(id);
  else if (act && act.startsWith('rp')) replayAct(id, act, e.target);
});
$('#devList').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'rate') return;
  const id = e.target.closest('.card').dataset.id;
  send(id, { cmd: 'rate', pvt_hz: Number(e.target.value) });
});
setInterval(scheduleRender, 1000);

// ------------------------------------------------------------------ grafik getaran
function selectDevice(id) {
  selected = id; accLayer.clearLayers(); accRef = accNow = null;
  const d = devices.get(id); if (d && d.last) updAccCircles(d, d.last);
  renderDevices(); drawVib();
}
function drawVib() {
  if (typeof TRIP !== 'undefined' && TRIP.chart(devices.get(selected))) return;
  const d0 = devices.get(selected); $('#vibTitle').textContent = 'Indeks getaran' + (d0 ? ' — ' + dn(d0) : '');
  const cv = $('#vibCanvas'); if (!cv.offsetParent) return;           // panel tertutup
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(200, cv.clientWidth), ch = Math.max(60, cv.clientHeight);
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cw, H = ch; ctx.clearRect(0, 0, W, H);
  const d = d0; if (!d) return;
  const dark = document.body.classList.contains('expo');
  const now = d.replay && d.rp ? d.rp.cur : Date.now(), span = 120000; const pts = d.vib.filter((x) => now - x.t <= span && x.t <= now);
  const vmax = Math.max(vibTh().at(-1) * 1.25 || 2.5, cfgNum('shockTh', 2) * 1.1, ...pts.map((x) => x.v));
  ctx.strokeStyle = dark ? '#3a4b5e' : '#ccc'; ctx.fillStyle = dark ? '#9fb0c2' : '#888'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (const th of vibTh()) { const y = H - 14 - (th / vmax) * (H - 20); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(28, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(th.toFixed(1), 2, y + 3); }
  const ys = H - 14 - (cfgNum('shockTh', 2) / vmax) * (H - 20);
  ctx.strokeStyle = '#d73027'; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(28, ys); ctx.lineTo(W, ys); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = dark ? '#9fb0c2' : '#888';
  ctx.fillText('-120 s', 28, H - 2); ctx.fillText(d.replay ? 'waktu putar' : 'sekarang', W - 62, H - 2);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t > 5000) continue;
    const x0 = 28 + (W - 30) * (1 - (now - pts[i - 1].t) / span), x1 = 28 + (W - 30) * (1 - (now - pts[i].t) / span);
    const y0 = H - 14 - (pts[i - 1].v / vmax) * (H - 20), y1 = H - 14 - (pts[i].v / vmax) * (H - 20);
    ctx.strokeStyle = V_COLORS[Math.max(0, vibClass(pts[i].v))]; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
}
setInterval(drawVib, 1000);

// ------------------------------------------------------------------ dialog sesi
async function renderSessions() {
  const list = (await Store.sessions()).sort((a, b) => b.created - a.created);
  if (!list.length) { $('#sessList').innerHTML = '<p class="muted">Belum ada sesi.</p>'; return; }
  let h = '';
  for (const r of list) {
    const c = completeness(r);
    const active = [...devices.values()].some((d) => d.rec && d.rec.sess === r.sess);
    h += `<div class="sess" data-sess="${esc(r.sess)}">
      <b>${esc(r.sess)}</b> <span class="muted small">${esc(r.dev)} · ${new Date(r.created).toLocaleString()}</span>
      ${active ? '<span class="rec small"> ● sedang Record</span>' : ''}${r.partial ? '<span class="small muted"> · dibuka di tengah sesi</span>' : ''}${r.reopened ? `<span class="small muted"> · halaman dimuat ulang ${r.reopened}x</span>` : ''}
      <div class="small">Posisi ${c.pvt} · IMU 5 Hz ${c.imu} · UBX ${c.raw}
        ${r.stopAck ? ` · durasi ${fmtDur(r.stopAck.dur_s)} · file SD ${esc(r.stopAck.file || '')}` : (active ? '' : ' · <i>tanpa ack selesai</i>')}</div>
      ${c.imuMiss.length || c.rawMiss.length || c.pvtMiss.length ? `<div class="small" style="color:#c62828">Data hilang di jalur web (lengkap di SD): posisi ${c.pvtMiss.length}, IMU ${c.imuMiss.length}, UBX ${c.rawMiss.length}</div>` : ''}
      <div class="actions">
        <button data-x="zip" class="primary">Unduh semua (.zip)</button>
        <button data-x="play">▶ Putar ulang</button>
        <button data-x="csv">Posisi .csv</button><button data-x="imucsv">IMU .csv</button><button data-x="ubx">UBX .ubx</button>
        <button data-x="geojson">GeoJSON</button><button data-x="report">Laporan</button>
        <button data-x="del" class="danger">Hapus</button>
      </div></div>`;
  }
  $('#sessList').innerHTML = h;
}
$('#sessList').addEventListener('click', async (e) => {
  const x = e.target.dataset.x; if (!x) return; const sess = e.target.closest('.sess').dataset.sess;
  if (x === 'del') { if (!window.confirm(`Hapus sesi ${sess} dari browser ini? (data di kartu SD tidak terhapus)`)) return; await Store.deleteSession(sess); renderSessions(); return; }
  if (x === 'play') { $('#dlgSessions').close(); replayFromSession(sess); return; }
  exportSession(sess, x);
});
async function openSessions() { for (const d of devices.values()) await flushRec(d); await renderSessions(); $('#dlgSessions').showModal(); }
$('#btnCloseSess').onclick = () => $('#dlgSessions').close();

// ------------------------------------------------------------------ dialog pengaturan
function openSettings() {
  const f = $('#frmSettings');
  for (const k of Object.keys(DEF)) { const el = f.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!CFG[k]; else el.value = k === 'cloudPass' ? (sessionPass || CFG.cloudPass || '') : k === 'cloudUser' ? (sessionUser || CFG.cloudUser || '') : (CFG[k] ?? ''); }
  $('#dlgSettings').showModal();
}
$('#dlgSettings').addEventListener('close', () => {
  if ($('#dlgSettings').returnValue !== 'save') return;
  const f = $('#frmSettings'); const c = Object.assign({}, CFG);
  for (const k of Object.keys(DEF)) { const el = f.elements[k]; if (!el) continue; c[k] = el.type === 'checkbox' ? el.checked : el.value.trim(); }
  if (!c.prefix) c.prefix = 'fobos';
  sessionPass = c.cloudPass; sessionUser = c.cloudUser; CFG = c; saveCfg(c); renderLegend(); for (const d of devices.values()) redrawTrack(d);
  if ((typeof WX !== 'undefined' && WX)) WX.applyCfg();
  toast('Pengaturan disimpan. Klik Sambungkan (atau Putuskan lalu Sambungkan).');
});
$('#btnConnect').onclick = connect;

window.addEventListener('beforeunload', (e) => {
  if ([...devices.values()].some((d) => d.rec)) { e.preventDefault(); e.returnValue = 'Sesi sedang direkam di browser ini.'; }
});


// ------------------------------------------------------------------ ringkasan (F), lembar bawah, HUD
function sumOf(d) {
  const st = d.st; const dur = st.t0 !== null ? (st.t1 - st.t0) / 1000 : 0;
  return { dist: fmtDist(st.dist), dur: fmtDur(dur), fix: st.n ? Math.round(100 * st.nFix / st.n) + '%' : '–',
    spd: st.spdMax ? (st.spdMax * 3.6).toFixed(0) + ' km/j' : '–', vib: st.vibN ? (st.vibSum / st.vibN).toFixed(2) + ' m/s²' : '–', shock: String(d.shocks.length) };
}
function renderSummary() {
  const d = devices.get(selected); $('#sumWho').textContent = d ? dn(d) : '';
  if (!d || !d.st.n) { $('#sumBody').innerHTML = '<span class="muted small">Belum ada jejak.</span>'; return; }
  const m = sumOf(d);
  $('#sumBody').innerHTML = [['Jarak', m.dist], ['Durasi', m.dur], ['RTK fix', m.fix], ['Kec. maks', m.spd], ['Getaran rata²', m.vib], ['Guncangan', m.shock]]
    .map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')
    + (typeof TRIP !== 'undefined' ? TRIP.summaryHtml(d) : '') + (hasWx() ? WX.timelineHtml(d) : '');
}
function renderSheetSum() {
  const d = devices.get(selected); const el = $('#sheetSum');
  if (!d) { el.textContent = ''; return; }
  const p = d.last || {}; el.innerHTML = `${esc(dn(d))} · <span class="q${p.q ?? 0}">${esc(qName(p.q ?? 0))}</span>${p.hacc != null ? ' ±' + esc(fmtAcc(p.hacc)) : ''}`;
}
function renderHud() {
  if (!document.body.classList.contains('expo')) return;
  const d = devices.get(selected);
  if (!d) { $('#hudId').textContent = 'Menunggu perangkat…'; return; }
  const p = d.last || {}; const q = p.q ?? 0;
  $('#hudId').textContent = dn(d);
  const tag = $('#hudMode'); tag.textContent = d.replay ? 'PUTAR ULANG' : 'LANGSUNG'; tag.classList.toggle('rp', d.replay);
  const hq = $('#hudQ'); hq.textContent = ({ 4: 'RTK FIX', 3: 'RTK FLOAT', 2: 'DGNSS', 1: 'SINGLE', 0: 'TANPA FIX' })[q]; hq.className = 'hud-q q' + q;
  $('#hudAcc').textContent = q > 0 && p.hacc != null ? '±' + fmtAcc(p.hacc) : '–';
  $('#hudSv').textContent = p.sv ?? '–';
  $('#hudSpd').textContent = p.spd != null ? (p.spd * 3.6).toFixed(0) + ' km/j' : '–';
  const v = d.replay ? p.vib : (d.imu && d.imu.vib != null ? d.imu.vib : p.vib);
  $('#hudVib').textContent = v != null ? v.toFixed(2) + ' m/s²' : '–';
  const ref = cfgNum('refAcc', 3.3);
  $('#hudCmp').innerHTML = q > 0 && p.hacc != null && p.hacc > 0
    ? `Garis putus merah = GNSS standar ±${String(ref).replace('.', ',')} m. Perkiraan akurasi penerima saat ini <b>±${esc(fmtAcc(p.hacc))}</b>, sekitar <b>${Math.round(ref / Math.max(p.hacc, 0.005))}×</b> lebih kecil.`
    : 'Menunggu solusi posisi…';
  const m = sumOf(d);
  $('#hudSum').innerHTML = [['Jarak', m.dist], ['Durasi', m.dur], ['RTK fix', m.fix], ['Guncangan', m.shock]]
    .map(([k, val]) => `<div><span class="hl">${k}</span><b>${esc(val)}</b></div>`).join('');
  if (typeof TRIP !== 'undefined') TRIP.hud(d);
  // armada: semua kendaraan sekaligus (klik untuk memilih)
  const fl = $('#hudFleet');
  if (devices.size < 2) { fl.innerHTML = ''; return; }
  fl.innerHTML = '<div class="hl">Armada dipantau · ' + devices.size + ' kendaraan</div>' + [...devices.values()].map((x) => {
    const pp = x.last || {}; const qq = pp.q ?? 0; const vv = x.replay ? pp.vib : (x.imu && x.imu.vib != null ? x.imu.vib : pp.vib);
    const vc = vv == null ? '#9e9e9e' : V_COLORS[vibClass(vv)];
    return `<div class="hf-row${x.id === selected ? ' on' : ''}" data-hf="${esc(x.id)}"><i style="background:${x.color}"></i><span class="hf-n">${esc(dn(x))}</span>`
      + `<span class="hud-q q${qq} hf-q">${({ 4: 'FIX', 3: 'FLOAT', 2: 'DGNSS', 1: 'SINGLE', 0: '–' })[qq]}</span>`
      + `<span>${pp.spd != null ? (pp.spd * 3.6).toFixed(0) + ' km/j' : '–'}</span><span style="color:${vc}">${vv != null ? vv.toFixed(2) : '–'}</span></div>`;
  }).join('');
}
$('#hudFleet').addEventListener('click', (e) => { const r = e.target.closest('[data-hf]'); if (r) selectDevice(r.dataset.hf); });

// ------------------------------------------------------------------ panel buka/tutup, lembar bawah, menu (rencana 1 & 2)
const isPhone = () => window.matchMedia('(max-width:760px)').matches;
let UI = {};
try { UI = JSON.parse(localStorage.getItem('fobos.ui') || '{}'); } catch (e) { UI = {}; }
function saveUi() {
  UI.panels = UI.panels || {};
  document.querySelectorAll('.panel[data-key]').forEach((p) => { UI.panels[(isPhone() ? 'm_' : 'd_') + p.dataset.key] = p.classList.contains('min'); });
  UI.side = !$('#main').classList.contains('side-off'); UI.mode = colorMode;
  UI.acc = $('#chkAcc').checked; UI.shock = $('#chkShock').checked; UI.follow = $('#chkFollow').checked;
  try { localStorage.setItem('fobos.ui', JSON.stringify(UI)); } catch (e) { /* abaikan */ }
}
function applyPanels() {
  const pre = isPhone() ? 'm_' : 'd_'; const P = UI.panels || {};
  document.querySelectorAll('.panel[data-key]').forEach((p) => {
    const k = pre + p.dataset.key; const min = k in P ? P[k] : isPhone();     // di ponsel: tertutup sejak awal
    p.classList.toggle('min', min); p.querySelector('.tog').textContent = min ? '▸' : '▾';
  });
}
document.querySelectorAll('.panel[data-key] .ph').forEach((h) => h.addEventListener('click', () => {
  const p = h.parentElement; const min = !p.classList.contains('min');
  if (!min && isPhone()) document.querySelectorAll('.panel[data-key]').forEach((o) => { if (o !== p) { o.classList.add('min'); o.querySelector('.tog').textContent = '▸'; } });
  p.classList.toggle('min', min); h.querySelector('.tog').textContent = min ? '▸' : '▾';
  saveUi(); drawVib();
}));
function setSide(open) {
  $('#main').classList.toggle('side-off', !open); $('#btnSideOpen').hidden = open;
  setTimeout(() => map.invalidateSize(), 50); saveUi();
}
$('#btnSide').onclick = (e) => { e.stopPropagation(); setSide(false); };
$('#btnSideOpen').onclick = () => setSide(true);
// lembar bawah ponsel: tertutup (1 baris) / setengah / penuh; ketuk atau geser pegangan
const SHEET = ['min', 'half', 'full'];
function setSheet(st) { $('#main').dataset.sheet = st; }
(() => {
  const h = $('#sideHead'); let y0 = null, t0 = 0;
  h.addEventListener('pointerdown', (e) => { if (!isPhone() || e.target.closest('button')) return; y0 = e.clientY; t0 = Date.now(); h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointerup', (e) => {
    if (y0 === null) return; const dy = e.clientY - y0; y0 = null;
    const i = SHEET.indexOf($('#main').dataset.sheet || 'min');
    if (Math.abs(dy) < 12 && Date.now() - t0 < 600) setSheet(i === 0 ? 'half' : 'min');
    else if (dy < 0) setSheet(SHEET[Math.min(2, i + 1)]);
    else setSheet(SHEET[Math.max(0, i - 1)]);
  });
  h.addEventListener('pointercancel', () => { y0 = null; });
})();
// menu ⋮ (ponsel) dan tombol header
function go(what) {
  $('#menuPop').hidden = true;
  if (what === 'sessions') openSessions();
  else if (what === 'replay') openReplay();
  else if (what === 'expo') expoOn();
  else if (what === 'settings') openSettings();
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); go(b.dataset.go); }));
$('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menuPop').hidden = !$('#menuPop').hidden; };
document.addEventListener('click', (e) => { if (!$('#menuPop').hidden && !e.target.closest('#menuPop')) $('#menuPop').hidden = true; });
$('#chkAcc').onchange = () => { const d = devices.get(selected); accLayer.clearLayers(); accRef = accNow = null; if (d) updAccCircles(d, d.last); saveUi(); };
$('#chkShock').onchange = () => { for (const d of devices.values()) { if ($('#chkShock').checked) drawShocks(d); else d.shockLayer.clearLayers(); } saveUi(); };
$('#chkFollow').onchange = saveUi;
window.addEventListener('resize', () => { applyPanels(); drawVib(); });

// ------------------------------------------------------------------ mode pameran (B)
let wakeLock = null;
async function expoOn() {
  document.body.classList.add('expo');
  if (!selected && devices.size) selected = devices.keys().next().value;
  $('#vibPanel').classList.remove('min'); $('#vibPanel .tog').textContent = '▾';
  try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (e) { /* layar penuh ditolak: tetap jalan */ }
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  setTimeout(() => { map.invalidateSize(); const d = devices.get(selected); if (d && d.last && d.last.q > 0) map.setView([d.last.lat, d.last.lon], Math.max(map.getZoom(), 21)); }, 150);
  renderHud(); drawVib();
}
function expoOff() {
  document.body.classList.remove('expo');
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  applyPanels(); setTimeout(() => map.invalidateSize(), 150); drawVib();
}
$('#btnExpoExit').onclick = expoOff;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('expo') && !document.fullscreenElement) expoOff(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('expo')) expoOff(); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && document.body.classList.contains('expo') && navigator.wakeLock && !wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* abaikan */ } }
});

// ------------------------------------------------------------------ putar ulang banyak kendaraan (A, v2.5)
// Tiap rekaman = satu "kendaraan" dengan kontrolnya sendiri di kartu perangkat (putar/jeda, geser waktu, kecepatan, lewati jeda).
// Kontrol bersama (di atas daftar perangkat) bekerja pada kendaraan yang dicentang "grup".
const RP = { quiet: false, raf: false, last: 0, lastDraw: 0 };
let listPointer = false, listDirty = false;
$('#devList').addEventListener('pointerdown', () => { listPointer = true; });
window.addEventListener('pointerup', () => { if (!listPointer) return; listPointer = false; if (listDirty) { listDirty = false; setTimeout(scheduleRender, 0); } });
window.addEventListener('pointercancel', () => { listPointer = false; });
const rpList = () => [...devices.values()].filter((d) => d.replay && d.rp);
const rpGroup = () => rpList().filter((d) => d.rp.grp);
const RP_SPEEDS = [1, 2, 5, 10, 20, 50];
const RTK_Q = { 1: 4, 2: 3, 3: 2, 4: 2, 5: 1, 6: 2 };          // RTKLIB Q -> kelas kualitas web
const STATUS_Q = { FIX: 4, FLOAT: 3, DGNSS: 2, SINGLE: 1, TANPA_FIX: 0 };
function splitLines(t) { return t.split(/\r?\n/); }
function csvHeader(lines) { for (let i = 0; i < lines.length; i++) { const l = lines[i].trim(); if (l && !l.startsWith('#')) return { i, cols: l.split(',').map((c) => c.trim().toLowerCase()) }; } return null; }
function posFromCsv(text) {
  const lines = splitLines(text); const hd = csvHeader(lines); if (!hd) return [];
  const ix = (n) => hd.cols.indexOf(n); const c = {};
  for (const k of ['utc', 'gps_week', 'tow_s', 'lat', 'lon', 'h_msl', 'h_ell', 'q', 'status', 'num_sv', 'h_acc', 'v_acc', 'std_lat', 'std_lon', 'hdop', 'speed', 'heading', 'vib', 'seq']) c[k] = ix(k);
  const out = [];
  for (let i = hd.i + 1; i < lines.length; i++) {
    const l = lines[i]; if (!l) continue; const f = l.split(',');
    const lat = num(f[c.lat]), lon = num(f[c.lon]); if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    let q = c.q >= 0 ? num(f[c.q]) : null; if (q === null && c.status >= 0) q = STATUS_Q[(f[c.status] || '').trim()] ?? 1; if (q === null) q = 1;
    const tw = c.tow_s >= 0 ? num(f[c.tow_s]) : null;
    out.push({ lat, lon, q, h: num(f[c.h_msl]), hae: num(f[c.h_ell]), sv: num(f[c.num_sv]), hacc: num(f[c.h_acc]), vacc: num(f[c.v_acc]),
      slat: num(f[c.std_lat]), slon: num(f[c.std_lon]), hdop: num(f[c.hdop]), spd: num(f[c.speed]), hdg: num(f[c.heading]),
      vib: c.vib >= 0 ? num(f[c.vib]) : null, wk: num(f[c.gps_week]) || 0, tow: tw === null ? i * 100 : Math.round(tw * 1000), utc: c.utc >= 0 ? f[c.utc] : '' });
  }
  return out;
}
function imuTimeKey(cols) {           // kolom waktu IMU -> fungsi (baris) => detik GPS (bilangan bulat) atau null
  const ix = (n) => cols.indexOf(n);
  const iw = ix('gps_week'), it = ix('tow_s');
  if (it >= 0) return (f) => { const t = num(f[it]); return t === null ? null : (num(f[iw]) || 0) * 604800 + t; };
  const iu = ['time_s', 'time', 'timestamp', 'unix_s', 'unix', 't', 'epoch'].map(ix).find((i) => i >= 0);
  if (iu === undefined) return null;
  return (f) => {                     // waktu Unix (UTC) dalam detik atau milidetik -> detik GPS
    let t = num(f[iu]); if (t === null || t < 1e8) return null;
    if (t > 1e11) t /= 1000;
    return t - GPS_EPOCH_MS / 1000 + LEAP_S;
  };
}
function vibFromImuCsv(text) {        // Map(detik GPS -> indeks getaran); 5 Hz web: kolom vib; IMU mentah (100–200 Hz): dihitung seperti firmware
  const lines = splitLines(text); const hd = csvHeader(lines); const out = new Map(); if (!hd) return { map: out, kind: '' };
  const ix = (n) => hd.cols.indexOf(n);
  const iv = ix('vib'), iax = ix('ax'), iay = ix('ay'), iaz = ix('az'), itf = ix('tflag');
  const tk = imuTimeKey(hd.cols); if (!tk) return { map: out, kind: '', err: 'kolom waktu tidak dikenali (perlu tow_s, atau time_s waktu Unix)' };
  if (iv >= 0) {
    for (let i = hd.i + 1; i < lines.length; i++) { const f = lines[i].split(','); const v = num(f[iv]); const t = tk(f); if (v === null || t === null) continue;
      const key = Math.floor(t); if (!out.has(key)) out.set(key, v); }
    return { map: out, kind: 'IMU 5 Hz' };
  }
  if (iax < 0 || iay < 0 || iaz < 0) return { map: out, kind: '', err: 'kolom ax, ay, az tidak ada' };
  let key = null, acc = null, skipped = 0, n = 0, gsum = 0, t0 = null, t1 = null;
  const raw = [];
  for (let i = hd.i + 1; i < lines.length; i++) {
    const f = lines[i].split(','); if (f.length < 4) continue;
    if (itf >= 0 && Number(f[itf]) === 0) { skipped++; continue; }        // stempel waktu lokal: tidak bisa disandingkan dengan posisi
    const t = tk(f); const ax = num(f[iax]), ay = num(f[iay]), az = num(f[iaz]); if (t === null || ax === null || ay === null || az === null) continue;
    raw.push(t, ax, ay, az); n++; if (n <= 500) gsum += Math.hypot(ax, ay, az);
    if (t0 === null) t0 = t; t1 = t;
  }
  const k = n && gsum / Math.min(n, 500) < 3 ? 9.80665 : 1;            // data dalam satuan g -> m/s²
  const fin = () => { if (acc && acc.n >= 10) { const r = vibRms(acc); if (r !== null) out.set(key, r); } };
  for (let j = 0; j < raw.length; j += 4) {
    const kk = Math.floor(raw[j]); const ax = raw[j + 1] * k, ay = raw[j + 2] * k, az = raw[j + 3] * k;
    if (kk !== key) { fin(); key = kk; acc = { s: [0, 0, 0], ss: [0, 0, 0, 0, 0, 0], n: 0 }; }
    acc.s[0] += ax; acc.s[1] += ay; acc.s[2] += az; acc.ss[0] += ax * ax; acc.ss[1] += ay * ay; acc.ss[2] += az * az;
    acc.ss[3] += ax * ay; acc.ss[4] += ax * az; acc.ss[5] += ay * az; acc.n++;
  }
  fin();
  const hz = t1 > t0 ? Math.round(n / (t1 - t0)) : 0;
  return { map: out, kind: `IMU ${hz} Hz${k !== 1 ? ' (satuan g)' : ''}`, skipped };
}
function vibRms(a) {                  // sama dengan VibAcc::rms() di firmware: simpangan baku percepatan searah gravitasi rata-rata
  const n = a.n; const m = [a.s[0] / n, a.s[1] / n, a.s[2] / n]; const g = Math.hypot(m[0], m[1], m[2]); if (g < 1e-6) return null;
  const u = [m[0] / g, m[1] / g, m[2] / g];
  const cxx = a.ss[0] / n - m[0] * m[0], cyy = a.ss[1] / n - m[1] * m[1], czz = a.ss[2] / n - m[2] * m[2];
  const cxy = a.ss[3] / n - m[0] * m[1], cxz = a.ss[4] / n - m[0] * m[2], cyz = a.ss[5] / n - m[1] * m[2];
  const v = u[0] * u[0] * cxx + u[1] * u[1] * cyy + u[2] * u[2] * czz + 2 * (u[0] * u[1] * cxy + u[0] * u[2] * cxz + u[1] * u[2] * cyz);
  return v > 0 ? Math.sqrt(v) : 0;
}
function posFromRtklib(text) {
  const lines = splitLines(text); let utc = false, ok = false; const out = [];
  for (const l of lines) {
    if (l.startsWith('%')) { if (/latitude\(deg\)/i.test(l)) { ok = true; utc = /\bUTC\b/.test(l) && !/GPST/.test(l); } continue; }
    if (!ok || !l.trim()) continue;
    const s = l.trim().split(/\s+/); let wk, tow, o;
    if (s[0].includes('/')) {
      const [Y, M, D] = s[0].split('/').map(Number); const [hh, mm, ss] = s[1].split(':'); const sec = Number(ss);
      let ms = Date.UTC(Y, M - 1, D, Number(hh), Number(mm), Math.floor(sec)) + Math.round((sec - Math.floor(sec)) * 1000);
      if (utc) ms += LEAP_S * 1000;
      const g = ms - GPS_EPOCH_MS; wk = Math.floor(g / 604800000); tow = g - wk * 604800000; o = 2;
    } else { wk = Number(s[0]); tow = Math.round(Number(s[1]) * 1000); o = 2; }
    const lat = num(s[o]), lon = num(s[o + 1]); if (lat === null || lon === null) continue;
    const Q = Number(s[o + 3]); const sdn = num(s[o + 5]), sde = num(s[o + 6]);
    out.push({ lat, lon, h: null, hae: num(s[o + 2]), q: RTK_Q[Q] ?? 1, sv: num(s[o + 4]), slat: sdn, slon: sde,
      hacc: sdn !== null && sde !== null ? Math.hypot(sdn, sde) : null, spd: null, vib: null, wk, tow });
  }
  if (!ok) throw new Error('File .pos tidak berformat lat/lon derajat (atur RTKLIB: Solution Format = Lat/Lon/Height, derajat).');
  for (let i = 1; i < out.length; i++) {         // kecepatan dari selisih posisi (RTKLIB .pos tidak menyimpannya)
    const a = out[i - 1], b = out[i]; const dt = ((b.wk - a.wk) * 604800000 + b.tow - a.tow) / 1000;
    if (dt > 0 && dt <= 2) b.spd = haversine(a, b) / dt;
  }
  return out;
}
async function unzip(buf) {          // ZIP "store" atau "deflate" (DecompressionStream bawaan browser)
  const u8 = new Uint8Array(buf); const dv = new DataView(buf); let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('bukan file ZIP');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = []; const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true); const raw = u8.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8 && 'DecompressionStream' in window) {
      const ab = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      out.push({ name, data: new Uint8Array(ab) });
    } else console.warn('metode kompresi ZIP tidak didukung', name, method);
  }
  return out;
}

// ---- membaca file: banyak posisi + banyak IMU sekaligus; IMU dipasangkan ke rekaman posisi dengan rentang waktu yang paling bertumpang tindih
async function readItems(fileList) {
  const items = [];
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) { for (const z of await unzip(await f.arrayBuffer())) items.push({ name: z.name.split('/').pop(), zip: f.name, text: () => new TextDecoder().decode(z.data) }); }
    else items.push({ name: f.name, text: () => f.text() });
  }
  const pos = [], imu = [];
  for (const it of items) {
    const nm = it.name.toLowerCase(); if (!/\.(csv|pos|txt)$/.test(nm)) continue;
    const text = await it.text(); const head = text.slice(0, 4000);
    if (/\.pos$/.test(nm) || /^%.*latitude\(deg\)/im.test(head)) { pos.push({ kind: 'rtklib', name: it.name, zip: it.zip, text }); continue; }
    const hl = (csvHeader(splitLines(head)) || { cols: [] }).cols;
    if (hl.includes('lat') && hl.includes('lon')) pos.push({ kind: 'csv', name: it.name, zip: it.zip, text });
    else if ((hl.includes('ax') && hl.includes('az')) || hl.includes('vib')) imu.push({ name: it.name, zip: it.zip, text });
  }
  // .zip unduhan web berisi posisi + IMU 5 Hz: bila dari zip yang sama, utamakan pasangan dalam zip itu
  return { pos, imu };
}
function imuAttach(pts, v) {          // tempel indeks getaran ke titik posisi (per detik GPS); kembalikan jumlah titik yang cocok
  let hit = 0;
  for (const p of pts) { const k = Math.floor(p._t / 1000); if (v.map.has(k)) { p.vib = v.map.get(k); hit++; } }
  return hit;
}
function imuOverlap(pts, v) {
  if (!v.map.size || !pts.length) return 0;
  const a = Math.floor(pts[0]._t / 1000), b = Math.floor(pts[pts.length - 1]._t / 1000); let n = 0;
  for (const k of v.map.keys()) if (k >= a && k <= b) n++;
  return n;
}
function prepPts(pts) {
  pts = pts.filter((p) => p.q > 0 && isFinite(p.lat) && isFinite(p.lon));
  for (const p of pts) p._t = devTime(p);
  pts.sort((a, b) => a._t - b._t);
  return pts;
}
async function replayFromFiles(fileList) {
  const { pos, imu } = await readItems(fileList);
  if (!pos.length) { toast('Tidak ada file posisi (_pos.csv, _web_posisi.csv, atau .pos RTKLIB) di pilihan anda.', 6000); return; }
  const tracks = [];
  for (const f of pos) {
    let pts; try { pts = prepPts(f.kind === 'rtklib' ? posFromRtklib(f.text) : posFromCsv(f.text)); } catch (e) { toast(`${f.name}: ${e.message || e}`, 7000); continue; }
    if (pts.length < 2) { toast(`${f.name}: titik posisi terlalu sedikit.`, 5000); continue; }
    tracks.push({ f, pts, name: f.name.replace(/\.(csv|pos|txt)$/i, '').replace(/_(web_posisi|pos)$/i, ''), imu: null });
  }
  const notes = [];
  for (const m of imu) {
    const v = vibFromImuCsv(m.text);
    if (!v.map.size) { notes.push(`${m.name}: ${v.err || 'tidak terbaca'}`); continue; }
    let best = null, bn = 0;
    for (const t of tracks) { if (t.imu && t.imu.hit) continue; const n = imuOverlap(t.pts, v) + (m.zip && m.zip === t.f.zip ? 1e6 : 0); if (n > bn) { bn = n; best = t; } }
    if (!best) { notes.push(`${m.name}: waktunya tidak bertumpang tindih dengan rekaman posisi mana pun`); continue; }
    best.imu = { name: m.name, kind: v.kind, hit: imuAttach(best.pts, v), skipped: v.skipped };
  }
  for (const t of tracks) addReplay(t.name, t.pts, t.f.name, t.imu, false);
  if (tracks.length) replayFitAll(tracks.length > 1 ? null : undefined);
  const msg = tracks.map((t) => `${t.name}${t.imu ? ' + getaran (' + t.imu.kind + ')' : ''}`).join(', ');
  if (tracks.length) toast(`Dimuat: ${msg}. Tekan ▶ pada kartu, atau "Mulai bersamaan".` + (notes.length ? ' Catatan: ' + notes.join('; ') : ''), notes.length ? 9000 : 5000);
  else if (notes.length) toast(notes.join('; '), 8000);
}
async function replayFromSession(sess) {
  const f = await sessionFiles(sess);
  const pts = prepPts(f.pts.filter((p) => p.q > 0).map((p) => Object.assign({}, p)));
  if (pts.length < 2) { toast('Sesi ini tidak berisi titik posisi yang cukup.'); return; }
  addReplay(sess, pts, 'rekaman browser', { name: 'IMU 5 Hz (sesi)', kind: 'sesi', hit: pts.filter((p) => p.vib != null).length }, true);
}
function addReplay(name, pts, src, imu, play) {
  let id = '▶ ' + (name.length > 22 ? name.slice(0, 22) + '…' : name); const base = id;
  for (let k = 2; devices.has(id); k++) id = `${base} (${k})`;
  const d = dev(id, { replay: true, select: true }); d.src = src; if (UI.rpNames && UI.rpNames[src]) d.label = UI.rpNames[src];
  d.rp = { pts, idx: 0, t0: pts[0]._t, t1: pts[pts.length - 1]._t, cur: pts[0]._t, playing: false, speed: Number(UI.rpSpeed) || 5, skip: true, grp: true, imu, loopAt: 0,
    ghost: L.polyline(pts.map((p) => [p.lat, p.lon]), { color: d.color, weight: 3, opacity: 0.35, dashArray: '4 7', interactive: false }).addTo(map) };
  document.body.classList.add('replaying');
  replaySeek(d, d.rp.t0);
  selectDevice(id); scheduleRender();
  if (play) { replayFitAll(); replayPlay(d, true); }
  return d;
}
async function replayAddImu(d, file) {
  try {
    const { imu } = await readItems([file]); if (!imu.length) { toast('File itu bukan CSV IMU (perlu kolom ax, ay, az dan waktu).', 6000); return; }
    const v = vibFromImuCsv(imu[0].text); if (!v.map.size) { toast(`${imu[0].name}: ${v.err || 'tidak terbaca'}`, 6000); return; }
    if (!imuOverlap(d.rp.pts, v)) { toast(`Waktu ${imu[0].name} tidak bertumpang tindih dengan ${dn(d)}: getaran tidak dipasang (IMU lama tetap dipakai).`, 7000); return; }
    for (const p of d.rp.pts) p.vib = null;
    const hit = imuAttach(d.rp.pts, v);
    d.rp.imu = { name: imu[0].name, kind: v.kind, hit, skipped: v.skipped };
    replaySeek(d, d.rp.cur);
    toast(`Getaran dari ${imu[0].name} (${v.kind}) dipasang: ${Math.round(100 * hit / d.rp.pts.length)}% titik posisi punya nilai getaran.`, 5000);
  } catch (e) { toast('Gagal membaca IMU: ' + (e.message || e), 6000); }
}
function replayFeed(d, p, live) {
  d.last = p; d.lastRx = Date.now();
  addPoint(d, p); placeMarker(d, p);
  const sec = Math.floor(p._t / 1000);
  if (sec !== d.vibSec) { d.vibSec = sec; pushVib(d, p.vib, p._t); RP.quiet = !live; evalShock(d, p.vib, p._t); RP.quiet = false; }
  if (live) followTo(d, p);
}
function replayReset(d) {
  d.pts = []; d.layer.clearLayers(); d.segs = []; d.cur = null; d.marker = null; d.sg = null; d.st = newStats();
  d.shocks = []; d.shockLayer.clearLayers(); d.vib = []; d.vibSec = null; d.lastShockT = -1e15; d.last = null;
}
function replaySeek(d, t) {
  const r = d.rp; r.cur = Math.max(r.t0, Math.min(r.t1, t)); r.loopAt = 0;
  replayReset(d); r.idx = 0;
  while (r.idx < r.pts.length && r.pts[r.idx]._t <= r.cur) replayFeed(d, r.pts[r.idx++], false);
  if (d.last && d.id === selected && $('#chkFollow').checked) { const p = d.last; if (!map.getBounds().pad(-0.2).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon], { animate: false }); }
  rpCardUi(d); scheduleRender(); if (d.id === selected) drawVib();
}
function replayPlay(d, on) {
  const r = d.rp; if (on && r.idx >= r.pts.length) replaySeek(d, r.t0);      // diputar dari awal lagi
  r.playing = on; r.loopAt = 0; rpCardUi(d); renderRpMaster();
  if (on && !RP.raf) { RP.raf = true; RP.last = performance.now(); requestAnimationFrame(replayTick); }
}
function replayTick(ts) {
  const all = rpList(); const dt = Math.min(250, ts - RP.last); RP.last = ts; let any = false;
  for (const d of all) {
    const r = d.rp;
    if (r.loopAt) { any = true; if (ts >= r.loopAt) { replaySeek(d, r.t0); r.playing = true; rpCardUi(d); } continue; }
    if (!r.playing) continue; any = true;
    r.cur += dt * r.speed;
    const nx = r.pts[r.idx];
    if (nx && r.skip && nx._t - r.cur > 3000) r.cur = nx._t - 200;                // lewati jeda (kendaraan berhenti / data putus)
    while (r.idx < r.pts.length && r.pts[r.idx]._t <= r.cur) replayFeed(d, r.pts[r.idx++], true);
    if (r.idx >= r.pts.length) {
      r.cur = r.t1; r.playing = false;
      if (UI.rpLoop) r.loopAt = ts + 2000;                                          // ulang otomatis setelah jeda 2 detik
      else toast(`Putar ulang ${dn(d)} selesai.`);
      renderRpMaster();
    }
  }
  if (ts - RP.lastDraw > 200) { RP.lastDraw = ts; for (const d of all) rpCardUi(d); drawVib(); scheduleRender(); }
  if (any) requestAnimationFrame(replayTick); else { RP.raf = false; for (const d of all) rpCardUi(d); renderRpMaster(); }
}
function replayRemove(d) {
  if (d.rp && d.rp.ghost) map.removeLayer(d.rp.ghost);
  d.rp = null; removeDevice(d.id);
  if (!rpList().length) document.body.classList.remove('replaying');
  renderRpMaster();
}
function replayStop() { for (const d of rpList()) replayRemove(d); }       // tutup semua putar ulang
function replayFitAll(onlyGroup) {
  const ds = onlyGroup ? rpGroup() : rpList(); if (!ds.length) return;
  const b = L.latLngBounds([]); for (const d of ds) b.extend(d.rp.ghost.getBounds());
  if (b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 19 });
}
// ---- kontrol bersama
function rpAll(cmd) {
  const g = rpGroup(); if (!g.length) { toast('Centang "grup" pada kartu kendaraan yang ingin dikendalikan bersama.', 4000); return; }
  if (cmd === 'sync') { for (const d of g) { replaySeek(d, d.rp.t0); } replayFitAll(true); for (const d of g) replayPlay(d, true); }
  else if (cmd === 'play') for (const d of g) replayPlay(d, true);
  else if (cmd === 'pause') for (const d of g) { d.rp.loopAt = 0; replayPlay(d, false); }
}
function renderRpMaster() {
  const box = $('#rpMaster'); const all = rpList();
  const mini = $('#rpMini');
  if (!all.length) { box.hidden = true; box.innerHTML = ''; if (mini) mini.hidden = true; return; }
  const g = rpGroup(); const playing = g.some((d) => d.rp.playing || d.rp.loopAt);
  const sp = Number(UI.rpSpeed) || 5;
  const html = `<div class="rpm-h"><b>Putar ulang</b> <span class="muted small">${all.length} kendaraan · ${g.length} di grup</span></div>
    <div class="rpm-b">
      <button class="primary" data-rpm="sync" title="Semua kendaraan di grup mulai dari awal rekamannya masing-masing pada saat yang sama">⏮▶ Mulai bersamaan</button>
      <button data-rpm="${playing ? 'pause' : 'play'}">${playing ? '❚❚ Jeda grup' : '▶ Lanjut grup'}</button>
      <select data-rpm="speed" title="Kecepatan untuk semua kendaraan di grup">${RP_SPEEDS.map((v) => `<option value="${v}"${v === sp ? ' selected' : ''}>${v}×</option>`).join('')}</select>
      <label class="small nowrap"><input type="checkbox" data-rpm="loop"${UI.rpLoop ? ' checked' : ''}> ulang otomatis</label>
    </div>
    <div class="rpm-b">
      <button data-rpm="fit">⤢ Tampilkan semua</button><button data-rpm="add">＋ Tambah rekaman</button><button data-rpm="close" class="danger">Tutup semua</button>
    </div>`;
  const key = html; if (box._k !== key) { box._k = key; if (!(document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) box.innerHTML = html; }
  box.hidden = false;
  if (mini) { mini.hidden = false; $('#rpMiniPlay').textContent = playing ? '❚❚' : '▶'; $('#rpMiniTxt').textContent = `${all.length} kendaraan`; }
  const sb = $('#rpSheetBtn'); if (sb) { sb.hidden = false; sb.textContent = playing ? '❚❚' : '▶'; }
}
function rpMasterAct(cmd, el) {
  if (cmd === 'sync' || cmd === 'play' || cmd === 'pause') rpAll(cmd);
  else if (cmd === 'fit') replayFitAll();
  else if (cmd === 'add') openReplay();
  else if (cmd === 'close') replayStop();
  else if (cmd === 'loop') { UI.rpLoop = el.checked; saveUi(); }
  else if (cmd === 'speed') { UI.rpSpeed = Number(el.value); saveUi(); for (const d of rpGroup()) d.rp.speed = UI.rpSpeed; for (const d of rpList()) rpCardUi(d); scheduleRender(); }
  renderRpMaster();
}
$('#rpMaster').addEventListener('click', (e) => { const b = e.target.closest('button[data-rpm]'); if (b) rpMasterAct(b.dataset.rpm, b); });
$('#rpMaster').addEventListener('change', (e) => { const c = e.target.dataset.rpm; if (c === 'loop' || c === 'speed') rpMasterAct(c, e.target); });
function rpToggleGroupPlay() { const g = rpGroup(); rpAll(g.some((d) => d.rp.playing || d.rp.loopAt) ? 'pause' : 'play'); }
// ---- kartu per kendaraan
function rpTimeText(r) {
  const tot = r.t1 - r.t0 || 1, el = r.cur - r.t0;
  return `${fmtDur(el / 1000)} / ${fmtDur(tot / 1000)}`;
}
function rpClockText(r) { const dt = new Date(GPS_EPOCH_MS + r.cur - LEAP_S * 1000); return `${clockLabel(r.cur)} · ${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`; }
function replayCard(d, p) {
  if (!d.rp) return "";
  const r = d.rp; const tot = r.t1 - r.t0 || 1;
  const imu = r.imu ? `${esc(r.imu.name)} · ${esc(r.imu.kind)} · ${Math.round(100 * r.imu.hit / r.pts.length)}% titik` : '<span class="muted">belum ada — getaran kosong</span>';
  const st = r.loopAt ? 'mengulang…' : r.playing ? 'berjalan' : r.idx >= r.pts.length ? 'selesai' : 'dijeda';
  return `<div class="card rpc ${selected === d.id ? 'sel' : ''}" data-id="${esc(d.id)}">
    <h4><span class="rp-nm"><i class="dot" style="background:${d.color}"></i><span class="rp-label">${esc(dn(d))}</span><button class="icon rp-ed" data-act="rpname" title="Ganti nama">✎</button></span>
      <span class="rp-hr"><label class="small rp-grp" title="Ikut dikendalikan tombol bersama"><input type="checkbox" data-act="rpgrp"${r.grp ? ' checked' : ''}> grup</label><span class="badge rp">${st}</span></span></h4>
    <div class="rp-ctl">
      <button class="primary icon" data-act="rpplay" aria-label="Putar/jeda">${r.playing || r.loopAt ? '❚❚' : '▶'}</button>
      <input type="range" class="rp-sl" data-act="rpseek" min="0" max="1000" value="${Math.round(1000 * (r.cur - r.t0) / tot)}" aria-label="Posisi waktu">
      <select data-act="rpspeed" aria-label="Kecepatan">${RP_SPEEDS.map((v) => `<option value="${v}"${v === r.speed ? ' selected' : ''}>${v}×</option>`).join('')}</select>
    </div>
    <div class="rp-ctl2 small"><span class="rp-tm">${rpTimeText(r)}</span><span class="rp-ck muted">${esc(rpClockText(r))}</span>
      <label class="nowrap"><input type="checkbox" data-act="rpskip"${r.skip ? ' checked' : ''}> lewati jeda</label></div>
    <div class="kv">
      <span>Posisi</span><span class="q${p.q ?? 0}">${qName(p.q ?? 0)} · ±${fmtAcc(p.hacc)} · ${p.sv ?? '–'} sat</span>
      <span>Kecepatan</span><span>${p.spd != null ? (p.spd * 3.6).toFixed(1) + ' km/j' : '–'}</span>
      <span>Getaran</span><span>${p.vib != null ? p.vib.toFixed(2) + ' m/s²' : '–'}</span>
      <span>File posisi</span><span>${esc(d.src || '')}</span>
      <span>File IMU</span><span>${imu}</span>
    </div>
    <div class="actions"><button data-act="rpimu">${r.imu ? 'Ganti IMU' : '＋ IMU (.csv)'}</button><button data-act="zoom">Ke kendaraan</button><button data-act="rpclose" class="danger">✕ Tutup</button></div></div>`;
}
function rpCardUi(d) {               // pembaruan ringan tanpa membangun ulang kartu
  const card = $('#devList').querySelector(`.card[data-id="${CSS.escape(d.id)}"]`); if (!card || !d.rp) return;
  const r = d.rp; const sl = card.querySelector('.rp-sl');
  if (sl && document.activeElement !== sl && !listPointer) sl.value = Math.round(1000 * (r.cur - r.t0) / (r.t1 - r.t0 || 1));
  const tm = card.querySelector('.rp-tm'); if (tm) tm.textContent = rpTimeText(r);
  const ck = card.querySelector('.rp-ck'); if (ck) ck.textContent = rpClockText(r);
  const pb = card.querySelector('[data-act="rpplay"]'); if (pb) pb.textContent = r.playing || r.loopAt ? '❚❚' : '▶';
}
const imuPick = document.createElement('input'); imuPick.type = 'file'; imuPick.accept = '.csv,.txt,.zip'; imuPick.hidden = true; document.body.appendChild(imuPick);
imuPick.addEventListener('change', () => { const d = devices.get(imuPick.dataset.id); const f = imuPick.files[0]; imuPick.value = ''; if (d && d.rp && f) replayAddImu(d, f); });
function replayAct(id, act, el) {
  const d = devices.get(id); if (!d || !d.rp) return;
  if (act === 'rpplay') { if (d.rp.loopAt) { d.rp.loopAt = 0; replayPlay(d, false); } else replayPlay(d, !d.rp.playing); }
  else if (act === 'rpclose') replayRemove(d);
  else if (act === 'rpimu') { imuPick.dataset.id = id; imuPick.click(); }
  else if (act === 'rpname') rpRename(d);
}
function rpRename(d) {
  const card = $('#devList').querySelector(`.card[data-id="${CSS.escape(d.id)}"]`); if (!card) return;
  const lab = card.querySelector('.rp-label'); const inp = document.createElement('input');
  inp.className = 'rp-in'; inp.value = dn(d); inp.maxLength = 24; lab.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const fin = (ok) => {
    if (done) return; done = true;
    const v = inp.value.trim(); if (ok && v) { d.label = v; UI.rpNames = UI.rpNames || {}; UI.rpNames[d.src] = v; saveUi(); if (d.marker) d.marker.setTooltipContent(dn(d)); }
    inp.blur(); renderDevices(); drawVib();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); e.stopPropagation(); });
  inp.addEventListener('blur', () => fin(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}
$('#devList').addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'rpseek') return;
  const d = devices.get(e.target.closest('.card').dataset.id); if (!d || !d.rp) return;
  const r = d.rp; replaySeek(d, r.t0 + (r.t1 - r.t0) * Number(e.target.value) / 1000);
});
$('#devList').addEventListener('change', (e) => {
  const act = e.target.dataset.act; if (!act || !act.startsWith('rp')) return;
  const d = devices.get(e.target.closest('.card').dataset.id); if (!d || !d.rp) return;
  if (act === 'rpspeed') d.rp.speed = Number(e.target.value);
  else if (act === 'rpskip') d.rp.skip = e.target.checked;
  else if (act === 'rpgrp') { d.rp.grp = e.target.checked; renderRpMaster(); }
  e.target.blur();
});
$('#rpMiniPlay').onclick = rpToggleGroupPlay;
$('#rpSheetBtn').onclick = (e) => { e.stopPropagation(); rpToggleGroupPlay(); };
$('#rpSheetBtn').addEventListener('pointerdown', (e) => e.stopPropagation());
async function openReplay() {
  const list = (await Store.sessions()).sort((a, b) => b.created - a.created);
  $('#rpSessList').innerHTML = list.length
    ? list.map((r) => `<div class="sess"><b>${esc(r.sess)}</b> <span class="muted">${esc(r.dev)} · ${new Date(r.created).toLocaleString()} · posisi ${(r.n && r.n.pvt) || 0}</span>
        <div class="actions"><button data-play="${esc(r.sess)}" class="primary">＋ Tambahkan</button></div></div>`).join('')
    : '<span class="muted">Belum ada rekaman di browser ini.</span>';
  $('#rpFiles').value = ''; $('#dlgReplay').showModal();
}
$('#rpSessList').addEventListener('click', (e) => { const s = e.target.dataset.play; if (s) { $('#dlgReplay').close(); replayFromSession(s); } });
$('#rpFiles').addEventListener('change', async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  $('#dlgReplay').close(); toast('Membaca file…', 2000);
  try { await replayFromFiles(files); } catch (err) { console.error(err); toast('Gagal membaca file: ' + (err.message || err), 7000); }
});
$('#btnCloseReplay').onclick = () => $('#dlgReplay').close();

// ------------------------------------------------------------------ mulai
(async () => {
  await Store.open();
  if (UI.mode && ['q', 'v', 's', 'w'].includes(UI.mode)) { colorMode = UI.mode; document.querySelectorAll('#legend .seg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === colorMode)); }
  if (UI.acc === false) $('#chkAcc').checked = false;
  if (UI.shock === false) $('#chkShock').checked = false;
  if (UI.follow === false) $('#chkFollow').checked = false;
  applyPanels(); if (UI.side === false && !isPhone()) setSide(false);
  renderLegend(); drawVib();
  if (!Store.ok) toast('Browser tidak mengizinkan IndexedDB: rekaman raw hanya di memori selama tab terbuka.', 7000);
  if ((CFG.mode === 'cloud' && CFG.cloudUrl && (CFG.cloudUser || CFG.cloudPass)) || (CFG.mode === 'local' && CFG.localUrl)) connect();
})();
