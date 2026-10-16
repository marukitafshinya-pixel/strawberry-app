// ハウスの使い方（収穫管理）の絵：収穫＝収穫かご（から）、いちご狩り全＝赤いいちご、いちご狩り予備＝上半分が白いいちご、
// いちご狩り前・後ろ＝赤いいちご＋「前」「後」、休み＝お月さま。作業配置表のハウスの番号の横に出す
import { useId } from "react";
import type { HouseUse } from "@/lib/harvest";

const BERRY = "M32 60C18 52 9 40 11 27c1.5-9 10-12 21-9 11-3 19.5 0 21 9 2 13-7 25-21 33z";
const SEEDS: [number, number][] = [
  [24, 30],
  [34, 28],
  [43, 31],
  [20, 40],
  [30, 39],
  [40, 40],
  [26, 49],
  [36, 49],
];

function Berry({ half }: { half?: boolean }) {
  // 絵ごとに別の名前（同じ画面にいくつ出しても、白いところの切り取りが混ざらないように）
  const clip = `top${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <>
      <path d={BERRY} fill="#e11d48" stroke="#9f1239" strokeWidth="2" />
      {/* 予備：上半分が白い（まだ赤くなっていない）いちご */}
      {half && (
        <>
          <clipPath id={clip}>
            <rect x="0" y="0" width="64" height="38" />
          </clipPath>
          <path d={BERRY} fill="#f8fafc" stroke="#9ca3af" strokeWidth="2" clipPath={`url(#${clip})`} />
        </>
      )}
      <g fill="#fde68a" stroke={half ? "#d6b84a" : "none"} strokeWidth=".4">
        {SEEDS.map(([x, y]) => (
          <ellipse key={`${x}-${y}`} cx={x} cy={y} rx="1.6" ry="2.4" />
        ))}
      </g>
      <path
        d="M32 20c-4-1-9-1-13 2 4 1 7 1 9 0-2 3-3 6-2 9 2-2 4-5 6-8 2 3 4 6 6 8 1-3 0-6-2-9 2 1 5 1 9 0-4-3-9-3-13-2z"
        fill="#16a34a"
        stroke="#14532d"
        strokeWidth="1.2"
      />
      <path d="M32 19c0-4 1-8 3-11" stroke="#14532d" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </>
  );
}

function Basket() {
  return (
    <>
      <path d="M14 28C14 12 50 12 50 28" fill="none" stroke="#92400e" strokeWidth="4" strokeLinecap="round" />
      <path d="M7 28h50l-6 26a4 4 0 0 1-4 3H17a4 4 0 0 1-4-3z" fill="#d97706" stroke="#78350f" strokeWidth="2" />
      <g stroke="#78350f" strokeWidth="1.6" opacity=".75">
        <path d="M9 36h46M11 44h42M13 51h38" />
        <path d="M20 29l3 27M32 29v27M44 29l-3 27" />
      </g>
    </>
  );
}

function Moon() {
  return (
    <>
      <path d="M38 10a24 24 0 1 0 16 38A20 20 0 0 1 38 10z" fill="#c7d2fe" stroke="#4f46e5" strokeWidth="2.5" />
      <text x="40" y="26" fontSize="13" fontWeight="bold" fill="#4f46e5" fontFamily="sans-serif">
        z
      </text>
      <text x="48" y="17" fontSize="10" fontWeight="bold" fill="#4f46e5" fontFamily="sans-serif">
        z
      </text>
    </>
  );
}

const TITLE: Record<HouseUse, string> = {
  harvest: "収穫",
  picking: "いちご狩り全",
  half: "いちご狩り前（後ろ半分は収穫）",
  halfBack: "いちご狩り後ろ（前半分は収穫）",
  reserve: "いちご狩り予備",
  off: "休み",
};

const HARVEST_BG = "#fef3c7";
const PICKING_BG = "#ffe4e6";
/** 作業配置表のハウスの番号のマスの色：収穫＝うすい黄色、いちご狩り（全・予備）＝うすいピンク、前・後ろ＝半分ずつ、休み＝灰色 */
export function houseUseBg(use: HouseUse): string {
  if (use === "harvest") return HARVEST_BG;
  if (use === "picking" || use === "reserve") return PICKING_BG;
  if (use === "half") return `linear-gradient(to right, ${PICKING_BG} 50%, ${HARVEST_BG} 50%)`;
  if (use === "halfBack") return `linear-gradient(to right, ${HARVEST_BG} 50%, ${PICKING_BG} 50%)`;
  return "#e5e7eb";
}

/** ハウスの使い方の絵。size はピクセル（「前」「後」の字もこれに合わせる） */
export function HouseUseIcon({ use, size = 22 }: { use: HouseUse; size?: number }) {
  const svg = (body: React.ReactNode) => (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden className="shrink-0">
      {body}
    </svg>
  );
  const icon = use === "harvest" ? svg(<Basket />) : use === "off" ? svg(<Moon />) : use === "reserve" ? svg(<Berry half />) : svg(<Berry />);
  const mark = use === "half" ? "前" : use === "halfBack" ? "後" : null;
  return (
    <span className="inline-flex items-center gap-0.5 align-middle" title={TITLE[use]} role="img" aria-label={TITLE[use]}>
      {icon}
      {mark && (
        <span
          className="rounded border border-emerald-700 bg-emerald-50 px-0.5 font-bold leading-none text-emerald-700"
          style={{ fontSize: Math.round(size * 0.55), paddingTop: 1, paddingBottom: 1 }}
        >
          {mark}
        </span>
      )}
    </span>
  );
}
