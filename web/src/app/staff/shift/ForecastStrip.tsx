"use client";

// 作業配置表の下に出す天気予報：作業配置表の日（当日）と次の日を、時間帯ごとに横一列で（天気・気温・降水確率・風）
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

/** 作業配置表の日（当日）と次の日。3時間ごとの予報がある日は時間帯ごとに、まだない日は1日ごとの予報（天気・風・降水確率）で出す */
export function ForecastStrip({ big, date }: { big?: boolean; date?: string }) {
  const { data, error } = useForecast();
  const today = todayJST();
  const first = date ?? today;
  const second = addDays(first, 1);
  const wrap = `mt-3 overflow-x-auto rounded-xl border-2 border-sky-700 bg-white ${big ? "text-lg" : "text-sm"}`;
  if (!data) return <div className={`${wrap} p-3 text-gray-500`}>{error || "天気予報を読み込み中…"}</div>;

  /** 見出し：今日・明日・明後日（それより先は日付だけ） */
  const label = (d: string) => (d === today ? "今日" : d === addDays(today, 1) ? "明日" : d === addDays(today, 2) ? "明後日" : "");
  const head = `whitespace-nowrap border-r border-gray-300 bg-sky-50 px-2 text-left font-bold ${big ? "py-1.5" : "py-1"}`;
  const cell = `whitespace-nowrap border-r border-gray-200 px-1 text-center tabular-nums leading-tight ${big ? "py-1" : "py-1"}`;
  const credit = (
    <p className={`px-2 pb-1 text-gray-500 ${big ? "text-sm" : "text-[11px]"}`}>
      出典：気象庁（{data.area}の予報・気温は{data.tempPoint}）
      {data.fetchedAt && `　${data.fetchedAt.toDate().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 取得`}
    </p>
  );
  type Slot = Forecast["slots"][number];
  /** 日ごとの列：3時間ごとの予報があればその時刻、なければ1日ごとの予報の1列 */
  const byDay = [first, second]
    .map((d) => ({ d, list: data.slots.filter((s) => s.time.startsWith(d)), day: data.days.find((x) => x.date === d) ?? null }))
    .filter((x) => x.list.length > 0 || x.day);
  if (byDay.length === 0) return <div className={`${wrap} p-3 text-gray-500`}>この日の天気予報はまだ出ていません。</div>;
  const dayPops = (d: string) =>
    data.pops
      .filter((p) => p.time.startsWith(d))
      .map((p) => `${hourOf(p.time)}時 ${p.pop ?? "－"}%`)
      .join(" ");
  const rows: [string, (s: Slot) => React.ReactNode, (d: (typeof byDay)[number]) => React.ReactNode][] = [
    [
      "天気",
      (s) => (
        <span className={big ? "text-3xl" : "text-xl"} title={s.weather ?? ""}>
          {weatherIcon(s.weatherCode, s.weather) || s.weather || "－"}
        </span>
      ),
      (x) => (
        <>
          <span className={big ? "text-3xl" : "text-xl"}>{weatherIcon(x.day?.weatherCode ?? null, x.day?.weather ?? null)}</span>
          <span className="block text-[0.8em] whitespace-normal">{x.day?.weather}</span>
        </>
      ),
    ],
    ["気温", (s) => (s.temp === null ? "－" : <b>{s.temp}℃</b>), () => "－"],
    [
      "降水確率",
      (s) => {
        const p = popAt(data, s.time);
        return p === null ? "－" : <span className={p >= 50 ? "font-bold text-sky-700" : ""}>{p}%</span>;
      },
      (x) => dayPops(x.d) || "－",
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
      (x) => <span className="text-[0.85em] whitespace-normal">{x.day?.wind ?? "－"}</span>,
    ],
  ];
  return (
    <div className={wrap}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-gray-300">
            <th className={head}>天気予報</th>
            {byDay.map(({ d, list }) => (
              <th key={d} colSpan={Math.max(1, list.length)} className="border-r-2 border-sky-700 bg-sky-700 px-2 py-1 text-center font-bold text-white">
                {label(d)} {md(d)}
              </th>
            ))}
          </tr>
          <tr className="border-b border-gray-300">
            <th className={head}>時刻</th>
            {byDay.flatMap(({ d, list }) =>
              list.length
                ? list.map((s, i) => (
                    <th key={s.time} className={`${cell} font-bold ${i === list.length - 1 ? "border-r-2 border-r-sky-700" : ""}`}>
                      {hourOf(s.time)}時
                    </th>
                  ))
                : [
                    <th key={d} className={`${cell} border-r-2 border-r-sky-700 font-bold`}>
                      1日
                    </th>,
                  ],
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, f, g]) => (
            <tr key={name} className="border-b border-gray-200">
              <th className={head}>{name}</th>
              {byDay.flatMap((x) =>
                x.list.length
                  ? x.list.map((s, i) => (
                      <td key={s.time} className={`${cell} ${i === x.list.length - 1 ? "border-r-2 border-r-sky-700" : ""}`}>
                        {f(s)}
                      </td>
                    ))
                  : [
                      <td key={x.d} className={`${cell} min-w-32 border-r-2 border-r-sky-700`}>
                        {g(x)}
                      </td>,
                    ],
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {credit}
    </div>
  );
}
