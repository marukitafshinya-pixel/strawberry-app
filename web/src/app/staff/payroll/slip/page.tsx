"use client";

// 個人別の給与明細の印刷（パソコン・管理者）：名前を選ぶとその人だけ、「全員」なら1人1枚（A4縦）。
// 明細の形は、従業員が携帯で見るものと同じ（components/PayslipSheet）。勤怠はタイムカードから計算する
import { doc, getDoc } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PayslipSheet, slipMonthLabel } from "@/components/PayslipSheet";
import { useAuth } from "@/lib/auth";
import { getFirebase } from "@/lib/firebase";
import { useEmployees, usePayroll } from "@/lib/payroll";
import { useSettings } from "@/lib/reservations";
import { applyLock, cardsIn, computePerson, employeeForCard, periodMonths, useTimecardConfig, useTimecardLock, useTimecardMonths } from "@/lib/timecard";

export default function PayslipPrintPage() {
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
  const ok = /^\d{4}-\d{2}$/.test(month);
  const [who, setWho] = useState(params.get("id") ?? "");
  const { value: payroll } = usePayroll(month);
  const { value: employeesNow } = useEmployees();
  const { value: settings } = useSettings();
  const { value: cfg } = useTimecardConfig();
  // 確定した月は、確定したときの区分（管理職か）で残業を数える
  const lock = useTimecardLock(ok ? month : "2000-01");
  const data = useTimecardMonths(ok ? periodMonths(month, cfg?.closeDay ?? 31) : ["2000-01"]);
  // 明細に出す会社の名前（請求書の設定の発行者名。携帯の明細と同じ）
  const [issuer, setIssuer] = useState<string | null>(null);
  useEffect(() => {
    if (role !== "admin") return;
    getFirebase()
      .then(({ db }) => getDoc(doc(db, "config/invoice")))
      .then((s) => setIssuer(String(s.get("issuerName") ?? "")))
      .catch(() => setIssuer(""));
  }, [role]);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!ok) return <p className="text-red-600">月が指定されていません</p>;
  if (!payroll || !employeesNow || !settings) return <p className="text-gray-500">読み込み中…</p>;

  const employees = applyLock(employeesNow, lock);
  const people = employees.filter((e) => payroll.rows[e.id] && Object.keys(payroll.rows[e.id]).length > 0);
  const shown = who ? people.filter((e) => e.id === who) : people;
  const company = issuer || settings.storeName;
  // 従業員ごとのタイムカードのカード番号
  const cards = cfg && data ? cardsIn(month, data, cfg) : [];
  const workOf = (id: string) => {
    if (!cfg || !data) return null;
    const card = cards.find((c) => employeeForCard(c, cfg, employees)?.id === id);
    if (!card) return null;
    const e = employees.find((x) => x.id === id);
    const p = computePerson(card, month, data, cfg, { noOvertime: e?.manager });
    return { days: p.workDays, work: p.work, over: p.over };
  };

  return (
    <div className="mx-auto max-w-2xl">
      <style>{`@media print { @page { size: A4 portrait; margin: 12mm; } body { background: #fff !important; } .payslip-page { break-after: page; } .payslip-page:last-child { break-after: auto; } }`}</style>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <Link href={`/staff/payroll/?month=${month}`} className="text-sm text-gray-500 underline">
          ← 給与の打ち込み
        </Link>
        <span className="font-bold">{slipMonthLabel(month)}</span>
        <select value={who} onChange={(e) => setWho(e.target.value)} className="rounded-lg border bg-white px-3 py-2">
          <option value="">全員（{people.length}人・1人1枚）</option>
          {people.map((e) => (
            <option key={e.id} value={e.id}>
              {e.code ? `${e.code} ` : ""}
              {e.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => window.print()}
          disabled={shown.length === 0}
          className="ml-auto rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-40"
        >
          🖨 印刷する（{shown.length}人）
        </button>
      </div>
      {people.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-gray-600">この月の給与はまだ打ち込まれていません。</p>
      ) : (
        <div className="space-y-6 print:space-y-0">
          {shown.map((e) => (
            <div key={e.id} className="payslip-page">
              <PayslipSheet
                month={month}
                paymentDate={payroll.paymentDate}
                row={payroll.rows[e.id]}
                me={{ name: e.name, code: e.code, company }}
                work={workOf(e.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
