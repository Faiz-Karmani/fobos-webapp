/* Fobos Mini — modul cuaca (opsional; web app tetap jalan bila modul ini gagal).
 * Sumber: Open-Meteo (cuaca model + arsip, tanpa API key), RainViewer (radar hujan, max zum 7),
 * BMKG (prakiraan kelurahan, perlu kode adm4 di Pengaturan). Semua dipanggil langsung dari browser.
 * Dimuat setelah app.js dan memakai variabel global app.js (map, devices, selected, UI, $, esc, CFG, ...).
 *
 * W1 cuaca sepanjang jejak (ikon + mode warna "Hujan")   W2 linimasa cuaca perjalanan (Ringkasan)
 * W3 cuaca saat rekaman pada Putar ulang                  W4 peta hujan model (kisi)
 * W5 peringatan hujan beberapa jam ke depan */
'use strict';
const WX = (() => {
  const OM = 'https://api.open-meteo.com/v1/forecast';
  const OMA = 'https://archive-api.open-meteo.com/v1/archive';
  const RV = 'https://api.rainviewer.com/public/weather-maps.json';
  const BM = 'https://api.bmkg.go.id/publik/prakiraan-cuaca';
  const HV = 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
  const S = { on: true, pos: null, fetchedAt: 0, data: null, err: '', busy: false, trkOn: true, trkFor: '', cardKey: '',
    radar: { on: false, frames: [], host: '', layer: null, idx: 0, timer: null, err: '', t: 0 },
    grid: { on: false, cells: new Map(), layer: null, last: 0, busy: false, tm: null, note: '', err: '' },
    bmkg: { data: null, err: '', t: 0, key: '' }, logBySess: {} };
  const attrib = new Set();
  function addAttr(html) { if (!attrib.has(html)) { attrib.add(html); map.attributionControl.addAttribution(html); } }
  const OM_ATTR = 'Cuaca: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0)';

  // ---- kelas hujan (dipakai jejak, linimasa, kisi, grafik)
  const RAIN = [['kering', '#a8b3bf'], ['< 1 mm/j', '#7fc4ff'], ['1–5 mm/j', '#2f86e0'], ['> 5 mm/j', '#0b3d91']];
  const rainCls = (mm) => ((mm == null || !isFinite(mm)) ? -1 : mm < 0.1 ? 0 : mm < 1 ? 1 : mm < 5 ? 2 : 3);
  const rainCol = (c) => (c < 0 ? '#d0d4d9' : RAIN[c][1]);
  const unixMs = (t) => (t > 1e11 ? GPS_EPOCH_MS + t - LEAP_S * 1000 : Date.now());   // ms GPS perangkat -> ms Unix

  // ---- kode cuaca WMO -> label + jenis ikon
  function wmo(c) {
    if (c === 0) return ['Cerah', 'sun'];
    if (c === 1) return ['Cerah berawan', 'sun'];
    if (c === 2) return ['Berawan sebagian', 'part'];
    if (c === 3) return ['Mendung', 'cloud'];
    if (c === 45 || c === 48) return ['Berkabut', 'fog'];
    if (c >= 51 && c <= 55) return ['Gerimis', 'rain'];
    if (c === 56 || c === 57) return ['Gerimis beku', 'rain'];
    if (c === 61) return ['Hujan ringan', 'rain'];
    if (c === 63) return ['Hujan sedang', 'rain'];
    if (c === 65) return ['Hujan lebat', 'rain'];
    if (c === 66 || c === 67) return ['Hujan beku', 'rain'];
    if (c >= 71 && c <= 77) return ['Salju', 'cloud'];
    if (c === 80) return ['Hujan lokal ringan', 'rain'];
    if (c === 81) return ['Hujan lokal sedang', 'rain'];
    if (c === 82) return ['Hujan lokal deras', 'rain'];
    if (c === 85 || c === 86) return ['Salju lokal', 'cloud'];
    if (c === 95) return ['Badai petir', 'storm'];
    if (c === 96 || c === 99) return ['Badai petir + es', 'storm'];
    return ['Tidak diketahui', 'cloud'];
  }
  const cloudPath = 'M17 40h26a9 9 0 0 0 1-17.9A12 12 0 0 0 21 19a10 10 0 0 0-4 21z';
  function icon(kind, day = true, still = false) {
    const sun = `<g class="wx-sun"><circle cx="30" cy="30" r="9" fill="#ffb300"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1="30" y1="12" x2="30" y2="17" stroke="#ffb300" stroke-width="3" stroke-linecap="round" transform="rotate(${a} 30 30)"/>`).join('')}</g>`;
    const moon = '<path class="wx-moon" d="M36 14a16 16 0 1 0 12 24 13 13 0 0 1-12-24z" fill="#ffe082"/>';
    const cl = (fill) => `<g class="wx-cloud"><path d="${cloudPath}" fill="${fill}"/></g>`;
    const drops = '<g class="wx-drops" stroke="#4aa3ff" stroke-width="3" stroke-linecap="round"><line x1="22" y1="46" x2="19" y2="54"/><line x1="32" y1="46" x2="29" y2="54"/><line x1="42" y1="46" x2="39" y2="54"/></g>';
    let g;
    if (kind === 'sun') g = day ? sun : moon;
    else if (kind === 'part') g = (day ? `<g transform="translate(-6,-6) scale(.8)">${sun}</g>` : `<g transform="translate(-4,-4) scale(.8)">${moon}</g>`) + cl('#dfe6ee');
    else if (kind === 'rain') g = cl('#9fb2c6') + drops;
    else if (kind === 'storm') g = cl('#6b7b8f') + '<path class="wx-bolt" d="M32 40l-7 11h6l-3 9 11-14h-6l4-6z" fill="#ffd54f"/>';
    else if (kind === 'fog') g = cl('#c3ccd6') + '<g stroke="#b0bac6" stroke-width="3" stroke-linecap="round"><line x1="14" y1="48" x2="46" y2="48"/><line x1="20" y1="55" x2="52" y2="55"/></g>';
    else g = cl('#c3ccd6');
    return `<svg class="wx-ic${still ? ' wx-static' : ''}" viewBox="0 0 60 60" aria-hidden="true">${g}</svg>`;
  }
  const dir8 = ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'];
  const dirName = (deg) => dir8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  const fmt1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');
  function arrow(deg) {   // panah menunjuk ke arah angin BERTIUP (dari deg + 180)
    return `<svg class="wx-arrow" viewBox="0 0 40 40" style="transform:rotate(${(deg + 180) % 360}deg)" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M20 6l7 18-7-4-7 4z" fill="currentColor"/></svg>`;
  }

  // ---- posisi acuan: perangkat terpilih
  function refPos() {
    const d = devices.get(selected); if (!d || !d.last) return null;
    const p = d.last; if (!isFinite(p.lat) || !isFinite(p.lon) || (p.lat === 0 && p.lon === 0) || !(p.q > 0)) return null;
    return { lat: p.lat, lon: p.lon, d };
  }
  const km = (a, b) => { const R = 6371, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

  async function getJson(url) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
    try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(tm); }
  }
  const emsg = (e) => ((e && e.name === 'AbortError') ? 'waktu habis' : (e && e.message) || String(e));

  // ---- Open-Meteo: cuaca saat ini + 12 jam
  async function loadOm(pos) {
    const u = `${OM}?latitude=${pos.lat.toFixed(4)}&longitude=${pos.lon.toFixed(4)}&current=${HV}`
      + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&forecast_hours=12&timezone=auto&wind_speed_unit=kmh';
    S.busy = true;
    try {
      const j = await getJson(u);
      if (!j || !j.current) throw new Error('format respons tidak dikenal');
      S.data = j; S.pos = { lat: pos.lat, lon: pos.lon }; S.fetchedAt = Date.now(); S.err = '';
      addAttr(OM_ATTR); logWx(pos.d, j.current);
    } catch (e) { S.err = emsg(e); }
    finally { S.busy = false; render(); }
  }
  function logWx(d, c) {
    if (!d || !d.sess || d.replay) return;
    const a = S.logBySess[d.sess] = S.logBySess[d.sess] || [];
    a.push({ waktu_utc: new Date().toISOString(), lat: S.pos.lat, lon: S.pos.lon, kode_cuaca: c.weather_code, cuaca: wmo(c.weather_code)[0],
      suhu_c: c.temperature_2m, kelembapan_pct: c.relative_humidity_2m, hujan_mm: c.precipitation, awan_pct: c.cloud_cover,
      angin_kmj: c.wind_speed_10m, arah_angin_deg: c.wind_direction_10m, hembusan_kmj: c.wind_gusts_10m, sumber: 'Open-Meteo (model)' });
  }
  function sessText(sess) {
    const a = S.logBySess[sess]; if (!a || !a.length) return '';
    const wet = a.reduce((m, x) => (x.hujan_mm > m.hujan_mm ? x : m), a[0]);
    const t = a.map((x) => x.suhu_c).filter((x) => x != null); const lo = Math.min(...t), hi = Math.max(...t);
    const base = wet.hujan_mm > 0 ? wet.cuaca : a[a.length - 1].cuaca;
    return `${base} · ${lo === hi ? fmt1(lo) : fmt1(lo) + '–' + fmt1(hi)}°C` + (wet.hujan_mm > 0 ? ` · hujan maks ${fmt1(wet.hujan_mm)} mm/j` : '');
  }

  // ---- W5: peringatan hujan (ketelitian per jam; data model)
  function alertInfo() {
    const j = S.data; if (!j || !j.current || !j.hourly || !j.hourly.time) return null;
    const c = j.current, h = j.hourly;
    if (c.precipitation >= 0.1) return { lvl: 'wet', txt: 'Sedang hujan di lokasi ini' };
    for (let i = 1; i <= Math.min(3, h.time.length - 1); i++) {
      const pr = h.precipitation_probability ? h.precipitation_probability[i] : null; const mm = h.precipitation ? h.precipitation[i] : 0;
      if (mm >= 0.2 || (pr != null && pr >= 60)) return { lvl: 'soon', txt: `Hujan diperkirakan sekitar pukul ${h.time[i].slice(11, 16)}` + (pr != null ? ` (peluang ${Math.round(pr)}%)` : '') };
    }
    return { lvl: 'dry', txt: 'Tidak ada hujan diperkirakan 3 jam ke depan' };
  }

  // ---- W1/W2/W3: cuaca sepanjang jejak. Titik contoh diambil di sepanjang lintasan, lalu nilai per jam dicocokkan dengan waktu lintasan.
  function buildSamples(pts) {
    const n = pts.length; if (!n) return [];
    const cum = new Float64Array(n); let total = 0;
    for (let i = 1; i < n; i++) { const dd = km(pts[i - 1], pts[i]) * 1000; if (dd < 500) total += dd; cum[i] = total; }
    const mk = (i) => ({ tg: pts[i]._t, t: unixMs(pts[i]._t), lat: pts[i].lat, lon: pts[i].lon, d: cum[i] });
    let f = 1, out = [];
    for (let guard = 0; guard < 12; guard++) {
      const step = Math.min(20000, Math.max(2000, total / 20)) * f, tstep = 900000 * f;
      out = []; let ld = -1e12, lt = -1e18;
      for (let i = 0; i < n; i++) if (cum[i] - ld >= step || pts[i]._t - lt >= tstep) { out.push(mk(i)); ld = cum[i]; lt = pts[i]._t; }
      const L = n - 1, last = out[out.length - 1];
      if (cum[L] - last.d >= 500 || pts[L]._t - last.tg >= 300000) out.push(mk(L));
      if (out.length <= 24) break; f *= 1.6;
    }
    return out;
  }
  async function fetchTrack(d, pts) {
    const W = d.wx = d.wx || { samples: [], busy: false, err: '', at: 0, n: 0, dist: 0, src: '' };
    if (W.busy) return; const s = buildSamples(pts); if (!s.length) return;
    W.busy = true;
    try {
      const coords = []; const idx = new Map();
      for (const x of s) { const k = x.lat.toFixed(2) + ',' + x.lon.toFixed(2); if (!idx.has(k)) { idx.set(k, coords.length); coords.push(k.split(',')); } x.ci = idx.get(k); }
      const tmin = Math.min(...s.map((x) => x.t)), tmax = Math.max(...s.map((x) => x.t));
      if (tmax - tmin > 10 * 86400000) throw new Error('rentang waktu rekaman lebih dari 10 hari');
      const day = (t) => new Date(t).toISOString().slice(0, 10);
      // rekaman lebih dari 7 hari lalu: arsip historis (reanalisis); lebih baru: API prakiraan. Bila satu gagal, coba yang lain.
      let old = Date.now() - tmin > 7 * 86400000;
      const mk = (o) => `${o ? OMA : OM}?latitude=${coords.map((c) => c[0]).join(',')}&longitude=${coords.map((c) => c[1]).join(',')}&hourly=${HV}`
        + `&start_date=${day(tmin)}&end_date=${day(tmax)}&timezone=GMT&wind_speed_unit=kmh`;
      let j;
      try { j = await getJson(mk(old)); } catch (e1) { old = !old; j = await getJson(mk(old)); }
      if (!Array.isArray(j)) j = [j];
      for (const x of s) {
        const h = j[x.ci] && j[x.ci].hourly; if (!h || !h.time) continue;
        const i = h.time.indexOf(new Date(x.t).toISOString().slice(0, 13) + ':00'); if (i < 0 || h.weather_code[i] == null) continue;
        x.code = h.weather_code[i]; x.mm = h.precipitation[i]; x.temp = h.temperature_2m[i]; x.rh = h.relative_humidity_2m[i]; x.app = h.apparent_temperature[i];
        x.cc = h.cloud_cover[i]; x.ws = h.wind_speed_10m[i]; x.wd = h.wind_direction_10m[i]; x.wg = h.wind_gusts_10m[i]; x.day = h.is_day ? h.is_day[i] : 1; x.ok = true;
      }
      const ok = s.filter((x) => x.ok); if (!ok.length) throw new Error('tidak ada data untuk waktu lintasan');
      W.samples = ok; W.err = ''; W.src = old ? 'arsip' : 'model'; addAttr(OM_ATTR);
    } catch (e) { W.err = emsg(e); }
    finally {
      W.busy = false; W.at = Date.now(); W.n = pts.length; W.dist = d.st ? d.st.dist : 0;
      if (devices.get(d.id) === d) { if (colorMode === 'w') redrawTrack(d); drawTrackIcons(); S.cardKey = ''; render(); if (typeof renderSummary === 'function') renderSummary(); if (typeof drawVib === 'function') drawVib(); }
    }
  }
  function maybeTrack() {
    if (!S.on) return; const d = devices.get(selected); if (!d) return;
    const pts = d.replay ? (d.rp ? d.rp.pts : null) : d.pts; if (!pts || pts.length < 2) return;
    const W = d.wx; const now = Date.now();
    if (W && W.busy) return;
    if (W && !d.replay && pts.length < W.n) { W.samples = []; W.at = 0; }                // jejak dihapus
    if (!W || (!W.samples.length && now - W.at > 60000)) { fetchTrack(d, pts); return; }
    if (d.replay) return;                                                               // rekaman: cukup sekali
    if (now - W.at > 600000 || (now - W.at > 60000 && d.st.dist - W.dist >= 2000)) fetchTrack(d, pts);
  }
  function nearest(d, tg) {
    const s = d && d.wx && d.wx.samples; if (!s || !s.length) return null;
    let b = s[0], bd = Math.abs(tg - b.tg);
    for (let i = 1; i < s.length; i++) { const dd = Math.abs(tg - s[i].tg); if (dd < bd) { b = s[i]; bd = dd; } }
    return b;
  }
  const rainAt = (d, tg) => { const x = nearest(d, tg); return x ? x.mm : null; };
  const sampleTip = (x, src) => `${clockLabel(x.tg)} · ${wmo(x.code)[0]} · ${fmt1(x.temp)}°C · hujan ${fmt1(x.mm)} mm/j · angin ${Math.round(x.ws)} km/j ${dirName(x.wd)} (${src})`;

  const trkLayer = L.layerGroup().addTo(map);
  function drawTrackIcons() {
    trkLayer.clearLayers(); S.trkFor = selected || '';
    if (!S.on || !S.trkOn) return; const d = devices.get(selected); const W = d && d.wx; if (!W || !W.samples.length) return;
    for (const x of W.samples) {
      const ic = L.divIcon({ className: 'wx-pin', html: `<div class="wx-pin-b" style="border-color:${rainCol(rainCls(x.mm))}">${icon(wmo(x.code)[1], x.day !== 0, true)}<b>${Math.round(x.temp)}°</b></div>`, iconSize: [54, 30], iconAnchor: [27, 40] });
      L.marker([x.lat, x.lon], { icon: ic, keyboard: false, zIndexOffset: -200 }).bindTooltip(sampleTip(x, W.src), { direction: 'top', offset: [0, -38] }).addTo(trkLayer);
    }
  }
  // W2: linimasa untuk kartu Ringkasan (ikon statis: kartu ini digambar ulang sangat sering)
  function timelineHtml(d) {
    const W = d && d.wx; if (!S.on || !W) return '';
    if (!W.samples.length) return W.err ? `<div class="wide"><span class="k">Cuaca perjalanan</span><span class="small muted">belum tersedia (${esc(W.err)})</span></div>` : '';
    const s = W.samples, n = s.length, t0 = s[0].tg, t1 = s[n - 1].tg, span = t1 - t0;
    let bar = '';
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? t0 : (s[i - 1].tg + s[i].tg) / 2, b = i === n - 1 ? t1 : (s[i].tg + s[i + 1].tg) / 2;
      bar += `<i style="width:${(span > 0 ? (b - a) / span * 100 : 100 / n).toFixed(2)}%;background:${rainCol(rainCls(s[i].mm))}" title="${esc(sampleTip(s[i], W.src))}"></i>`;
    }
    const pickN = Math.min(n, 5); let ics = '';
    for (let k = 0; k < pickN; k++) {
      const i = pickN === 1 ? 0 : Math.round(k * (n - 1) / (pickN - 1)); const x = s[i];
      const left = span > 0 ? (x.tg - t0) / span * 100 : 50;
      ics += `<span style="left:${(6 + left * 0.88).toFixed(1)}%">${icon(wmo(x.code)[1], x.day !== 0, true)}<b>${Math.round(x.temp)}°</b></span>`;
    }
    const wet = s.filter((x) => x.mm >= 0.1); const tt = s.map((x) => x.temp); const lo = Math.min(...tt), hi = Math.max(...tt);
    const txt = (wet.length ? `Hujan di ${wet.length} dari ${n} titik contoh · maks ${fmt1(Math.max(...wet.map((x) => x.mm)))} mm/j` : 'Kering sepanjang perjalanan')
      + ` · ${lo === hi ? fmt1(lo) : fmt1(lo) + '–' + fmt1(hi)}°C`;
    const cur = (d.replay && d.rp && span > 0) ? `<u style="left:${Math.max(0, Math.min(100, (d.rp.cur - t0) / span * 100)).toFixed(1)}%"></u>` : '';
    return `<div class="wide wx-tl"><span class="k">Cuaca perjalanan <em>(${W.src === 'arsip' ? 'arsip historis' : 'model'} Open-Meteo)</em></span>
      <div class="wx-tl-ic">${ics}</div><div class="wx-tl-bar">${bar}${cur}</div>
      <div class="wx-tl-x"><span>${esc(clockLabel(t0))}</span><span>${esc(clockLabel(t1))}</span></div><span class="wx-tl-t">${esc(txt)}</span></div>`;
  }

  // ---- bilah prakiraan 12 jam (SVG)
  function hourly() {
    const h = S.data && S.data.hourly; if (!h || !h.time) return '';
    const n = Math.min(12, h.time.length); const W = 288, H = 92, bw = W / n;
    const tmax = Math.max(...h.temperature_2m.slice(0, n)), tmin = Math.min(...h.temperature_2m.slice(0, n));
    const ty = (t) => 30 + (tmax === tmin ? 10 : (tmax - t) / (tmax - tmin) * 22);
    let bars = '', line = '', lab = '';
    for (let i = 0; i < n; i++) {
      const pr = h.precipitation_probability ? (h.precipitation_probability[i] || 0) : 0;
      const bh = pr / 100 * 40, x = i * bw;
      bars += `<rect x="${(x + 3).toFixed(1)}" y="${(88 - bh).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="#4aa3ff" fill-opacity="${(0.35 + pr / 160).toFixed(2)}"/>`;
      line += (i ? 'L' : 'M') + (x + bw / 2).toFixed(1) + ' ' + ty(h.temperature_2m[i]).toFixed(1);
      if (i % 3 === 0) lab += `<text x="${(x + bw / 2).toFixed(1)}" y="10" text-anchor="middle" class="wx-t">${esc(h.time[i].slice(11, 16))}</text><text x="${(x + bw / 2).toFixed(1)}" y="${(ty(h.temperature_2m[i]) - 5).toFixed(1)}" text-anchor="middle" class="wx-tv">${Math.round(h.temperature_2m[i])}°</text>`;
    }
    return `<svg class="wx-hourly" viewBox="0 0 ${W} ${H}" role="img" aria-label="Prakiraan 12 jam: suhu (garis) dan peluang hujan (batang)">${bars}<path d="${line}" fill="none" stroke="#ff8a3d" stroke-width="2"/>${lab}</svg>`
      + '<div class="wx-cap">12 jam ke depan: garis = suhu · batang = peluang hujan</div>';
  }

  // ---- kartu: data yang ditampilkan (langsung = kondisi model saat ini; putar ulang = cuaca pada waktu rekaman)
  function cardData() {
    const rp = refPos();
    if (rp && rp.d.replay) {
      const x = rp.d.rp ? nearest(rp.d, rp.d.rp.cur) : null;
      if (!x) return { replay: true, c: null, wait: !(rp.d.wx && rp.d.wx.err), err: rp.d.wx && rp.d.wx.err };
      return { replay: true, x, src: rp.d.wx.src, c: { temperature_2m: x.temp, apparent_temperature: x.app, relative_humidity_2m: x.rh, precipitation: x.mm, weather_code: x.code,
        cloud_cover: x.cc, wind_speed_10m: x.ws, wind_direction_10m: x.wd, wind_gusts_10m: x.wg, is_day: x.day } };
    }
    return { replay: false, c: S.data && S.data.current };
  }
  function nowText() {
    const k = cardData(); const c = k.c; if (!c) return '';
    return `${wmo(c.weather_code)[0]} · ${fmt1(c.temperature_2m)}°C · angin ${Math.round(c.wind_speed_10m)} km/j ${dirName(c.wind_direction_10m)}`;
  }

  // ---- render panel
  function render() {
    const body = $('#wxBody'); if (!body) return;
    const brief = $('#wxBrief');
    if (!S.on) { body.innerHTML = '<div class="muted small">Cuaca dimatikan.</div>'; brief.textContent = ''; return; }
    const K = cardData(); const c = K.c; const al = K.replay ? null : alertInfo();
    let h = '';
    if (c) {
      const [lbl, kind] = wmo(c.weather_code);
      if (K.replay) h += `<div class="wx-alert rp">Cuaca saat rekaman · ${esc(clockLabel(K.x.tg))} (${K.src === 'arsip' ? 'arsip historis' : 'model'})</div>`;
      else if (al) h += `<div class="wx-alert ${al.lvl}">${esc(al.txt)}</div>`;
      h += `<div class="wx-main">${icon(kind, c.is_day !== 0)}<div class="wx-big"><b>${fmt1(c.temperature_2m)}°C</b><span>${esc(lbl)}</span></div>
        <div class="wx-wind">${arrow(c.wind_direction_10m)}<b>${Math.round(c.wind_speed_10m)}</b><span>km/j ${esc(dirName(c.wind_direction_10m))}</span></div></div>
        <div class="wx-grid"><div><span class="k">Terasa</span><span class="v">${fmt1(c.apparent_temperature)}°</span></div>
        <div><span class="k">Lembap</span><span class="v">${Math.round(c.relative_humidity_2m)}%</span></div>
        <div><span class="k">Hujan</span><span class="v">${fmt1(c.precipitation)} mm</span></div>
        <div><span class="k">Awan</span><span class="v">${Math.round(c.cloud_cover)}%</span></div>
        <div><span class="k">Hembusan</span><span class="v">${Math.round(c.wind_gusts_10m)} km/j</span></div></div>`;
      if (!K.replay) {
        h += hourly();
        const age = Math.round((Date.now() - S.fetchedAt) / 60000);
        h += `<div class="wx-cap">Model cuaca di ${S.pos.lat.toFixed(3)}, ${S.pos.lon.toFixed(3)} · diperbarui ${age < 1 ? 'baru saja' : age + ' mnt lalu'}</div>`;
      }
      brief.innerHTML = `${icon(kind, c.is_day !== 0, true)}<span>${fmt1(c.temperature_2m)}°</span>`;
    } else if (K.replay) {
      h += `<div class="${K.err ? 'wx-err' : 'muted small'}">${K.err ? 'Cuaca saat rekaman belum dapat diambil (' + esc(K.err) + ').' : 'Mengambil cuaca saat rekaman…'}</div>`; brief.textContent = '';
    } else if (S.err) {
      h += `<div class="wx-err">Cuaca belum dapat diambil (${esc(S.err)}). Butuh internet pada perangkat ini; akan dicoba lagi otomatis.</div>`; brief.textContent = '';
    } else {
      h += `<div class="muted small">${refPos() ? 'Mengambil cuaca…' : 'Menunggu posisi dari perangkat…'}</div>`; brief.textContent = '';
    }
    h += `<div class="wx-sec">Lapisan peta</div><div class="wx-layers">
      <label><input type="checkbox" id="chkWxTrack" ${S.trkOn ? 'checked' : ''}> cuaca di jejak</label>
      <label><input type="checkbox" id="chkGrid" ${S.grid.on ? 'checked' : ''}> peta hujan</label>
      <label><input type="checkbox" id="chkRadar" ${S.radar.on ? 'checked' : ''}> radar</label></div>`;
    if (S.grid.on) h += `<div class="wx-lg">${RAIN.slice(1).map((r) => `<span><i style="background:${r[1]}"></i>${r[0]}</span>`).join('')}</div><div class="wx-cap">${esc(S.grid.err ? 'Peta hujan: ' + S.grid.err : (S.grid.note || 'Peta hujan = prakiraan model saat ini, bukan pengamatan.'))}</div>`;
    if (S.radar.on) h += radarBar();
    h += bmkgHtml();
    body.innerHTML = h;
    const hw = $('#hudWx');
    if (hw) hw.innerHTML = c ? `<span class="hl">Cuaca${K.replay ? ' saat rekaman' : ''}</span> <b>${esc(nowText())}</b>${al && al.lvl !== 'dry' ? ` <span class="hud-al">${esc(al.txt)}</span>` : ''}` : '';
  }

  // ---- W4: peta hujan model (kisi; sel dibulatkan agar bisa disimpan sementara)
  map.createPane('wxgrid'); map.getPane('wxgrid').style.zIndex = 350;
  function gridPlan() {
    const b = map.getBounds();
    for (const st of [0.1, 0.25, 0.5, 1, 2]) {
      const r0 = Math.floor(b.getSouth() / st), r1 = Math.floor(b.getNorth() / st), c0 = Math.floor(b.getWest() / st), c1 = Math.floor(b.getEast() / st);
      if ((r1 - r0 + 1) * (c1 - c0 + 1) <= 80) return { st, r0, r1, c0, c1 };
    }
    return null;
  }
  function gridDraw(pl) {
    const G = S.grid; if (!G.layer) G.layer = L.layerGroup().addTo(map); G.layer.clearLayers();
    if (!pl || !G.on) return;
    let wet = 0, have = 0;
    for (let r = pl.r0; r <= pl.r1; r++) for (let c = pl.c0; c <= pl.c1; c++) {
      const e = G.cells.get(`${pl.st}:${r}:${c}`); if (!e) continue; have++;
      if (!(e.mm >= 0.1)) continue; wet++;
      L.rectangle([[r * pl.st, c * pl.st], [(r + 1) * pl.st, (c + 1) * pl.st]], { pane: 'wxgrid', stroke: false, fillColor: rainCol(rainCls(e.mm)), fillOpacity: 0.42 })
        .bindTooltip(`${fmt1(e.mm)} mm/j · ${wmo(e.code)[0]} (model)`, { sticky: true }).addTo(G.layer);
    }
    G.note = !have ? 'Memuat peta hujan…' : wet ? `Hujan pada ${wet} dari ${have} sel (±${Math.round(pl.st * 111)} km per sel) · model, bukan pengamatan.` : 'Tidak ada hujan di area tampilan (model).';
  }
  async function gridUpdate() {
    const G = S.grid; if (!G.on || !S.on) return;
    const pl = gridPlan();
    if (!pl) { G.note = 'Perbesar peta untuk menampilkan peta hujan.'; gridDraw(null); render(); return; }
    const now = Date.now(), need = [];
    for (let r = pl.r0; r <= pl.r1; r++) for (let c = pl.c0; c <= pl.c1; c++) {
      const key = `${pl.st}:${r}:${c}`; const e = G.cells.get(key);
      if (!e || now - e.t > 600000) need.push({ key, lat: ((r + 0.5) * pl.st).toFixed(3), lon: ((c + 0.5) * pl.st).toFixed(3) });
    }
    if (need.length && !G.busy) {
      if (now - G.last < 4000) { clearTimeout(G.tm); G.tm = setTimeout(gridUpdate, 4200 - (now - G.last)); }
      else {
        G.busy = true; G.last = now;
        try {
          let j = await getJson(`${OM}?latitude=${need.map((x) => x.lat).join(',')}&longitude=${need.map((x) => x.lon).join(',')}&current=precipitation,weather_code`);
          if (!Array.isArray(j)) j = [j];
          need.forEach((x, i) => { const c = j[i] && j[i].current; if (c) G.cells.set(x.key, { mm: c.precipitation, code: c.weather_code, t: Date.now() }); });
          if (G.cells.size > 800) { const ks = [...G.cells.keys()]; for (const k of ks.slice(0, ks.length - 500)) G.cells.delete(k); }
          G.err = ''; addAttr(OM_ATTR);
        } catch (e) { G.err = emsg(e); }
        finally { G.busy = false; }
      }
    }
    gridDraw(pl); render();
  }
  function gridToggle(on) { const G = S.grid; G.on = on; if (!on) { if (G.layer) G.layer.clearLayers(); render(); } else gridUpdate(); saveOpt(); }

  // ---- radar RainViewer
  function radarBar() {
    const R = S.radar; if (R.err) return `<div class="wx-err">Radar: ${esc(R.err)}</div>`;
    if (!R.frames.length) return '<div class="muted small">Memuat radar…</div>';
    const f = R.frames[R.idx]; const m = Math.round((Date.now() / 1000 - f.time) / 60);
    const note = map.getZoom() > 11 ? 'Radar hanya tampil pada zum ≤ 11; perkecil peta.' : 'Radar hanya ada di wilayah yang datanya dibuka sumbernya; sebagian besar Indonesia bisa kosong.';
    return `<div class="wx-rbar"><button id="rvPlay" class="icon">${R.timer ? '❚❚' : '▶'}</button><input id="rvSlider" type="range" min="0" max="${R.frames.length - 1}" value="${R.idx}"><span class="small">${m <= 1 ? 'terbaru' : m + ' mnt lalu'}</span></div><div class="wx-cap">${note}</div>`;
  }
  function rvUrl(f) { return `${S.radar.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`; }
  async function radarLoad() {
    const R = S.radar; R.err = '';
    try {
      const j = await getJson(RV);
      const past = j && j.radar && j.radar.past; if (!past || !past.length) throw new Error('tidak ada frame radar');
      R.frames = past; R.host = j.host || 'https://tilecache.rainviewer.com'; R.idx = past.length - 1; R.t = Date.now();
      addAttr('Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">Weather data by RainViewer</a>');
      radarShow();
    } catch (e) { R.err = emsg(e); }
    render();
  }
  function radarShow() {
    const R = S.radar; if (!R.on || !R.frames.length) return;
    const f = R.frames[R.idx];
    if (map.getZoom() > 11) { if (R.layer) { map.removeLayer(R.layer); R.layer = null; } return; }
    if (!R.layer) { R.layer = L.tileLayer(rvUrl(f), { opacity: 0.65, maxNativeZoom: 7, maxZoom: 22, zIndex: 300, crossOrigin: true }).addTo(map); }
    else R.layer.setUrl(rvUrl(f));
  }
  function radarStop() { const R = S.radar; if (R.timer) { clearInterval(R.timer); R.timer = null; } }
  function radarPlay() {
    const R = S.radar; if (R.timer) { radarStop(); render(); return; }
    R.idx = 0; radarShow();
    R.timer = setInterval(() => { R.idx++; if (R.idx >= R.frames.length) { R.idx = R.frames.length - 1; radarStop(); } radarShow(); render(); }, 1500);   // 1 putaran saja: hemat permintaan tile
    render();
  }
  function radarToggle(on) {
    const R = S.radar; R.on = on;
    if (!on) { radarStop(); if (R.layer) { map.removeLayer(R.layer); R.layer = null; } render(); saveOpt(); return; }
    if (!R.frames.length || Date.now() - R.t > 600000) radarLoad(); else { radarShow(); render(); }
    saveOpt();
  }

  // ---- BMKG (opsional)
  function bmkgHtml() {
    const key = (CFG.bmkgAdm4 || '').trim(); if (!key) return '';
    const B = S.bmkg;
    if (B.err) return `<div class="wx-bmkg"><b>BMKG</b><div class="wx-err">${esc(B.err)}</div></div>`;
    if (!B.data) return '<div class="wx-bmkg"><b>BMKG</b> <span class="muted small">memuat…</span></div>';
    const lok = B.data.lokasi || {}; const flat = []; for (const day of (B.data.data && B.data.data[0] && B.data.data[0].cuaca) || []) for (const e of (day || [])) flat.push(e);
    const nowT = Date.now(); let nx = flat.filter((e) => { const t = Date.parse(String(e.utc_datetime || '').replace(' ', 'T') + 'Z'); return isFinite(t) && t >= nowT - 90 * 60000; }).slice(0, 3);
    if (!nx.length) nx = flat.slice(0, 3);
    const rows = nx.map((e) => `<div class="wx-brow"><span>${esc(String(e.local_datetime || '').slice(11, 16))}</span><span>${esc(e.weather_desc || '–')}</span><span>${e.t != null ? esc(e.t) + '°C' : ''}</span><span>${e.hu != null ? esc(e.hu) + '%' : ''}</span></div>`).join('');
    return `<div class="wx-bmkg"><b>Prakiraan BMKG</b> <span class="small muted">${esc([lok.desa, lok.kecamatan].filter(Boolean).join(', '))}</span>${rows || '<div class="muted small">data kosong</div>'}<div class="wx-cap">Sumber: BMKG</div></div>`;
  }
  async function bmkgLoad() {
    const key = (CFG.bmkgAdm4 || '').trim(); const B = S.bmkg; if (!key) { B.data = null; B.err = ''; return; }
    if (B.key === key && (B.data || B.err) && Date.now() - B.t < 1800000) return;
    B.key = key; B.t = Date.now();
    try { const j = await getJson(`${BM}?adm4=${encodeURIComponent(key)}`); if (!j || !j.data) throw new Error('format respons tidak dikenal'); B.data = j; B.err = ''; addAttr('Prakiraan: BMKG'); }
    catch (e) { B.data = null; B.err = `BMKG tidak dapat diambil (${emsg(e)}). Periksa kode adm4 di Pengaturan; bila kode benar, kemungkinan peramban memblokir permintaan (CORS).`; }
    render();
  }

  // ---- siklus
  function saveOpt() { UI.radar = S.radar.on; UI.wxGrid = S.grid.on; UI.wxTrack = S.trkOn; if (typeof saveUi === 'function') saveUi(); }
  function tick() {
    if (!S.on || S.busy) return;
    const p = refPos();
    if (p && !p.d.replay && navigator.onLine !== false && (!S.pos || km(S.pos, p) > 5 || Date.now() - S.fetchedAt > 600000)) loadOm(p);
    if ((CFG.bmkgAdm4 || '').trim()) bmkgLoad();
    if (S.radar.on && Date.now() - S.radar.t > 600000 && !S.radar.timer) radarLoad();
    if (S.grid.on) gridUpdate();
    else if (S.data) render();      // menyegarkan "x mnt lalu"
  }
  function light() {               // pemeriksaan ringan tiap 3 detik
    if (!S.on) return;
    maybeTrack();
    if (S.trkFor !== (selected || '')) { drawTrackIcons(); S.cardKey = ''; }
    const d = devices.get(selected);
    const key = (selected || '') + '|' + (d && d.replay ? (() => { const x = d.rp ? nearest(d, d.rp.cur) : null; return x ? x.tg : (d.wx && d.wx.err) || 'w'; })() : 'live');
    if (key !== S.cardKey) { S.cardKey = key; render(); }
  }
  function init() {
    S.on = CFG.wxOn !== false;
    const root = $('#wxPanel'); if (root) root.hidden = !S.on;
    document.addEventListener('change', (e) => {
      const t = e.target; if (!t) return;
      if (t.id === 'chkRadar') radarToggle(t.checked);
      else if (t.id === 'chkGrid') gridToggle(t.checked);
      else if (t.id === 'chkWxTrack') { S.trkOn = t.checked; drawTrackIcons(); saveOpt(); }
    });
    document.addEventListener('click', (e) => { if (e.target && e.target.id === 'rvPlay') radarPlay(); });
    document.addEventListener('input', (e) => { if (e.target && e.target.id === 'rvSlider') { radarStop(); S.radar.idx = Number(e.target.value); radarShow(); } });
    map.on('zoomend', () => { if (S.radar.on) { radarShow(); render(); } });
    let mt = null; map.on('moveend', () => { if (!S.grid.on) return; clearTimeout(mt); mt = setTimeout(gridUpdate, 1200); });
    if (UI.wxTrack === false) S.trkOn = false;
    if (S.on && UI.radar) { S.radar.on = true; radarLoad(); }
    if (S.on && UI.wxGrid) { S.grid.on = true; setTimeout(gridUpdate, 2500); }
    render(); setInterval(tick, 15000); setTimeout(tick, 1500); setInterval(light, 3000);
    window.addEventListener('online', tick);
  }
  function applyCfg() {
    S.on = CFG.wxOn !== false; const r = $('#wxPanel'); if (r) r.hidden = !S.on;
    if (!S.on) { if (S.radar.on) radarToggle(false); if (S.grid.layer) S.grid.layer.clearLayers(); trkLayer.clearLayers(); }
    S.bmkg.key = ''; render(); tick(); if (S.on) drawTrackIcons();
  }
  return { init, applyCfg, tick, light, sessText, nowText, timelineHtml, rainAt, rainCls, rainCol, RAIN, logs: S.logBySess, _state: S };
})();
try { WX.init(); } catch (e) { console.error('modul cuaca gagal dimulai', e); }
