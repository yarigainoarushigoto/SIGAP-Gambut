"""
SIGAP-Gambut — backend ringan untuk dashboard.

* Berlangganan MQTT (paket JSON dari penerima LoRa) dan/atau menerima POST /api/ingest.
* Menyimpan pembacaan ke SQLite.
* Menyajikan API riwayat untuk dashboard dan file statis dashboard (folder ../web).

Jalankan:  uvicorn app:app --host 0.0.0.0 --port 8000
Variabel lingkungan: lihat README.md bagian "Backend".
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Union

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

log = logging.getLogger("sigap")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

DB_PATH = os.getenv("DB_PATH", str(Path(__file__).with_name("sigap.db")))
WEB_DIR = Path(os.getenv("WEB_DIR", str(Path(__file__).resolve().parent.parent / "web")))
MQTT_HOST = os.getenv("MQTT_HOST", "")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASS = os.getenv("MQTT_PASS", "")
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "sigap/+/+/telemetry")
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

FIELDS = ["seq", "wt_cm", "float_low", "sm_pct", "soil_t_c", "air_t_c", "rh_pct",
          "rain_mm", "batt_v", "pfvi", "rssi", "snr"]

# --------------------------------------------------------------------------- DB

_lock = threading.Lock()


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


_con: Optional[sqlite3.Connection] = None


def conn() -> sqlite3.Connection:
    global _con
    if _con is None:
        _con = db()
        _con.execute("PRAGMA journal_mode=WAL")
        _con.executescript(
            """
            CREATE TABLE IF NOT EXISTS telemetry (
              node TEXT NOT NULL, ts INTEGER NOT NULL,
              seq INTEGER, wt_cm REAL, float_low INTEGER, sm_pct REAL, soil_t_c REAL,
              air_t_c REAL, rh_pct REAL, rain_mm REAL, batt_v REAL, pfvi REAL,
              rssi REAL, snr REAL, extra TEXT,
              PRIMARY KEY (node, ts)
            );
            CREATE INDEX IF NOT EXISTS telemetry_ts ON telemetry(ts);
            CREATE TABLE IF NOT EXISTS bmkg_rain (
              date TEXT PRIMARY KEY, rain_mm REAL, station TEXT
            );
            """
        )
        _con.commit()
    return _con


# ---------------------------------------------------------------------- schema

class Telemetry(BaseModel):
    """Satu paket dari node (lihat docs/kontrak-data.md)."""
    node: str = Field(..., min_length=1, max_length=64)
    ts: Union[int, float, str, None] = None  # unix detik/ms atau ISO-8601; kosong = waktu terima
    seq: Optional[int] = None
    wt_cm: Optional[float] = Field(None, ge=-100, le=600)
    float_low: Optional[bool] = None
    sm_pct: Optional[float] = Field(None, ge=0, le=100)
    soil_t_c: Optional[float] = Field(None, ge=-20, le=80)
    air_t_c: Optional[float] = Field(None, ge=-40, le=80)
    rh_pct: Optional[float] = Field(None, ge=0, le=100)
    rain_mm: Optional[float] = Field(None, ge=0, le=500)
    batt_v: Optional[float] = Field(None, ge=0, le=30)
    pfvi: Optional[float] = Field(None, ge=0, le=300)
    rssi: Optional[float] = None
    snr: Optional[float] = None
    pfvi_fc: Optional[list[float]] = None

    model_config = {"extra": "allow"}

    @field_validator("node")
    @classmethod
    def _node(cls, v: str) -> str:
        return v.strip()

    def ts_ms(self) -> int:
        t = self.ts
        if t is None or t == "":
            return int(datetime.now(timezone.utc).timestamp() * 1000)
        if isinstance(t, str):
            try:
                return int(float(t) * (1 if float(t) > 1e12 else 1000))
            except ValueError:
                d = datetime.fromisoformat(t.replace("Z", "+00:00"))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                return int(d.timestamp() * 1000)
        return int(t if t > 1e12 else t * 1000)


class BmkgRain(BaseModel):
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    rain_mm: float = Field(..., ge=0, le=1000)
    station: Optional[str] = None


def store_telemetry(items: list[Telemetry]) -> int:
    rows = []
    for t in items:
        d = t.model_dump()
        known = set(FIELDS) | {"node", "ts"}
        extra = {k: v for k, v in d.items() if k not in known and v is not None}
        rows.append((
            t.node, t.ts_ms(), t.seq, t.wt_cm, None if t.float_low is None else int(t.float_low),
            t.sm_pct, t.soil_t_c, t.air_t_c, t.rh_pct, t.rain_mm, t.batt_v, t.pfvi, t.rssi, t.snr,
            json.dumps(extra) if extra else None,
        ))
    with _lock:
        c = conn()
        cur = c.executemany(
            "INSERT OR REPLACE INTO telemetry (node, ts, seq, wt_cm, float_low, sm_pct, soil_t_c, air_t_c,"
            " rh_pct, rain_mm, batt_v, pfvi, rssi, snr, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        c.commit()
    return cur.rowcount


def row_to_dict(r: sqlite3.Row) -> dict[str, Any]:
    d = {"node": r["node"], "ts": r["ts"]}
    for k in FIELDS:
        d[k] = r[k]
    if d["float_low"] is not None:
        d["float_low"] = bool(d["float_low"])
    if r["extra"]:
        try:
            d.update(json.loads(r["extra"]))
        except json.JSONDecodeError:
            pass
    return d


# ------------------------------------------------------------------------ MQTT

def start_mqtt() -> None:
    if not MQTT_HOST:
        log.info("MQTT_HOST kosong: hanya menerima data lewat POST /api/ingest")
        return
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log.warning("paho-mqtt belum terpasang; MQTT dinonaktifkan")
        return

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="sigap-api")
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)

    def on_connect(cl, _u, _f, rc, _p=None):
        log.info("MQTT terhubung (%s), subscribe %s", rc, MQTT_TOPIC)
        cl.subscribe(MQTT_TOPIC, qos=1)
        cl.subscribe("sigap/+/bmkg/rain", qos=1)

    def on_message(_cl, _u, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
            if msg.topic.endswith("/bmkg/rain"):
                b = BmkgRain(**payload)
                with _lock:
                    conn().execute("INSERT OR REPLACE INTO bmkg_rain VALUES (?,?,?)", (b.date, b.rain_mm, b.station))
                    conn().commit()
                return
            items = payload if isinstance(payload, list) else [payload]
            parts = msg.topic.split("/")
            for it in items:
                if "node" not in it and len(parts) >= 3:
                    it["node"] = parts[2]
            store_telemetry([Telemetry(**it) for it in items])
        except Exception as e:  # noqa: BLE001 — satu paket rusak tidak boleh mematikan subscriber
            log.warning("Paket MQTT ditolak (%s): %s", msg.topic, e)

    client.on_connect = on_connect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=2, max_delay=60)
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()


# ------------------------------------------------------------------------- API

@asynccontextmanager
async def lifespan(_app: FastAPI):
    conn()
    start_mqtt()
    yield


app = FastAPI(title="SIGAP-Gambut API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])


def _parse_time(s: Optional[str]) -> Optional[int]:
    if not s:
        return None
    return Telemetry(node="x", ts=s).ts_ms()


@app.get("/api/health")
def health():
    c = conn()
    n = c.execute("SELECT COUNT(*) AS n, COUNT(DISTINCT node) AS k, MAX(ts) AS last FROM telemetry").fetchone()
    return {"ok": True, "readings": n["n"], "nodes": n["k"], "last_ts": n["last"], "mqtt": bool(MQTT_HOST)}


@app.get("/api/nodes")
def nodes():
    rows = conn().execute(
        "SELECT node, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM telemetry GROUP BY node").fetchall()
    return [dict(r) for r in rows]


@app.get("/api/telemetry")
def telemetry(
    node: Optional[str] = None,
    since: Optional[str] = Query(None, description="ISO-8601 atau unix"),
    until: Optional[str] = None,
    limit: int = Query(20000, ge=1, le=200000),
):
    q, args = "SELECT * FROM telemetry WHERE 1=1", []
    if node:
        q += " AND node = ?"; args.append(node)
    if (t := _parse_time(since)) is not None:
        q += " AND ts >= ?"; args.append(t)
    if (t := _parse_time(until)) is not None:
        q += " AND ts <= ?"; args.append(t)
    # ambil `limit` terbaru, kembalikan urut naik
    q = f"SELECT * FROM ({q} ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC"
    args.append(limit)
    return [row_to_dict(r) for r in conn().execute(q, args).fetchall()]


@app.get("/api/latest")
def latest():
    rows = conn().execute(
        "SELECT t.* FROM telemetry t JOIN (SELECT node, MAX(ts) AS m FROM telemetry GROUP BY node) x"
        " ON t.node = x.node AND t.ts = x.m").fetchall()
    return [row_to_dict(r) for r in rows]


def _check_token(token: Optional[str]) -> None:
    if INGEST_TOKEN and token != INGEST_TOKEN:
        raise HTTPException(401, "X-Api-Key salah atau tidak ada")


@app.post("/api/ingest")
def ingest(payload: Union[Telemetry, list[Telemetry]], x_api_key: Optional[str] = Header(None)):
    """Alternatif MQTT: penerima LoRa mengirim HTTP POST JSON (satu paket atau array)."""
    _check_token(x_api_key)
    items = payload if isinstance(payload, list) else [payload]
    return {"stored": store_telemetry(items)}


@app.get("/api/bmkg")
def bmkg(since: Optional[str] = None):
    q, args = "SELECT * FROM bmkg_rain", []
    if since:
        q += " WHERE date >= ?"; args.append(since[:10])
    return [dict(r) for r in conn().execute(q + " ORDER BY date", args).fetchall()]


@app.post("/api/bmkg")
def bmkg_add(payload: Union[BmkgRain, list[BmkgRain]], x_api_key: Optional[str] = Header(None)):
    """Masukkan curah hujan harian BMKG (data sekunder) — manual atau dari skrip pengambil data."""
    _check_token(x_api_key)
    items = payload if isinstance(payload, list) else [payload]
    with _lock:
        conn().executemany("INSERT OR REPLACE INTO bmkg_rain VALUES (?,?,?)", [(b.date, b.rain_mm, b.station) for b in items])
        conn().commit()
    return {"stored": len(items)}


# Dashboard statis disajikan di "/" (didaftarkan terakhir agar /api/* didahulukan)
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
