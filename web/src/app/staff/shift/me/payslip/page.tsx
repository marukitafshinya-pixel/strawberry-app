"use client";

// 従業員の携帯：自分の給与明細（公開された月だけ）。月の切り替えと、年間累計（支給日が1月〜12月の分）。印刷もできる（A4縦）
import Link from "next/link";
import { useEffect, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { fetchMyPayslips, fetchMyTimecard, type MyPayslips, type MySlip } from "@/lib/myPay";
import { PAY_ITEMS, computeRow, reiwa, type PayKey } from "@/lib/payroll";
import { DEFAULT_TIMECARD_CONFIG, computePerson, hm } from "@/lib/timecard";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const monthLabel = (ym: string) => `${reiwa(Number(ym.slice(0, 4)))} ${Number(ym.slice(5))}月度分`;
const dateLabel = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8))}日` : d);
/** 年間累計に数える年：支給日の年（支給日がなければ月度の年） */
const yearOf = (s: MySlip) => (s.paymentDate.slice(0, 4) || s.month.slice(0, 4)).slice(0, 4);
const pay = PAY_ITEMS.filter((i) => i.group === "pay");
const social = PAY_ITEMS.filter((i) => i.group === "social");
const tax = PAY_ITEMS.filter((i) => i.group === "tax");

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
                <span className="flex-1 text-center font-bold">{monthLabel(slip.month)}</span>
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

function Head({ title, sub, me }: { title: string; sub: string; me: MyPayslips }) {
  return (
    <div className="mb-3 border-b-2 border-gray-800 pb-2">
      <h2 className="text-center text-xl font-bold tracking-widest">{title}</h2>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2 text-sm">
        <span>{sub}</span>
        <span className="text-base font-bold">
          {me.code && <span className="mr-2 text-sm font-normal text-gray-600">{me.code}</span>}
          {me.name} 様
        </span>
      </div>
      {me.company && <p className="mt-1 text-right text-xs text-gray-600">{me.company}</p>}
    </div>
  );
}

const box =
  "w-full border-collapse text-sm tabular-nums [&_td]:border [&_td]:border-gray-400 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-400 [&_th]:bg-gray-100 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-normal";

function Lines({
  title,
  items,
  row,
  total,
  totalLabel,
}: {
  title: string;
  items: readonly { key: PayKey; label: string }[];
  row: Partial<Record<PayKey, number>>;
  total?: number;
  totalLabel?: string;
}) {
  const shown = items.filter((i) => row[i.key]);
  return (
    <table className={`${box} mt-3`}>
      <thead>
        <tr>
          <th colSpan={2} className="!bg-gray-200 !font-bold">
            {title}
          </th>
        </tr>
      </thead>
      <tbody>
        {shown.length === 0 && (
          <tr>
            <td colSpan={2} className="text-gray-400">
              なし
            </td>
          </tr>
        )}
        {shown.map((i) => (
          <tr key={i.key}>
            <th className="w-1/2">{i.label}</th>
            <td className="text-right">{yen(row[i.key] ?? 0)}</td>
          </tr>
        ))}
        {totalLabel && (
          <tr className="font-bold">
            <th className="!font-bold">{totalLabel}</th>
            <td className="text-right">{yen(total ?? 0)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 1か月分の給与明細（勤怠はタイムカードから） */
function Slip({ slip, me }: { slip: MySlip; me: MyPayslips }) {
  const [work, setWork] = useState<{ days: number; work: number; over: number } | null>(null);
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
  const t = computeRow(slip.row);
  const deduct = t.social + (slip.row.incomeTax ?? 0) + (slip.row.residentTax ?? 0) - (slip.row.yearEnd ?? 0);
  return (
    <section className="rounded-xl bg-white p-4 shadow-sm print:p-0 print:shadow-none">
      <Head title="給与明細書" sub={`${monthLabel(slip.month)}　支給日 ${dateLabel(slip.paymentDate) || "－"}`} me={me} />
      {work && (
        <table className={box}>
          <tbody>
            <tr>
              <th>出勤日数</th>
              <td className="text-right">{work.days}日</td>
              <th>労働時間</th>
              <td className="text-right">{hm(work.work)}</td>
              <th>うち残業</th>
              <td className="text-right">{work.over ? hm(work.over) : "－"}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="sm:grid sm:grid-cols-2 sm:gap-3 print:grid print:grid-cols-2 print:gap-3">
        <Lines title="支給" items={pay} row={slip.row} totalLabel="支給合計" total={t.pay} />
        <div>
          <Lines title="控除（社会保険）" items={social} row={slip.row} totalLabel="社会保険料計" total={t.social} />
          <Lines title="控除（税金など）" items={tax} row={slip.row} />
        </div>
      </div>
      <table className={`${box} mt-3`}>
        <tbody>
          <tr>
            <th>控除合計</th>
            <td className="text-right">{yen(deduct)}</td>
          </tr>
          <tr className="text-lg font-bold">
            <th className="!font-bold">差引支給額</th>
            <td className="text-right">{yen(t.net)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** 年間累計：その年に支給された月の合計と、月ごとの一覧 */
function YearTotal({ year, slips, me }: { year: string; slips: MySlip[]; me: MyPayslips }) {
  const sum = (k: PayKey) => slips.reduce((a, s) => a + (s.row[k] ?? 0), 0);
  const total = Object.fromEntries(PAY_ITEMS.map((i) => [i.key, sum(i.key)])) as Partial<Record<PayKey, number>>;
  const t = computeRow(total);
  const list = [...slips].sort((a, b) => a.month.localeCompare(b.month));
  return (
    <section className="rounded-xl bg-white p-4 shadow-sm print:p-0 print:shadow-none">
      <Head title="給与 年間累計" sub={`${year}年（支給日が1月〜12月の分・${slips.length}か月）`} me={me} />
      <div className="sm:grid sm:grid-cols-2 sm:gap-3 print:grid print:grid-cols-2 print:gap-3">
        <Lines title="支給" items={pay} row={total} totalLabel="支給合計" total={t.pay} />
        <div>
          <Lines title="控除（社会保険）" items={social} row={total} totalLabel="社会保険料計" total={t.social} />
          <Lines title="控除（税金など）" items={tax} row={total} />
        </div>
      </div>
      <table className={`${box} mt-3`}>
        <tbody>
          <tr className="text-lg font-bold">
            <th className="!font-bold">差引支給額の合計</th>
            <td className="text-right">{yen(t.net)}</td>
          </tr>
        </tbody>
      </table>
      <table className={`${box} mt-3 text-xs`}>
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
                <td>{monthLabel(s.month)}</td>
                <td>{dateLabel(s.paymentDate)}</td>
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
