"use client";

import { addDays, shiftMonth, todayJST } from "@/lib/date";
import { countsTowardCapacity, useReservationsRange } from "@/lib/reservations";
import type { Settings } from "@/lib/settings";

/** 月のカレンダー。1日ごとの合計人数を出し、押すとその日の予約一覧を開く */
export function ReservationCalendar({
  month,
  selected,
  settings,
  onMonth,
  onPick,
}: {
  month: string;
  selected: string;
  settings: Settings;
  onMonth: (ym: string) => void;
  onPick: (ymd: string) => void;
}) {
  const first = `${month}-01`;
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const { value: reservations, error } = useReservationsRange(first, last);
  const today = todayJST();

  // 日ごとの合計（キャンセルとリクエストは数えない。リクエストは別に件数を出す）
  const byDay = new Map<
    string,
    { people: number; count: number; requests: number }
  >();
  for (const r of reservations ?? []) {
    const d = byDay.get(r.date) ?? { people: 0, count: 0, requests: 0 };
    if (countsTowardCapacity(r.status)) {
      d.people += r.people;
      d.count += 1;
    } else if (r.status === "request") d.requests += 1;
    byDay.set(r.date, d);
  }
  const monthPeople = [...byDay.values()].reduce((n, d) => n + d.people, 0);

  // 日曜はじまり。前の月の分は空白で埋める
  const [y, m] = month.split("-").map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = Number(last.slice(8));
  const cells: (string | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: days }, (_, i) => addDays(first, i)),
  ];
  while (cells.length % 7) cells.push(null);

  const closedOrOff = (ymd: string) => {
    const md = ymd.slice(5);
    const inSeason =
      settings.seasonStart <= settings.seasonEnd
        ? md >= settings.seasonStart && md <= settings.seasonEnd
        : md >= settings.seasonStart || md <= settings.seasonEnd;
    return !inSeason || settings.closedDates.includes(ymd);
  };

  return (
    <div className="mt-4 rounded-2xl bg-white p-3 shadow-sm print:mt-0 print:p-0 print:shadow-none">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onMonth(shiftMonth(month, -1))}
          className="rounded-lg border px-3 py-2 print:hidden"
        >
          ‹ 前の月
        </button>
        <h2 className="text-lg font-bold">
          {y}年{m}月
        </h2>
        <button
          onClick={() => onMonth(shiftMonth(month, 1))}
          className="rounded-lg border px-3 py-2 print:hidden"
        >
          次の月 ›
        </button>
        {month !== today.slice(0, 7) && (
          <button
            onClick={() => onMonth(today.slice(0, 7))}
            className="rounded-lg border px-3 py-2 print:hidden"
          >
            今月
          </button>
        )}
        <span className="ml-auto text-sm text-gray-600">
          {reservations
            ? `この月の合計 ${monthPeople.toLocaleString("ja-JP")}人`
            : "読み込み中…"}
        </span>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-red-600">読み込めませんでした</p>
      ) : null}

      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs font-semibold">
        {"日月火水木金土".split("").map((w, i) => (
          <div
            key={w}
            className={
              i === 0
                ? "text-red-600"
                : i === 6
                  ? "text-sky-700"
                  : "text-gray-600"
            }
          >
            {w}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((ymd, i) => {
          if (!ymd) return <div key={`e${i}`} />;
          const d = byDay.get(ymd);
          const dow = i % 7;
          const off = closedOrOff(ymd);
          return (
            <button
              key={ymd}
              onClick={() => onPick(ymd)}
              className={`flex min-h-16 flex-col items-center rounded-lg border p-1 sm:min-h-20 ${
                ymd === selected ? "border-berry ring-2 ring-berry" : ""
              } ${off ? "bg-gray-50" : "bg-white"} ${ymd === today ? "border-berry" : ""}`}
            >
              <span
                className={`text-xs ${dow === 0 ? "text-red-600" : dow === 6 ? "text-sky-700" : "text-gray-700"} ${ymd === today ? "font-bold" : ""}`}
              >
                {Number(ymd.slice(8))}
              </span>
              {d && d.people > 0 ? (
                <span className="mt-auto text-base font-bold text-berry-dark sm:text-lg">
                  {d.people}
                  <span className="text-xs font-normal">人</span>
                </span>
              ) : (
                <span className="mt-auto text-xs text-gray-300">
                  {off ? "休" : "－"}
                </span>
              )}
              {d && d.requests > 0 && (
                <span className="rounded bg-purple-100 px-1 text-[10px] text-purple-800">
                  リク{d.requests}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-gray-500 print:hidden">
        数字はその日の予約の合計人数です（キャンセルとリクエストは入れていません）。日付を押すと、その日の予約一覧を開きます。
      </p>
    </div>
  );
}
