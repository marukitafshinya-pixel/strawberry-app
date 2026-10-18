"use client";

// 収穫の実績の「振り返り」タブ：1日を選んで、その日の入力の流れ（ケースの増え方）・ハウスごとの予測とのずれ・
// 入力の遅れや応援などの気づき・気温とハウスの温度を1つの画面で見る
import { useState } from "react";
import { LineChart, Legend, SERIES_COLORS } from "@/components/charts";
import { addDays, formatJa } from "@/lib/date";
import { dayStats, useHouseTemps } from "@/lib/govee";
import { clock, DEFAULT_BREAK, fmtCases, groupOf, useHarvestLog, type HarvestDoc, type HarvestLogRow, type HouseGroup } from "@/lib/harvest";
import type { HarvestDayMeta } from "@/lib/harvestForecast";
import { caseTimeline, minOfDay, reviewHouses, reviewPoints, type Point } from "@/lib/harvestReview";
import type { ShiftMember } from "@/lib/shift";
import { useWeatherMonths } from "@/lib/weather";

const POINT_STYLE: Record<Point["kind"], { icon: string; cls: string }> = {
  late: { icon: "🐢", cls: "border-amber-300 bg-amber-50" },
  early: { icon: "🐇", cls: "border-sky-300 bg-sky-50" },
  help: { icon: "🤝", cls: "border-emerald-300 bg-emerald-50" },
  lag: { icon: "⏰", cls: "border-rose-300 bg-rose-50" },
  bulk: { icon: "📦", cls: "border-rose-300 bg-rose-50" },
  gap: { icon: "⏸", cls: "border-gray-300 bg-gray-50" },
  fix: { icon: "✏️", cls: "border-gray-300 bg-gray-50" },
};

export function ReviewTab({
  data,
  meta,
  houses,
  groups,
  members,
}: {
  data: Record<string, HarvestDoc>;
  meta: Record<string, HarvestDayMeta>;
  houses: string[];
  groups: HouseGroup[];
  members: ShiftMember[];
}) {
  const days = Object.keys(data)
    .filter((d) => Object.values(data[d]).some((h) => h.start != null || (h.cases ?? 0) > 0))
    .sort()
    .reverse();
  const [pick, setPick] = useState<string | null>(null);
  const day = pick && days.includes(pick) ? pick : (days[0] ?? null);
  const log = useHarvestLog(day);
  const weather = useWeatherMonths(day ? addDays(day, -1).slice(0, 7) : "0000-00", day ? day.slice(0, 7) : "0000-00");
  const temps = useHouseTemps(day ?? "0000-00-00", day ?? "0000-00-00");
  if (!day) return <p className="mt-4 text-gray-500">この期間には収穫の記録がありません。</p>;
  const rec = data[day] ?? {};
  const m = meta[day];
  const brk = m?.brk ?? DEFAULT_BREAK;
  const names = new Map(members.map((x) => [x.id, x.name]));
  const nameOf = (id: string) => names.get(id) ?? "？";
  const byUid = new Map(members.filter((x) => x.uid).map((x) => [x.uid!, x.name]));
  const g = (h: string) => groupOf(groups, h);

  const rows = log ? reviewHouses(houses, rec, log, m?.forecastHouses ?? null, brk) : [];
  const points = log ? reviewPoints(rows, nameOf) : [];
  const total = Object.values(rec).reduce((n, h) => n + (h.cases ?? 0), 0);
  const wOf = (d: string) => weather?.find((x) => x.month === d.slice(0, 7))?.days[d.slice(8, 10)];
  const out = wOf(day);
  const sun = wOf(addDays(day, -1))?.sun;
  // ハウスの中の温度：温度計ごとの最低・平均・最高を、温度計の数でならす
  const stats = Object.values(temps?.[day] ?? {})
    .map((l) => dayStats(l))
    .filter((x): x is NonNullable<ReturnType<typeof dayStats>> => !!x);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((n, v) => n + v, 0) / xs.length) * 10) / 10 : null);
  const inMin = mean(stats.map((x) => x.min.temp));
  const inAvg = mean(stats.filter((x) => x.n >= 54).map((x) => x.avg));
  const inMax = mean(stats.filter((x) => x.n >= 54).map((x) => x.max.temp));

  // ケースの増え方（まとまりごと）。色はまとまりの順で固定
  const tl = log ? caseTimeline(log, g) : null;
  const groupNames = [...groups.map((x) => x.name), "その他"].filter((n) => tl?.byGroup[n]);
  const series = groupNames.slice(0, SERIES_COLORS.length).map((n, i) => ({ key: n, label: `まとまり${n}`, color: SERIES_COLORS[i] }));
  const chartRows = (tl?.slots ?? []).map((s, i) => ({
    key: String(s),
    label: clock(s),
    values: Object.fromEntries(series.map((x) => [x.key, tl!.byGroup[x.key][i]])),
  }));
  const taps = (log ?? []).filter((x) => typeof x.delta === "number" && x.delta > 0).length;

  const tile = (label: string, value: React.ReactNode, sub?: React.ReactNode) => (
    <div className="rounded-xl border bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
  const diff = m?.endTime != null && m.forecast != null ? m.endTime - m.forecast : null;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={day} onChange={(e) => setPick(e.target.value)} className="rounded-lg border px-3 py-2">
          {days.map((d) => (
            <option key={d} value={d}>
              {formatJa(d)}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-600">その日の入力の流れから、次の日に生かす点を読み取ります。</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {tile("収穫ケース", fmtCases(total))}
        {tile(
          "収穫終了",
          clock(m?.endTime) || "－",
          m?.forecast != null
            ? `朝の予測 ${clock(m.forecast)}${diff != null ? `（${diff === 0 ? "ぴったり" : diff > 0 ? `${diff}分おそい` : `${-diff}分はやい`}）` : ""}`
            : "朝の予測なし",
        )}
        {tile("夜温（外）", out?.nightMin != null ? `${out.nightMin.toFixed(1)}℃` : "－", sun != null ? `前日の日照 ${sun.toFixed(1)}時間` : undefined)}
        {tile(
          "ハウスの中",
          inMin != null ? `${inMin.toFixed(1)}℃` : "－",
          inMin != null ? `最低の平均。平均 ${inAvg?.toFixed(1) ?? "－"}℃・最高 ${inMax?.toFixed(1) ?? "－"}℃` : undefined,
        )}
        {tile("＋1 を押した回数", log ? taps : "…", log ? `入力の記録 ${log.length}件` : undefined)}
      </div>

      {log === null ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : log.length === 0 ? (
        <p className="mt-4 rounded-xl border bg-white p-4 text-gray-600">
          この日は入力の記録がありません（入力の記録は10月17日から残しています）。ハウスごとの予測と実際は「予測と実際」タブで見られます。
        </p>
      ) : (
        <>
          <section className="mt-4 rounded-xl border bg-white p-3">
            <h2 className="font-bold">気づき（次の日に生かす点）</h2>
            {points.length === 0 ? (
              <p className="mt-2 text-sm text-gray-600">大きなずれや入力の抜けはありませんでした 👍</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {points.map((p, i) => (
                  <li key={i} className={`rounded-lg border px-3 py-2 text-sm ${POINT_STYLE[p.kind].cls}`}>
                    <span className="mr-1">{POINT_STYLE[p.kind].icon}</span>
                    {p.text}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {chartRows.length > 1 && (
            <section className="mt-3 rounded-xl border bg-white p-3">
              <h2 className="font-bold">ケースの増え方（まとまりごと・10分ごと）</h2>
              <div className="mt-1">
                <Legend series={series} />
              </div>
              <LineChart rows={chartRows} series={series} unit="" />
              <p className="text-xs text-gray-500">線がたいらなところは、＋1 が押されていない時間です（休憩・移動・応援・入れ忘れ）。</p>
            </section>
          )}

          <section className="mt-3 overflow-x-auto rounded-xl border bg-white">
            <h2 className="px-3 pt-3 font-bold">ハウスごと</h2>
            <table className="mt-2 w-full min-w-max text-sm tabular-nums">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">ハウス</th>
                  <th className="px-3 py-2">収穫者</th>
                  <th className="px-3 py-2">入った</th>
                  <th className="px-3 py-2">終わった（予測）</th>
                  <th className="px-3 py-2 text-right">終わりの差</th>
                  <th className="px-3 py-2 text-right">ケース</th>
                  <th className="px-3 py-2 text-right">1人1時間</th>
                  <th className="px-3 py-2 text-right">＋1</th>
                  <th className="px-3 py-2">「終わった」の入力</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.house} className="border-t">
                    <td className="px-3 py-1.5 font-bold">No.{r.house}</td>
                    <td className="px-3 py-1.5">
                      {r.members.map(nameOf).join("・")}
                      {r.helpers.length > 0 && <span className="ml-1 text-xs text-emerald-700">＋応援 {r.helpers.map((x) => nameOf(x.id)).join("・")}</span>}
                    </td>
                    <td className="px-3 py-1.5">{clock(r.start) || "－"}</td>
                    <td className="px-3 py-1.5">
                      {clock(r.end) || "－"}
                      {r.fEnd != null && <span className="ml-1 text-xs text-gray-500">（{clock(r.fEnd)}）</span>}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right ${r.endDiff != null && r.endDiff >= 15 ? "text-red-700" : r.endDiff != null && r.endDiff <= -15 ? "text-blue-700" : ""}`}
                    >
                      {r.endDiff == null ? "" : r.endDiff === 0 ? "±0" : `${r.endDiff > 0 ? "+" : "−"}${Math.abs(r.endDiff)}分`}
                    </td>
                    <td className="px-3 py-1.5 text-right">{r.cases ? fmtCases(r.cases) : ""}</td>
                    <td className="px-3 py-1.5 text-right">{r.pace ?? ""}</td>
                    <td className="px-3 py-1.5 text-right">{r.taps || ""}</td>
                    <td className={`px-3 py-1.5 ${r.endLag != null && r.endLag >= 15 ? "text-red-700" : "text-gray-500"}`}>
                      {r.endEnteredAt != null ? `${clock(r.endEnteredAt)}${r.endLag != null && r.endLag > 0 ? `（${r.endLag}分あと）` : ""}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <details className="mt-3 rounded-xl border bg-white p-3">
            <summary className="cursor-pointer font-bold">入力の記録（{log.length}件）</summary>
            <ul className="mt-2 max-h-96 space-y-0.5 overflow-y-auto text-sm tabular-nums">
              {log.map((x) => (
                <li key={x.id} className={x.auto ? "text-gray-400" : ""}>
                  <span className="inline-block w-12">{clock(minOfDay(x.at))}</span>
                  {describe(x, nameOf)}
                  <span className="ml-2 text-xs text-gray-400">{x.auto ? "（自動）" : (byUid.get(x.by) ?? "管理者・スタッフ")}</span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </>
  );
}

/** 入力の記録の1行を文にする */
function describe(x: HarvestLogRow, nameOf: (id: string) => string): string {
  const h = x.house ? `No.${x.house} ` : "";
  if (typeof x.delta === "number") return `${h}${x.delta > 0 ? "＋" : "−"}${Math.abs(x.delta)}`;
  if (typeof x.cases === "number") return `${h}確定数を ${fmtCases(x.cases)} に`;
  if (x.end !== undefined) return `${h}終わった ${clock(x.end) || "（消す）"}`;
  if (x.start !== undefined) return `${h}入った ${clock(x.start) || "（消す）"}`;
  if (x.members) return `${h}収穫者 ${x.members.map(nameOf).join("・") || "（なし）"}`;
  if (x.use) return `${h}使い方を変えた`;
  if (x.dayEnd !== undefined) return `収穫終了 ${clock(x.dayEnd) || "（消す）"}`;
  if (x.break) return `休憩 ${clock(x.break.start)}から${x.break.minutes}分`;
  return h;
}
