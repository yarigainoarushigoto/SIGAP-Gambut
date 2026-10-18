// Peat Fire Vulnerability Index (PFVI) — port JavaScript dari fungsi
// `firepredict()` paket peatfr (Mahdiyasa dkk., 2025; github.com/mellygsln/peatfr),
// berdasarkan formulasi Taufik dkk. (2022).
//
//   PFVI_t = PFVI_{t-1} + DF_t - RF_t - WTF_t          (dibatasi 0..300)
//
// Modul ini tidak menjalankan optimasi Nelder-Mead; parameter aH, bH, alpha, n
// diambil dari konfigurasi (nilai awal stasiun BRG6 sebelum dikalibrasi ulang).
// Dipakai dashboard untuk menghitung ulang PFVI harian dari data sensor sebagai
// pembanding hasil inferensi edge (TinyML) pada node.

export const PFVI_CLASSES = [
  { key: "rendah",  label: "Rendah",  min: 0,   max: 75,  status: "good" },
  { key: "sedang",  label: "Sedang",  min: 75,  max: 150, status: "warning" },
  { key: "tinggi",  label: "Tinggi",  min: 150, max: 225, status: "serious" },
  { key: "ekstrem", label: "Ekstrem", min: 225, max: 300, status: "critical" },
];

/** Kelas risiko PFVI. Batas mengikuti peatfr: <=75 rendah, <=150 sedang, <=225 tinggi, >225 ekstrem. */
export function pfviClass(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v <= 75) return PFVI_CLASSES[0];
  if (v <= 150) return PFVI_CLASSES[1];
  if (v <= 225) return PFVI_CLASSES[2];
  return PFVI_CLASSES[3];
}

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** Drought factor (mm/hari). Tm = suhu udara maksimum harian (°C), R0 = curah hujan tahunan representatif (mm). */
export function droughtFactor(prevPfvi, Tm, R0, dt = 1) {
  return ((300 - prevPfvi) * (0.4982 * Math.exp(0.0905 * Tm + 1.6096) - 4.268) * dt * 1e-3) /
    (1 + 10.88 * Math.exp(-0.00173582677165354 * R0));
}

/** Rainfall factor: hanya hujan efektif (>= 5,1 mm/hari). Hari hujan pertama dikurangi intersepsi 5,1 mm. */
export function rainfallFactor(Rt, Rprev) {
  if (Rt == null || Rt < 5.1) return 0;
  if (Rprev != null && Rprev >= 5.1) return Rt; // hari hujan berikutnya
  return Rt - 5.1;                               // hari hujan ke-1
}

/** Kadar lengas volumetrik relatif θ(h) — kurva van Genuchten, h = kedalaman muka air (meter, >= 0). */
export function theta(hMeter, alpha, n) {
  const m = 1 - 1 / n;
  return Math.pow(1 + Math.pow(Math.max(hMeter, 0) / alpha, n), -m);
}

/** Water table factor. Positif = membasahi (menurunkan PFVI), negatif = mengeringkan. */
export function waterTableFactor(hMeter, p) {
  return p.aH - p.bH * ((1 - theta(hMeter, p.alpha, p.n)) * 300);
}

/** Indeks kekeringan observasi dari kelembapan tanah (dipakai peatfr untuk inisialisasi & kalibrasi). */
export function observedDroughtIndex(smPct, fc = 40, sat = 70) {
  return clamp(300 * (1 - (smPct - fc) / (sat - fc)), 0, 300);
}

/**
 * Hitung deret PFVI harian.
 * @param {Array<{date:string, wtCm:number, smPct:number, rainMm:number, tmaxC:number}>} days
 *        wtCm = kedalaman muka air di bawah permukaan gambut (cm, positif = di bawah permukaan)
 * @param {{aH:number,bH:number,alpha:number,n:number,R0:number,fc:number,sat:number}} p
 * @param {number|null} initial  PFVI awal; bila null pakai DIobs dari SM hari pertama (seperti peatfr)
 * @returns Array berisi {date, pfvi, df, rf, wtf, diObs, cls}
 */
export function computePfviSeries(days, p, initial = null) {
  const out = [];
  if (!days.length) return out;
  let prev = initial ?? observedDroughtIndex(days[0].smPct ?? p.fc, p.fc, p.sat);
  let prevRain = null;
  for (const d of days) {
    const x0 = clamp(prev, 0, 300);
    const h = Math.max(d.wtCm ?? 0, 0) / 100; // cm -> m; tergenang (negatif) = 0
    const df = d.tmaxC == null ? 0 : droughtFactor(x0, d.tmaxC, p.R0);
    const rf = rainfallFactor(d.rainMm ?? 0, prevRain);
    const wtf = d.wtCm == null ? 0 : waterTableFactor(h, p);
    const pfvi = clamp(x0 + df - rf - wtf, 0, 300);
    out.push({
      date: d.date, pfvi, df, rf, wtf,
      diObs: d.smPct == null ? null : observedDroughtIndex(d.smPct, p.fc, p.sat),
      cls: pfviClass(pfvi),
    });
    prev = pfvi;
    prevRain = d.rainMm ?? 0;
  }
  return out;
}
