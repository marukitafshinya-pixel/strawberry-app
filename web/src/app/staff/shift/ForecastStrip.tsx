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

/** 作業配置表の日（当日）と次の日を、同じ時間帯の表で出す。3時間ごとの予報がまだない時間は、1日ごとの予報（天気・降水確率）で埋める（灰色） */
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
  /** 3時間ごとの予報が出ているいちばん先の時刻 */
  const lastSlot = data.slots.length ? data.slots[data.slots.length - 1].time : null;
  const credit = (
    <p className={`px-2 pb-1 text-gray-500 ${big ? "text-sm" : "text-[11px]"}`}>
      出典：気象庁（3時間ごとの予報は{data.slotsSource ?? `${data.area}・気温は${data.tempPoint}`}
      {lastSlot && `、${md(lastSlot.slice(0, 10))} ${hourOf(lastSlot)}時の分まで`}）
      {data.fetchedAt && `　${data.fetchedAt.toDate().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 取得`}
    </p>
  );
  type Slot = Forecast["slots"][number];
  /** 表の1列：3時間ごとの予報があればその予報、まだなければ1日ごとの予報で埋める（fill） */
  type Col = { time: string; slot: Slot | null };
  const TIMES = [0, 3, 6, 9, 12, 15, 18, 21];
  const byDay = [first, second].map((d) => {
    const list = data.slots.filter((s) => s.time.startsWith(d));
    // 今日はこれからの時間だけ。ほかの日は 0時〜21時をそろえて出す
    const cols: Col[] =
      d === today && list.length
        ? list.map((s) => ({ time: s.time, slot: s }))
        : TIMES.map((h) => {
            const time = `${d}T${String(h).padStart(2, "0")}:00:00+09:00`;
            return { time, slot: list.find((s) => Date.parse(s.time) === Date.parse(time)) ?? null };
          });
    return { d, cols, day: data.days.find((x) => x.date === d) ?? null, week: data.weekly?.find((x) => x.date === d) ?? null };
  });
  const fillCell = `${cell} bg-gray-50 text-gray-500`;
  const rows: [string, (s: Slot) => React.ReactNode, (x: (typeof byDay)[number], c: Col) => React.ReactNode][] = [
    [
      "天気",
      (s) => (
        <span className={big ? "text-3xl" : "text-xl"} title={s.weather ?? ""}>
          {weatherIcon(s.weatherCode, s.weather) || s.weather || "－"}
        </span>
      ),
      (x) => (
        <span className={big ? "text-3xl" : "text-xl"} title={x.day?.weather ?? ""}>
          {weatherIcon(x.day?.weatherCode ?? x.week?.weatherCode ?? null, x.day?.weather ?? null) || "－"}
        </span>
      ),
    ],
    ["気温", (s) => (s.temp === null ? "－" : <b>{s.temp}℃</b>), () => "－"],
    [
      "降水確率",
      (s) => {
        const p = popAt(data, s.time);
        return p === null ? "－" : <span className={p >= 50 ? "font-bold text-sky-700" : ""}>{p}%</span>;
      },
      (x, c) => {
        const p = popAt(data, c.time) ?? x.week?.pop ?? null;
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
      () => "－",
    ],
  ];
  /** 1日ごとの予報で埋めた時間がある日は、見出しにその日の最高・最低（週間予報）と風を出す */
  const filled = (x: (typeof byDay)[number]) => x.cols.some((c) => !c.slot);
  const anyFilled = byDay.some(filled);
  return (
    <div className={wrap}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-gray-300">
            <th className={head}>天気予報</th>
            {byDay.map((x) => (
              <th key={x.d} colSpan={x.cols.length} className="border-r-2 border-sky-700 bg-sky-700 px-2 py-1 text-center font-bold text-white">
                {label(x.d)} {md(x.d)}
                {filled(x) && (x.week?.tempMax != null || x.week?.tempMin != null) && (
                  <span className="ml-2 font-normal">
                    {x.week?.tempMax != null && <>最高 {x.week.tempMax}℃ </>}
                    {x.week?.tempMin != null && <>最低 {x.week.tempMin}℃</>}
                  </span>
                )}
                {filled(x) && x.day?.wind && <span className="ml-2 text-[0.85em] font-normal">{x.day.wind}</span>}
              </th>
            ))}
          </tr>
          <tr className="border-b border-gray-300">
            <th className={head}>時刻</th>
            {byDay.flatMap((x) =>
              x.cols.map((c, i) => (
                <th key={c.time} className={`${c.slot ? cell : fillCell} font-bold ${i === x.cols.length - 1 ? "border-r-2 border-r-sky-700" : ""}`}>
                  {hourOf(c.time)}時
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, f, g]) => (
            <tr key={name} className="border-b border-gray-200">
              <th className={head}>{name}</th>
              {byDay.flatMap((x) =>
                x.cols.map((c, i) => (
                  <td key={c.time} className={`${c.slot ? cell : fillCell} ${i === x.cols.length - 1 ? "border-r-2 border-r-sky-700" : ""}`}>
                    {c.slot ? f(c.slot) : g(x, c)}
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {anyFilled && (
        <p className={`px-2 pt-1 text-gray-500 ${big ? "text-sm" : "text-[11px]"}`}>
          灰色の時間は、3時間ごとの予報がまだ出ていないので、1日ごとの予報（天気・6時間ごとの降水確率）で出しています。気温はその日の最高・最低（週間予報）を見出しに出しています。
        </p>
      )}
      {credit}
    </div>
  );
}
