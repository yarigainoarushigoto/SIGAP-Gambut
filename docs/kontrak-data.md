# Kontrak data SIGAP-Gambut

Dokumen ini mengikat tiga pihak: **firmware node** (ESP32 + SX1276 di lapangan), **firmware penerima**
(ESP32 + SX1276 di gedung), dan **server/dashboard**. Selama format di bawah dipatuhi, tiap bagian bisa
dikembangkan terpisah.

```
Node lapangan ──LoRa 920–923 MHz, paket biner 20 byte──▶ Penerima (gedung)
Penerima ──MQTT JSON (WiFi/router 4G)──▶ Mosquitto ──▶ backend FastAPI ──▶ SQLite ──▶ dashboard
                     └── atau HTTP POST /api/ingest ──▶ backend
```

## 1. Paket radio LoRa (node → penerima)

Node tidak punya RTC yang andal, jadi **stempel waktu diberikan penerima** saat paket diterima.
Semua bilangan little-endian (bawaan ESP32).

```c
typedef struct __attribute__((packed)) {
  uint8_t  ver;         // versi format = 1
  uint8_t  node;        // nomor node (1 -> "node-01")
  uint16_t seq;         // nomor urut, untuk deteksi paket hilang & ACK
  int16_t  wt_mm;       // kedalaman muka air, mm, positif = di bawah permukaan gambut
  uint16_t sm_x10;      // kelembapan gambut % x10 (SEN0600)
  int16_t  soil_t_x10;  // suhu tanah °C x10 (SEN0600)
  int16_t  air_t_x10;   // suhu udara °C x10 (DHT22)
  uint8_t  rh;          // RH udara % (DHT22)
  uint16_t rain_x100;   // hujan sejak paket sebelumnya, mm x100 (pulsa x mm/pulsa hasil kalibrasi)
  uint16_t batt_mv;     // tegangan baterai, mV
  uint16_t pfvi_x10;    // PFVI hasil inferensi edge x10 (0..3000), 0xFFFF = tidak ada
  uint8_t  flags;       // bit0 float_low, bit1 err_level, bit2 err_soil, bit3 err_dht
} SigapPacket;          // 20 byte
```

Nilai sensor yang gagal dibaca: kirim `0x7FFF` (int16) / `0xFFFF` (uint16) dan set bit error di `flags`;
penerima menerjemahkannya menjadi `null`.

**Kedalaman muka air dari sensor hydrostatic.** Sensor membaca tinggi kolom air di atasnya (`h_air`).
Bila ujung sensor terpasang `L` cm di bawah permukaan gambut: `wt_cm = L − h_air`.
Simpan `L` di firmware dan ukur ulang setelah pemasangan sumur pantau.

## 2. MQTT (penerima → server)

| Topik | Isi |
|---|---|
| `sigap/<site>/<node>/telemetry` | satu paket JSON (bagian 3); `qos=1` |
| `sigap/<site>/<node>/status` | opsional: `online` / `offline` (pakai *Last Will* penerima) |
| `sigap/<site>/bmkg/rain` | opsional: curah hujan harian BMKG `{"date":"2026-10-17","rain_mm":4.2,"station":"..."}` |

Contoh: `sigap/gunajaya/node-01/telemetry`. Jika `node` tidak ada di payload, backend mengambilnya dari topik.

## 3. Payload JSON telemetri

```json
{
  "node": "node-01",
  "ts": 1792341169,
  "seq": 1441,
  "wt_cm": 42.6,
  "float_low": false,
  "sm_pct": 46.2,
  "soil_t_c": 26.1,
  "air_t_c": 24.6,
  "rh_pct": 96,
  "rain_mm": 0.0,
  "batt_v": 13.06,
  "pfvi": 198.4,
  "rssi": -95,
  "snr": 9.2
}
```

| Field | Satuan | Sumber | Keterangan |
|---|---|---|---|
| `node` | – | penerima | wajib, harus sama dengan `nodes[].id` di `web/assets/js/config.js` |
| `ts` | unix detik / ms / ISO-8601 | penerima | waktu terima; kosong = waktu server |
| `seq` | – | node | nomor urut paket |
| `wt_cm` | cm | hydrostatic 0–5 mH₂O | **positif = di bawah permukaan**, negatif = tergenang |
| `float_low` | bool | float switch | `true` = air sumur di bawah titik pasang |
| `sm_pct` | % volumetrik | SEN0600 | |
| `soil_t_c` | °C | SEN0600 | |
| `air_t_c` | °C | DHT22 | dalam rumah pelindung radiasi |
| `rh_pct` | % | DHT22 | |
| `rain_mm` | mm | tipping bucket | **akumulasi sejak paket sebelumnya**, bukan total harian |
| `batt_v` | V | pembagi tegangan | LiFePO4 12,8 V |
| `pfvi` | 0–300 | TinyML di node | opsional; bila kosong dashboard memakai hitung ulang harian |
| `pfvi_fc` | array | TinyML di node | opsional: prakiraan PFVI h hari ke depan |
| `rssi`, `snr` | dBm, dB | penerima | kualitas tautan LoRa |

Field yang tidak dikenal tetap disimpan (kolom `extra`) dan dikembalikan oleh API.

## 4. HTTP (alternatif MQTT)

```
POST /api/ingest           body: satu objek atau array objek bagian 3
Header: X-Api-Key: <INGEST_TOKEN>   (bila diaktifkan di server)
POST /api/bmkg             body: {"date","rain_mm","station"} atau array
```

## 5. API untuk dashboard

| Endpoint | Fungsi |
|---|---|
| `GET /api/health` | status, jumlah pembacaan, waktu paket terakhir |
| `GET /api/nodes` | daftar node + rentang data |
| `GET /api/latest` | paket terakhir tiap node |
| `GET /api/telemetry?node=&since=&until=&limit=` | riwayat, urut naik |
| `GET /api/bmkg?since=YYYY-MM-DD` | curah hujan harian BMKG |

## 6. Cara dashboard menghitung PFVI

Pembacaan 10-menit diagregasi per hari (WIB): `h` = rata-rata `wt_cm`/100 (m), `Tm` = maksimum `air_t_c`,
`R` = jumlah `rain_mm` (atau BMKG bila sensor kosong). Lalu PFVI dihitung rekursif seperti
`firepredict()` di peatfr. Satu catatan saat porting: di peatfr, `Rf_b <- c(Rf[-length(Rf)], NA)`
menyelaraskan hujan "hari sebelumnya" dengan hari yang sama. Dashboard memakai hari sebelumnya yang
sebenarnya, sesuai persamaan di proposal (Taufik dkk., 2022). Perbedaannya hanya muncul pada hari hujan
berturut-turut.
