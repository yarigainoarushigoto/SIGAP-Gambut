#!/usr/bin/env python3
"""
Kirim data uji ke backend SIGAP-Gambut — untuk mencoba alur server + dashboard
sebelum node dan penerima LoRa terpasang.

Contoh:
  # isi riwayat 7 hari lewat HTTP, lalu kirim paket tiap 10 detik
  python tools/kirim_data_uji.py --api http://localhost:8000 --hari 7 --live 10

  # kirim lewat MQTT, seperti yang dilakukan penerima LoRa
  python tools/kirim_data_uji.py --mqtt localhost --live 10
"""
import argparse
import json
import math
import random
import time
import urllib.request

STEP = 600  # detik (10 menit)


def paket(node: str, ts: float, start: float, seq: int, rnd: random.Random) -> dict:
    hari = (ts - start) / 86400
    jam = ((ts + 7 * 3600) % 86400) / 3600  # WIB
    sun = max(0.0, math.sin(math.pi * (jam - 6) / 12))
    wt = 30 + 1.0 * hari + 0.3 * sun + rnd.gauss(0, 0.15)
    air = 24.8 + 8.5 * sun ** 0.8 + rnd.gauss(0, 0.3)
    return {
        "node": node, "ts": int(ts), "seq": seq,
        "wt_cm": round(wt, 1), "float_low": wt > 60,
        "sm_pct": round(71.5 - 0.6 * wt + rnd.gauss(0, 0.4), 1),
        "soil_t_c": round(26.4 + 1.3 * math.sin(math.pi * (jam - 9) / 12), 1),
        "air_t_c": round(air, 1), "rh_pct": round(min(99, 97 - (air - 24) * 4.6)),
        "rain_mm": 0.0, "batt_v": round(13.08 + 0.36 * sun ** 0.7 + rnd.gauss(0, 0.01), 2),
        "pfvi": round(min(300, 120 + 3.2 * hari), 1),
        "rssi": int(-97 + rnd.gauss(0, 3)), "snr": round(8.5 + rnd.gauss(0, 1), 1),
    }


def kirim_http(api: str, data, token: str = "") -> None:
    req = urllib.request.Request(api.rstrip("/") + "/api/ingest", data=json.dumps(data).encode(),
                                 headers={"Content-Type": "application/json", "X-Api-Key": token}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", help="alamat backend, mis. http://localhost:8000")
    ap.add_argument("--mqtt", help="host broker MQTT (alternatif --api)")
    ap.add_argument("--mqtt-port", type=int, default=1883)
    ap.add_argument("--site", default="gunajaya")
    ap.add_argument("--node", default="node-01")
    ap.add_argument("--token", default="", help="INGEST_TOKEN bila diaktifkan di server")
    ap.add_argument("--hari", type=float, default=0, help="isi riwayat N hari ke belakang (hanya --api)")
    ap.add_argument("--live", type=float, default=0, help="setelah itu kirim paket baru tiap N detik")
    a = ap.parse_args()
    if not a.api and not a.mqtt:
        ap.error("isi --api atau --mqtt")

    rnd = random.Random(42)
    now = time.time()
    start = now - max(a.hari, 1) * 86400
    seq = 1

    if a.hari and a.api:
        batch, ts = [], start
        while ts <= now:
            if rnd.random() > 0.01:
                batch.append(paket(a.node, ts, start, seq, rnd))
            seq += 1
            ts += STEP
            if len(batch) >= 500:
                kirim_http(a.api, batch, a.token); batch = []
        if batch:
            kirim_http(a.api, batch, a.token)
        print(f"Riwayat {a.hari} hari terkirim ({seq - 1} paket).")

    if not a.live:
        return
    client = None
    if a.mqtt:
        import paho.mqtt.client as mqtt
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        client.connect(a.mqtt, a.mqtt_port)
        client.loop_start()
    topic = f"sigap/{a.site}/{a.node}/telemetry"
    print(f"Mengirim paket tiap {a.live} detik ({'MQTT ' + topic if client else 'HTTP'}). Ctrl+C untuk berhenti.")
    while True:
        p = paket(a.node, time.time(), start, seq, rnd)
        seq += 1
        if client:
            client.publish(topic, json.dumps(p), qos=1)
        else:
            kirim_http(a.api, p, a.token)
        print(json.dumps(p))
        time.sleep(a.live)


if __name__ == "__main__":
    main()
