"use client";

// 個人別の給与明細の印刷（パソコン・管理者）：印刷する人にチェックを入れて、いっぺんに1人1枚（A4縦）。
// チェックした人はアプリに覚えておき（config/payslipPrint）、次の月度もその人たちにチェックが入った状態で開く。
// 明細の形は、従業員が携帯で見るものと同じ（components/PayslipSheet）。勤怠はタイムカードから計算する。
// 「タイムカード集計表もいっしょに」なら、明細の下にその人の個人別タイムカード集計表を入れて1枚にする。
// とじ穴をあけるので、用紙の余白は広め（左を一番広く）
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PayslipSheet, slipMonthLabel } from "@/components/PayslipSheet";
import { useAuth } from "@/lib/auth";
import { getFirebase } from "@/lib/firebase";
import { reiwa, timecardPay, useEmployees, usePayroll } from "@/lib/payroll";
import { useSettings } from "@/lib/reservations";
import { applyLock, cardsIn, computePerson, employeeForCard, periodMonths, useTimecardConfig, useTimecardLock, useTimecardMonths } from "@/lib/timecard";
import { TimecardSheet } from "../timecard/Sheet";

/** 印刷する人のチェック（従業員の id のリスト）を覚えておく場所。管理者だけ */
const PICK_DOC = "config/payslipPrint";

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
  /** チェックした人（従業員の id）。null＝まだ読みこんでいない。覚えたものがなければ全員 */
  const [picked, setPicked] = useState<string[] | "all" | null>(null);
  const [withTc, setWithTc] = useState(true);
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
    getFirebase()
      .then(({ db }) => getDoc(doc(db, PICK_DOC)))
      .then((s) => setPicked(Array.isArray(s.get("ids")) ? (s.get("ids") as string[]) : "all"))
      .catch(() => setPicked("all"));
  }, [role]);
  const [saveError, setSaveError] = useState("");

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!ok) return <p className="text-red-600">月が指定されていません</p>;
  if (!payroll || !employeesNow || !settings || !picked) return <p className="text-gray-500">読み込み中…</p>;

  const employees = applyLock(employeesNow, lock);
  const people = employees.filter((e) => payroll.rows[e.id] && Object.keys(payroll.rows[e.id]).length > 0);
  const isPicked = (id: string) => picked === "all" || picked.includes(id);
  const shown = people.filter((e) => isPicked(e.id));
  /** チェックを変えて、アプリに覚えておく（この月にいない人のチェックもそのまま残す） */
  const pick = (ids: string[]) => {
    const others =
      picked === "all" ? employees.map((e) => e.id).filter((id) => !people.some((p) => p.id === id)) : picked.filter((id) => !people.some((p) => p.id === id));
    const next = [...new Set([...others, ...ids])];
    setPicked(next);
    setSaveError("");
    getFirebase()
      .then(({ db }) => setDoc(doc(db, PICK_DOC), { ids: next.slice(0, 300), updatedAt: serverTimestamp() }))
      .catch(() => setSaveError("チェックした人を覚えておけませんでした（印刷はできます）"));
  };
  const toggle = (id: string) => pick(shown.map((e) => e.id).includes(id) ? shown.map((e) => e.id).filter((x) => x !== id) : [...shown.map((e) => e.id), id]);
  const company = issuer || settings.storeName;
  // 従業員ごとのタイムカードのカード番号
  const cards = cfg && data ? cardsIn(month, data, cfg) : [];
  const personOf = (e: (typeof employees)[number]) => {
    if (!cfg || !data) return null;
    const card = cards.find((c) => employeeForCard(c, cfg, employees)?.id === e.id);
    return card ? computePerson(card, month, data, cfg, { noOvertime: e.manager }) : null;
  };
  const [y, m] = month.split("-").map(Number);

  return (
    <div className="mx-auto max-w-2xl">
      {/* 余白：上下・右 12mm、左（とじ穴の側）20mm。集計表といっしょのときは、その分だけ縮めて1枚に収める */}
      <style>{`@media print { @page { size: A4 portrait; margin: 12mm 12mm 12mm 20mm; } body { background: #fff !important; } .payslip-page { break-after: page; } .payslip-page:last-child { break-after: auto; } .payslip-page.with-tc { zoom: 0.9; } }`}</style>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <Link href={`/staff/payroll/?month=${month}`} className="text-sm text-gray-500 underline">
          ← 給与の打ち込み
        </Link>
        <span className="font-bold">{slipMonthLabel(month)}</span>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={withTc} onChange={(e) => setWithTc(e.target.checked)} />
          タイムカード集計表もいっしょに（1枚にまとめる）
        </label>
        <button
          onClick={() => window.print()}
          disabled={shown.length === 0}
          className="ml-auto rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-40"
        >
          🖨 印刷する（{shown.length}人）
        </button>
      </div>
      {people.length > 0 && (
        <div className="mb-4 rounded-xl bg-white p-3 shadow-sm print:hidden">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-bold">印刷する人</span>
            <span className="text-gray-500">（チェックした人は覚えておき、次の月度もチェックが入ります）</span>
            <button onClick={() => pick(people.map((e) => e.id))} className="ml-auto rounded border px-2 py-1">
              全員
            </button>
            <button onClick={() => pick([])} className="rounded border px-2 py-1">
              全部はずす
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {people.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isPicked(e.id)} onChange={() => toggle(e.id)} />
                <span className="text-gray-500">{e.code}</span>
                {e.name}
              </label>
            ))}
          </div>
          {saveError && <p className="mt-2 text-sm text-red-600">{saveError}</p>}
        </div>
      )}
      {people.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-gray-600">この月の給与はまだ打ち込まれていません。</p>
      ) : (
        <div className="space-y-6 print:space-y-0">
          {shown.map((e) => {
            const p = personOf(e);
            return (
              <div key={e.id} className={`payslip-page ${withTc && p ? "with-tc" : ""}`}>
                <PayslipSheet
                  month={month}
                  paymentDate={payroll.paymentDate}
                  row={payroll.rows[e.id]}
                  me={{ name: e.name, code: e.code, company }}
                  work={p && { days: p.workDays, work: p.work, over: p.over }}
                  compact={withTc && !!p}
                />
                {withTc && p && (
                  <div className="mt-4 rounded-xl bg-white p-4 shadow-sm print:mt-3 print:rounded-none print:border-t print:border-dashed print:border-gray-400 print:p-0 print:pt-2 print:shadow-none">
                    <TimecardSheet person={p} name={e.name} title={`${reiwa(y)} ${m}月度分`} pay={timecardPay(e, p)} stacked />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
