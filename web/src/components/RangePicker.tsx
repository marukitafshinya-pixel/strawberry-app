"use client";

// 期間の選択（集計画面で共通）
import { useRouter, useSearchParams } from "next/navigation";
import { addDays, isValidYmd, todayJST } from "@/lib/date";
import type { Settings } from "@/lib/settings";

/** 一度に集計できる最長の日数（表示が重くならないように） */
export const MAX_DAYS = 366;

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

/** よく使う期間 */
export function presets(settings: Settings, today: string): { label: string; from: string; to: string }[] {
  const y = Number(today.slice(0, 4));
  const ym = today.slice(0, 7);
  const firstOfMonth = `${ym}-01`;
  const lastOfMonth = addDays(`${new Date(Date.UTC(y, Number(ym.slice(5)), 1)).toISOString().slice(0, 7)}-01`, -1);
  const prevFirst = new Date(Date.UTC(y, Number(ym.slice(5)) - 2, 1)).toISOString().slice(0, 10);
  const monday = addDays(today, -((new Date(Date.parse(today)).getUTCDay() + 6) % 7));
  // 今シーズン（営業期間）：年をまたがない前提。またぐ設定なら今年の開始日から翌年の終了日まで
  const seasonFrom = `${y}-${settings.seasonStart}`;
  const seasonTo = settings.seasonStart <= settings.seasonEnd ? `${y}-${settings.seasonEnd}` : `${y + 1}-${settings.seasonEnd}`;
  return [
    { label: "今日", from: today, to: today },
    { label: "今週", from: monday, to: addDays(monday, 6) },
    { label: "今月", from: firstOfMonth, to: lastOfMonth },
    { label: "先月", from: prevFirst, to: addDays(firstOfMonth, -1) },
    { label: "今シーズン", from: seasonFrom, to: seasonTo },
    { label: "今年", from: `${y}-01-01`, to: `${y}-12-31` },
    { label: "去年", from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}


/** 画面のアドレス（?from=…&to=…）に期間を持たせる。再読み込みしても同じ期間が出る */
export function useRangeParams(basePath: string) {
  const params = useSearchParams();
  const router = useRouter();
  const today = todayJST();
  const qFrom = params.get("from");
  const qTo = params.get("to");
  const from = isValidYmd(qFrom) ? qFrom : `${today.slice(0, 7)}-01`;
  const to = isValidYmd(qTo) && qTo >= from ? qTo : today < from ? from : today;
  const days = daysBetween(from, to);
  return {
    from,
    to,
    days,
    tooLong: days > MAX_DAYS,
    setRange: (f: string, t: string) => router.replace(`${basePath}?from=${f}&to=${t}`),
  };
}

export function RangePicker({
  settings,
  from,
  to,
  days,
  onChange,
}: {
  settings: Settings;
  from: string;
  to: string;
  days: number;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <section className="mt-4 space-y-2 rounded-2xl bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={from}
          onChange={(e) => isValidYmd(e.target.value) && onChange(e.target.value, to < e.target.value ? e.target.value : to)}
          className="rounded-lg border px-3 py-2 text-base"
        />
        〜
        <input
          type="date"
          value={to}
          onChange={(e) => isValidYmd(e.target.value) && onChange(from > e.target.value ? e.target.value : from, e.target.value)}
          className="rounded-lg border px-3 py-2 text-base"
        />
        <span className="text-sm text-gray-600">{days}日間</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {presets(settings, todayJST()).map((p) => (
          <button
            key={p.label}
            onClick={() => onChange(p.from, p.to)}
            className={`rounded-full border px-3 py-1 text-sm ${p.from === from && p.to === to ? "border-berry bg-berry text-white" : ""}`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}
