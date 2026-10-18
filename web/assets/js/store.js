// Penyimpanan data di memori + normalisasi payload telemetri.

const FIELDS = ["wt_cm", "sm_pct", "soil_t_c", "air_t_c", "rh_pct", "rain_mm", "batt_v", "pfvi", "rssi", "snr", "seq"];

/** Normalisasi satu paket telemetri (dari MQTT, API, atau simulator). Lihat docs/kontrak-data.md. */
export function normalize(p) {
  if (!p || typeof p !== "object") return null;
  const node = p.node || p.node_id;
  let ts = p.ts ?? p.time ?? p.timestamp;
  if (typeof ts === "string") ts = Date.parse(ts);
  else if (typeof ts === "number" && ts < 1e12) ts = ts * 1000; // detik -> ms
  if (!node || !Number.isFinite(ts)) return null;
  const r = { node: String(node), ts };
  for (const k of FIELDS) {
    const v = p[k];
    r[k] = v == null || v === "" ? null : Number(v);
    if (Number.isNaN(r[k])) r[k] = null;
  }
  r.float_low = p.float_low == null ? null : Boolean(p.float_low === true || p.float_low === 1 || p.float_low === "1" || p.float_low === "true");
  if (Array.isArray(p.pfvi_fc)) r.pfvi_fc = p.pfvi_fc.map(Number);
  return r;
}

export class Store {
  constructor() {
    this.readings = new Map(); // node -> sorted array
    this.bmkg = {};            // "YYYY-MM-DD" -> mm
    this.listeners = new Set();
    this.status = { mode: "–", connected: false, detail: "" };
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { for (const fn of this.listeners) fn(kind); }

  setStatus(s) { this.status = { ...this.status, ...s }; this.emit("status"); }

  add(list, { silent = false } = {}) {
    let added = 0;
    for (const raw of list) {
      const r = normalize(raw);
      if (!r) continue;
      if (!this.readings.has(r.node)) this.readings.set(r.node, []);
      const arr = this.readings.get(r.node);
      const last = arr[arr.length - 1];
      if (!last || r.ts > last.ts) arr.push(r);
      else {
        // sisipkan berurutan; abaikan duplikat (ts sama)
        const i = arr.findIndex((x) => x.ts >= r.ts);
        if (arr[i] && arr[i].ts === r.ts) continue;
        arr.splice(i, 0, r);
      }
      added++;
    }
    if (added && !silent) this.emit("data");
    return added;
  }

  setBmkg(obj) { Object.assign(this.bmkg, obj); this.emit("data"); }

  nodes() { return [...this.readings.keys()]; }
  series(node) { return this.readings.get(node) || []; }
  latest(node) { const a = this.series(node); return a[a.length - 1] || null; }
  since(node, ms) { const a = this.series(node); const t = Date.now() - ms; return a.filter((r) => r.ts >= t); }

  /** Nilai paling akhir yang tidak null untuk satu field (sensor bisa absen di satu paket). */
  lastValue(node, key) {
    const a = this.series(node);
    for (let i = a.length - 1; i >= 0; i--) if (a[i][key] != null) return a[i][key];
    return null;
  }
  /** Nilai sekitar `ms` yang lalu (untuk delta 24 jam). */
  valueAgo(node, key, ms) {
    const a = this.series(node);
    const t = (a[a.length - 1]?.ts ?? Date.now()) - ms;
    let best = null;
    for (const r of a) { if (r.ts > t) break; if (r[key] != null) best = r[key]; }
    return best;
  }
}
