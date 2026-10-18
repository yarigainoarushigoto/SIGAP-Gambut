// Utilitas umum: format angka/waktu (WIB), agregasi harian, estimasi SoC baterai.

export const TZ = "Asia/Jakarta";

const nf = (d) => new Intl.NumberFormat("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const NF = [nf(0), nf(1), nf(2)];
export function fmt(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return "–";
  return NF[digits].format(v);
}

export function dateKey(ts, tz = TZ) {
  // "YYYY-MM-DD" pada zona waktu lokasi
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}
export function hourOf(ts, tz = TZ) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(ts)) % 24;
}

const dtFull = new Intl.DateTimeFormat("id-ID", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dtShort = new Intl.DateTimeFormat("id-ID", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dDay = new Intl.DateTimeFormat("id-ID", { timeZone: TZ, day: "numeric", month: "short" });
const dTime = new Intl.DateTimeFormat("id-ID", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

export const fmtDateTime = (ts) => dtFull.format(ts).replace(/\./g, ":") + " WIB";
export const fmtShort = (ts) => dtShort.format(ts).replace(/\./g, ":");
export const fmtDay = (ts) => dDay.format(ts);
export const fmtTime = (ts) => dTime.format(ts).replace(/\./g, ":");
export const fmtDayKey = (key) => dDay.format(new Date(key + "T12:00:00+07:00"));

export function relTime(ts, now = Date.now()) {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return "baru saja";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} menit lalu`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const vals = (rows, k) => rows.map((r) => r[k]).filter((v) => v != null && !Number.isNaN(v));

/** Agregasi pembacaan 10-menit menjadi harian (masukan PFVI & format peatfr). */
export function dailyAggregate(readings, bmkgByDate = {}, rainSource = "auto", tz = TZ) {
  const groups = new Map();
  for (const r of readings) {
    const k = dateKey(r.ts, tz);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [date, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const t = vals(rows, "air_t_c");
    const rainSensor = rows.some((r) => r.rain_mm != null) ? vals(rows, "rain_mm").reduce((a, b) => a + b, 0) : null;
    const rainBmkg = bmkgByDate[date] ?? null;
    let rainMm = rainSensor;
    if (rainSource === "bmkg" || (rainSource === "auto" && rainSensor == null)) rainMm = rainBmkg;
    const lastEdge = [...rows].reverse().find((r) => r.pfvi != null);
    out.push({
      date,
      n: rows.length,
      wtCm: mean(vals(rows, "wt_cm")),
      smPct: mean(vals(rows, "sm_pct")),
      tmaxC: t.length ? Math.max(...t) : null,
      tminC: t.length ? Math.min(...t) : null,
      rhPct: mean(vals(rows, "rh_pct")),
      rainMm, rainSensor, rainBmkg,
      pfviEdge: lastEdge ? lastEdge.pfvi : null,
    });
  }
  return out;
}

/** Bucket rata-rata (untuk menipiskan grafik 7/30 hari). sumKeys dijumlahkan, bukan dirata-rata. */
export function bucket(readings, ms, keys, sumKeys = []) {
  const map = new Map();
  for (const r of readings) {
    const b = Math.floor(r.ts / ms) * ms;
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(r);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([ts, rows]) => {
    const o = { ts: ts + ms / 2 };
    for (const k of keys) o[k] = mean(vals(rows, k));
    for (const k of sumKeys) { const v = vals(rows, k); o[k] = v.length ? v.reduce((a, b) => a + b, 0) : null; }
    return o;
  });
}

/** Perkiraan SoC LiFePO4 12,8 V (4S) dari tegangan terminal. Kasar — kurva datar di tengah. */
const SOC = [[10.0, 0], [12.0, 9], [12.5, 14], [12.8, 17], [12.9, 20], [13.0, 30], [13.1, 40], [13.2, 70], [13.3, 90], [13.4, 99], [13.6, 100]];
export function socFromVoltage(v) {
  if (v == null) return null;
  if (v <= SOC[0][0]) return 0;
  for (let i = 1; i < SOC.length; i++) {
    if (v <= SOC[i][0]) {
      const [v0, s0] = SOC[i - 1], [v1, s1] = SOC[i];
      return s0 + ((v - v0) / (v1 - v0)) * (s1 - s0);
    }
  }
  return 100;
}

export function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function download(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function toCsv(rows, columns) {
  const escCell = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => c.label).join(","), ...rows.map((r) => columns.map((c) => escCell(c.get(r))).join(","))].join("\n");
}
