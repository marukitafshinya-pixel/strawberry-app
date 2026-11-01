"use client";

// 従業員の携帯：自分の給与明細（公開された月だけ）。月の切り替えと、年間累計（支給日が1月〜12月の分）。印刷もできる（A4縦）
import Link from "next/link";
import { useEffect, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { fetchMyPayslips, fetchMyTimecard, type MyPayslips, type MySlip } from "@/lib/myPay";
import { PAY_ITEMS, computeRow, type PayKey } from "@/lib/payroll";
import { DEFAULT_TIMECARD_CONFIG, computePerson } from "@/lib/timecard";
import {
  PAY_LINES,
  PayslipSheet,
  SOCIAL_LINES,
  SlipHead,
  SlipLines,
  TAX_LINES,
  slipBox,
  slipDateLabel,
  slipMonthLabel,
  yen,
  type SlipWork,
} from "@/components/PayslipSheet";

/** 年間累計に数える年：支給日の年（支給日がなければ月度の年） */
const yearOf = (s: MySlip) => (s.paymentDate.slice(0, 4) || s.month.slice(0, 4)).slice(0, 4);

export default function MyPayslipPage() {
  const [data, setData] = useState<MyPayslips | null>(null);
  const [error, setError] = useState("");
  const [at, setAt] = useState(0);
  const [view, setView] = useState<"month" | "year">("month");
  const [year, setYear] = useState<string | null>(null);
  useEffect(() => {
    fetchMyPayslips()
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);

  const slips = data?.slips ?? [];
  const slip = slips[at];
  const years = [...new Set(slips.map(yearOf))].sort().reverse();
  const yr = year ?? years[0] ?? "";

  return (
    <div className="mx-auto max-w-2xl space-y-3 pb-10">
      <style>{`@media print { @page { size: A4 portrait; margin: 12mm; } }`}</style>
      <div className="flex items-center justify-between print:hidden">
        <Link href="/staff/shift/me/" className="text-sm text-gray-600 underline">
          ← 勤務の画面
        </Link>
        <Link href="/staff/shift/me/timecard/" className="text-sm text-gray-600 underline">
          🕒 タイムカード
        </Link>
      </div>
      <h1 className="text-xl font-bold print:hidden">💴 給与明細</h1>
      {error ? (
        <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{error}</p>
      ) : !data ? (
        <p className="text-gray-500">読み込み中…</p>
      ) : slips.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-gray-600">見られる給与明細はまだありません。</p>
      ) : (
        <>
          <div className="flex gap-2 print:hidden">
            {(["month", "year"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex-1 rounded-lg border px-3 py-2 font-bold ${view === v ? "border-berry bg-berry text-white" : "bg-white"}`}
              >
                {v === "month" ? "月ごと" : "年間累計"}
              </button>
            ))}
          </div>
          {view === "month" ? (
            <>
              <div className="flex items-center gap-2 print:hidden">
                <button onClick={() => setAt(at + 1)} disabled={at >= slips.length - 1} className="rounded-lg border bg-white px-3 py-2 disabled:opacity-30">
                  ‹ 前月
                </button>
                <span className="flex-1 text-center font-bold">{slipMonthLabel(slip.month)}</span>
                <button onClick={() => setAt(at - 1)} disabled={at <= 0} className="rounded-lg border bg-white px-3 py-2 disabled:opacity-30">
                  次月 ›
                </button>
              </div>
              <Slip key={slip.month} slip={slip} me={data} />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 print:hidden">
                <span className="text-sm text-gray-600">年（支給日）</span>
                <select value={yr} onChange={(e) => setYear(e.target.value)} className="rounded-lg border px-3 py-2">
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}年
                    </option>
                  ))}
                </select>
              </div>
              <YearTotal year={yr} slips={slips.filter((s) => yearOf(s) === yr)} me={data} />
            </>
          )}
          <button onClick={() => window.print()} className="w-full rounded-lg bg-berry py-3 font-bold text-white print:hidden">
            🖨 印刷
          </button>
        </>
      )}
    </div>
  );
}

/** 1か月分の給与明細（勤怠は本人のタイムカードから） */
function Slip({ slip, me }: { slip: MySlip; me: MyPayslips }) {
  const [work, setWork] = useState<SlipWork | null>(null);
  useEffect(() => {
    let alive = true;
    fetchMyTimecard(slip.month)
      .then((t) => {
        if (!alive || !t.card) return;
        const p = computePerson(t.card, slip.month, t.data, { ...DEFAULT_TIMECARD_CONFIG, ...t.rules, cards: {} }, { noOvertime: t.manager });
        setWork({ days: p.workDays, work: p.work, over: p.over });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slip.month]);
  return <PayslipSheet month={slip.month} paymentDate={slip.paymentDate} row={slip.row} me={me} work={work} />;
}

/** 年間累計：その年に支給された月の合計と、月ごとの一覧 */
function YearTotal({ year, slips, me }: { year: string; slips: MySlip[]; me: MyPayslips }) {
  const sum = (k: PayKey) => slips.reduce((a, s) => a + (s.row[k] ?? 0), 0);
  const total = Object.fromEntries(PAY_ITEMS.map((i) => [i.key, sum(i.key)])) as Partial<Record<PayKey, number>>;
  const t = computeRow(total);
  const list = [...slips].sort((a, b) => a.month.localeCompare(b.month));
  return (
    <section className="rounded-xl bg-white p-4 shadow-sm print:p-0 print:shadow-none">
      <SlipHead title="給与 年間累計" sub={`${year}年（支給日が1月〜12月の分・${slips.length}か月）`} me={me} />
      <div className="sm:grid sm:grid-cols-2 sm:gap-3 print:grid print:grid-cols-2 print:gap-3">
        <SlipLines title="支給" items={PAY_LINES} row={total} totalLabel="支給合計" total={t.pay} />
        <div>
          <SlipLines title="控除（社会保険）" items={SOCIAL_LINES} row={total} totalLabel="社会保険料計" total={t.social} />
          <SlipLines title="控除（税金など）" items={TAX_LINES} row={total} />
        </div>
      </div>
      <table className={`${slipBox} mt-3`}>
        <tbody>
          <tr className="text-lg font-bold">
            <th className="!font-bold">差引支給額の合計</th>
            <td className="text-right">{yen(t.net)}</td>
          </tr>
        </tbody>
      </table>
      <table className={`${slipBox} mt-3 text-xs`}>
        <thead>
          <tr>
            <th>月度</th>
            <th>支給日</th>
            <th className="!text-right">支給合計</th>
            <th className="!text-right">差引支給額</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => {
            const r = computeRow(s.row);
            return (
              <tr key={s.month}>
                <td>{slipMonthLabel(s.month)}</td>
                <td>{slipDateLabel(s.paymentDate)}</td>
                <td className="text-right">{yen(r.pay)}</td>
                <td className="text-right">{yen(r.net)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
