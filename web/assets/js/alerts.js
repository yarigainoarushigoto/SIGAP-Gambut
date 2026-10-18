// Mesin notifikasi: aturan ambang -> peristiwa (log) + kondisi aktif.
// Peristiwa dibuat hanya saat status berubah (masuk/keluar ambang), jadi tidak berulang tiap paket.

import { pfviClass } from "./pfvi.js";
import { fmt } from "./util.js";

export const LEVELS = {
  danger: { label: "Bahaya", rank: 3 },
  warn: { label: "Waspada", rank: 2 },
  info: { label: "Info", rank: 1 },
  ok: { label: "Normal", rank: 0 },
};

/** Aturan bernilai level per pembacaan. Masing-masing mengembalikan {level, title, detail} atau null (normal). */
function rules(t) {
  return [
    {
      key: "wt", field: "wt_cm", dir: 1, margin: 1.0, name: "Tinggi muka air",
      eval: (r) => r.wt_cm == null ? undefined
        : r.wt_cm >= t.wtDangerCm ? { level: "danger", title: `Muka air melewati ambang ${t.wtDangerCm} cm`, detail: `${fmt(r.wt_cm)} cm di bawah permukaan gambut` }
        : r.wt_cm >= t.wtWarnCm ? { level: "warn", title: `Muka air mendekati ambang ${t.wtDangerCm} cm`, detail: `${fmt(r.wt_cm)} cm di bawah permukaan gambut` }
        : null,
      recover: "Muka air kembali di atas ambang waspada",
    },
    {
      key: "pfvi", field: "pfvi", dir: 1, margin: 5, name: "Status PFVI",
      eval: (r) => {
        if (r.pfvi == null) return undefined;
        const c = pfviClass(r.pfvi);
        if (c.key === "ekstrem") return { level: "danger", title: "PFVI masuk kelas Ekstrem", detail: `Indeks ${fmt(r.pfvi, 0)} dari 300` };
        if (c.key === "tinggi") return { level: "warn", title: "PFVI masuk kelas Tinggi", detail: `Indeks ${fmt(r.pfvi, 0)} dari 300` };
        return null;
      },
      recover: "PFVI turun ke kelas Sedang/Rendah",
    },
    {
      key: "sm", field: "sm_pct", dir: -1, margin: 1.0, name: "Kelembapan gambut",
      eval: (r) => r.sm_pct == null ? undefined
        : r.sm_pct < t.smLowPct ? { level: "warn", title: "Kelembapan gambut rendah", detail: `${fmt(r.sm_pct)} % (ambang ${t.smLowPct} %)` } : null,
      recover: "Kelembapan gambut kembali normal",
    },
    {
      key: "float", name: "Float switch",
      eval: (r) => r.float_low == null ? undefined
        : r.float_low ? { level: "warn", title: "Float switch: air sumur pantau di bawah titik pasang", detail: "Periksa sensor hydrostatic / sumur kering" } : null,
      recover: "Float switch kembali tergenang",
    },
    {
      key: "batt", field: "batt_v", dir: -1, margin: 0.1, name: "Baterai node",
      eval: (r) => r.batt_v == null ? undefined
        : r.batt_v < t.battCritV ? { level: "danger", title: "Baterai node kritis", detail: `${fmt(r.batt_v, 2)} V` }
        : r.batt_v < t.battLowV ? { level: "warn", title: "Baterai node rendah", detail: `${fmt(r.batt_v, 2)} V` } : null,
      recover: "Tegangan baterai kembali normal",
    },
    {
      key: "rssi", field: "rssi", dir: -1, margin: 3, name: "Sinyal LoRa",
      eval: (r) => r.rssi == null ? undefined
        : r.rssi < t.rssiWeakDbm ? { level: "info", title: "Sinyal LoRa lemah", detail: `RSSI ${r.rssi} dBm` } : null,
      recover: "Sinyal LoRa kembali baik",
    },
  ];
}

/**
 * Evaluasi seluruh riwayat satu node.
 * @returns {{events: Array, active: Array}}  events terbaru di depan
 */
export function evaluate(nodeId, readings, cfg, now = Date.now()) {
  const t = cfg.thresholds;
  const rs = rules(t);
  const state = {};
  const events = [];
  const gapMs = t.offlineMinutes * 60e3;
  let prev = null;
  for (const r of readings) {
    if (prev && r.ts - prev.ts > gapMs) {
      const mins = Math.round((r.ts - prev.ts) / 60e3);
      events.push({ node: nodeId, ts: prev.ts + gapMs, level: "danger", key: "offline", title: `Node tidak mengirim data`, detail: `Tidak ada paket lebih dari ${t.offlineMinutes} menit` });
      events.push({ node: nodeId, ts: r.ts, level: "info", key: "offline", title: `Koneksi node pulih`, detail: `Terputus sekitar ${mins} menit` });
    }
    for (const rule of rs) {
      const res = rule.eval(r);
      if (res === undefined) continue; // sensor tidak mengirim nilai
      const cur = state[rule.key] || { level: "ok" };
      const level = res ? res.level : "ok";
      if (level === cur.level) {
        state[rule.key] = res ? { ...cur, ...res, pending: 0 } : { level: "ok", pending: 0 };
        continue;
      }
      // Histeresis nilai: saat turun level, nilai harus melewati ambang dengan selisih `margin`.
      if (rule.field && cur.level !== "ok" && LEVELS[level].rank < LEVELS[cur.level].rank && r[rule.field] != null) {
        const shifted = rule.eval({ ...r, [rule.field]: r[rule.field] + rule.dir * rule.margin });
        if (shifted && LEVELS[shifted.level].rank >= LEVELS[cur.level].rank) {
          state[rule.key] = { ...cur, pending: 0 };
          continue;
        }
      }
      // Naik level: langsung. Turun level: tunggu 3 paket berturut-turut (histeresis, cegah notifikasi berkedip).
      const escalate = LEVELS[level].rank > LEVELS[cur.level].rank;
      const pending = (cur.pendingLevel === level ? cur.pending : 0) + 1;
      if (!escalate && pending < 3) { state[rule.key] = { ...cur, pending, pendingLevel: level }; continue; }
      if (res) events.push({ node: nodeId, ts: r.ts, key: rule.key, ...res });
      else events.push({ node: nodeId, ts: r.ts, key: rule.key, level: "ok", title: rule.recover, detail: rule.name });
      state[rule.key] = res ? { ...res, since: r.ts, name: rule.name, pending: 0 } : { level: "ok", pending: 0 };
    }
    prev = r;
  }
  const active = Object.entries(state).filter(([, s]) => s.level !== "ok").map(([key, s]) => ({ node: nodeId, key, ...s }));
  if (prev && now - prev.ts > gapMs) {
    active.unshift({ node: nodeId, key: "offline", level: "danger", title: "Node tidak mengirim data", detail: `Paket terakhir ${Math.round((now - prev.ts) / 60e3)} menit lalu`, since: prev.ts + gapMs, name: "Konektivitas" });
  }
  active.sort((a, b) => LEVELS[b.level].rank - LEVELS[a.level].rank);
  events.reverse();
  return { events, active };
}
