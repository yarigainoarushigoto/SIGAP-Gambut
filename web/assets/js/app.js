// SIGAP-Gambut — inti aplikasi: memuat konfigurasi, memilih sumber data, routing, header, notifikasi.

import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { probeApi, startApi, startMqtt, startSimulator } from "./sources.js";
import { dailyAggregate, fmtDateTime, relTime, esc } from "./util.js";
import { computePfviSeries } from "./pfvi.js";
import { evaluate, LEVELS } from "./alerts.js";
import { destroyAll } from "./charts.js";
import { VIEWS } from "./views.js";

const cfg = loadConfig();
const store = new Store();

const ctx = {
  cfg, store,
  node: null,
  derived: {},     // per node: { readings, latest, daily, pfvi, alerts }
  version: 0,
  mode: "demo",
  toast,
};
window.SIGAP = ctx; // memudahkan debugging dari konsol

/* -------------------------------------------------- turunan data */
function derive() {
  ctx.derived = {};
  for (const id of store.nodes()) {
    const readings = store.series(id);
    const daily = dailyAggregate(readings, store.bmkg, cfg.pfvi.rainSource);
    const pfvi = computePfviSeries(daily, cfg.pfvi);
    const alerts = evaluate(id, readings, cfg);
    ctx.derived[id] = { readings, latest: readings[readings.length - 1] || null, daily, pfvi, alerts };
  }
  ctx.version++;
}

export function nodeMeta(id) {
  return cfg.nodes.find((n) => n.id === id) || { id, name: id, lat: null, lng: null };
}
ctx.nodeMeta = nodeMeta;

/* -------------------------------------------------- header */
const $ = (s) => document.querySelector(s);

function renderHeader() {
  const meta = nodeMeta(ctx.node);
  const d = ctx.derived[ctx.node];
  const last = d?.latest;
  $("#siteLine").textContent =
    `${meta.name} — ${cfg.site.name}, ${cfg.site.region}` + (last ? ` · Diperbarui ${fmtDateTime(last.ts)}` : "");

  const conn = $("#conn");
  conn.className = "conn";
  let label;
  if (ctx.mode === "demo") { conn.classList.add("demo"); label = "Mode demo"; }
  else if (store.status.connected === false) { conn.classList.add("down"); label = "Server terputus"; }
  else { conn.classList.add("live"); label = store.status.mqtt ? "Live · MQTT" : "Live · API"; }
  conn.querySelector(".conn-label").textContent = label;
  conn.title = last ? `Paket terakhir ${relTime(last.ts)}` : "Belum ada data";

  const active = Object.values(ctx.derived).flatMap((x) => x.alerts.active).filter((a) => a.level !== "info");
  const badge = $("#alertCount");
  badge.hidden = !active.length;
  badge.textContent = active.length;

  const ids = store.nodes();
  const pickWrap = $("#nodePickWrap"), pick = $("#nodePick");
  pickWrap.hidden = ids.length < 2;
  if (pick.options.length !== ids.length) {
    pick.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(nodeMeta(id).name)}</option>`).join("");
  }
  pick.value = ctx.node;
}

/* -------------------------------------------------- toast & notifikasi browser */
function toast(title, detail = "", level = "info") {
  const st = { danger: "st-critical", warn: "st-warning", info: "st-muted", ok: "st-good" }[level] || "";
  const el = document.createElement("div");
  el.className = `toast ${st}`;
  el.style.borderLeftColor = "var(--st)";
  el.innerHTML = `<b>${esc(title)}</b>${detail ? `<span class="muted">${esc(detail)}</span>` : ""}`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

let seenEventTs = 0;
function announceNewEvents(initial) {
  const all = Object.values(ctx.derived).flatMap((d) => d.alerts.events);
  const newest = all.reduce((m, e) => Math.max(m, e.ts), 0);
  if (!initial) {
    for (const e of all.filter((e) => e.ts > seenEventTs).slice(0, 3)) {
      toast(e.title, `${nodeMeta(e.node).name} · ${e.detail || ""}`, e.level);
      if (LEVELS[e.level].rank >= 2 && "Notification" in window && Notification.permission === "granted") {
        try { new Notification(`SIGAP-Gambut: ${e.title}`, { body: `${nodeMeta(e.node).name} — ${e.detail || ""}`, icon: "assets/img/favicon.svg", tag: e.key + e.node }); } catch { /* abaikan */ }
      }
    }
  }
  seenEventTs = Math.max(seenEventTs, newest);
}

/* -------------------------------------------------- routing */
let current = null;
function route() {
  const name = (location.hash || "#ringkasan").slice(1).split("?")[0];
  const view = VIEWS[name] ? name : "ringkasan";
  for (const a of document.querySelectorAll("#tabs a")) {
    if (a.dataset.route === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (current?.unmount) current.unmount();
  destroyAll();
  const el = $("#view");
  el.innerHTML = "";
  current = VIEWS[view];
  if (!ctx.node && !current.noData) {
    el.innerHTML = `<div class="ph">Belum ada data dari node. ${ctx.mode === "live" ? "Periksa gateway LoRa dan alamat server di <a href='#pengaturan'>Pengaturan</a>." : ""}</div>`;
    return;
  }
  current.mount(el, ctx);
  current.update?.(ctx);
}

let pending = false;
function onData() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    derive();
    if (!ctx.node || !ctx.derived[ctx.node]) {
      ctx.node = store.nodes()[0] || null;
      renderHeader();
      route();
    } else {
      renderHeader();
      current?.update?.(ctx);
    }
    announceNewEvents(false);
  });
}

/* -------------------------------------------------- boot */
async function boot() {
  $("#themeBtn").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("sigap.theme", root.dataset.theme); } catch { /* abaikan */ }
    route(); // gambar ulang grafik dengan warna tema baru
  });
  $("#nodePick").addEventListener("change", (e) => { ctx.node = e.target.value; renderHeader(); route(); });
  window.addEventListener("hashchange", route);
  setInterval(() => { renderHeader(); current?.tick?.(ctx); }, 30000);

  let mode = cfg.source.mode;
  if (mode === "auto" || mode === "live") {
    const health = await probeApi(cfg);
    if (health) mode = "live";
    else if (mode === "live") {
      store.setStatus({ connected: false });
      mode = "live-down";
    } else mode = "demo";
  }

  try {
    if (mode === "live") {
      ctx.mode = "live";
      await startApi(cfg, store);
      store.setStatus({ connected: true });
      startMqtt(cfg, store);
    } else if (mode === "live-down") {
      ctx.mode = "live";
      toast("Backend tidak terjangkau", `Periksa alamat API di Pengaturan (${cfg.source.apiBase || location.origin}).`, "danger");
    } else {
      ctx.mode = "demo";
      $("#demoStrip").hidden = false;
      startSimulator(cfg, store);
    }
  } catch (err) {
    console.error(err);
    toast("Gagal memuat data", String(err.message || err), "danger");
  }

  derive();
  ctx.node = store.nodes().includes(cfg.nodes[0]?.id) ? cfg.nodes[0].id : store.nodes()[0] || null;
  announceNewEvents(true);
  renderHeader();
  route();
  store.on((kind) => { if (kind === "data") onData(); else renderHeader(); });
}

boot();
