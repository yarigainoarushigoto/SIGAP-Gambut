// Halaman-halaman dashboard. Setiap view: mount(el, ctx) membangun kerangka, update(ctx) mengisi data.

import { fmt, fmtDateTime, fmtShort, fmtDayKey, relTime, esc, bucket, socFromVoltage, haversineKm, download, toCsv, dateKey } from "./util.js";
import { pfviClass, PFVI_CLASSES, theta } from "./pfvi.js";
import { timeChart, legendHtml } from "./charts.js";
import { LEVELS } from "./alerts.js";
import { saveConfig, resetConfig } from "./config.js";

const H = 36e5, D = 864e5;
const STATUS_CLASS = { good: "st-good", warning: "st-warning", serious: "st-serious", critical: "st-critical" };
const LEVEL_CLASS = { danger: "st-critical", warn: "st-warning", info: "st-muted", ok: "st-good" };
const q = (el, s) => el.querySelector(s);

/* ---------------------------------------------------------------- helper */

const pts = (rows, key) => rows.map((r) => ({ x: r.ts, y: r[key] ?? null }));

/** Sisipkan titik null bila jeda antar data > gapMs agar garis terputus (paket hilang terlihat). */
function withGaps(points, gapMs) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i && points[i].x - points[i - 1].x > gapMs) out.push({ x: points[i - 1].x + 1, y: null });
    out.push(points[i]);
  }
  return out;
}

function wtStatus(cm, t) {
  if (cm == null) return "st-muted";
  if (cm >= t.wtDangerCm) return "st-critical";
  if (cm >= t.wtWarnCm) return "st-warning";
  return "st-good";
}
function wtLabel(cm, t) {
  if (cm == null) return "Tidak ada data";
  if (cm >= t.wtDangerCm) return "Bahaya";
  if (cm >= t.wtWarnCm) return "Waspada";
  if (cm < 0) return "Tergenang";
  return "Aman";
}
const pill = (cls, text) => `<span class="pill ${cls}"><span class="sw"></span>${esc(text)}</span>`;
const clsPill = (c) => (c ? pill(STATUS_CLASS[c.status], c.label) : pill("st-muted", "–"));

function deltaText(now, ago, unit, { upWord, downWord, upBad = true, digits = 1 }) {
  if (now == null || ago == null) return "";
  const d = now - ago;
  if (Math.abs(d) < 0.05) return `stabil / 24 jam`;
  const up = d > 0;
  const cls = (up === upBad) ? "up" : "down";
  return `<span class="${cls}">${up ? "▲" : "▼"} ${up ? upWord : downWord} ${fmt(Math.abs(d), digits)} ${unit}</span> / 24 jam`;
}

const ICON_WARN = `<svg class="alarm-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 1 21h22L12 2Zm0 6 1 7h-2l1-7Zm0 9.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z"/></svg>`;

function pfviNow(d) {
  const edge = d.latest?.pfvi ?? null;
  const dash = d.pfvi.length ? d.pfvi[d.pfvi.length - 1].pfvi : null;
  return { edge, dash, value: edge ?? dash, source: edge != null ? "inferensi edge (node)" : "hitung ulang dashboard" };
}

function dryDays(daily) {
  let n = 0;
  for (let i = daily.length - 1; i >= 0; i--) { if ((daily[i].rainMm ?? 0) >= 5.1) break; n++; }
  return n;
}

function packetStats(d, cfg, windowMs = D) {
  const t0 = (d.latest?.ts ?? Date.now()) - windowMs;
  const got = d.readings.filter((r) => r.ts > t0).length;
  const expected = Math.round(windowMs / (cfg.intervalMinutes * 6e4));
  return { got, expected, pct: Math.min(100, (got / expected) * 100) };
}

/* ---------------------------------------------------------------- Peta (dipakai 2 view) */

function makeMap(el, ctx, { zoom = 14, interactive = true } = {}) {
  if (!window.L) { el.innerHTML = `<div class="ph">Peta tidak tersedia</div>`; return null; }
  const L = window.L;
  const map = L.map(el, { zoomControl: interactive, scrollWheelZoom: interactive, attributionControl: true });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "© Esri, Maxar",
  });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
  sat.addTo(map);
  map.attributionControl.setPrefix(false);
  if (interactive) L.control.layers({ "Citra satelit": sat, "Peta jalan (OSM)": osm }, {}, { position: "topright" }).addTo(map);
  if (interactive) L.control.scale({ imperial: false }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const pos = ctx.cfg.nodes.filter((n) => n.lat != null).map((n) => [n.lat, n.lng]);
  if (ctx.cfg.gateway?.lat != null) pos.push([ctx.cfg.gateway.lat, ctx.cfg.gateway.lng]);
  if (pos.length > 1) map.fitBounds(pos, { padding: [40, 40], maxZoom: 16 });
  else if (pos.length) map.setView(pos[0], zoom);
  else map.setView([-0.37, 109.56], 12);
  setTimeout(() => map.invalidateSize(), 50);
  return { map, layer };
}

function drawMarkers(m, ctx) {
  if (!m) return;
  const L = window.L;
  m.layer.clearLayers();
  const gw = ctx.cfg.gateway;
  if (gw?.lat != null) {
    L.marker([gw.lat, gw.lng], { icon: L.divIcon({ className: "", html: `<div class="gw-marker"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) })
      .bindPopup(`<div class="map-pop"><b>${esc(gw.name)}</b><br>ESP32 + SX1276 · WiFi/router 4G → MQTT</div>`)
      .addTo(m.layer);
  }
  for (const n of ctx.cfg.nodes) {
    if (n.lat == null) continue;
    const d = ctx.derived[n.id];
    const last = d?.latest;
    const p = d ? pfviNow(d) : {};
    const c = pfviClass(p.value);
    const offline = d?.alerts.active.some((a) => a.key === "offline");
    const st = offline || !c ? "var(--muted)" : `var(--${c.status})`;
    if (gw?.lat != null) {
      const km = haversineKm(n, gw);
      L.polyline([[n.lat, n.lng], [gw.lat, gw.lng]], { color: "#7cc6ff", weight: 2, dashArray: "6 6", opacity: 0.9 })
        .bindTooltip(`Tautan LoRa ${fmt(km, 2)} km${last?.rssi != null ? ` · RSSI ${last.rssi} dBm` : ""}`, { sticky: true })
        .addTo(m.layer);
    }
    const html = `<div class="node-marker ${c && c.status !== "good" && !offline ? "pulse" : ""}" style="--st:${st}"></div>`;
    L.marker([n.lat, n.lng], { icon: L.divIcon({ className: "", html, iconSize: [22, 22], iconAnchor: [11, 11] }) })
      .bindPopup(`<div class="map-pop"><b>${esc(n.name)}</b> ${offline ? "· <span style='color:var(--critical-ink)'>offline</span>" : "· aktif"}
        <table>
          <tr><td>Muka air</td><td>${fmt(last?.wt_cm)} cm</td></tr>
          <tr><td>Kelembapan gambut</td><td>${fmt(last?.sm_pct)} %</td></tr>
          <tr><td>Suhu udara</td><td>${fmt(last?.air_t_c)} °C</td></tr>
          <tr><td>PFVI</td><td>${fmt(p.value, 0)} (${c ? c.label : "–"})</td></tr>
          <tr><td>Baterai</td><td>${fmt(last?.batt_v, 2)} V</td></tr>
        </table>
        <div class="muted" style="margin-top:4px">${last ? "Paket terakhir " + relTime(last.ts) : "Belum ada data"}</div></div>`)
      .bindTooltip(`${esc(n.name)}${c ? " · " + c.label : ""}`, { direction: "top", offset: [0, -10] })
      .addTo(m.layer);
  }
}

/* ================================================================= RINGKASAN */

const ringkasan = {
  mount(el, ctx) {
    el.innerHTML = `
      <div id="alarm"></div>
      <section class="kpis" id="kpis" aria-label="Pembacaan terkini"></section>
      <div class="grid g-main">
        <section class="card">
          <div class="card-head">
            <div><h2>Tren 14 hari terakhir</h2><p class="sub">PFVI harian dan kedalaman muka air. Garis putus merah = ambang bahaya.</p></div>
          </div>
          <p class="chart-title">Indeks PFVI (0–300)</p>
          <div class="chart-box tall"><canvas id="cPfvi" aria-label="Grafik PFVI 14 hari"></canvas></div>
          ${legendHtml([{ label: "PFVI harian (hitung ulang dashboard)", color: "--s1" }, { label: "PFVI inferensi edge (node)", color: "--s2" }])}
          <hr class="divider">
          <p class="chart-title">Kedalaman muka air di bawah permukaan gambut (cm)</p>
          <div class="chart-box"><canvas id="cWt" aria-label="Grafik muka air 14 hari"></canvas></div>
        </section>
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2>Lokasi node sensor</h2><p class="sub" id="mapSub"></p></div><a href="#peta" class="sub">Buka peta →</a></div>
            <div class="map" id="miniMap"></div>
          </section>
          <section class="card">
            <div class="card-head"><h2>Notifikasi terbaru</h2><a href="#notifikasi" class="sub">Semua →</a></div>
            <div class="notes" id="notes"></div>
          </section>
        </div>
      </div>
      <div class="grid g-2" style="margin-top:16px">
        <section class="card">
          <div class="card-head"><div><h2>Kondisi perangkat</h2><p class="sub">Node lapangan bertenaga surya + tautan LoRa</p></div><a href="#perangkat" class="sub">Detail →</a></div>
          <div class="tiles" id="tiles"></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Riwayat pembacaan sensor (ringkas)</h2><a href="#data" class="sub">Semua data →</a></div>
          <div class="table-wrap" id="recent"></div>
        </section>
      </div>`;
    this.map = makeMap(q(el, "#miniMap"), ctx, { interactive: false });
    q(el, "#mapSub").textContent = `${ctx.cfg.site.partner}, ${ctx.cfg.site.region}`;
    this.el = el;
  },
  unmount() { this.map?.map.remove(); this.map = null; },
  update(ctx) {
    const el = this.el, cfg = ctx.cfg, t = cfg.thresholds, s = ctx.store, id = ctx.node;
    const d = ctx.derived[id];
    if (!d) return;
    const last = d.latest;
    const today = d.daily[d.daily.length - 1];

    // Alarm aktif
    const act = d.alerts.active.filter((a) => a.level !== "info");
    if (act.length) {
      const worst = act[0].level;
      q(el, "#alarm").innerHTML = `<div class="alarm ${LEVEL_CLASS[worst]}" role="alert">${ICON_WARN}<div>
        <b>${act.length} kondisi ${worst === "danger" ? "bahaya" : "waspada"} aktif</b>
        <ul>${act.slice(0, 4).map((a) => `<li><strong>${esc(a.title)}</strong> — ${esc(a.detail || "")}${a.since ? ` (sejak ${fmtShort(a.since)})` : ""}</li>`).join("")}</ul></div></div>`;
    } else q(el, "#alarm").innerHTML = "";

    // KPI
    const wt = s.lastValue(id, "wt_cm"), wt24 = s.valueAgo(id, "wt_cm", D);
    const sm = s.lastValue(id, "sm_pct"), sm24 = s.valueAgo(id, "sm_pct", D);
    const air = s.lastValue(id, "air_t_c");
    const p = pfviNow(d), c = pfviClass(p.value);
    const pos = p.value == null ? 0 : (p.value / 300) * 100;
    const dd = dryDays(d.daily);
    q(el, "#kpis").innerHTML = `
      <article class="card kpi" style="--kpi-accent:var(--s1)">
        <div class="kpi-label"><span>Tinggi muka air</span>${pill(wtStatus(wt, t), wtLabel(wt, t))}</div>
        <div class="kpi-value">${fmt(wt)}<small>cm</small></div>
        <div class="kpi-meta"><span>di bawah permukaan gambut</span>
          <span>${deltaText(wt, wt24, "cm", { upWord: "turun", downWord: "naik" })}</span>
          <span>Ambang bahaya ${t.wtDangerCm} cm · float ${last?.float_low ? "<b>kering</b>" : "tergenang"}</span></div>
      </article>
      <article class="card kpi" style="--kpi-accent:var(--s3)">
        <div class="kpi-label"><span>Kelembapan gambut</span>${sm != null && sm < t.smLowPct ? pill("st-warning", "Rendah") : ""}</div>
        <div class="kpi-value">${fmt(sm)}<small>%</small></div>
        <div class="kpi-meta"><span>${deltaText(sm, sm24, "%", { upWord: "naik", downWord: "turun", upBad: false })}</span>
          <span>SEN0600 RS485 · suhu tanah ${fmt(s.lastValue(id, "soil_t_c"))} °C</span></div>
      </article>
      <article class="card kpi" style="--kpi-accent:#6250d6">
        <div class="kpi-label"><span>Curah hujan hari ini</span></div>
        <div class="kpi-value">${fmt(today?.rainMm ?? 0)}<small>mm</small></div>
        <div class="kpi-meta"><span>${dd} hari tanpa hujan efektif (≥ 5,1 mm)</span>
          <span>Tipping bucket${today?.rainBmkg != null ? ` · BMKG ${fmt(today.rainBmkg)} mm` : ""}</span></div>
      </article>
      <article class="card kpi" style="--kpi-accent:var(--s2)">
        <div class="kpi-label"><span>Suhu udara</span>${air != null && air >= t.airTempHighC ? pill("st-warning", "Panas") : ""}</div>
        <div class="kpi-value">${fmt(air)}<small>°C</small></div>
        <div class="kpi-meta"><span>Maks. hari ini ${fmt(today?.tmaxC)} °C</span>
          <span>RH ${fmt(s.lastValue(id, "rh_pct"), 0)} % · DHT22</span></div>
      </article>
      <article class="card kpi pfvi-card ${c ? STATUS_CLASS[c.status] : "st-muted"}">
        <div class="kpi-label"><span>Status PFVI</span><span class="muted" style="text-transform:none;letter-spacing:0;font-weight:600">${c ? `kelas ${c.min}–${c.max}` : ""}</span></div>
        <div class="pfvi-class">${c ? c.label : "–"}</div>
        <div class="kpi-meta"><span>Indeks <b>${fmt(p.value, 0)}</b> dari 300 · ${p.source}</span>
          ${p.edge != null && p.dash != null ? `<span>Hitung ulang harian: ${fmt(p.dash, 0)}</span>` : ""}</div>
        <div class="pfvi-scale" aria-hidden="true">
          <div class="seg">${PFVI_CLASSES.map((k) => `<span style="background:var(--${k.status})"></span>`).join("")}</div>
          <div class="needle" style="left:${pos}%"></div>
          <div class="ticks"><span>0</span><span>75</span><span>150</span><span>225</span><span>300</span></div>
        </div>
      </article>`;

    // Grafik 14 hari
    const now = last?.ts ?? Date.now();
    const span = [now - 14 * D, now];
    const recent = d.readings.filter((r) => r.ts >= span[0]);
    const hourly = bucket(recent, 2 * H, ["wt_cm", "pfvi"]);
    const dailyPts = d.pfvi.map((r) => ({ x: new Date(r.date + "T23:59:00+07:00").getTime(), y: r.pfvi })).filter((p) => p.x >= span[0] - D);
    timeChart({
      id: "r-pfvi", canvas: q(el, "#cPfvi"), span, yMin: 0, yMax: 300, bands: true, digits: 0, daily: false,
      series: [
        { label: "PFVI harian (dashboard)", color: "--s1", data: dailyPts, points: true, spanGaps: true },
        { label: "PFVI edge", color: "--s2", data: withGaps(pts(hourly, "pfvi"), 3 * H) },
      ],
    });
    timeChart({
      id: "r-wt", canvas: q(el, "#cWt"), span, reverse: true, beginAtZero: true, unitShort: "cm",
      yMax: Math.max(t.wtDangerCm + 10, ...hourly.map((h) => h.wt_cm ?? 0)) + 5,
      thresholds: [{ value: t.wtDangerCm, label: `Bahaya ${t.wtDangerCm} cm`, color: "--critical", below: true }, { value: t.wtWarnCm, label: `Waspada ${t.wtWarnCm} cm`, color: "--warning" }],
      series: [{ label: "Muka air", color: "--s1", data: withGaps(pts(hourly, "wt_cm"), 5 * H) }],
    });

    drawMarkers(this.map, ctx);

    // Notifikasi terbaru
    const ev = d.alerts.events.slice(0, 5);
    q(el, "#notes").innerHTML = ev.length ? ev.map((e) => `<div class="note ${LEVEL_CLASS[e.level]}"><b>${esc(e.title)}</b><span>${esc(e.detail || "")} · ${fmtShort(e.ts)} WIB</span></div>`).join("")
      : `<div class="empty">Belum ada notifikasi.</div>`;

    // Perangkat
    const v = last?.batt_v, soc = socFromVoltage(v), ps = packetStats(d, cfg);
    const bst = v == null ? "st-muted" : v < t.battCritV ? "st-critical" : v < t.battLowV ? "st-warning" : "st-good";
    q(el, "#tiles").innerHTML = `
      <div class="tile ${bst}"><div class="t-label">Baterai LiFePO4</div><div class="t-value">${fmt(v, 2)}<small>V</small></div>
        <div class="meter"><span style="width:${soc ?? 0}%"></span></div><div class="t-meta">± ${fmt(soc, 0)} % (perkiraan dari tegangan)</div></div>
      <div class="tile"><div class="t-label">Sinyal LoRa</div><div class="t-value">${last?.rssi ?? "–"}<small>dBm</small></div><div class="t-meta">SNR ${fmt(last?.snr)} dB</div></div>
      <div class="tile"><div class="t-label">Paket diterima 24 jam</div><div class="t-value">${ps.got}<small>/ ${ps.expected}</small></div>
        <div class="meter"><span style="width:${ps.pct}%;background:var(--s1)"></span></div><div class="t-meta">${fmt(ps.pct, 0)} % · interval ${cfg.intervalMinutes} menit</div></div>
      <div class="tile"><div class="t-label">Paket terakhir</div><div class="t-value" style="font-size:16px">${last ? relTime(last.ts) : "–"}</div><div class="t-meta">seq #${last?.seq ?? "–"}</div></div>`;

    // Riwayat ringkas (setiap ~6 jam terakhir agar mirip catatan lapangan)
    const picks = [];
    let lastPick = Infinity;
    for (let i = d.readings.length - 1; i >= 0 && picks.length < 6; i--) {
      const r = d.readings[i];
      if (lastPick - r.ts >= 6 * H || !picks.length) { picks.push(r); lastPick = r.ts; }
    }
    q(el, "#recent").innerHTML = `<table class="data"><thead><tr><th>Waktu (WIB)</th><th class="num">Muka air (cm)</th><th class="num">Kelembapan (%)</th><th class="num">Suhu (°C)</th><th class="num">PFVI</th><th>Kelas</th></tr></thead><tbody>
      ${picks.map((r) => `<tr><td>${fmtShort(r.ts)}</td><td class="num">${fmt(r.wt_cm)}</td><td class="num">${fmt(r.sm_pct)}</td><td class="num">${fmt(r.air_t_c)}</td><td class="num">${fmt(r.pfvi, 0)}</td><td>${clsPill(pfviClass(r.pfvi))}</td></tr>`).join("")}
      </tbody></table>`;
  },
  tick(ctx) { this.update(ctx); },
};

/* ================================================================= GRAFIK HISTORIS */

const RANGES = { "24j": { ms: D, label: "24 jam" }, "7h": { ms: 7 * D, label: "7 hari" }, "30h": { ms: 30 * D, label: "30 hari" } };

const grafik = {
  range: "7h",
  mount(el, ctx) {
    const card = (id, title, cap, legend = "", cls = "") => `
      <section class="card"><p class="chart-title">${title}</p><p class="chart-cap">${cap}</p>
      <div class="chart-box ${cls}"><canvas id="${id}"></canvas></div>${legend}</section>`;
    el.innerHTML = `
      <div class="page-head"><div><h1>Grafik historis</h1><p>${esc(ctx.nodeMeta(ctx.node).name)} · arahkan kursor ke grafik untuk nilai tiap titik</p></div>
        <div class="seg-ctl" role="group" aria-label="Rentang waktu">${Object.entries(RANGES).map(([k, r]) => `<button type="button" data-r="${k}" aria-pressed="${k === this.range}">${r.label}</button>`).join("")}</div></div>
      <div class="grid g-2">
        ${card("gWt", "Kedalaman muka air (cm)", "Sensor hydrostatic 0–5 mH₂O · sumbu terbalik: makin ke bawah makin kering")}
        ${card("gPfvi", "Indeks PFVI", "Pita warna = kelas risiko. DIobs = indeks kekeringan dari kelembapan tanah (acuan kalibrasi)",
          legendHtml([{ label: "Harian (dashboard)", color: "--s1" }, { label: "Edge (node)", color: "--s2" }, { label: "DI obs (dari kelembapan)", color: "--s3", kind: "dash" }]))}
        ${card("gSm", "Kelembapan gambut (%)", "SEN0600 RS485, kadar air volumetrik")}
        ${card("gRain", "Curah hujan (mm)", "Tipping bucket di node; total BMKG harian sebagai pembanding", `<div id="rainLegend"></div>`)}
        ${card("gT", "Suhu (°C)", "Udara (DHT22, dalam pelindung radiasi) dan tanah (SEN0600)",
          legendHtml([{ label: "Suhu udara", color: "--s1" }, { label: "Suhu tanah", color: "--s2" }]))}
        ${card("gRh", "Kelembapan udara (%)", "DHT22")}
        ${card("gBatt", "Tegangan baterai (V)", "LiFePO4 12,8 V 20 Ah, diisi panel 50 Wp lewat MPPT")}
        ${card("gRssi", "Kekuatan sinyal LoRa (dBm)", "RSSI paket di penerima, 920–923 MHz")}
      </div>`;
    el.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
      this.range = b.dataset.r;
      el.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.r === this.range));
      this.update(ctx);
    }));
    this.el = el;
  },
  update(ctx) {
    const el = this.el, d = ctx.derived[ctx.node], t = ctx.cfg.thresholds;
    if (!d) return;
    const now = d.latest?.ts ?? Date.now();
    const ms = RANGES[this.range].ms;
    const span = [now - ms, now];
    const rows = d.readings.filter((r) => r.ts >= span[0]);
    const keys = ["wt_cm", "sm_pct", "air_t_c", "soil_t_c", "rh_pct", "batt_v", "rssi", "pfvi"];
    const step = this.range === "24j" ? 0 : this.range === "7h" ? H : 3 * H;
    const data = step ? bucket(rows, step, keys) : rows;
    const gap = step ? step * 2.5 : ctx.cfg.thresholds.offlineMinutes * 6e4;
    const line = (k) => withGaps(pts(data, k), gap);
    const daily = this.range !== "24j";

    timeChart({
      id: "g-wt", canvas: q(el, "#gWt"), span, reverse: true, beginAtZero: true, unitShort: "cm",
      yMax: Math.max(t.wtDangerCm + 10, ...data.map((r) => r.wt_cm ?? 0)) + 5,
      thresholds: [{ value: t.wtDangerCm, label: `Bahaya ${t.wtDangerCm} cm`, color: "--critical", below: true }, { value: t.wtWarnCm, label: `Waspada ${t.wtWarnCm} cm`, color: "--warning" }],
      series: [{ label: "Muka air", color: "--s1", data: line("wt_cm") }],
    });
    const dayX = (date) => new Date(date + "T23:59:00+07:00").getTime();
    timeChart({
      id: "g-pfvi", canvas: q(el, "#gPfvi"), span, yMin: 0, yMax: 300, bands: true, digits: 0,
      series: [
        { label: "PFVI harian", color: "--s1", data: d.pfvi.map((r) => ({ x: dayX(r.date), y: r.pfvi })), points: true, spanGaps: true },
        { label: "PFVI edge", color: "--s2", data: line("pfvi") },
        { label: "DIobs", color: "--s3", data: d.pfvi.map((r) => ({ x: dayX(r.date), y: r.diObs })), dashed: true, spanGaps: true },
      ],
    });
    timeChart({ id: "g-sm", canvas: q(el, "#gSm"), span, unitShort: "%", thresholds: [{ value: t.smLowPct, label: `Rendah < ${t.smLowPct} %`, color: "--warning" }], series: [{ label: "Kelembapan gambut", color: "--s1", data: line("sm_pct") }] });

    // Hujan: per jam untuk 24 jam, per hari untuk 7/30 hari
    let rainSeries;
    if (daily) {
      const days = d.daily.filter((x) => dayX(x.date) >= span[0]);
      const mid = (date) => new Date(date + "T12:00:00+07:00").getTime();
      rainSeries = [
        { label: "Tipping bucket", color: "--s1", bar: true, data: days.map((x) => ({ x: mid(x.date), y: x.rainSensor ?? 0 })) },
        { label: "BMKG", color: "--s2", bar: true, data: days.map((x) => ({ x: mid(x.date), y: x.rainBmkg })) },
      ];
      q(el, "#rainLegend").innerHTML = legendHtml([{ label: "Tipping bucket (node)", color: "--s1", kind: "box" }, { label: "BMKG (data sekunder)", color: "--s2", kind: "box" }]);
    } else {
      const hr = bucket(rows, H, [], ["rain_mm"]);
      rainSeries = [{ label: "Hujan per jam", color: "--s1", bar: true, data: hr.map((r) => ({ x: r.ts, y: r.rain_mm })) }];
      q(el, "#rainLegend").innerHTML = "";
    }
    timeChart({ id: "g-rain", canvas: q(el, "#gRain"), span: daily ? [span[0], span[1] + D / 2] : span, beginAtZero: true, suggestedMax: 5, tickDigits: 1, unitShort: "mm", daily, series: rainSeries });

    timeChart({ id: "g-t", canvas: q(el, "#gT"), span, unitShort: "°C", series: [{ label: "Suhu udara", color: "--s1", data: line("air_t_c") }, { label: "Suhu tanah", color: "--s2", data: line("soil_t_c") }] });
    timeChart({ id: "g-rh", canvas: q(el, "#gRh"), span, unitShort: "%", digits: 0, series: [{ label: "RH", color: "--s1", data: line("rh_pct") }] });
    timeChart({
      id: "g-batt", canvas: q(el, "#gBatt"), span, unitShort: "V", digits: 2, tickDigits: 1,
      thresholds: [{ value: t.battLowV, label: `Rendah ${t.battLowV} V`, color: "--warning" }],
      series: [{ label: "Baterai", color: "--s1", data: line("batt_v") }],
    });
    timeChart({ id: "g-rssi", canvas: q(el, "#gRssi"), span, unitShort: "dBm", digits: 0, thresholds: [{ value: t.rssiWeakDbm, label: `Lemah ${t.rssiWeakDbm} dBm`, color: "--warning" }], series: [{ label: "RSSI", color: "--s1", data: line("rssi") }] });
  },
};

/* ================================================================= PETA */

const peta = {
  mount(el, ctx) {
    el.innerHTML = `
      <div class="page-head"><div><h1>Peta node</h1><p>${esc(ctx.cfg.site.partner)} · ${esc(ctx.cfg.site.region)}</p></div></div>
      <div class="grid g-main">
        <section class="card" style="padding:12px"><div class="map big" id="bigMap"></div></section>
        <div class="stack">
          <section class="card"><h2>Daftar node</h2><div id="nodeList" style="margin-top:10px" class="notes"></div></section>
          <section class="card"><h2>Keterangan</h2>
            <div class="legend" style="display:grid;gap:6px;margin-top:8px">
              ${PFVI_CLASSES.map((c) => `<span><i class="box" style="--c:var(--${c.status});border-radius:50%"></i>Node · PFVI ${c.label} (${c.min}–${c.max})</span>`).join("")}
              <span><i class="box" style="--c:var(--muted);border-radius:50%"></i>Node offline</span>
              <span><i class="box" style="--c:#2a78d6"></i>Penerima LoRa di gedung</span>
              <span><i class="dash" style="--c:#7cc6ff"></i>Tautan radio LoRa titik-ke-titik</span>
            </div>
            <p class="sub" style="margin-top:10px">Koordinat diatur di Pengaturan. Nilai bawaan adalah contoh, ganti dengan titik GPS pemasangan.</p>
          </section>
        </div>
      </div>`;
    this.map = makeMap(q(el, "#bigMap"), ctx, { zoom: 15 });
    this.el = el;
  },
  unmount() { this.map?.map.remove(); this.map = null; },
  update(ctx) {
    drawMarkers(this.map, ctx);
    const gw = ctx.cfg.gateway;
    q(this.el, "#nodeList").innerHTML = ctx.cfg.nodes.map((n) => {
      const d = ctx.derived[n.id];
      const p = d ? pfviNow(d) : {};
      const c = pfviClass(p.value);
      const off = !d || d.alerts.active.some((a) => a.key === "offline");
      const km = gw?.lat != null && n.lat != null ? haversineKm(n, gw) : null;
      return `<div class="note ${off ? "st-muted" : c ? STATUS_CLASS[c.status] : "st-muted"}">
        <b>${esc(n.name)} <span class="muted" style="font-weight:500">(${esc(n.id)})</span></b>
        <span>${off ? "Offline / belum ada data" : `PFVI ${fmt(p.value, 0)} · ${c?.label} · muka air ${fmt(d.latest?.wt_cm)} cm`}</span>
        <span>${n.lat != null ? `${n.lat.toFixed(5)}, ${n.lng.toFixed(5)}` : "Koordinat belum diisi"}${km != null ? ` · ${fmt(km, 2)} km ke penerima` : ""}</span>
      </div>`;
    }).join("");
  },
};

/* ================================================================= NOTIFIKASI */

const notifikasi = {
  filter: "all",
  mount(el, ctx) {
    const t = ctx.cfg.thresholds;
    el.innerHTML = `
      <div class="page-head"><div><h1>Notifikasi</h1><p>Peristiwa dibuat saat status berubah. Naik level langsung; dianggap pulih setelah 3 paket berturut-turut melewati ambang dengan selisih (mis. muka air 1 cm)</p></div>
        <div class="btns"><button class="btn" id="notifBtn" type="button">Aktifkan notifikasi browser</button></div></div>
      <div class="grid g-main">
        <section class="card">
          <div class="card-head"><h2>Log peristiwa</h2>
            <div class="seg-ctl" role="group" aria-label="Filter level">
              ${[["all", "Semua"], ["danger", "Bahaya"], ["warn", "Waspada"], ["info", "Info"], ["ok", "Pulih"]].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === this.filter}">${l}</button>`).join("")}
            </div></div>
          <div class="table-wrap scroll-y" id="log"></div>
        </section>
        <div class="stack">
          <section class="card"><h2>Kondisi aktif</h2><div class="notes" id="active" style="margin-top:10px"></div></section>
          <section class="card"><h2>Aturan ambang</h2>
            <dl class="kv" style="margin-top:10px">
              <dt>Muka air waspada</dt><dd>≥ ${t.wtWarnCm} cm</dd>
              <dt>Muka air bahaya</dt><dd>≥ ${t.wtDangerCm} cm</dd>
              <dt>PFVI</dt><dd>Tinggi (&gt; 150) waspada, Ekstrem (&gt; 225) bahaya</dd>
              <dt>Kelembapan gambut</dt><dd>&lt; ${t.smLowPct} %</dd>
              <dt>Baterai</dt><dd>&lt; ${fmt(t.battLowV)} V waspada, &lt; ${fmt(t.battCritV)} V bahaya</dd>
              <dt>Node offline</dt><dd>&gt; ${t.offlineMinutes} menit tanpa paket</dd>
              <dt>Sinyal LoRa lemah</dt><dd>&lt; ${t.rssiWeakDbm} dBm</dd>
            </dl>
            <p class="sub" style="margin-top:10px"><a href="#pengaturan">Ubah ambang di Pengaturan</a></p>
          </section>
        </div>
      </div>`;
    el.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => {
      this.filter = b.dataset.f;
      el.querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.f === this.filter));
      this.update(ctx);
    }));
    const nb = q(el, "#notifBtn");
    const syncBtn = () => {
      if (!("Notification" in window)) { nb.disabled = true; nb.textContent = "Browser tidak mendukung notifikasi"; return; }
      if (Notification.permission === "granted") { nb.disabled = true; nb.textContent = "Notifikasi browser aktif"; }
      if (Notification.permission === "denied") { nb.disabled = true; nb.textContent = "Notifikasi diblokir browser"; }
    };
    syncBtn();
    nb.addEventListener("click", async () => { try { await Notification.requestPermission(); } catch { /* abaikan */ } syncBtn(); });
    this.el = el;
  },
  update(ctx) {
    const all = Object.values(ctx.derived).flatMap((d) => d.alerts.events).sort((a, b) => b.ts - a.ts);
    const rows = this.filter === "all" ? all : all.filter((e) => e.level === this.filter);
    q(this.el, "#log").innerHTML = rows.length ? `<table class="data"><thead><tr><th>Waktu (WIB)</th><th>Node</th><th>Level</th><th>Peristiwa</th><th>Keterangan</th></tr></thead><tbody>
      ${rows.slice(0, 400).map((e) => `<tr><td>${fmtShort(e.ts)}</td><td>${esc(ctx.nodeMeta(e.node).name)}</td><td>${pill(LEVEL_CLASS[e.level], e.level === "ok" ? "Pulih" : LEVELS[e.level].label)}</td><td>${esc(e.title)}</td><td class="muted">${esc(e.detail || "")}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">Tidak ada peristiwa untuk filter ini.</div>`;
    const act = Object.values(ctx.derived).flatMap((d) => d.alerts.active);
    q(this.el, "#active").innerHTML = act.length ? act.map((a) => `<div class="note ${LEVEL_CLASS[a.level]}"><b>${esc(a.title)}</b><span>${esc(ctx.nodeMeta(a.node).name)} · ${esc(a.detail || "")}</span>${a.since ? `<span>Sejak ${fmtShort(a.since)} WIB</span>` : ""}</div>`).join("")
      : `<div class="note st-good"><b>Semua normal</b><span>Tidak ada kondisi di luar ambang.</span></div>`;
  },
};

/* ================================================================= PERANGKAT & SISTEM */

const perangkat = {
  mount(el, ctx) {
    const p = ctx.cfg.pfvi;
    el.innerHTML = `
      <div class="page-head"><div><h1>Perangkat &amp; sistem</h1><p>${esc(ctx.nodeMeta(ctx.node).name)} · ${esc(ctx.nodeMeta(ctx.node).note || "")}</p></div></div>
      <section class="card"><div class="card-head"><h2>Status node</h2><span class="sub" id="devSub"></span></div><div class="tiles" id="devTiles"></div></section>
      <div class="grid g-2" style="margin-top:16px">
        <section class="card"><p class="chart-title">Tegangan baterai 7 hari (V)</p><p class="chart-cap">Naik siang hari saat panel mengisi; turun malam hari</p><div class="chart-box short"><canvas id="pBatt"></canvas></div></section>
        <section class="card"><p class="chart-title">Paket diterima per jam (7 hari)</p><p class="chart-cap">Target ${60 / ctx.cfg.intervalMinutes} paket/jam; jeda = paket hilang atau node mati</p><div class="chart-box short"><canvas id="pPkt"></canvas></div></section>
      </div>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>Arsitektur sistem</h2><p class="sub">Lima blok kerangka IoT SIGAP-Gambut (proposal, Gambar 3)</p></div></div>
        <div class="arch">
          <div class="arch-col"><h3>1. Sumber daya (PV)</h3><ul><li>Panel surya 50 Wp</li><li>MPPT 20 A (profil LiFePO4 14,4 V)</li><li>LiFePO4 12,8 V 20 Ah + BMS</li><li>Fuse/MCB DC 6 A</li><li>Buck 12→5 V (LM2596)</li><li>Step-up 12→24 V (sensor level)</li></ul></div>
          <div class="arch-col"><h3>2. Sensor lapangan</h3><ul><li>Level air hydrostatic 0–5 mH₂O, 4–20 mA (ADS1115)</li><li>Float switch level rendah</li><li>Soil moisture + suhu SEN0600 (RS485)</li><li>DHT22 suhu + RH udara</li><li>Tipping bucket rain gauge</li><li>Tegangan baterai</li></ul></div>
          <div class="arch-col"><h3>3. Node lapangan</h3><ul><li>TTGO LoRa32 V2.1 (ESP32 + SX1276)</li><li>Inferensi PFVI TinyML di edge</li><li>Paket ±20 byte / 10 menit</li><li>ACK + kirim ulang</li></ul></div>
          <div class="arch-col"><h3>4. Gateway (gedung)</h3><ul><li>TTGO LoRa32 penerima</li><li>Adaptor 5 V</li><li>WiFi gedung / router 4G</li><li>Publikasi MQTT JSON</li></ul></div>
          <div class="arch-col"><h3>5. Server &amp; dashboard</h3><ul><li>Mosquitto (MQTT + WebSocket)</li><li>FastAPI ingest + API riwayat</li><li>SQLite / PostgreSQL</li><li>Dashboard web ini</li></ul></div>
        </div>
      </section>
      <div class="grid g-2" style="margin-top:16px">
        <section class="card">
          <h2>Model PFVI yang dipakai dashboard</h2>
          <p class="sub" style="margin-bottom:10px">Port <code>firepredict()</code> peatfr; dihitung ulang harian dari agregat sensor sebagai pembanding hasil edge.</p>
          <div class="formula">PFVI_t = PFVI_(t-1) + DF_t − RF_t − WTF_t      (0 ≤ PFVI ≤ 300)
DF_t   = (300 − PFVI_(t-1))·(0,4982·e^(0,0905·Tm + 1,6096) − 4,268)·10⁻³
         / (1 + 10,88·e^(−0,001736·R0))
RF_t   = R_t − 5,1 (hujan ke-1) · R_t (hari hujan berikutnya) · 0 (R_t &lt; 5,1)
WTF_t  = aH − bH·[(1 − θ(h))·300],  θ(h) = (1 + (h/α)^n)^−(1−1/n)</div>
          <dl class="kv" style="margin-top:12px">
            <dt>aH, bH</dt><dd>${p.aH} mm, ${p.bH} mm</dd>
            <dt>α, n (van Genuchten)</dt><dd>${p.alpha}, ${p.n}</dd>
            <dt>R0 (hujan tahunan)</dt><dd>${p.R0} mm</dd>
            <dt>h</dt><dd>kedalaman muka air harian rata-rata (m)</dd>
            <dt>Tm</dt><dd>suhu udara maksimum harian (°C)</dd>
            <dt>Sumber hujan</dt><dd>${{ auto: "Tipping bucket, bila kosong BMKG", sensor: "Tipping bucket", bmkg: "BMKG" }[p.rainSource]}</dd>
          </dl>
          <p class="sub" style="margin-top:8px">Parameter awal stasiun BRG6 (Taufik dkk., 2022), dikalibrasi ulang dengan data lapangan melalui Nelder-Mead.</p>
        </section>
        <section class="card">
          <h2>Komponen PFVI 7 hari terakhir</h2>
          <p class="sub" style="margin-bottom:10px">DF menaikkan indeks; RF dan WTF positif menurunkannya. WTF negatif berarti muka air terlalu dalam untuk membasahi permukaan.</p>
          <div class="table-wrap" id="pfviTable"></div>
          <p class="sub" style="margin-top:8px" id="thetaNote"></p>
        </section>
      </div>`;
    this.el = el;
  },
  update(ctx) {
    const el = this.el, d = ctx.derived[ctx.node], cfg = ctx.cfg, t = cfg.thresholds;
    if (!d) return;
    const last = d.latest;
    const ps = packetStats(d, cfg), ps7 = packetStats(d, cfg, 7 * D);
    const v = last?.batt_v, soc = socFromVoltage(v);
    const bst = v == null ? "st-muted" : v < t.battCritV ? "st-critical" : v < t.battLowV ? "st-warning" : "st-good";
    const off = d.alerts.active.some((a) => a.key === "offline");
    q(el, "#devSub").innerHTML = off ? pill("st-critical", "Offline") : pill("st-good", "Online");
    q(el, "#devTiles").innerHTML = `
      <div class="tile ${bst}"><div class="t-label">Baterai</div><div class="t-value">${fmt(v, 2)}<small>V</small></div><div class="meter"><span style="width:${soc ?? 0}%"></span></div><div class="t-meta">SoC ± ${fmt(soc, 0)} % (perkiraan)</div></div>
      <div class="tile"><div class="t-label">RSSI</div><div class="t-value">${last?.rssi ?? "–"}<small>dBm</small></div><div class="t-meta">SNR ${fmt(last?.snr)} dB</div></div>
      <div class="tile"><div class="t-label">Paket 24 jam</div><div class="t-value">${fmt(ps.pct, 0)}<small>%</small></div><div class="t-meta">${ps.got} dari ${ps.expected}</div></div>
      <div class="tile"><div class="t-label">Paket 7 hari</div><div class="t-value">${fmt(ps7.pct, 1)}<small>%</small></div><div class="t-meta">${ps7.got} dari ${ps7.expected}</div></div>
      <div class="tile"><div class="t-label">Float switch</div><div class="t-value" style="font-size:16px">${last?.float_low == null ? "–" : last.float_low ? "Kering" : "Tergenang"}</div><div class="t-meta">Pengaman level rendah</div></div>
      <div class="tile"><div class="t-label">Paket terakhir</div><div class="t-value" style="font-size:16px">${last ? relTime(last.ts) : "–"}</div><div class="t-meta">seq #${last?.seq ?? "–"} · ${last ? fmtShort(last.ts) : ""}</div></div>`;

    const now = last?.ts ?? Date.now();
    const span = [now - 7 * D, now];
    const rows = d.readings.filter((r) => r.ts >= span[0]);
    const b = bucket(rows, H, ["batt_v"]);
    timeChart({ id: "p-batt", canvas: q(el, "#pBatt"), span, unitShort: "V", digits: 2, tickDigits: 1, series: [{ label: "Baterai", color: "--s1", data: withGaps(pts(b, "batt_v"), 3 * H) }] });
    const counts = new Map();
    for (const r of rows) { const k = Math.floor(r.ts / H) * H; counts.set(k, (counts.get(k) || 0) + 1); }
    const pk = [];
    for (let k = Math.floor(span[0] / H) * H; k <= now; k += H) pk.push({ x: k + H / 2, y: counts.get(k) || 0 });
    timeChart({ id: "p-pkt", canvas: q(el, "#pPkt"), span, beginAtZero: true, yMax: 60 / cfg.intervalMinutes + 1, digits: 0, unitShort: "paket", series: [{ label: "Paket", color: "--s1", bar: true, data: pk }] });

    const last7 = d.pfvi.slice(-7).reverse();
    const byDate = Object.fromEntries(d.daily.map((x) => [x.date, x]));
    q(el, "#pfviTable").innerHTML = `<table class="data"><thead><tr><th>Tanggal</th><th class="num">h (cm)</th><th class="num">Tm (°C)</th><th class="num">Hujan (mm)</th><th class="num">DF</th><th class="num">RF</th><th class="num">WTF</th><th class="num">PFVI</th></tr></thead><tbody>
      ${last7.map((r) => { const a = byDate[r.date]; return `<tr><td>${fmtDayKey(r.date)}</td><td class="num">${fmt(a?.wtCm)}</td><td class="num">${fmt(a?.tmaxC)}</td><td class="num">${fmt(a?.rainMm)}</td><td class="num">${fmt(r.df, 2)}</td><td class="num">${fmt(r.rf, 1)}</td><td class="num">${fmt(r.wtf, 2)}</td><td class="num"><b>${fmt(r.pfvi, 0)}</b></td></tr>`; }).join("")}
      </tbody></table>`;
    const wt = d.latest?.wt_cm;
    if (wt != null) q(el, "#thetaNote").textContent = `Pada muka air ${fmt(wt)} cm, θ(h) = ${fmt(theta(Math.max(wt, 0) / 100, cfg.pfvi.alpha, cfg.pfvi.n), 2)}. WTF berganti tanda di kedalaman ±60 cm dengan parameter saat ini.`;
  },
};

/* ================================================================= DATA & EKSPOR */

const READING_COLS = [
  { label: "waktu_wib", get: (r) => fmtShort(r.ts) },
  { label: "timestamp_utc", get: (r) => new Date(r.ts).toISOString() },
  { label: "node", get: (r) => r.node },
  { label: "seq", get: (r) => r.seq },
  { label: "muka_air_cm", get: (r) => r.wt_cm },
  { label: "float_low", get: (r) => (r.float_low == null ? "" : r.float_low ? 1 : 0) },
  { label: "kelembapan_gambut_pct", get: (r) => r.sm_pct },
  { label: "suhu_tanah_c", get: (r) => r.soil_t_c },
  { label: "suhu_udara_c", get: (r) => r.air_t_c },
  { label: "rh_udara_pct", get: (r) => r.rh_pct },
  { label: "hujan_mm", get: (r) => r.rain_mm },
  { label: "baterai_v", get: (r) => r.batt_v },
  { label: "pfvi_edge", get: (r) => r.pfvi },
  { label: "rssi_dbm", get: (r) => r.rssi },
  { label: "snr_db", get: (r) => r.snr },
];

const data = {
  range: "7h", page: 0,
  mount(el, ctx) {
    el.innerHTML = `
      <div class="page-head"><div><h1>Data &amp; ekspor</h1><p>${esc(ctx.nodeMeta(ctx.node).name)} · pembacaan mentah tiap ${ctx.cfg.intervalMinutes} menit dan agregat harian</p></div>
        <div class="seg-ctl" role="group" aria-label="Rentang">${Object.entries(RANGES).map(([k, r]) => `<button type="button" data-r="${k}" aria-pressed="${k === this.range}">${r.label}</button>`).join("")}</div></div>
      <section class="card">
        <div class="card-head"><div><h2>Unduh data</h2><p class="sub" id="dlSub"></p></div></div>
        <div class="btns">
          <button class="btn primary" data-dl="raw" type="button">CSV pembacaan</button>
          <button class="btn" data-dl="daily" type="button">CSV harian + PFVI</button>
          <button class="btn" data-dl="peatfr" type="button">CSV format peatfr (WT, SM, Rf, Temp)</button>
          <button class="btn" data-dl="json" type="button">JSON</button>
        </div>
        <p class="sub" style="margin-top:10px">Format peatfr: WT dalam meter bernilai negatif di bawah permukaan (sesuai <code>firepredict()</code>), SM %, Rf mm/hari, Temp = suhu maksimum harian °C. Bisa langsung dipakai <code>autopeatfr(WT, SM, Rf, Temp)</code> di R untuk kalibrasi Nelder-Mead.</p>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>Agregat harian</h2></div>
        <div class="table-wrap" id="dailyTable"></div>
      </section>
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>Pembacaan mentah</h2><div class="btns" id="pager"></div></div>
        <div class="table-wrap scroll-y" id="rawTable"></div>
      </section>`;
    el.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
      this.range = b.dataset.r; this.page = 0;
      el.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.r === this.range));
      this.update(ctx);
    }));
    el.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => this.export(ctx, b.dataset.dl)));
    this.el = el;
  },
  rows(ctx) {
    const d = ctx.derived[ctx.node];
    const t0 = (d.latest?.ts ?? Date.now()) - RANGES[this.range].ms;
    return d.readings.filter((r) => r.ts >= t0);
  },
  dailyRows(ctx) {
    const d = ctx.derived[ctx.node];
    const rows = this.rows(ctx);
    const first = rows.length ? dateKey(rows[0].ts) : "9999";
    const pf = Object.fromEntries(d.pfvi.map((x) => [x.date, x]));
    return d.daily.filter((x) => x.date >= first).map((x) => ({ ...x, ...pf[x.date] }));
  },
  export(ctx, kind) {
    const node = ctx.node, stamp = new Date().toISOString().slice(0, 10);
    if (kind === "raw") download(`sigap_${node}_${this.range}_${stamp}.csv`, toCsv(this.rows(ctx), READING_COLS));
    if (kind === "json") download(`sigap_${node}_${this.range}_${stamp}.json`, JSON.stringify(this.rows(ctx), null, 1), "application/json");
    if (kind === "daily") download(`sigap_${node}_harian_${stamp}.csv`, toCsv(this.dailyRows(ctx), [
      { label: "tanggal", get: (r) => r.date }, { label: "jumlah_paket", get: (r) => r.n },
      { label: "muka_air_cm", get: (r) => r.wtCm?.toFixed(2) }, { label: "kelembapan_pct", get: (r) => r.smPct?.toFixed(2) },
      { label: "suhu_maks_c", get: (r) => r.tmaxC }, { label: "suhu_min_c", get: (r) => r.tminC },
      { label: "hujan_sensor_mm", get: (r) => r.rainSensor?.toFixed(2) }, { label: "hujan_bmkg_mm", get: (r) => r.rainBmkg },
      { label: "df", get: (r) => r.df?.toFixed(3) }, { label: "rf", get: (r) => r.rf?.toFixed(3) }, { label: "wtf", get: (r) => r.wtf?.toFixed(3) },
      { label: "pfvi_dashboard", get: (r) => r.pfvi?.toFixed(1) }, { label: "pfvi_edge_akhir_hari", get: (r) => r.pfviEdge },
      { label: "diobs", get: (r) => r.diObs?.toFixed(1) }, { label: "kelas", get: (r) => pfviClass(r.pfvi)?.label },
    ]));
    if (kind === "peatfr") download(`peatfr_input_${node}_${stamp}.csv`, toCsv(this.dailyRows(ctx), [
      { label: "Date", get: (r) => r.date },
      { label: "WT", get: (r) => (r.wtCm == null ? "" : (-r.wtCm / 100).toFixed(4)) },
      { label: "SM", get: (r) => r.smPct?.toFixed(2) },
      { label: "Rf", get: (r) => r.rainMm?.toFixed(2) },
      { label: "Temp", get: (r) => r.tmaxC },
    ]));
  },
  update(ctx) {
    const el = this.el;
    const rows = this.rows(ctx);
    const daily = this.dailyRows(ctx).slice().reverse();
    q(el, "#dlSub").textContent = `${rows.length.toLocaleString("id-ID")} pembacaan · ${daily.length} hari · rentang ${RANGES[this.range].label}`;
    q(el, "#dailyTable").innerHTML = `<table class="data"><thead><tr><th>Tanggal</th><th class="num">Paket</th><th class="num">Muka air (cm)</th><th class="num">Kelembapan (%)</th><th class="num">Suhu maks (°C)</th><th class="num">Hujan sensor (mm)</th><th class="num">Hujan BMKG (mm)</th><th class="num">PFVI</th><th>Kelas</th></tr></thead><tbody>
      ${daily.map((r) => `<tr><td>${fmtDayKey(r.date)}</td><td class="num">${r.n}</td><td class="num">${fmt(r.wtCm)}</td><td class="num">${fmt(r.smPct)}</td><td class="num">${fmt(r.tmaxC)}</td><td class="num">${fmt(r.rainSensor)}</td><td class="num">${fmt(r.rainBmkg)}</td><td class="num">${fmt(r.pfvi, 0)}</td><td>${clsPill(pfviClass(r.pfvi))}</td></tr>`).join("")}
      </tbody></table>`;
    const per = 100, pages = Math.max(1, Math.ceil(rows.length / per));
    this.page = Math.min(this.page, pages - 1);
    const view = rows.slice().reverse().slice(this.page * per, this.page * per + per);
    q(el, "#pager").innerHTML = `<button class="btn" data-p="-1" ${this.page === 0 ? "disabled" : ""}>‹ Lebih baru</button><span class="sub" style="align-self:center">Hal. ${this.page + 1} / ${pages}</span><button class="btn" data-p="1" ${this.page >= pages - 1 ? "disabled" : ""}>Lebih lama ›</button>`;
    q(el, "#pager").querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { this.page += Number(b.dataset.p); this.update(ctx); }));
    q(el, "#rawTable").innerHTML = `<table class="data"><thead><tr><th>Waktu (WIB)</th><th class="num">Seq</th><th class="num">Muka air</th><th>Float</th><th class="num">Kelembapan</th><th class="num">Suhu tanah</th><th class="num">Suhu udara</th><th class="num">RH</th><th class="num">Hujan</th><th class="num">Baterai</th><th class="num">PFVI</th><th class="num">RSSI</th></tr></thead><tbody>
      ${view.map((r) => `<tr><td>${fmtShort(r.ts)}</td><td class="num">${r.seq ?? ""}</td><td class="num">${fmt(r.wt_cm)}</td><td>${r.float_low == null ? "–" : r.float_low ? "kering" : "ok"}</td><td class="num">${fmt(r.sm_pct)}</td><td class="num">${fmt(r.soil_t_c)}</td><td class="num">${fmt(r.air_t_c)}</td><td class="num">${fmt(r.rh_pct, 0)}</td><td class="num">${fmt(r.rain_mm, 2)}</td><td class="num">${fmt(r.batt_v, 2)}</td><td class="num">${fmt(r.pfvi, 0)}</td><td class="num">${r.rssi ?? "–"}</td></tr>`).join("")}
      </tbody></table>`;
  },
};

/* ================================================================= PENGATURAN */

const pengaturan = {
  noData: true,
  mount(el, ctx) {
    const c = ctx.cfg, s = c.source, t = c.thresholds, p = c.pfvi, n = c.nodes[0] || {}, g = c.gateway || {};
    const f = (path, label, val, type = "text", hint = "", attrs = "") => `<label class="field"><span>${label}</span><input name="${path}" type="${type}" value="${esc(val ?? "")}" ${type === "number" ? 'step="any"' : ""} ${attrs}>${hint ? `<small>${hint}</small>` : ""}</label>`;
    el.innerHTML = `
      <div class="page-head"><div><h1>Pengaturan</h1><p>Tersimpan di browser ini. Untuk mengubah bawaan semua pengguna, edit <code>web/assets/js/config.js</code>.</p></div></div>
      <form class="form card" id="cfgForm">
        <fieldset><legend>Sumber data</legend><div class="fields">
          <label class="field"><span>Mode</span><select name="source.mode">
            ${[["auto", "Otomatis (backend bila tersedia, jika tidak demo)"], ["live", "Live (wajib backend)"], ["demo", "Demo (data simulasi)"]].map(([k, l]) => `<option value="${k}" ${s.mode === k ? "selected" : ""}>${l}</option>`).join("")}
          </select><small>Saat ini: ${ctx.mode === "demo" ? "demo" : "live"}</small></label>
          ${f("source.apiBase", "Alamat API backend", s.apiBase, "url", "Kosong = server yang sama. Contoh: https://sigap.domain-anda.id", 'placeholder="https://…"')}
          ${f("source.mqttUrl", "MQTT WebSocket (opsional)", s.mqttUrl, "text", "Contoh: wss://domain-anda:9001 — untuk pembaruan instan", 'placeholder="wss://…"')}
          ${f("source.mqttTopic", "Topik MQTT", s.mqttTopic)}
          ${f("source.mqttUser", "Pengguna MQTT", s.mqttUser)}
          ${f("source.mqttPass", "Kata sandi MQTT", s.mqttPass, "password", "Disimpan di browser ini saja")}
          ${f("source.pollSeconds", "Interval polling API (detik)", s.pollSeconds, "number")}
        </div></fieldset>
        <fieldset><legend>Lokasi</legend><div class="fields">
          ${f("site.name", "Nama lokasi", c.site.name)}
          ${f("site.partner", "Mitra", c.site.partner)}
          ${f("site.region", "Provinsi", c.site.region)}
          ${f("nodes.0.id", "ID node", n.id, "text", "Harus sama dengan field node pada payload")}
          ${f("nodes.0.name", "Nama node", n.name)}
          ${f("nodes.0.lat", "Lintang node", n.lat, "number")}
          ${f("nodes.0.lng", "Bujur node", n.lng, "number")}
          ${f("gateway.lat", "Lintang penerima", g.lat, "number")}
          ${f("gateway.lng", "Bujur penerima", g.lng, "number")}
        </div></fieldset>
        <fieldset><legend>Ambang notifikasi</legend><div class="fields">
          ${f("thresholds.wtWarnCm", "Muka air waspada (cm)", t.wtWarnCm, "number")}
          ${f("thresholds.wtDangerCm", "Muka air bahaya (cm)", t.wtDangerCm, "number")}
          ${f("thresholds.smLowPct", "Kelembapan gambut rendah (%)", t.smLowPct, "number")}
          ${f("thresholds.battLowV", "Baterai rendah (V)", t.battLowV, "number")}
          ${f("thresholds.battCritV", "Baterai kritis (V)", t.battCritV, "number")}
          ${f("thresholds.offlineMinutes", "Node offline setelah (menit)", t.offlineMinutes, "number")}
          ${f("thresholds.rssiWeakDbm", "Sinyal LoRa lemah (dBm)", t.rssiWeakDbm, "number")}
          ${f("thresholds.airTempHighC", "Suhu udara tinggi (°C)", t.airTempHighC, "number")}
        </div></fieldset>
        <fieldset><legend>Parameter PFVI</legend><div class="fields">
          ${f("pfvi.aH", "aH (mm)", p.aH, "number")}
          ${f("pfvi.bH", "bH (mm)", p.bH, "number")}
          ${f("pfvi.alpha", "α (van Genuchten)", p.alpha, "number")}
          ${f("pfvi.n", "n (van Genuchten)", p.n, "number")}
          ${f("pfvi.R0", "R0 hujan tahunan (mm)", p.R0, "number")}
          ${f("pfvi.fc", "Kapasitas lapang (%)", p.fc, "number", "Untuk DIobs")}
          ${f("pfvi.sat", "Kadar air jenuh (%)", p.sat, "number", "Untuk DIobs")}
          <label class="field"><span>Sumber curah hujan</span><select name="pfvi.rainSource">
            ${[["auto", "Sensor, bila kosong BMKG"], ["sensor", "Tipping bucket"], ["bmkg", "BMKG"]].map(([k, l]) => `<option value="${k}" ${p.rainSource === k ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        </div></fieldset>
        <div class="btns">
          <button class="btn primary" type="submit">Simpan &amp; muat ulang</button>
          <button class="btn" type="button" id="cfgReset">Kembalikan bawaan</button>
          <button class="btn" type="button" id="cfgTest">Uji koneksi API</button>
          <span class="sub" id="cfgMsg" style="align-self:center"></span>
        </div>
      </form>`;
    const form = q(el, "#cfgForm");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const next = structuredClone(ctx.cfg);
      for (const input of form.querySelectorAll("[name]")) {
        const path = input.name.split(".");
        let o = next;
        for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
        const k = path[path.length - 1];
        const raw = input.value.trim();
        o[k] = input.type === "number" ? (raw === "" ? null : Number(raw)) : raw;
      }
      saveConfig(next);
      location.reload();
    });
    q(el, "#cfgReset").addEventListener("click", () => { if (confirm("Hapus pengaturan tersimpan dan kembali ke bawaan?")) { resetConfig(); location.reload(); } });
    q(el, "#cfgTest").addEventListener("click", async () => {
      const base = (form.querySelector('[name="source.apiBase"]').value || "").replace(/\/+$/, "");
      const msg = q(el, "#cfgMsg");
      msg.textContent = "Menguji…";
      try {
        const r = await fetch(`${base}/api/health`, { cache: "no-store" });
        const j = await r.json();
        msg.textContent = j.ok ? `Terhubung · ${j.readings ?? 0} pembacaan, ${j.nodes ?? 0} node tersimpan` : "Respon tidak dikenali";
      } catch (err) { msg.textContent = "Gagal: " + (err.message || err); }
    });
  },
};

export const VIEWS = { ringkasan, grafik, peta, notifikasi, perangkat, data, pengaturan };
