/* Fobos Mini — modul perjalanan (opsional).
 * D1 profil elevasi & kemiringan: dihitung dari tinggi GNSS Fobos sendiri (tanpa layanan luar).
 * D2 info ruas jalan: OpenStreetMap lewat Overpass API. Hemat kueri: satu kotak ±1,3 km diambil sekali,
 *    pencocokan dilakukan di browser; batas harian & jeda antar-kueri dijaga di bawah pedoman layanan publik.
 * Dimuat setelah app.js dan weather.js. */
'use strict';
const TRIP = (() => {
  const OVP = 'https://overpass-api.de/api/interpreter';
  const DAY_MAX = 80, GAP_MS = 20000;
  const HW = { motorway: 'jalan tol', trunk: 'jalan arteri utama', primary: 'jalan primer', secondary: 'jalan sekunder', tertiary: 'jalan tersier',
    residential: 'jalan permukiman', unclassified: 'jalan lokal', service: 'jalan akses', living_street: 'jalan lingkungan', track: 'jalan tanah/kebun', road: 'jalan' };
  const SF = { asphalt: 'aspal', concrete: 'beton', 'concrete:plates': 'pelat beton', 'concrete:lanes': 'beton jalur', paving_stones: 'paving blok', sett: 'batu susun',
    cobblestone: 'batu bulat', gravel: 'kerikil', fine_gravel: 'kerikil halus', compacted: 'tanah dipadatkan', ground: 'tanah', dirt: 'tanah', earth: 'tanah',
    unpaved: 'tanpa perkerasan', paved: 'diperkeras', sand: 'pasir', mud: 'lumpur', grass: 'rumput', metal: 'logam', wood: 'kayu' };
  const hwLabel = (h) => (!h ? 'jalan' : h.endsWith('_link') ? 'ruas penghubung' : (HW[h] || 'jalan'));
  const label = (w) => w.name || w.ref || '(' + hwLabel(w.hw) + ' tanpa nama)';
  const R = { box: null, ways: [], busy: false, err: '', last: 0, failAt: 0 };
  const roadOf = new WeakMap();            // titik -> ruas (atau null); tidak ditempel ke objek titik agar tidak ikut tersimpan
  const on = () => CFG.osmOn !== false;
  let tab = UI.chart === 'e' ? 'e' : 'v';

  // ------------------------------------------------------------ D2: Overpass
  function quota(inc) {
    let q = {}; try { q = JSON.parse(localStorage.getItem('fobos.osm') || '{}'); } catch (e) { q = {}; }
    const day = new Date().toISOString().slice(0, 10); if (q.day !== day) q = { day, n: 0 };
    if (inc) { q.n++; try { localStorage.setItem('fobos.osm', JSON.stringify(q)); } catch (e) { /* abaikan */ } }
    return q.n;
  }
  const inBox = (p, b, m = 0) => b && p.lat >= b.s + m * (b.n - b.s) && p.lat <= b.n - m * (b.n - b.s) && p.lon >= b.w + m * (b.e - b.w) && p.lon <= b.e - m * (b.e - b.w);
  async function fetchRoads(pos, d) {
    const dl = 0.012, dn = 0.012 / Math.max(0.2, Math.cos(pos.lat * Math.PI / 180));
    const b = { s: pos.lat - dl, n: pos.lat + dl, w: pos.lon - dn, e: pos.lon + dn };
    const q = '[out:json][timeout:15];way["highway"]["highway"!~"^(footway|path|steps|cycleway|pedestrian|corridor|platform|proposed|construction|bridleway|elevator)$"]'
      + `(${b.s.toFixed(5)},${b.w.toFixed(5)},${b.n.toFixed(5)},${b.e.toFixed(5)});out tags geom;`;
    R.busy = true; R.last = Date.now(); quota(true);
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(OVP, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); if (!j || !Array.isArray(j.elements)) throw new Error('format respons tidak dikenal');
      const ways = [];
      for (const e of j.elements) {
        if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue; const t = e.tags || {};
        const w = { id: e.id, name: t.name || '', ref: t.ref || '', hw: t.highway || '', surface: t.surface || '', maxspeed: t.maxspeed || '', g: e.geometry, s: 90, n: -90, w: 180, e: -180 };
        for (const v of e.geometry) { if (v.lat < w.s) w.s = v.lat; if (v.lat > w.n) w.n = v.lat; if (v.lon < w.w) w.w = v.lon; if (v.lon > w.e) w.e = v.lon; }
        ways.push(w);
      }
      R.ways = ways; R.box = b; R.err = ''; R.failAt = 0;
      if (d && devices.get(d.id) === d) rematch(d);
    } catch (e) { R.err = (e && e.name === 'AbortError') ? 'waktu habis' : (e && e.message) || String(e); R.failAt = Date.now(); }
    finally { clearTimeout(tm); R.busy = false; if (typeof scheduleRender === 'function') scheduleRender(); }
  }
  function need() {
    if (!on() || R.busy || navigator.onLine === false) return;
    const d = devices.get(selected); const p = d && d.last; if (!p || !(p.q > 0) || !isFinite(p.lat) || !isFinite(p.lon)) return;
    if (inBox(p, R.box, 0.2)) return;
    const now = Date.now(); if (now - R.last < GAP_MS || (R.failAt && now - R.failAt < 120000)) return;
    if (quota(false) >= DAY_MAX) { R.err = `batas ${DAY_MAX} kueri/hari tercapai`; return; }
    fetchRoads({ lat: p.lat, lon: p.lon }, d);
  }
  function match(lat, lon, prev) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540, my = 25 / ky, mx = 25 / kx;
    let best = null, bd = 1e9, pd = 1e9;
    for (const w of R.ways) {
      if (lat < w.s - my || lat > w.n + my || lon < w.w - mx || lon > w.e + mx) continue;
      let dm = 1e9; const g = w.g;
      for (let i = 0; i < g.length - 1; i++) {
        const ax = (g[i].lon - lon) * kx, ay = (g[i].lat - lat) * ky, bx = (g[i + 1].lon - lon) * kx, by = (g[i + 1].lat - lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx, ey = ay + t * dy, dd = Math.sqrt(ex * ex + ey * ey); if (dd < dm) dm = dd;
      }
      if (w === prev) pd = dm; if (dm < bd) { bd = dm; best = w; }
    }
    if (prev && pd < 20 && pd - bd < 6) return prev;      // jangan berpindah-pindah di persimpangan
    return bd <= 20 ? best : null;
  }
  function assign(d, p) {
    if (roadOf.has(p) || !inBox(p, R.box)) return;
    const a = d._rdP;
    if (a && a !== p && roadOf.has(a) && Math.abs(p.lat - a.lat) < 7e-5 && Math.abs(p.lon - a.lon) < 7e-5) { roadOf.set(p, roadOf.get(a)); return; }   // < ±8 m dari titik jangkar
    roadOf.set(p, match(p.lat, p.lon, a ? roadOf.get(a) : null)); d._rdP = p;
  }
  function accum(d, p, prev) {
    const w = roadOf.get(p); if (!w) return;
    const k = label(w); let a = d.roads.get(k); if (!a) { a = { name: k, w, dist: 0, vs: 0, vn: 0 }; d.roads.set(k, a); }
    if (prev && roadOf.get(prev) === w && p._d != null && prev._d != null) a.dist += Math.max(0, p._d - prev._d);
    if (p.vib != null) { a.vs += p.vib; a.vn++; }
  }
  function point(d, p) {                   // dipanggil app.js untuk tiap titik jejak (harus ringan)
    const n = d.pts.length; if (n === 1 || !d.roads) { d.roads = new Map(); d._rdP = null; }
    if (!on()) return;
    assign(d, p); accum(d, p, n > 1 ? d.pts[n - 2] : null);
  }
  function rematch(d) {                    // setelah data jalan baru tiba: cocokkan titik yang belum punya ruas, lalu hitung ulang rekap
    d._rdP = null; d.roads = new Map();
    for (let i = 0; i < d.pts.length; i++) { assign(d, d.pts[i]); accum(d, d.pts[i], i ? d.pts[i - 1] : null); }
  }
  function roadText(w) {
    const bits = [hwLabel(w.hw)]; if (w.surface) bits.push(SF[w.surface] || w.surface);
    const ms = parseInt(w.maxspeed, 10); if (isFinite(ms)) bits.push('maks ' + ms + ' km/j');
    return bits.join(' · ');
  }
  function current(d) { const p = d && d.last; return p ? roadOf.get(p) : undefined; }
  function summaryHtml(d) {
    if (!on() || !d) return '';
    const w = current(d); let h;
    if (w) h = `<div class="wide rd"><span class="k">Ruas jalan (OpenStreetMap)</span><span class="v rd-n">${esc(label(w))}</span><span class="rd-t">${esc(roadText(w))}</span></div>`;
    else {
      const msg = w === null ? 'di luar jalan terpetakan' : R.busy ? 'memuat data jalan…' : R.err ? `belum tersedia (${R.err})` : 'menunggu data jalan…';
      h = `<div class="wide rd"><span class="k">Ruas jalan (OpenStreetMap)</span><span class="small muted">${esc(msg)}</span></div>`;
    }
    const rows = d.roads ? [...d.roads.values()].filter((a) => a.dist >= 20).sort((a, b) => b.dist - a.dist).slice(0, 4) : [];
    if (rows.length) {
      const open = !!UI.roadsOpen;
      h += `<div class="wide rd-tb"><button class="rd-tg" data-tg="roads">${open ? '▾' : '▸'} Getaran per ruas jalan (${rows.length})</button>`;
      if (open) h += rows.map((a) => `<div class="rd-row"><span>${esc(a.name)}</span><span>${esc(fmtDist(a.dist))}</span><span>${a.vn ? (a.vs / a.vn).toFixed(2) + ' m/s²' : '–'}</span></div>`).join('')
        + '<div class="rd-note">jarak · rata-rata indeks getaran pada titik yang cocok dengan ruas</div>';
      h += '</div>';
    }
    return h;
  }
  function hud(d) { const el = $('#hudRoad'); if (!el) return; const w = on() ? current(d) : null; el.textContent = w ? label(w) + ' · ' + roadText(w) : ''; }

  // ------------------------------------------------------------ D1: profil elevasi
  const VIB_CAP = 'RMS percepatan searah gravitasi per detik (m/s²), relatif — bukan IRI';
  function elevStats(a) {
    let rtk = a.filter((x) => x.q >= 3); const all = rtk.length < 2; if (all) rtk = a;
    let gain = 0, loss = 0, ref = rtk[0].h;
    for (const x of rtk) { const dh = x.h - ref; if (dh >= 0.5) { gain += dh; ref = x.h; } else if (dh <= -0.5) { loss -= dh; ref = x.h; } }
    const L = a[a.length - 1]; let grade = null;
    for (let i = a.length - 2; i >= 0; i--) if (L.x - a[i].x >= 20) { grade = (L.h - a[i].h) / (L.x - a[i].x) * 100; break; }
    return { gain, loss, grade, all };
  }
  function chart(d) {
    const cap = $('#chartCap');
    if (tab !== 'e') { if (cap && cap.textContent !== VIB_CAP) cap.textContent = VIB_CAP; return false; }
    $('#vibTitle').textContent = 'Profil elevasi' + (d ? ' — ' + dn(d) : '');
    const cv = $('#vibCanvas'); if (!cv.offsetParent) return true;
    const dpr = window.devicePixelRatio || 1; const W = Math.max(200, cv.clientWidth), H = Math.max(60, cv.clientHeight);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const dark = document.body.classList.contains('expo'); const fg = dark ? '#9fb0c2' : '#888';
    ctx.font = '11px sans-serif'; ctx.fillStyle = fg;
    const key = d && d.pts.some((p) => p.h != null && isFinite(p.h)) ? 'h' : 'hae';
    const a = []; if (d) for (const p of d.pts) { const h = p[key]; if (h != null && isFinite(h) && p._d != null) a.push({ x: p._d, h, q: p.q, t: p._t }); }
    if (a.length < 2 || a[a.length - 1].x - a[0].x < 1) { ctx.fillText('Belum ada data tinggi yang cukup (perangkat perlu bergerak).', 8, H / 2); if (cap) cap.textContent = 'Tinggi dari GNSS Fobos sepanjang lintasan'; return true; }
    const x0 = a[0].x, x1 = a[a.length - 1].x; let lo = Infinity, hi = -Infinity; for (const p of a) { if (p.h < lo) lo = p.h; if (p.h > hi) hi = p.h; }
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; } const padv = (hi - lo) * 0.08; lo -= padv; hi += padv;
    const LM = 40, TM = 10, BM = 14; const X = (x) => LM + (W - LM - 4) * (x - x0) / (x1 - x0), Y = (h) => TM + (H - TM - BM) * (1 - (h - lo) / (hi - lo));
    ctx.strokeStyle = dark ? '#3a4b5e' : '#ddd'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    for (const v of [lo + padv, (lo + hi) / 2, hi - padv]) { const y = Y(v); ctx.beginPath(); ctx.moveTo(LM, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(v.toFixed(1), 2, y + 3); }
    ctx.setLineDash([]);
    const step = Math.max(1, Math.floor(a.length / (W * 1.5))); const s = []; for (let i = 0; i < a.length; i += step) s.push(a[i]); if (s[s.length - 1] !== a[a.length - 1]) s.push(a[a.length - 1]);
    ctx.beginPath(); ctx.moveTo(X(s[0].x), H - BM); for (const p of s) ctx.lineTo(X(p.x), Y(p.h)); ctx.lineTo(X(s[s.length - 1].x), H - BM); ctx.closePath();
    ctx.fillStyle = dark ? 'rgba(74,163,255,.16)' : 'rgba(31,95,191,.12)'; ctx.fill();
    ctx.lineWidth = 2;
    for (let i = 1; i < s.length; i++) { ctx.strokeStyle = s[i].q === 4 ? (dark ? '#4aa3ff' : '#1f5fbf') : '#9aa5b1'; ctx.beginPath(); ctx.moveTo(X(s[i - 1].x), Y(s[i - 1].h)); ctx.lineTo(X(s[i].x), Y(s[i].h)); ctx.stroke(); }
    if (typeof WX !== 'undefined' && d.wx && d.wx.samples.length) {     // pita hujan (model) di tepi atas
      for (let i = 1; i < s.length; i++) { const c = WX.rainCls(WX.rainAt(d, s[i].t)); if (c > 0) { ctx.fillStyle = WX.rainCol(c); ctx.fillRect(X(s[i - 1].x), 1, Math.max(1, X(s[i].x) - X(s[i - 1].x)), 5); } }
    }
    const L = s[s.length - 1]; ctx.fillStyle = '#d73027'; ctx.beginPath(); ctx.arc(X(L.x), Y(L.h), 3.5, 0, 6.3); ctx.fill();
    ctx.fillStyle = fg; ctx.fillText('0', LM, H - 2); const tl = fmtDist(x1 - x0); ctx.fillText(tl, W - ctx.measureText(tl).width - 4, H - 2);
    const st = elevStats(a); const sg = (v) => (v > 0 ? '+' : '') + v.toFixed(1).replace('.', ',');
    if (cap) cap.textContent = `Tinggi ${L.h.toFixed(1)} m (${key === 'h' ? 'MSL' : 'elipsoid'}) · naik ${st.gain.toFixed(1)} m · turun ${st.loss.toFixed(1)} m`
      + (st.grade != null ? ` · kemiringan ${sg(st.grade)}%` : '') + (d.kind === 'traj' ? ' · garis abu-abu = ambiguitas ESKF belum fix' : ' · garis abu-abu = bukan RTK fix') + (st.all ? ' · belum ada RTK: angka kasar' : '');
    return true;
  }
  function setTab(t) {
    tab = t === 'e' ? 'e' : 'v'; UI.chart = tab;
    document.querySelectorAll('#chartTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (typeof saveUi === 'function') saveUi(); if (typeof drawVib === 'function') drawVib();
  }
  function init() {
    document.querySelectorAll('#chartTabs button').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); setTab(b.dataset.tab); }; b.classList.toggle('on', b.dataset.tab === tab); });
    const sb = $('#sumBody'); if (sb) sb.addEventListener('pointerdown', (e) => { const t = e.target.closest('[data-tg="roads"]'); if (!t) return; e.preventDefault(); UI.roadsOpen = !UI.roadsOpen; if (typeof saveUi === 'function') saveUi(); if (typeof renderSummary === 'function') renderSummary(); });
    setInterval(need, 3000);
  }
  return { init, point, chart, summaryHtml, hud, setTab, _R: R, _roadOf: roadOf };
})();
try { TRIP.init(); } catch (e) { console.error('modul perjalanan gagal dimulai', e); }
