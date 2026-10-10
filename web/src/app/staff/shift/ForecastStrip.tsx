"use client";

// 作業配置表の下に出す天気予報：今日と明日を、時間帯ごとに横一列で（天気・気温・降水確率・風）
import { todayJST, addDays } from "@/lib/date";
import { useForecast, weatherIcon, type Forecast } from "@/lib/forecast";

const hourOf = (iso: string) => Number(iso.slice(11, 13));
const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

/** その時刻を含む6時間の降水確率 */
function popAt(f: Forecast, iso: string): number | null {
  const t = Date.parse(iso);
  const p = f.pops.find((x) => {
    const s = Date.parse(x.time);
    return t >= s && t < s + 6 * 3600_000;
  });
  return p?.pop ?? null;
}

export function ForecastStrip({ big }: { big?: boolean }) {
  const { data, error } = useForecast();
  const today = todayJST();
  const tomorrow = addDays(today, 1);
  const wrap = `mt-3 overflow-x-auto rounded-xl border-2 border-sky-700 bg-white ${big ? "text-lg" : "text-sm"}`;
  if (!data) return <div className={`${wrap} p-3 text-gray-500`}>{error || "天気予報を読み込み中…"}</div>;

  const slots = data.slots.filter((s) => s.time.startsWith(today) || s.time.startsWith(tomorrow));
  const head = `whitespace-nowrap border-r border-gray-300 bg-sky-50 px-2 text-left font-bold ${big ? "py-1.5" : "py-1"}`;
  const cell = `whitespace-nowrap border-r border-gray-200 px-1 text-center tabular-nums leading-tight ${big ? "py-1" : "py-1"}`;
  const credit = (
    <p className={`px-2 pb-1 text-gray-500 ${big ? "text-sm" : "text-[11px]"}`}>
      出典：気象庁（{data.area}の予報・気温は{data.tempPoint}）
      {data.fetchedAt && `　${data.fetchedAt.toDate().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 取得`}
    </p>
  );

  // 3時間ごとの予報が読めなかったときは、1日ごとの天気と6時間ごとの降水確率で出す
  if (slots.length === 0) {
    const days = data.days.filter((d) => d.date === today || d.date === tomorrow);
    return (
      <div className={wrap}>
        <table className="w-full border-collapse">
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-b border-gray-200">
                <th className={head}>{d.date === today ? "今日" : "明日"} {md(d.date)}</th>
                <td className="px-2">
                  {weatherIcon(d.weatherCode, d.weather)} {d.weather}
                </td>
                <td className="px-2 text-gray-600">{d.wind}</td>
                <td className="px-2">
                  降水確率{" "}
                  {data.pops
                    .filter((p) => p.time.startsWith(d.date))
                    .map((p) => `${hourOf(p.time)}時 ${p.pop ?? "－"}%`)
                    .join("　")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {credit}
      </div>
    );
  }

  const byDay = [today, tomorrow].map((d) => ({ d, list: slots.filter((s) => s.time.startsWith(d)) })).filter((x) => x.list.length > 0);
  return (
    <div className={wrap}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-gray-300">
            <th className={head}>天気予報</th>
            {byDay.map(({ d, list }) => (
              <th key={d} colSpan={list.length} className={`border-r-2 border-sky-700 bg-sky-700 px-2 py-1 text-center font-bold text-white`}>
                {d === today ? "今日" : "明日"} {md(d)}
              </th>
            ))}
          </tr>
          <tr className="border-b border-gray-300">
            <th className={head}>時刻</th>
            {byDay.flatMap(({ list }) =>
              list.map((s, i) => (
                <th key={s.time} className={`${cell} font-bold ${i === list.length - 1 ? "border-r-2 border-r-sky-700" : ""}`}>
                  {hourOf(s.time)}時
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["天気", (s) => <span className={big ? "text-3xl" : "text-xl"} title={s.weather ?? ""}>{weatherIcon(s.weatherCode, s.weather) || s.weather || "－"}</span>],
              ["気温", (s) => (s.temp === null ? "－" : <b>{s.temp}℃</b>)],
              [
                "降水確率",
                (s) => {
                  const p = popAt(data, s.time);
                  return p === null ? "－" : <span className={p >= 50 ? "font-bold text-sky-700" : ""}>{p}%</span>;
                },
              ],
              [
                "風",
                (s) =>
                  s.windDir ? (
                    <>
                      {s.windDir}
                      {s.windSpeed !== null && <span className="block text-[0.8em] text-gray-600">{s.windSpeed}m/s</span>}
                    </>
                  ) : (
                    "－"
                  ),
              ],
            ] as [string, (s: (typeof slots)[number]) => React.ReactNode][]
          ).map(([label, f]) => (
            <tr key={label} className="border-b border-gray-200">
              <th className={head}>{label}</th>
              {byDay.flatMap(({ list }) =>
                list.map((s, i) => (
                  <td key={s.time} className={`${cell} ${i === list.length - 1 ? "border-r-2 border-r-sky-700" : ""}`}>
                    {f(s)}
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {credit}
    </div>
  );
}
