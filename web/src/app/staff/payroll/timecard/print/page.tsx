"use client";

// 個人別タイムカード集計表の印刷（1人1枚・A4縦）。card を付けるとその人だけ。
// blank=1 は記入用の用紙：打刻のない日もすべての日を出し、先月の人（と今月の人）を印刷する（タイムレコーダーを使わない日に、手で書きこむため）
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAuth } from "@/lib/auth";
import { shiftMonth } from "@/lib/date";
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
  const blank = params.get("blank") === "1";
  const { value: cfg } = useTimecardConfig();
  const { value: employees } = useEmployees();
  const ok = /^\d{4}-\d{2}$/.test(month);
  // 記入用の用紙は、先月の人も出すので先月の分も読む
  const months = ok
    ? [...new Set([...(blank ? periodMonths(shiftMonth(month, -1), cfg?.closeDay ?? 31) : []), ...periodMonths(month, cfg?.closeDay ?? 31)])]
    : ["2000-01"];
  const data = useTimecardMonths(months);
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!ok) return <p className="text-red-600">月が指定されていません</p>;
  if (!cfg || !data || !employees) return <p className="text-gray-500">読み込み中…</p>;

  const [y, m] = month.split("-").map(Number);
  const title = `${reiwa(y)} ${m}月度分`;
  const cards = only
    ? [only]
    : blank
      ? // 先月の人と今月の人（役員・在籍していない人は除く）。カード番号の順
        [...new Set([...cardsIn(shiftMonth(month, -1), data, cfg), ...cardsIn(month, data, cfg)])]
          .filter((c) => {
            const e = employeeForCard(c, cfg, employees);
            return !e || (e.active && e.kind !== "officer");
          })
          .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }))
      : cardsIn(month, data, cfg);
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
          return (
            <TimecardSheet
              key={c}
              person={person}
              name={e?.name ?? `（カード${c}）`}
              title={title}
              pay={e && !blank ? timecardPay(e, person) : null}
              allDays={blank}
            />
          );
        })}
      </div>
    </>
  );
}
