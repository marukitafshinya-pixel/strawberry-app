"use client";

// 個人別タイムカード集計表の印刷（1人1枚・A4縦）。card を付けるとその人だけ
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAuth } from "@/lib/auth";
import { reiwa, timecardPay, useEmployees } from "@/lib/payroll";
import { cardsIn, computePerson, employeeForCard, periodMonths, useTimecardConfig, useTimecardMonths } from "@/lib/timecard";
import { TimecardSheet } from "../Sheet";

export default function TimecardPrintPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <PrintView />
    </Suspense>
  );
}

function PrintView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const month = params.get("month") ?? "";
  const only = params.get("card");
  const { value: cfg } = useTimecardConfig();
  const { value: employees } = useEmployees();
  const ok = /^\d{4}-\d{2}$/.test(month);
  const data = useTimecardMonths(ok ? periodMonths(month, cfg?.closeDay ?? 31) : ["2000-01"]);
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!ok) return <p className="text-red-600">月が指定されていません</p>;
  if (!cfg || !data || !employees) return <p className="text-gray-500">読み込み中…</p>;

  const [y, m] = month.split("-").map(Number);
  const title = `${reiwa(y)} ${m}月度分`;
  const cards = only ? [only] : cardsIn(month, data, cfg);
  return (
    <>
      <style>{`@media print { @page { size: A4 portrait; margin: 10mm; } .timecard-sheet { break-after: page; } .timecard-sheet:last-child { break-after: auto; } }`}</style>
      <div className="mb-3 flex items-center gap-2 print:hidden">
        <Link href="/staff/payroll/timecard/" className="text-gray-500 underline">
          ← タイムカード
        </Link>
        <button onClick={() => window.print()} className="ml-auto rounded-lg bg-berry px-4 py-2 font-bold text-white">
          🖨 印刷する（{cards.length}人）
        </button>
      </div>
      <div className="space-y-8 bg-white print:space-y-0">
        {cards.map((c) => {
          const e = employeeForCard(c, cfg, employees);
          const person = computePerson(c, month, data, cfg, { noOvertime: e?.manager });
          return <TimecardSheet key={c} person={person} name={e?.name ?? `（カード${c}）`} title={title} pay={e ? timecardPay(e, person) : null} />;
        })}
      </div>
    </>
  );
}
