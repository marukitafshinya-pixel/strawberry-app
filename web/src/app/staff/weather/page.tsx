"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { shiftMonth, todayJST } from "@/lib/date";
import { WEATHER_ITEMS, WEATHER_STATION_NAME, aggregate, jmaPageUrl, useWeatherMonths, type WeatherMonth } from "@/lib/weather";

/** まとめて取り込むときの、はじめの月 */
const IMPORT_FROM = "2025-01";
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const fmt = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString("ja-JP", { maximumFractionDigits: 1 }) : "");

export default function WeatherPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <WeatherView />
    </Suspense>
  );
}

function WeatherView() {
  const params = useSearchParams();
  const router = useRouter();
  const thisMonth = todayJST().slice(0, 7);
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : thisMonth;
  const view = params.get("view") === "year" ? "year" : "day";
  const go = (m: string, v = view) => router.replace(`/staff/weather/?month=${m}${v === "year" ? "&view=year" : ""}`);
  const [y, m] = month.split("-").map(Number);
  // 年の一覧と、まとめて取り込むときの「まだない月」を出すため、取り込む範囲と表示中の年を読む
  const from = [IMPORT_FROM, `${y}-01`].sort()[0];
  const to = [thisMonth, `${y}-12`].sort().at(-1)!;
  const months = useWeatherMonths(from, to);

  return (
    <div>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">気象データ（{WEATHER_STATION_NAME}）</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border">
          {(
            [
              ["day", "日ごと"],
              ["year", "月ごと（1年）"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => go(month, v)} className={`px-3 py-2 text-sm ${view === v ? "bg-berry font-bold text-white" : "bg-white"}`}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={() => go(view === "year" ? `${y - 1}-${String(m).padStart(2, "0")}` : shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ {view === "year" ? "前の年" : "前月"}
        </button>
        <span className="text-lg font-bold">{view === "year" ? `${y}年` : `${y}年${m}月`}</span>
        <button onClick={() => go(view === "year" ? `${y + 1}-${String(m).padStart(2, "0")}` : shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          {view === "year" ? "次の年" : "翌月"} ›
        </button>
        {month !== thisMonth && (
          <button onClick={() => go(thisMonth)} className="rounded-lg border bg-white px-3 py-2 text-sm">
            今月
          </button>
        )}
      </div>

      {!months ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <>
          {view === "day" ? <DayTable month={month} data={months.find((x) => x.month === month)} /> : <YearTable year={y} months={months} onPick={(mm) => go(mm, "day")} />}
          <Importer month={month} months={months} thisMonth={thisMonth} />
        </>
      )}
      <p className="mt-4 text-xs text-gray-500">
        出典：気象庁ホームページ「過去の気象データ検索」（アメダス {WEATHER_STATION_NAME}）。
        <a href={jmaPageUrl(y, m)} target="_blank" rel="noreferrer" className="ml-1 underline">
          {y}年{m}月の気象庁のページ
        </a>
      </p>
    </div>
  );
}

function DayTable({ month, data }: { month: string; data?: WeatherMonth }) {
  if (!data || Object.keys(data.days).length === 0)
    return <p className="mt-4 rounded-xl bg-white p-4 text-gray-600">この月の気象データはまだありません。下の「気象庁から取り込む」で取り込んでください。</p>;
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, "0"));
  return (
    <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
      <table className="w-full min-w-max text-sm tabular-nums">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left">日</th>
            {WEATHER_ITEMS.map((it) => (
              <th key={it.key} className="px-2 py-2 text-right">
                {it.label}
                <span className="block font-normal">（{it.unit}）</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const v = data.days[d];
            const wd = new Date(Date.UTC(y, m - 1, Number(d))).getUTCDay();
            const tone = wd === 0 ? "text-red-600" : wd === 6 ? "text-sky-700" : "";
            return (
              <tr key={d} className="border-t">
                <th className={`sticky left-0 z-10 bg-white px-3 py-1 text-left font-normal ${tone}`}>
                  {Number(d)}日（{WD[wd]}）
                </th>
                {WEATHER_ITEMS.map((it) => (
                  <td key={it.key} className={`px-2 py-1 text-right ${it.key === "precip" && (v?.precip ?? 0) >= 10 ? "font-bold text-sky-700" : ""} ${it.key === "tMax" && (v?.tMax ?? 0) >= 30 ? "font-bold text-red-600" : ""}`}>
                    {fmt(v?.[it.key])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 bg-gray-50 font-bold">
          <tr>
            <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left">月の値</th>
            {WEATHER_ITEMS.map((it) => (
              <td key={it.key} className="px-2 py-2 text-right">
                {fmt(aggregate(days.map((d) => data.days[d]?.[it.key]), it.agg))}
                <span className="block text-[10px] font-normal text-gray-500">{it.agg === "sum" ? "合計" : it.agg === "avg" ? "平均" : it.agg === "max" ? "最大" : "最小"}</span>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function YearTable({ year, months, onPick }: { year: number; months: WeatherMonth[]; onPick: (m: string) => void }) {
  const list = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  return (
    <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
      <table className="w-full min-w-max text-sm tabular-nums">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-3 py-2 text-left">月</th>
            {WEATHER_ITEMS.map((it) => (
              <th key={it.key} className="px-2 py-2 text-right">
                {it.label}
                <span className="block font-normal">
                  （{it.unit}・{it.agg === "sum" ? "合計" : it.agg === "avg" ? "平均" : it.agg === "max" ? "最大" : "最小"}）
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((ym) => {
            const data = months.find((x) => x.month === ym);
            const vals = Object.values(data?.days ?? {});
            return (
              <tr key={ym} className="border-t">
                <th className="px-3 py-1.5 text-left font-normal">
                  <button onClick={() => onPick(ym)} className="text-sky-700 underline">
                    {Number(ym.slice(5))}月
                  </button>
                  {!data && <span className="ml-1 text-[10px] text-gray-400">まだなし</span>}
                </th>
                {WEATHER_ITEMS.map((it) => (
                  <td key={it.key} className="px-2 py-1.5 text-right">
                    {fmt(aggregate(vals.map((v) => v[it.key]), it.agg))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 気象庁から取り込む：この月だけ、または 2025年1月から今月までのまだない月をまとめて */
function Importer({ month, months, thisMonth }: { month: string; months: WeatherMonth[]; thisMonth: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const all: string[] = [];
  for (let m = IMPORT_FROM; m <= thisMonth; m = shiftMonth(m, 1)) all.push(m);
  const have = new Set(months.filter((x) => Object.keys(x.days).length > 0).map((x) => x.month));
  // まだない月と、今月・先月（日々ふえるので取り直す）
  const need = all.filter((m) => !have.has(m) || m >= shiftMonth(thisMonth, -1));
  const cur = months.find((x) => x.month === month);

  async function run(list: string[]) {
    setErr("");
    setBusy(true);
    try {
      for (let i = 0; i < list.length; i++) {
        const [y, m] = list[i].split("-").map(Number);
        setMsg(`${y}年${m}月を取り込み中…（${i + 1}/${list.length}）`);
        await callFunction("importWeatherMonth", { year: y, month: m }, 90_000);
        // 気象庁のサイトに負担をかけないよう、少し間をあける
        if (i < list.length - 1) await new Promise((r) => setTimeout(r, 1500));
      }
      setMsg(`${list.length}か月分を取り込みました`);
    } catch (e) {
      setErr(errorText(e));
      setMsg("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">気象庁から取り込む</h2>
      <p className="mt-1 text-xs text-gray-500">
        気象庁のページから、日ごとの値を月ごとに取り込みます。気象庁の値は確定まで少しかかるので、今月と先月は取り込み直すと新しい値になります。
        {cur?.fetchedAt && <span className="ml-1">この月を取り込んだ日時：{cur.fetchedAt.toDate().toLocaleString("ja-JP")}</span>}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => run([month])} disabled={busy || month > thisMonth} className="rounded-lg border border-berry px-4 py-2 text-sm font-bold text-berry disabled:opacity-40">
          この月を取り込む（取り直す）
        </button>
        <button onClick={() => run(need)} disabled={busy || need.length === 0} className="rounded-lg bg-berry px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
          2025年1月〜今月で、まだの月をまとめて取り込む（{need.length}か月）
        </button>
      </div>
      {msg && <p className="mt-2 text-sm text-gray-700">{msg}</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}
