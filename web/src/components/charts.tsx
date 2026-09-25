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

export const yenShort = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : n.toLocaleString("ja-JP"));
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
  const max = unit === "円" ? niceMax(Math.max(0, ...totals)) : Math.max(4, Math.ceil(niceMax(Math.max(0, ...totals)) / 2) * 2);
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / Math.max(1, rows.length);
  const barW = Math.max(3, Math.min(28, slot * 0.7));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
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
