// Konfigurasi bawaan dashboard SIGAP-Gambut.
// Semua nilai bisa diubah dari halaman Pengaturan (tersimpan di browser),
// atau langsung di file ini sebelum deploy.

export const DEFAULT_CONFIG = {
  site: {
    name: "Konsesi Sawit Mitra",
    partner: "PT. Gunajaya Harapan Lestari",
    region: "Kalimantan Barat",
    timeZone: "Asia/Jakarta", // WIB
  },

  // Sumber data:
  //  "auto" : coba API backend (apiBase + /api/health); bila gagal pakai mode demo
  //  "live" : wajib API backend (+ MQTT WebSocket bila diisi)
  //  "demo" : data simulasi di browser (untuk presentasi / GitHub Pages)
  source: {
    mode: "auto",
    apiBase: "",            // kosong = origin yang sama (dashboard disajikan oleh server/app.py)
    mqttUrl: "",            // mis. "wss://vps-anda:9001" (listener WebSocket Mosquitto)
    mqttTopic: "sigap/+/+/telemetry",
    mqttUser: "",
    mqttPass: "",
    pollSeconds: 60,        // interval polling API bila MQTT WebSocket tidak dipakai
    historyDays: 30,
  },

  // Node lapangan. Koordinat di bawah adalah CONTOH — ganti dengan titik GPS pemasangan sebenarnya.
  nodes: [
    {
      id: "node-01",
      name: "Node Sensor 01",
      lat: -0.3735, lng: 109.5590,
      note: "Sumur pantau PVC, sensor hydrostatic 0–5 mH₂O + float switch",
    },
  ],
  gateway: { name: "Penerima LoRa (dalam gedung)", lat: -0.3668, lng: 109.5652 },

  intervalMinutes: 10, // jadwal kirim node (rancangan: paket ~20 byte tiap 10 menit)

  thresholds: {
    wtWarnCm: 35,      // muka air mendekati ambang
    wtDangerCm: 40,    // ambang kritis bawah permukaan (Taufik dkk., 2022: 40–60 cm)
    smLowPct: 45,      // kelembapan gambut rendah
    battLowV: 12.8,    // LiFePO4 4S ≈ 15–20 % SoC
    battCritV: 12.0,
    offlineMinutes: 30, // 3 paket terlewat
    rssiWeakDbm: -115,
    airTempHighC: 35,
  },

  // Parameter PFVI — nilai awal stasiun BRG6 (Taufik dkk., 2022), sebelum kalibrasi ulang.
  pfvi: {
    aH: 5.67, bH: 0.116, alpha: 0.428, n: 1.24,
    R0: 3000,  // curah hujan tahunan representatif (mm), bawaan peatfr
    fc: 40, sat: 70, // kapasitas lapang & jenuh (%), untuk indeks kekeringan observasi
    rainSource: "auto", // "sensor" | "bmkg" | "auto" (sensor, bila kosong pakai BMKG)
  },
};

const KEY = "sigap.config.v1";

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (k in base && typeof base[k] === "object" && !Array.isArray(base[k]))
      ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { saved = {}; }
  // Parameter URL ?mode=demo|live&api=...  (praktis untuk tautan presentasi)
  const q = new URLSearchParams(location.search);
  const cfg = deepMerge(DEFAULT_CONFIG, saved);
  if (q.get("mode")) cfg.source.mode = q.get("mode");
  if (q.get("api")) cfg.source.apiBase = q.get("api");
  return cfg;
}

export function saveConfig(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); return true; } catch { return false; }
}

export function resetConfig() {
  try { localStorage.removeItem(KEY); } catch { /* abaikan */ }
}
