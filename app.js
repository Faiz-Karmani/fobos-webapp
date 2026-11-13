/* Fobos Mini — web app pemantauan (Leaflet + OpenStreetMap + MQTT over WebSocket).
 * Tanpa server: semua berjalan di browser. Raw GNSS/IMU selama sesi disimpan di IndexedDB.
 * Format pesan: lihat PANDUAN.md bagian "Protokol". */
'use strict';

// ------------------------------------------------------------------ konfigurasi
const DEF = { mode: 'cloud', cloudUrl: 'wss://mqtt.flespi.io:443', cloudUser: '', cloudPass: '', remember: false, autoZip: true,
  localUrl: '', prefix: 'fobos', vibTh: '0.5,1,2' };
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
const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([-2.5, 118], 5);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const Q_INFO = { 4: ['RTK fix', '#1a9850'], 3: ['RTK float', '#f39c12'], 2: ['DGNSS', '#2c7fb8'], 1: ['Single', '#d73027'], 0: ['Tanpa fix', '#9e9e9e'] };
const V_COLORS = ['#1a9850', '#d9c800', '#f39c12', '#d73027'];
const DEV_COLORS = ['#1f5fbf', '#8e24aa', '#00897b', '#6d4c41', '#c2185b', '#455a64'];
let colorMode = 'q';
function vibTh() { return CFG.vibTh.split(',').map(Number).filter((x) => !isNaN(x)).sort((a, b) => a - b); }
function vibClass(v) { if (v === null || v === undefined || isNaN(v)) return -1; const th = vibTh(); let i = 0; while (i < th.length && v >= th[i]) i++; return Math.min(i, V_COLORS.length - 1); }
function segColor(cls) { return colorMode === 'q' ? Q_INFO[cls][1] : (cls < 0 ? '#9e9e9e' : V_COLORS[cls]); }
function ptClass(p) { return colorMode === 'q' ? p.q : vibClass(p.vib); }
function renderLegend() {
  let h = '';
  if (colorMode === 'q') for (const q of [4, 3, 2, 1, 0]) h += `<div class="lg"><i style="background:${Q_INFO[q][1]}"></i>${Q_INFO[q][0]}</div>`;
  else {
    const th = vibTh(); const lab = ['< ' + th[0]]; for (let i = 0; i < th.length - 1; i++) lab.push(`${th[i]}–${th[i + 1]}`); lab.push('≥ ' + th[th.length - 1]);
    lab.forEach((l, i) => { h += `<div class="lg"><i style="background:${V_COLORS[Math.min(i, 3)]}"></i>${l} m/s²</div>`; });
    h += '<div class="lg"><i style="background:#9e9e9e"></i>tanpa data</div>';
  }
  $('#legendBody').innerHTML = h;
}
document.querySelectorAll('#legend .seg button').forEach((b) => b.onclick = () => {
  colorMode = b.dataset.mode; document.querySelectorAll('#legend .seg button').forEach((x) => x.classList.toggle('on', x === b));
  renderLegend(); for (const d of devices.values()) redrawTrack(d);
});

// ------------------------------------------------------------------ perangkat
const devices = new Map();
let selected = null;
function dev(id) {
  let d = devices.get(id);
  if (d) return d;
  const color = DEV_COLORS[devices.size % DEV_COLORS.length];
  d = { id, color, pts: [], segs: [], cur: null, marker: null, status: null, last: null, lastRx: 0, vib: [],
        sess: '', rec: null, pvtBuf: [], imuBuf: [], imu: null, imuRx: 0 };
  d.layer = L.layerGroup().addTo(map);
  devices.set(id, d);
  if (!selected) selected = id;
  renderDevices();
  return d;
}
function addPoint(d, p) {
  d.pts.push(p);
  const cls = ptClass(p);
  const prev = d.pts.length > 1 ? d.pts[d.pts.length - 2] : null;
  const gap = prev && (Math.abs(p.tow - prev.tow) > 5000);
  if (!d.cur || d.cur.cls !== cls || gap) {
    const ll = (prev && !gap) ? [[prev.lat, prev.lon], [p.lat, p.lon]] : [[p.lat, p.lon]];
    const pl = L.polyline(ll, { color: segColor(cls), weight: 5, opacity: 0.9 }).addTo(d.layer);
    d.cur = { cls, pl }; d.segs.push(pl);
  } else d.cur.pl.addLatLng([p.lat, p.lon]);
}
function redrawTrack(d) {
  d.layer.clearLayers(); d.segs = []; d.cur = null; d.marker = null;
  const pts = d.pts; d.pts = [];
  for (const p of pts) addPoint(d, p);
  if (d.last) placeMarker(d, d.last);
}
function placeMarker(d, p) {
  if (!d.marker) {
    d.marker = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: d.color, fillOpacity: 1 }).addTo(d.layer);
    d.marker.bindTooltip(d.id, { permanent: true, direction: 'top', offset: [0, -8] });
    d.marker.on('click', () => { selected = d.id; renderDevices(); drawVib(); });
  } else d.marker.setLatLng([p.lat, p.lon]);
}
function clearTrack(id) { const d = devices.get(id); if (!d) return; d.pts = []; d.layer.clearLayers(); d.segs = []; d.cur = null; d.marker = null; if (d.last) placeMarker(d, d.last); }

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

function pushVib(d, v) {
  if (v === null || v === undefined) return;
  d.vib.push({ t: Date.now(), v }); if (d.vib.length > 1200) d.vib.shift();
}
function onPvt(id, p) {
  const d = dev(id);
  d.last = p; d.lastRx = Date.now();
  if (p.sess !== undefined) syncSession(d, p.sess);
  if (p.q > 0 && isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0)) {
    addPoint(d, p); placeMarker(d, p);
    if (selected === id && $('#chkFollow').checked) {
      if (!d._zoomed) { map.setView([p.lat, p.lon], 18); d._zoomed = true; } else if (!map.getBounds().pad(-0.2).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon]);
    }
  }
  // grafik getaran dari PVT hanya bila pesan IMU tidak datang
  if (Date.now() - (d.imuRx || 0) > 3000 && p.tow % 1000 < 100) pushVib(d, p.vib);
  if (d.rec) { d.pvtBuf.push(p); d.rec.n.pvt++; d.rec.seq.pvt.push(p.seq); }
  scheduleRender();
}
// ringkasan IMU 5 Hz: rata-rata 200 ms + indeks getaran per detik
function onImu(id, m) {
  const d = dev(id);
  d.imu = m; d.imuRx = Date.now(); d.lastRx = Date.now();
  pushVib(d, m.vib);
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
let renderPending = false;
function scheduleRender() { if (!renderPending) { renderPending = true; requestAnimationFrame(() => { renderPending = false; renderDevices(); }); } }
function renderDevices() {
  const list = $('#devList'); $('#devCount').textContent = devices.size;
  if (document.activeElement && document.activeElement.tagName === 'SELECT' && list.contains(document.activeElement)) return;   // jangan ganggu pilihan yang sedang dibuka
  if (!devices.size) return;
  const now = Date.now(); let h = '';
  for (const d of devices.values()) {
    const p = d.last || {}; const s = d.status || {};
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
  if (!act) { selected = id; renderDevices(); drawVib(); return; }
  if (act === 'start') startSession(id);
  else if (act === 'stop') stopSession(id);
  else if (act === 'csv' || act === 'geojson') exportTrack(id, act);
  else if (act === 'zoom') { const d = devices.get(id); if (d && d.last) map.setView([d.last.lat, d.last.lon], 18); selected = id; renderDevices(); }
  else if (act === 'clear') clearTrack(id);
});
$('#devList').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'rate') return;
  const id = e.target.closest('.card').dataset.id;
  send(id, { cmd: 'rate', pvt_hz: Number(e.target.value) });
});
setInterval(scheduleRender, 1000);

// ------------------------------------------------------------------ grafik getaran
function drawVib() {
  const cv = $('#vibCanvas'); const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const d = devices.get(selected); $('#vibTitle').textContent = 'Indeks getaran' + (d ? ' — ' + d.id : '');
  if (!d) return;
  const now = Date.now(), span = 120000; const pts = d.vib.filter((x) => now - x.t <= span);
  const vmax = Math.max(vibTh().at(-1) * 1.25 || 2.5, ...pts.map((x) => x.v));
  ctx.strokeStyle = '#ccc'; ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
  for (const th of vibTh()) { const y = H - 14 - (th / vmax) * (H - 20); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(28, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(th.toFixed(1), 2, y + 3); }
  ctx.setLineDash([]); ctx.fillText('-120 s', 28, H - 2); ctx.fillText('sekarang', W - 44, H - 2);
  for (let i = 1; i < pts.length; i++) {
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
  exportSession(sess, x);
});
$('#btnSessions').onclick = async () => { for (const d of devices.values()) await flushRec(d); await renderSessions(); $('#dlgSessions').showModal(); };
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
  toast('Pengaturan disimpan. Klik Sambungkan (atau Putuskan lalu Sambungkan).');
});
$('#btnSettings').onclick = openSettings;
$('#btnConnect').onclick = connect;

window.addEventListener('beforeunload', (e) => {
  if ([...devices.values()].some((d) => d.rec)) { e.preventDefault(); e.returnValue = 'Sesi sedang direkam di browser ini.'; }
});

// ------------------------------------------------------------------ mulai
(async () => {
  await Store.open();
  renderLegend();
  if (!Store.ok) toast('Browser tidak mengizinkan IndexedDB: rekaman raw hanya di memori selama tab terbuka.', 7000);
  if ((CFG.mode === 'cloud' && CFG.cloudUrl && (CFG.cloudUser || CFG.cloudPass)) || (CFG.mode === 'local' && CFG.localUrl)) connect();
})();
