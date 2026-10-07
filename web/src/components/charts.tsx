"use client";

// ダッシュボード用のグラフ（SVGで描く小さな部品）
// 色は「色覚の多様性に配慮して検証済み」の順番で割り当てる。順番を変えない。
import { useEffect, useRef, useState, type ReactNode } from "react";

/** 置かれた場所の実際の幅（px）を測る。グラフの文字を画面の大きさにかかわらず同じ大きさにするため */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** 分類の色（固定順。9つ目以降は「その他」にまとめる） */
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
/** 内訳のない売上（Airレジの取り込み）用の中立色 */
export const NEUTRAL = "#a9a79f";
const GRID = "#e6e4df";
const TEXT_MUTED = "#6b6a65";
const SURFACE = "#ffffff";

export const yenShort = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}万` : n.toLocaleString("ja-JP"));
const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

export type Series = { key: string; label: string; color: string };

/** 上だけ角を丸めた長方形（データの端を丸め、ゼロ側は四角のまま） */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * 縦軸の目盛り。いちばん高い値のすぐ上で軸が終わるよう、きりのよい間隔（1・2・2.5・5 × 10のn乗）から
 * 余白がいちばん少なくなるものを選ぶ（目盛りは3〜10本）。整数だけにするときは int を true に
 */
export function tightTicks(v: number, int = false): number[] {
  if (v <= 0) return int ? [0, 2, 4] : [0, 500, 1000];
  let best: { top: number; step: number } | null = null;
  const e = Math.floor(Math.log10(v));
  for (let k = e - 2; k <= e + 1; k++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** k;
      if (int && !Number.isInteger(step)) continue;
      const n = Math.ceil(v / step);
      if (n < 3 || n > 10) continue;
      const top = n * step;
      if (!best || top < best.top || (top === best.top && step > best.step)) best = { top, step };
    }
  }
  if (!best) best = { top: niceMax(v), step: niceMax(v) / 2 };
  return Array.from({ length: Math.round(best.top / best.step) + 1 }, (_, i) => Math.round(i * best!.step * 1000) / 1000);
}

/** グラフの上に出す説明の吹き出し */
function Tooltip({ x, children }: { x: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-lg border bg-white px-3 py-2 text-sm shadow-lg"
      style={{ left: `clamp(0px, calc(${x}% - 4.5rem), calc(100% - 9rem))` }}
    >
      {children}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * 積み上げ縦棒（例：日ごとの売上を分類別に積む）
 * rows: x軸の項目ごとに { label, values: {系列key: 値} }
 */
export function StackedColumns({
  rows,
  series,
  height = 220,
  width = 640,
  ariaLabel,
  unit = "円",
}: {
  rows: { key: string; label: string; sub?: string; values: Record<string, number> }[];
  series: Series[];
  height?: number;
  /** 描画の基準の幅。狭い場所に置くときは小さくすると文字が読みやすい */
  width?: number;
  ariaLabel: string;
  /** 値の単位（"円" なら金額として表示） */
  unit?: "円" | "人";
}) {
  const fmt = (n: number) => (unit === "円" ? yen(n) : `${n.toLocaleString("ja-JP")}${unit}`);
  const axis = (n: number) => (unit === "円" ? yenShort(n) : n.toLocaleString("ja-JP"));
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(width);
  const H = height;
  const pad = { l: 44, r: 8, t: 12, b: 24 };
  const totals = rows.map((r) => series.reduce((n, s) => n + (r.values[s.key] ?? 0), 0));
  // 人数のときは、目盛りが整数になるよう偶数にそろえる
  const ticks = tightTicks(Math.max(0, ...totals), unit !== "円");
  const max = ticks[ticks.length - 1];
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(1, rows.length);
  const barW = Math.max(3, Math.min(28, slot * 0.7));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  // ラベルが重ならないよう、項目が多いときは間引く
  const labelEvery = Math.max(1, Math.ceil((rows.length * 26) / plotW));

  return (
    <div className="relative" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={TEXT_MUTED}>
              {axis(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = pad.l + slot * i + slot / 2;
          let acc = 0;
          const segs = series
            .map((s) => ({ s, v: r.values[s.key] ?? 0 }))
            .filter((x) => x.v > 0);
          return (
            <g key={r.key}>
              {segs.map(({ s, v }, j) => {
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                // 積み上げの間に2pxのすき間
                const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                const top = j === segs.length - 1;
                return top ? (
                  <path key={s.key} d={topRoundedRect(cx - barW / 2, y1, barW, h, 4)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                ) : (
                  <rect key={s.key} x={cx - barW / 2} y={y1} width={barW} height={h} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill={TEXT_MUTED}>
                  {r.label}
                </text>
              )}
              {/* 当たり判定は棒より広く（列全体） */}
              <rect
                x={pad.l + slot * i}
                y={pad.t}
                width={slot}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerDown={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${r.sub ?? r.label} ${fmt(totals[i])}`}
              />
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#bdbbb4" strokeWidth={1} />
      </svg>
      {hover !== null && (
        <Tooltip x={((pad.l + slot * hover + slot / 2) / W) * 100}>
          <div className="text-base font-bold">{fmt(totals[hover])}</div>
          <div className="text-xs text-gray-500">{rows[hover].sub ?? rows[hover].label}</div>
          <ul className="mt-1 space-y-0.5">
            {series
              .filter((s) => (rows[hover].values[s.key] ?? 0) > 0)
              .map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-xs">
                  <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
                  <span className="font-semibold">{fmt(rows[hover].values[s.key])}</span>
                  <span className="text-gray-500">{s.label}</span>
                </li>
              ))}
          </ul>
        </Tooltip>
      )}
    </div>
  );
}

/** 横棒の一覧（例：分類ごとの売上）。値は常に表示する */
export function HBars({ items }: { items: { key: string; label: string; value: number; color: string; note?: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.key} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate" title={it.label}>
            {it.label}
          </span>
          <span className="h-3 overflow-hidden rounded-r bg-transparent">
            <span className="block h-full rounded-r" style={{ width: `${(it.value / max) * 100}%`, background: it.color, minWidth: it.value > 0 ? 3 : 0 }} />
          </span>
          <span className="text-right font-semibold tabular-nums">
            {yen(it.value)}
            {it.note && <span className="ml-1 text-xs font-normal text-gray-500">{it.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 埋まり具合のメーター（例：時間枠ごとの予約人数／定員） */
export function Meter({ value, max, color = SERIES_COLORS[0] }: { value: number; max: number; color?: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : value > 0 ? 1 : 0;
  const over = value > max;
  return (
    <span className="block h-3 overflow-hidden rounded-full" style={{ background: GRID }}>
      <span className="block h-full rounded-full" style={{ width: `${ratio * 100}%`, background: over ? "#c0392b" : color, boxShadow: `inset -2px 0 0 ${SURFACE}` }} />
    </span>
  );
}

/**
 * 凡例を兼ねた切り替えボタン。押すとその系列（分類）をグラフに出す／出さないを切り替える。
 * 色は系列ごとに固定なので、切り替えても他の系列の色は変わらない。
 */
export function SeriesToggle({
  series,
  hidden,
  onChange,
}: {
  series: Series[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}) {
  if (series.length === 0) return null;
  const allShown = hidden.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        onClick={() => onChange([])}
        className={`rounded-full border px-3 py-1 ${allShown ? "border-gray-800 bg-gray-800 text-white" : "bg-white"}`}
        aria-pressed={allShown}
      >
        すべて
      </button>
      {series.map((s) => {
        const on = !hidden.includes(s.key);
        return (
          <span key={s.key} className="inline-flex overflow-hidden rounded-full border bg-white">
            <button
              onClick={() => onChange(on ? [...hidden, s.key] : hidden.filter((k) => k !== s.key))}
              className={`flex items-center gap-1.5 px-3 py-1 ${on ? "" : "text-gray-400 line-through"}`}
              aria-pressed={on}
              title={on ? "押すとグラフから外します" : "押すとグラフに出します"}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: on ? s.color : "#d4d2cc" }} />
              {s.label}
            </button>
            <button
              onClick={() => onChange(series.filter((x) => x.key !== s.key).map((x) => x.key))}
              className="border-l px-2 py-1 text-xs text-gray-500"
              title={`${s.label}だけを表示`}
            >
              だけ
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * 2つの年を並べた縦棒（例：月ごとの売上を今年と去年で比べる）
 * rows: 月ごとに a（比べる年）と b（基準の年）の値
 */
export function PairedColumns({
  rows,
  a,
  b,
  fmt,
  axis,
  height = 240,
  ariaLabel,
}: {
  rows: { key: string; label: string; sub?: string; a: number | null; b: number | null }[];
  a: Series;
  b: Series;
  fmt: (n: number) => string;
  axis: (n: number) => string;
  height?: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(640);
  const H = height;
  const pad = { l: 48, r: 8, t: 12, b: 24 };
  const ticks = tightTicks(Math.max(0, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0])));
  const max = ticks[ticks.length - 1];
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(1, rows.length);
  // 2本の棒の間に2pxのすき間
  const barW = Math.max(3, Math.min(22, (slot * 0.8 - 2) / 2));
  const y = (v: number) => pad.t + plotH - (Math.max(0, v) / max) * plotH;
  const pct = (x: number | null, base: number | null) => (x !== null && base ? `${Math.round((x / base) * 100)}%` : "－");

  return (
    <div className="relative" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={TEXT_MUTED}>
              {axis(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = pad.l + slot * i + slot / 2;
          const dim = hover === null || hover === i ? 1 : 0.55;
          const bar = (v: number | null, x: number, color: string) =>
            v !== null && v > 0 ? <path d={topRoundedRect(x, y(v), barW, y(0) - y(v), 4)} fill={color} opacity={dim} /> : null;
          return (
            <g key={r.key}>
              {bar(r.a, cx - barW - 1, a.color)}
              {bar(r.b, cx + 1, b.color)}
              <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill={TEXT_MUTED}>
                {/* 狭いときは「月」を省く */}
                {slot < 34 ? r.label.replace(/月$/, "") : r.label}
              </text>
              <rect
                x={pad.l + slot * i}
                y={pad.t}
                width={slot}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerDown={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${r.label} ${a.label} ${r.a === null ? "なし" : fmt(r.a)} ${b.label} ${r.b === null ? "なし" : fmt(r.b)}`}
              />
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#bdbbb4" strokeWidth={1} />
      </svg>
      {hover !== null && (
        <Tooltip x={((pad.l + slot * hover + slot / 2) / W) * 100}>
          <div className="text-xs text-gray-500">{rows[hover].sub ?? rows[hover].label}</div>
          <ul className="mt-1 space-y-0.5">
            {[
              { s: a, v: rows[hover].a },
              { s: b, v: rows[hover].b },
            ].map(({ s, v }) => (
              <li key={s.key} className="flex items-center gap-2 text-xs">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                <span className="font-semibold">{v === null ? "なし" : fmt(v)}</span>
                <span className="text-gray-500">{s.label}</span>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-xs">
            {b.label}比 <b>{pct(rows[hover].a, rows[hover].b)}</b>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** 気象の線・棒（出荷などのグラフの下に、同じ日付の列をそろえて並べる） */
type WeatherValues = Partial<Record<"tAvg" | "tMax" | "tMin" | "precip" | "sun", number | null>>;
/** values＝今年、prev＝前年の同じ日・週・月（前年と比べるときだけ） */
export type WeatherRow = { key: string; label: string; sub?: string; values: WeatherValues; prev?: WeatherValues };
const WEATHER_STYLE = {
  tMax: { label: "最高気温", color: "#e34948", unit: "℃" },
  tAvg: { label: "平均気温", color: "#eb6834", unit: "℃" },
  tMin: { label: "最低気温", color: "#2a78d6", unit: "℃" },
  precip: { label: "降水量", color: "#4a3aa7", unit: "mm" },
  sun: { label: "日照時間", color: "#eda100", unit: "h" },
} as const;
type WKey = keyof typeof WEATHER_STYLE;

/**
 * 気象のグラフ。上のグラフ（StackedColumns）と同じ左右の余白・列の幅なので、日付の列がそろう。
 * 単位が違うものは同じ目盛りにしない：気温（℃）・降水量（mm）・日照時間（h）は、それぞれ別の段にする
 */
export function WeatherStrip({
  rows,
  show,
  width = 640,
  padL = 44,
  compare,
}: {
  rows: WeatherRow[];
  show: WKey[];
  width?: number;
  padL?: number;
  /** 前年と比べるとき：今年・前年の呼び名 */
  compare?: { a: string; b: string };
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(width);
  const pad = { l: padL, r: 8 };
  const plotW = W - pad.l - pad.r;
  const slot = plotW / Math.max(1, rows.length);
  const cx = (i: number) => pad.l + slot * i + slot / 2;
  const temps = (["tMax", "tAvg", "tMin"] as const).filter((k) => show.includes(k));
  const panels: { kind: "temp" | "precip" | "sun"; keys: WKey[] }[] = [];
  if (temps.length) panels.push({ kind: "temp", keys: temps });
  if (show.includes("precip")) panels.push({ kind: "precip", keys: ["precip"] });
  if (show.includes("sun")) panels.push({ kind: "sun", keys: ["sun"] });
  const PH = 96;
  const top = 8;
  const H = panels.length * (PH + 14) + 6;
  const num = (v: number) => v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });

  return (
    <div className="relative" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="気象のグラフ" onPointerLeave={() => setHover(null)}>
        {panels.map((p, pi) => {
          const y0 = top + pi * (PH + 14);
          const vals = rows.flatMap((r) => p.keys.flatMap((k) => [r.values[k], compare ? r.prev?.[k] : null])).filter((v): v is number => typeof v === "number");
          let lo = p.kind === "temp" ? Math.floor(Math.min(...vals, 0) / 5) * 5 : 0;
          let hi = p.kind === "temp" ? Math.ceil(Math.max(...vals, 10) / 5) * 5 : niceMax(Math.max(1, ...vals));
          if (!vals.length) {
            lo = 0;
            hi = p.kind === "temp" ? 30 : 10;
          }
          const y = (v: number) => y0 + PH - ((v - lo) / (hi - lo || 1)) * PH;
          const unit = WEATHER_STYLE[p.keys[0]].unit;
          return (
            <g key={p.kind}>
              {[lo, (lo + hi) / 2, hi].map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                  <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={TEXT_MUTED}>
                    {num(t)}
                    {t === hi ? unit : ""}
                  </text>
                </g>
              ))}
              {p.kind === "temp"
                ? p.keys.flatMap((k) =>
                    (compare ? (["prev", "values"] as const) : (["values"] as const)).map((which) => {
                      const get = (r: WeatherRow) => (which === "prev" ? r.prev?.[k] : r.values[k]);
                      const isPrev = which === "prev";
                      // 値のない日で線を切る
                      const segs: string[] = [];
                      let cur = "";
                      rows.forEach((r, i) => {
                        const v = get(r);
                        if (typeof v !== "number") {
                          if (cur) segs.push(cur);
                          cur = "";
                          return;
                        }
                        cur += `${cur ? "L" : "M"}${cx(i)},${y(v)} `;
                      });
                      if (cur) segs.push(cur);
                      const color = WEATHER_STYLE[k].color;
                      return (
                        <g key={`${k}-${which}`} opacity={isPrev ? 0.7 : 1}>
                          {segs.map((d, j) => (
                            <path key={j} d={d} fill="none" stroke={color} strokeWidth={isPrev ? 1.5 : 2} strokeDasharray={isPrev ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
                          ))}
                          {/* 列が広いとき（月ごとなど）は点も打つ。1つだけの値でも見えるように。前年は白抜き */}
                          {slot >= 24 &&
                            rows.map((r, i) => {
                              const v = get(r);
                              return typeof v === "number" ? (
                                <circle key={r.key} cx={cx(i)} cy={y(v)} r={3.5} fill={isPrev ? SURFACE : color} stroke={isPrev ? color : SURFACE} strokeWidth={1.5} />
                              ) : null;
                            })}
                          {hover !== null && typeof get(rows[hover]) === "number" && (
                            <circle cx={cx(hover)} cy={y(get(rows[hover])!)} r={4} fill={isPrev ? SURFACE : color} stroke={isPrev ? color : SURFACE} strokeWidth={2} />
                          )}
                        </g>
                      );
                    }),
                  )
                : rows.flatMap((r, i) => {
                    const k = p.keys[0];
                    const color = WEATHER_STYLE[k].color;
                    const full = Math.max(2, Math.min(20, slot * 0.6));
                    // 前年と比べるときは、左に前年（薄い色）・右に今年を並べる
                    const bars = compare
                      ? [
                          { v: r.prev?.[k], x: cx(i) - full / 2 - 1, w: full / 2, prev: true },
                          { v: r.values[k], x: cx(i) + 1, w: full / 2, prev: false },
                        ]
                      : [{ v: r.values[k], x: cx(i) - full / 2, w: full, prev: false }];
                    return bars.map((b) => {
                      if (typeof b.v !== "number" || b.v <= 0) return null;
                      const h = y0 + PH - y(b.v);
                      const dim = hover === null || hover === i ? 1 : 0.55;
                      return <path key={`${r.key}-${b.prev}`} d={topRoundedRect(b.x, y(b.v), Math.max(1.5, b.w), h, Math.min(3, b.w / 2))} fill={color} opacity={(b.prev ? 0.4 : 1) * dim} />;
                    });
                  })}
              <line x1={pad.l} x2={W - pad.r} y1={y0 + PH} y2={y0 + PH} stroke="#bdbbb4" strokeWidth={1} />
            </g>
          );
        })}
        {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={top} y2={H - 6} stroke="#9a988f" strokeWidth={1} strokeDasharray="3 3" />}
        {rows.map((r, i) => (
          <rect
            key={r.key}
            x={pad.l + slot * i}
            y={0}
            width={slot}
            height={H}
            fill="transparent"
            onPointerEnter={() => setHover(i)}
            onPointerDown={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={(cx(hover) / W) * 100}>
          <div className="text-xs text-gray-500">
            {rows[hover].sub ?? rows[hover].label}
            {compare && `（${compare.a}）`}
          </div>
          <ul className="mt-1 space-y-0.5">
            {show.map((k) => {
              const v = rows[hover].values[k];
              const pv = rows[hover].prev?.[k];
              const f = (x: number | null | undefined) => (typeof x === "number" ? `${num(x)}${WEATHER_STYLE[k].unit}` : "－");
              return (
                <li key={k} className="flex items-center gap-2 text-xs">
                  <Swatch k={k} />
                  <span className="text-gray-500">{WEATHER_STYLE[k].label}</span>
                  <span className="font-semibold">{f(v)}</span>
                  {compare && (
                    <span className="text-gray-500">
                      （{compare.b} {f(pv)}）
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Tooltip>
      )}
    </div>
  );
}

/** 線（気温）は細い線、棒（降水量・日照時間）は四角で見せる */
function Swatch({ k }: { k: WKey }) {
  const bar = k === "precip" || k === "sun";
  return <span className={`inline-block ${bar ? "h-2.5 w-2.5 rounded-sm" : "h-0.5 w-3"}`} style={{ background: WEATHER_STYLE[k].color }} />;
}

/** 重ねる気象の項目を選ぶチェックボックス。「前年と比較」で、選んだ項目の前年も並べる */
export function WeatherPicker({
  show,
  onChange,
  compare,
  onCompare,
  year,
}: {
  show: WKey[];
  onChange: (v: WKey[]) => void;
  compare?: boolean;
  onCompare?: (v: boolean) => void;
  year?: number;
}) {
  const order: WKey[] = ["tAvg", "tMax", "tMin", "precip", "sun"];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-xs text-gray-500">気象を並べる：</span>
      {order.map((k) => (
        <label key={k} className="flex items-center gap-1">
          <input type="checkbox" checked={show.includes(k)} onChange={(e) => onChange(e.target.checked ? order.filter((x) => x === k || show.includes(x)) : show.filter((x) => x !== k))} />
          <Swatch k={k} />
          {WEATHER_STYLE[k].label}
        </label>
      ))}
      {onCompare && (
        <label className="ml-2 flex items-center gap-1 border-l pl-3 font-semibold">
          <input type="checkbox" checked={!!compare} onChange={(e) => onCompare(e.target.checked)} />
          前年と比較
        </label>
      )}
      {compare && show.length > 0 && year && (
        <span className="flex items-center gap-3 text-xs text-gray-600">
          <span className="flex items-center gap-1">
            <svg width="22" height="8" aria-hidden>
              <line x1="1" x2="21" y1="4" y2="4" stroke="#6b6a64" strokeWidth="2" />
            </svg>
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#6b6a64]" />
            {year}年
          </span>
          <span className="flex items-center gap-1">
            <svg width="22" height="8" aria-hidden>
              <line x1="1" x2="21" y1="4" y2="4" stroke="#6b6a64" strokeWidth="1.5" strokeDasharray="5 4" />
            </svg>
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#6b6a64] opacity-40" />
            {year - 1}年
          </span>
        </span>
      )}
    </div>
  );
}
export type WeatherKey5 = WKey;
