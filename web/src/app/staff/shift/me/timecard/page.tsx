"use client";

// 従業員の携帯：自分の個人別タイムカード集計表（月ごと）。印刷もできる（A4横）
import Link from "next/link";
import { useEffect, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { shiftMonth, todayJST } from "@/lib/date";
import { fetchMyTimecard, type MyTimecard } from "@/lib/myPay";
import { reiwa, timecardPay, type Employee } from "@/lib/payroll";
import { DEFAULT_TIMECARD_CONFIG, computePerson, type TimecardConfig } from "@/lib/timecard";
import { TimecardSheet } from "@/app/staff/payroll/timecard/Sheet";

export default function MyTimecardPage() {
  const [month, setMonth] = useState(() => todayJST().slice(0, 7));
  const [state, setState] = useState<{ month: string; v?: MyTimecard; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetchMyTimecard(month)
      .then((v) => alive && setState({ month, v }))
      .catch((e) => alive && setState({ month, error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [month]);
  const cur = state?.month === month ? state : null;
  const [y, m] = month.split("-").map(Number);
  const title = `${reiwa(y)} ${m}月度分`;
  const cfg: TimecardConfig | null = cur?.v ? { ...DEFAULT_TIMECARD_CONFIG, ...cur.v.rules, cards: {} } : null;
  const person = cur?.v?.card && cfg ? computePerson(cur.v.card, month, cur.v.data, cfg, { noOvertime: cur.v.manager }) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-3 pb-10">
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } }`}</style>
      <div className="flex items-center justify-between print:hidden">
        <Link href="/staff/shift/me/" className="text-sm text-gray-600 underline">
          ← 勤務の画面
        </Link>
        <Link href="/staff/shift/me/payslip/" className="text-sm text-gray-600 underline">
          💴 給与明細
        </Link>
      </div>
      <h1 className="text-xl font-bold print:hidden">🕒 タイムカード</h1>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="min-w-32 text-center font-bold">{title}</span>
        <button
          onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={month >= todayJST().slice(0, 7)}
          className="rounded-lg border bg-white px-3 py-2 disabled:opacity-30"
        >
          次月 ›
        </button>
        {person && (
          <button onClick={() => window.print()} className="ml-auto rounded-lg bg-berry px-4 py-2 font-bold text-white">
            🖨 印刷
          </button>
        )}
      </div>
      {!cur ? (
        <p className="text-gray-500">読み込み中…</p>
      ) : cur.error ? (
        <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{cur.error}</p>
      ) : !person ? (
        <p className="rounded-xl bg-white p-4 text-gray-600">この月のタイムカードはありません。</p>
      ) : (
        <>
          <p className={`rounded-lg px-3 py-2 text-sm print:hidden ${cur.v!.locked ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>
            {cur.v!.locked ? "🔒 この月は確定しています。" : "まだ確定していません。打刻もれなどは、あとで管理者が直すことがあります。"}
          </p>
          <div className="overflow-x-auto rounded-xl bg-white p-2 print:overflow-visible print:p-0">
            <TimecardSheet
              person={person}
              name={cur.v!.name}
              title={title}
              // 時給・時間内・時間外・基本給・交通費・合計（時給か日額の交通費がある人だけ）
              pay={timecardPay({ ...(cur.v!.pay ?? {}) } as Employee, person)}
            />
          </div>
        </>
      )}
    </div>
  );
}
