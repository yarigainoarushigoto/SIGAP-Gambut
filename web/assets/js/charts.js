// Pembungkus Chart.js: sumbu waktu linear (tanpa adapter), pita kelas PFVI, garis ambang, tooltip silang.

import { fmtShort, fmtDay, fmtTime, fmt } from "./util.js";
import { PFVI_CLASSES } from "./pfvi.js";

const registry = new Map();

export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const STATUS_VAR = { good: "--good", warning: "--warning", serious: "--serious", critical: "--critical" };

/** Plugin: pita latar kelas PFVI (0–75–150–225–300). */
const bandsPlugin = {
  id: "pfviBands",
  beforeDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.enabled) return;
    const { ctx, chartArea: a, scales: { y } } = chart;
    ctx.save();
    for (const c of PFVI_CLASSES) {
      const y0 = y.getPixelForValue(c.max), y1 = y.getPixelForValue(c.min);
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = css(STATUS_VAR[c.status]);
      ctx.fillRect(a.left, Math.max(a.top, y0), a.right - a.left, Math.min(a.bottom, y1) - Math.max(a.top, y0));
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = css("--text-2");
      ctx.font = "600 10.5px " + css("--font");
      ctx.textAlign = "right";
      if (y0 > a.top - 1) ctx.fillText(c.label, a.right - 6, y0 + 13);
    }
    ctx.restore();
  },
};

/** Plugin: garis ambang horizontal putus-putus berlabel. */
const thresholdPlugin = {
  id: "thresholds",
  afterDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.lines || !opts.lines.length) return;
    const { ctx, chartArea: a, scales: { y } } = chart;
    ctx.save();
    for (const l of opts.lines) {
      const py = y.getPixelForValue(l.value);
      if (py < a.top || py > a.bottom) continue;
      ctx.strokeStyle = css(l.color || "--critical");
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--text-2");
      ctx.font = "600 10.5px " + css("--font");
      ctx.textAlign = "left";
      ctx.fillText(l.label, a.left + 6, l.below ? py + 13 : py - 5);
    }
    ctx.restore();
  },
};

/** Plugin: garis vertikal mengikuti kursor (crosshair). */
const crosshairPlugin = {
  id: "crosshair",
  afterDraw(chart) {
    const act = chart.tooltip?.getActiveElements?.();
    if (!act || !act.length) return;
    const x = act[0].element.x;
    const { ctx, chartArea: a } = chart;
    ctx.save();
    ctx.strokeStyle = css("--muted");
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke();
    ctx.restore();
  },
};

if (window.Chart) window.Chart.register(bandsPlugin, thresholdPlugin, crosshairPlugin);

function tickFormatter(spanMs) {
  return (v) => (spanMs <= 2 * 864e5 ? fmtTime(v) : fmtDay(v));
}

/**
 * Buat / perbarui grafik garis atau batang dengan sumbu waktu.
 * spec: { id, canvas, type, series:[{label, color, data:[{x,y}], dashed, fill, bar}], unit, digits,
 *         yMin, yMax, reverse, bands, thresholds, span:[from,to], daily }
 */
export function timeChart(spec) {
  const C = window.Chart;
  if (!C) return null;
  const grid = css("--grid"), txt = css("--text-2");
  const span = spec.span ? spec.span[1] - spec.span[0] : 864e5;
  const datasets = spec.series.map((s) => {
    const color = css(s.color);
    const isBar = s.bar || spec.type === "bar";
    return {
      type: isBar ? "bar" : "line",
      label: s.label,
      data: s.data,
      borderColor: color,
      backgroundColor: isBar ? color : color,
      borderWidth: isBar ? 0 : 2,
      borderDash: s.dashed ? [5, 4] : [],
      pointRadius: s.points ? 3 : 0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: css("--surface"),
      pointBackgroundColor: color,
      tension: 0.25,
      spanGaps: s.spanGaps ?? (spec.gapMs ? spec.gapMs : false),
      fill: false,
      borderRadius: isBar ? 3 : 0,
      barPercentage: 0.9,
      categoryPercentage: 0.9,
      maxBarThickness: 18,
      grouped: true,
      order: isBar ? 2 : 1,
    };
  });

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    normalized: true,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    layout: { padding: { top: 4, right: 4 } },
    scales: {
      x: {
        type: "linear",
        min: spec.span?.[0], max: spec.span?.[1],
        offset: spec.series.some((s) => s.bar),
        grid: { display: false },
        border: { color: grid },
        ticks: { color: txt, maxTicksLimit: 7, autoSkip: true, maxRotation: 0, callback: tickFormatter(span), font: { size: 11 } },
      },
      y: {
        min: spec.yMin, max: spec.yMax, suggestedMax: spec.suggestedMax,
        reverse: !!spec.reverse,
        beginAtZero: spec.beginAtZero ?? false,
        grid: { color: grid, drawTicks: false },
        border: { display: false },
        ticks: { color: txt, padding: 6, maxTicksLimit: 6, font: { size: 11 }, callback: (v) => fmt(v, spec.tickDigits ?? 0) },
        title: spec.unit ? { display: true, text: spec.unit, color: txt, font: { size: 11, weight: "600" } } : undefined,
      },
    },
    plugins: {
      legend: { display: false },
      pfviBands: { enabled: !!spec.bands },
      thresholds: { lines: spec.thresholds || [] },
      tooltip: {
        backgroundColor: css("--surface"),
        titleColor: css("--text"),
        bodyColor: css("--text"),
        borderColor: css("--border"),
        borderWidth: 1,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
        callbacks: {
          title: (items) => items.length ? (spec.daily ? fmtDay(items[0].parsed.x) : fmtShort(items[0].parsed.x)) : "",
          label: (it) => ` ${it.dataset.label}: ${fmt(it.parsed.y, spec.digits ?? 1)}${spec.unitShort ? " " + spec.unitShort : ""}`,
          labelColor: (it) => ({ borderColor: it.dataset.borderColor, backgroundColor: it.dataset.borderColor }),
        },
      },
    },
  };

  const existing = registry.get(spec.id);
  if (existing && existing.canvas === spec.canvas && existing.config.type === "line") {
    existing.data.datasets = datasets;
    existing.options = options;
    existing.update("none");
    return existing;
  }
  if (existing) existing.destroy();
  const chart = new C(spec.canvas, { type: "line", data: { datasets }, options });
  registry.set(spec.id, chart);
  return chart;
}

export function destroyAll() {
  for (const c of registry.values()) c.destroy();
  registry.clear();
}

export function legendHtml(items) {
  return `<div class="legend">${items.map((i) => `<span><i class="${i.kind || ""}" style="--c:var(${i.color})"></i>${i.label}</span>`).join("")}</div>`;
}
