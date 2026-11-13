/* Fobos Mini — modul cuaca (opsional; web app tetap jalan bila modul ini gagal).
 * Sumber: Open-Meteo (cuaca + prakiraan, tanpa API key), RainViewer (radar hujan, max zum 7),
 * BMKG (prakiraan kelurahan, perlu kode adm4 di Pengaturan). Semua dipanggil langsung dari browser.
 * Dimuat setelah app.js dan memakai variabel global app.js (map, devices, selected, $, esc, cfgNum, CFG). */
'use strict';
const WX = (() => {
  const OM = 'https://api.open-meteo.com/v1/forecast';
  const RV = 'https://api.rainviewer.com/public/weather-maps.json';
  const BM = 'https://api.bmkg.go.id/publik/prakiraan-cuaca';
  const S = { on: true, pos: null, fetchedAt: 0, data: null, err: '', busy: false,
    radar: { on: false, frames: [], host: '', layer: null, idx: 0, timer: null, err: '', t: 0 },
    bmkg: { data: null, err: '', t: 0, key: '' }, logBySess: {} };
  const attrib = new Set();
  function addAttr(html) { if (!attrib.has(html)) { attrib.add(html); map.attributionControl.addAttribution(html); } }

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
  function icon(kind, day = true) {
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
    return `<svg class="wx-ic" viewBox="0 0 60 60" aria-hidden="true">${g}</svg>`;
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
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
    try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(tm); }
  }

  // ---- Open-Meteo
  async function loadOm(pos) {
    const u = `${OM}?latitude=${pos.lat.toFixed(4)}&longitude=${pos.lon.toFixed(4)}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day'
      + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&forecast_hours=12&timezone=auto&wind_speed_unit=kmh';
    S.busy = true;
    try {
      const j = await getJson(u);
      if (!j || !j.current) throw new Error('format respons tidak dikenal');
      S.data = j; S.pos = { lat: pos.lat, lon: pos.lon }; S.fetchedAt = Date.now(); S.err = '';
      addAttr('Cuaca: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0)');
      logWx(pos.d, j.current);
    } catch (e) { S.err = (e && e.name === 'AbortError') ? 'waktu habis' : (e && e.message) || String(e); }
    finally { S.busy = false; render(); if (typeof renderSummary === 'function') renderSummary(); }
  }
  function logWx(d, c) {
    if (!d || !d.sess || d.replay) return;
    const a = S.logBySess[d.sess] = S.logBySess[d.sess] || [];
    a.push({ waktu_utc: new Date().toISOString(), lat: S.pos.lat, lon: S.pos.lon, kode_cuaca: c.weather_code, cuaca: wmo(c.weather_code)[0],
      suhu_c: c.temperature_2m, kelembapan_pct: c.relative_humidity_2m, hujan_mm: c.precipitation, awan_pct: c.cloud_cover,
      angin_kmj: c.wind_speed_10m, arah_angin_deg: c.wind_direction_10m, hembusan_kmj: c.wind_gusts_10m, sumber: 'Open-Meteo' });
  }

  // ---- ringkasan teks (dipakai Ringkasan sesi, HUD, laporan)
  function sessText(sess) {
    const a = S.logBySess[sess]; if (!a || !a.length) return '';
    const wet = a.reduce((m, x) => (x.hujan_mm > m.hujan_mm ? x : m), a[0]);
    const t = a.map((x) => x.suhu_c).filter((x) => x != null); const lo = Math.min(...t), hi = Math.max(...t);
    const base = wet.hujan_mm > 0 ? wet.cuaca : a[a.length - 1].cuaca;
    return `${base} · ${lo === hi ? fmt1(lo) : fmt1(lo) + '–' + fmt1(hi)}°C` + (wet.hujan_mm > 0 ? ` · hujan maks ${fmt1(wet.hujan_mm)} mm/j` : '');
  }
  function nowText() {
    const c = S.data && S.data.current; if (!c) return '';
    return `${wmo(c.weather_code)[0]} · ${fmt1(c.temperature_2m)}°C · angin ${Math.round(c.wind_speed_10m)} km/j ${dirName(c.wind_direction_10m)}`;
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
      + '<div class="wx-cap">garis = suhu · batang biru = peluang hujan per jam</div>';
  }

  // ---- render panel
  function render() {
    const body = $('#wxBody'); if (!body) return;
    const brief = $('#wxBrief'); const c = S.data && S.data.current;
    if (!S.on) { body.innerHTML = '<div class="muted small">Cuaca dimatikan.</div>'; brief.textContent = ''; return; }
    let h = '';
    if (c) {
      const [lbl, kind] = wmo(c.weather_code);
      h += `<div class="wx-main">${icon(kind, c.is_day !== 0)}<div class="wx-big"><b>${fmt1(c.temperature_2m)}°C</b><span>${esc(lbl)}</span></div>
        <div class="wx-wind">${arrow(c.wind_direction_10m)}<b>${Math.round(c.wind_speed_10m)}</b><span>km/j ${esc(dirName(c.wind_direction_10m))}</span></div></div>
        <div class="wx-grid"><div><span class="k">Terasa</span><span class="v">${fmt1(c.apparent_temperature)}°</span></div>
        <div><span class="k">Lembap</span><span class="v">${Math.round(c.relative_humidity_2m)}%</span></div>
        <div><span class="k">Hujan</span><span class="v">${fmt1(c.precipitation)} mm</span></div>
        <div><span class="k">Awan</span><span class="v">${Math.round(c.cloud_cover)}%</span></div>
        <div><span class="k">Hembusan</span><span class="v">${Math.round(c.wind_gusts_10m)} km/j</span></div></div>` + hourly();
      const age = Math.round((Date.now() - S.fetchedAt) / 60000);
      h += `<div class="wx-cap">Lokasi ${S.pos.lat.toFixed(3)}, ${S.pos.lon.toFixed(3)} · diperbarui ${age < 1 ? 'baru saja' : age + ' mnt lalu'}${refPos() && refPos().d.replay ? ' · cuaca terkini di lokasi rekaman' : ''}</div>`;
      brief.innerHTML = `${icon(kind, c.is_day !== 0)}<span>${fmt1(c.temperature_2m)}°</span>`;
    } else if (S.err) {
      h += `<div class="wx-err">Cuaca belum dapat diambil (${esc(S.err)}). Butuh internet pada perangkat ini; akan dicoba lagi otomatis.</div>`; brief.textContent = '';
    } else {
      h += `<div class="muted small">${refPos() ? 'Mengambil cuaca…' : 'Menunggu posisi dari perangkat…'}</div>`; brief.textContent = '';
    }
    h += `<label class="small wx-radar"><input type="checkbox" id="chkRadar" ${S.radar.on ? 'checked' : ''}> radar hujan (RainViewer)</label>`;
    if (S.radar.on) h += radarBar();
    h += bmkgHtml();
    body.innerHTML = h;
    const hw = $('#hudWx'); if (hw) hw.innerHTML = c ? `<span class="hl">Cuaca</span> <b>${esc(nowText())}</b>` : '';
  }

  // ---- radar RainViewer
  function radarBar() {
    const R = S.radar; if (R.err) return `<div class="wx-err">Radar: ${esc(R.err)}</div>`;
    if (!R.frames.length) return '<div class="muted small">Memuat radar…</div>';
    const f = R.frames[R.idx]; const m = Math.round((Date.now() / 1000 - f.time) / 60);
    const zoomNote = map.getZoom() > 11 ? '<div class="wx-cap">Radar hanya tampil pada zum ≤ 11 (resolusi sumber rendah); perkecil peta.</div>' : '';
    return `<div class="wx-rbar"><button id="rvPlay" class="icon">${R.timer ? '❚❚' : '▶'}</button><input id="rvSlider" type="range" min="0" max="${R.frames.length - 1}" value="${R.idx}"><span class="small">${m <= 1 ? 'terbaru' : m + ' mnt lalu'}</span></div>${zoomNote}`;
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
    } catch (e) { R.err = (e && e.message) || String(e); }
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
    const key = (CFG.bmkgAdm4 || '').trim(); const B = S.bmkg; if (!key) { B.data = null; B.err = ''; render(); return; }
    if (B.key === key && B.data && Date.now() - B.t < 1800000) return;
    B.key = key;
    try { const j = await getJson(`${BM}?adm4=${encodeURIComponent(key)}`); if (!j || !j.data) throw new Error('format respons tidak dikenal'); B.data = j; B.err = ''; B.t = Date.now(); addAttr('Prakiraan: BMKG'); }
    catch (e) { B.data = null; B.err = `BMKG tidak dapat diambil (${(e && e.message) || e}). Periksa kode adm4 di Pengaturan; bila kode benar, kemungkinan peramban memblokir permintaan (CORS).`; }
    render();
  }

  // ---- siklus
  function saveOpt() { try { const u = JSON.parse(localStorage.getItem('fobos.ui') || '{}'); u.radar = S.radar.on; localStorage.setItem('fobos.ui', JSON.stringify(u)); } catch (e) { /* abaikan */ } }
  function tick() {
    if (!S.on || S.busy) return;
    const p = refPos();
    if (p && (!S.pos || km(S.pos, p) > 5 || Date.now() - S.fetchedAt > 600000)) { if (navigator.onLine !== false) loadOm(p); }
    if ((CFG.bmkgAdm4 || '').trim()) bmkgLoad();
    if (S.radar.on && Date.now() - S.radar.t > 600000 && !S.radar.timer) radarLoad();
    if (S.data) render();      // menyegarkan "x mnt lalu"
  }
  function init() {
    S.on = CFG.wxOn !== false;
    const root = $('#wxPanel'); if (root) root.hidden = !S.on;
    document.addEventListener('change', (e) => { if (e.target && e.target.id === 'chkRadar') radarToggle(e.target.checked); });
    document.addEventListener('click', (e) => { if (e.target && e.target.id === 'rvPlay') radarPlay(); });
    document.addEventListener('input', (e) => { if (e.target && e.target.id === 'rvSlider') { radarStop(); S.radar.idx = Number(e.target.value); radarShow(); } });
    map.on('zoomend', () => { if (S.radar.on) { radarShow(); render(); } });
    let u = {}; try { u = JSON.parse(localStorage.getItem('fobos.ui') || '{}'); } catch (e) { u = {}; }
    if (u.radar && S.on) { S.radar.on = true; radarLoad(); }
    render(); setInterval(tick, 15000); setTimeout(tick, 1500);
    window.addEventListener('online', tick);
  }
  function applyCfg() { S.on = CFG.wxOn !== false; const r = $('#wxPanel'); if (r) r.hidden = !S.on; if (!S.on && S.radar.on) radarToggle(false); S.bmkg.key = ''; render(); tick(); }
  return { init, applyCfg, tick, sessText, nowText, logs: S.logBySess, _state: S };
})();
try { WX.init(); } catch (e) { console.error('modul cuaca gagal dimulai', e); }
