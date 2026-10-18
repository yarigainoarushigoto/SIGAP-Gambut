// Sumber data: API backend (riwayat + polling), MQTT over WebSocket (real-time), dan simulator (mode demo).

import { dateKey, dailyAggregate } from "./util.js";
import { computePfviSeries } from "./pfvi.js";

/* ------------------------------------------------------------------ API */

function apiUrl(cfg, path) {
  const base = (cfg.source.apiBase || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

export async function probeApi(cfg, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(cfg, "/api/health"), { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ok ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}

export async function startApi(cfg, store) {
  const sinceMs = Date.now() - cfg.source.historyDays * 864e5;
  const since = new Date(sinceMs).toISOString();
  const [tele, bmkg] = await Promise.all([
    fetch(apiUrl(cfg, `/api/telemetry?since=${encodeURIComponent(since)}&limit=100000`)).then((r) => r.json()),
    fetch(apiUrl(cfg, `/api/bmkg?since=${since.slice(0, 10)}`)).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  store.add(tele, { silent: true });
  const b = {};
  for (const row of bmkg) b[row.date] = row.rain_mm;
  store.setBmkg(b);

  let lastTs = Math.max(sinceMs, ...store.nodes().map((n) => store.latest(n)?.ts ?? 0));
  const poll = async () => {
    try {
      const rows = await fetch(apiUrl(cfg, `/api/telemetry?since=${encodeURIComponent(new Date(lastTs + 1).toISOString())}`), { cache: "no-store" }).then((r) => r.json());
      store.add(rows);
      for (const n of store.nodes()) lastTs = Math.max(lastTs, store.latest(n)?.ts ?? 0);
      store.setStatus({ connected: true, lastPoll: Date.now() });
    } catch {
      store.setStatus({ connected: false, detail: "API tidak terjangkau" });
    }
  };
  const id = setInterval(poll, Math.max(10, cfg.source.pollSeconds) * 1000);
  return () => clearInterval(id);
}

/* ----------------------------------------------------------------- MQTT */

export function startMqtt(cfg, store) {
  if (!cfg.source.mqttUrl || !window.mqtt) return null;
  const client = window.mqtt.connect(cfg.source.mqttUrl, {
    username: cfg.source.mqttUser || undefined,
    password: cfg.source.mqttPass || undefined,
    reconnectPeriod: 5000,
    clientId: "sigap-web-" + Math.random().toString(16).slice(2, 10),
  });
  client.on("connect", () => {
    client.subscribe(cfg.source.mqttTopic);
    client.subscribe("sigap/+/bmkg/rain");
    store.setStatus({ mqtt: true });
  });
  client.on("close", () => store.setStatus({ mqtt: false }));
  client.on("error", () => store.setStatus({ mqtt: false }));
  client.on("message", (topic, buf) => {
    let p;
    try { p = JSON.parse(buf.toString()); } catch { return; }
    if (topic.endsWith("/bmkg/rain")) {
      if (p.date && p.rain_mm != null) store.setBmkg({ [p.date]: Number(p.rain_mm) });
      return;
    }
    // node dari topik bila tidak ada di payload: sigap/<site>/<node>/telemetry
    if (!p.node) p.node = topic.split("/")[2];
    store.add([p]);
  });
  return () => client.end(true);
}

/* ------------------------------------------------------------ SIMULATOR */
// Skenario: akhir musim kemarau, muka air turun ±1,1 cm/hari dengan beberapa
// kejadian hujan di awal periode. Deterministik (seed tetap) agar mudah dipresentasikan.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const STEP = 10 * 60 * 1000;
const RAIN_EVENTS = [ // [hari ke-, total mm, jam mulai (WIB), durasi jam]
  [2, 21, 15, 3], [3, 9.5, 14, 2], [6, 6.2, 16, 1.5], [11, 12.4, 13, 2.5], [12, 3.1, 17, 1], [19, 2.4, 15, 1], [26, 3.4, 16, 1.5],
];

export function startSimulator(cfg, store, { days = 30, tickSeconds = 12 } = {}) {
  const nodes = cfg.nodes.length ? cfg.nodes : [{ id: "node-01" }];
  const now = Date.now();
  const start = Math.floor((now - days * 864e5) / STEP) * STEP;
  const startDay = new Date(dateKey(start) + "T00:00:00+07:00").getTime();

  const sims = nodes.map((n, idx) => {
    const rnd = mulberry32(20261018 + idx * 97);
    const offset = idx * 6; // node kedua sedikit lebih kering
    function rainAt(ts) {
      const dayIdx = Math.floor((ts - startDay) / 864e5);
      const hour = ((ts - startDay) % 864e5) / 36e5;
      let mm = 0;
      for (const [d, tot, h0, dur] of RAIN_EVENTS) if (d === dayIdx && hour >= h0 && hour < h0 + dur) mm += tot / (dur * 6);
      return mm;
    }
    let cumRain = 0, wtNoise = 0, rssiDrift = 0;
    function sample(ts) {
      const dDays = (ts - start) / 864e5;
      const hour = (((ts - startDay) % 864e5) + 864e5) % 864e5 / 36e5;
      const rain = rainAt(ts);
      cumRain += rain;
      const sun = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12));
      const rainyDay = RAIN_EVENTS.some(([d]) => d === Math.floor((ts - startDay) / 864e5));
      wtNoise = wtNoise * 0.9 + gauss(rnd) * 0.12;
      const wt = 22 + offset + 1.12 * dDays + 0.35 * sun - cumRain * 0.22 + wtNoise;
      const tmaxDay = 32.2 + 1.4 * Math.sin(dDays / 4.3) + dDays * 0.035 - (rainyDay ? 1.8 : 0);
      const air = 24.6 + (tmaxDay - 24.6) * Math.pow(sun, 0.8) + gauss(rnd) * 0.25 - (rain > 0 ? 2 : 0);
      const rh = Math.min(99, Math.max(38, 97 - (air - 24) * 4.6 + gauss(rnd) * 1.5 + (rain > 0 ? 8 : 0)));
      const sm = Math.min(78, Math.max(18, 71.5 - 0.6 * wt + gauss(rnd) * 0.35 + Math.min(6, rain * 2)));
      const soilT = 26.4 + 1.3 * Math.sin((Math.PI * (hour - 9)) / 12) + dDays * 0.02 + gauss(rnd) * 0.08;
      const batt = 13.08 + 0.36 * Math.pow(sun, 0.7) * (rainyDay ? 0.55 : 1) - (hour > 18 || hour < 6 ? 0.04 * ((hour + 6) % 24) / 12 : 0) + gauss(rnd) * 0.01;
      rssiDrift = rssiDrift * 0.95 + gauss(rnd) * 0.6;
      const rssi = Math.round(-97 - offset * 0.8 + rssiDrift * 2 - (rain > 0 ? 4 : 0));
      return {
        node: n.id, ts,
        wt_cm: +wt.toFixed(1), float_low: wt > 60, sm_pct: +sm.toFixed(1), soil_t_c: +soilT.toFixed(1),
        air_t_c: +air.toFixed(1), rh_pct: +rh.toFixed(0), rain_mm: +(rain.toFixed(2)),
        batt_v: +batt.toFixed(2), rssi, snr: +(8.5 + rssiDrift * 0.7 + gauss(rnd) * 0.6).toFixed(1),
      };
    }
    return { node: n, rnd, sample };
  });

  // Riwayat
  const all = [];
  for (const s of sims) {
    let seq = 1000;
    const rows = [];
    for (let ts = start; ts <= now; ts += STEP) {
      const r = s.sample(ts);
      r.seq = seq++;
      // putus koneksi ~40 menit dua hari lalu + kehilangan paket acak 1,5 %
      const gap = ts > now - 2 * 864e5 - 3 * 36e5 && ts < now - 2 * 864e5 - 3 * 36e5 + 45 * 6e4;
      if (gap || s.rnd() < 0.015) continue;
      rows.push(r);
    }
    // PFVI hasil "inferensi edge": deret harian dihitung dari agregat, diinterpolasi per paket (+ derau kecil kuantisasi model)
    const daily = dailyAggregate(rows, {}, "sensor");
    const series = computePfviSeries(daily, cfg.pfvi);
    const byDate = Object.fromEntries(series.map((d, i) => [d.date, { cur: d.pfvi, prev: i ? series[i - 1].pfvi : d.pfvi }]));
    for (const r of rows) {
      const k = byDate[dateKey(r.ts)];
      const frac = (((r.ts - startDay) % 864e5) + 864e5) % 864e5 / 864e5;
      r.pfvi = +(k.prev + (k.cur - k.prev) * frac + gauss(s.rnd) * 1.2).toFixed(1);
    }
    s.lastPfvi = rows[rows.length - 1]?.pfvi ?? 100;
    s.seq = seq;
    all.push(...rows);
  }
  store.add(all, { silent: true });

  // BMKG: total harian stasiun terdekat (berbeda dari tipping bucket karena jarak)
  const bm = {};
  const rndB = mulberry32(77);
  for (let d = 0; d <= days; d++) {
    const key = dateKey(startDay + d * 864e5 + 12 * 36e5);
    const ev = RAIN_EVENTS.filter(([i]) => i === d).reduce((a, [, mm]) => a + mm, 0);
    bm[key] = +(ev * (0.75 + rndB() * 0.6) + (rndB() < 0.15 ? rndB() * 4 : 0)).toFixed(1);
  }
  store.setBmkg(bm);

  // "Real-time": paket baru tiap tickSeconds (stempel waktu = sekarang)
  const id = setInterval(() => {
    const ts = Date.now();
    const rows = sims.map((s) => {
      const r = s.sample(ts);
      r.seq = s.seq++;
      s.lastPfvi = +(s.lastPfvi + gauss(s.rnd) * 0.3).toFixed(1);
      r.pfvi = s.lastPfvi;
      r.rain_mm = 0;
      return r;
    });
    store.add(rows);
  }, tickSeconds * 1000);
  return () => clearInterval(id);
}
