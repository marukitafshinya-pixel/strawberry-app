"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAuth } from "@/lib/auth";
import { EMPLOYER_ITEMS, PAY_ITEMS, computeRow, reiwa, useEmployees, usePayroll } from "@/lib/payroll";
import { useSettings } from "@/lib/reservations";

const n = (v: number) => v.toLocaleString("ja-JP");

export default function PayrollPrintPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <PrintView />
    </Suspense>
  );
}

function PrintView() {
  const { role } = useAuth();
  const month = useSearchParams().get("month") ?? "";
  const { value: payroll } = usePayroll(month);
  const { value: employees } = useEmployees();
  const { value: settings } = useSettings();
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!/^\d{4}-\d{2}$/.test(month)) return <p className="text-red-600">月が指定されていません</p>;
  if (!payroll || !employees || !settings) return <p className="text-gray-500">読み込み中…</p>;

  const [y, m] = month.split("-").map(Number);
  const title = `${reiwa(y)} ${m}月度分`;
  const pay = payroll.paymentDate ? payroll.paymentDate.split("-").map(Number) : null;
  const people = employees.filter((e) => payroll.rows[e.id] && Object.keys(payroll.rows[e.id]).length > 0);
  const rows = people.map((e) => ({ e, r: payroll.rows[e.id], s: computeRow(payroll.rows[e.id]) }));
  const total = (f: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + f(x), 0);
  const transfers = rows.filter((x) => x.e.payMethod === "transfer" && x.s.net !== 0);
  const cash = rows.filter((x) => x.e.payMethod === "cash" && x.s.net !== 0);
  const employerTotal = EMPLOYER_ITEMS.reduce((a, it) => a + (payroll.employer[it.key] ?? 0), 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <Link href={`/staff/payroll/?month=${month}`} className="text-sm text-gray-500 underline">
          ← 給与の打ち込み
        </Link>
        <button onClick={() => window.print()} className="rounded-lg bg-berry px-6 py-2 font-bold text-white">
          印刷する
        </button>
        <span className="text-xs text-gray-500">用紙はA4横がおすすめです（印刷の画面で「横向き」を選んでください）</span>
      </div>

      <div className="overflow-x-auto bg-white p-4 text-black shadow print:overflow-visible print:p-0 print:shadow-none">
        {/* 1枚目：給与集計表 */}
        <section>
          <div className="flex items-end justify-between">
            <h1 className="text-lg font-bold">{title} 給与集計表</h1>
            <div className="text-right text-xs">
              {pay && (
                <div>
                  振替日：{pay[1]}月{pay[2]}日
                </div>
              )}
              <div>{settings.storeName}</div>
            </div>
          </div>
          <table className="mt-2 w-full border-collapse text-[8pt]">
            <thead>
              <tr>
                <Th>番号</Th>
                <Th>氏名</Th>
                {PAY_ITEMS.slice(0, 4).map((i) => (
                  <Th key={i.key}>{i.label}</Th>
                ))}
                <Th>支給合計</Th>
                {PAY_ITEMS.slice(4, 9).map((i) => (
                  <Th key={i.key}>{i.label}</Th>
                ))}
                <Th>社会保険料計</Th>
                {PAY_ITEMS.slice(9).map((i) => (
                  <Th key={i.key}>{i.label}</Th>
                ))}
                <Th>差引支給合計</Th>
                <Th>振込支給</Th>
                <Th>現金支給</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ e, r, s }) => (
                <tr key={e.id}>
                  <Td left>{e.code}</Td>
                  <Td left>{e.name}</Td>
                  {PAY_ITEMS.slice(0, 4).map((i) => (
                    <Td key={i.key}>{r[i.key] ? n(r[i.key]!) : ""}</Td>
                  ))}
                  <Td strong>{n(s.pay)}</Td>
                  {PAY_ITEMS.slice(4, 9).map((i) => (
                    <Td key={i.key}>{r[i.key] ? n(r[i.key]!) : ""}</Td>
                  ))}
                  <Td strong>{n(s.social)}</Td>
                  {PAY_ITEMS.slice(9).map((i) => (
                    <Td key={i.key}>{r[i.key] ? n(r[i.key]!) : ""}</Td>
                  ))}
                  <Td strong>{n(s.net)}</Td>
                  <Td>{e.payMethod === "transfer" ? n(s.net) : ""}</Td>
                  <Td>{e.payMethod === "cash" ? n(s.net) : ""}</Td>
                </tr>
              ))}
              <tr className="font-bold">
                <Td left>合計</Td>
                <Td left>{rows.length}名</Td>
                {PAY_ITEMS.slice(0, 4).map((i) => (
                  <Td key={i.key}>{n(total((x) => x.r[i.key] ?? 0))}</Td>
                ))}
                <Td>{n(total((x) => x.s.pay))}</Td>
                {PAY_ITEMS.slice(4, 9).map((i) => (
                  <Td key={i.key}>{n(total((x) => x.r[i.key] ?? 0))}</Td>
                ))}
                <Td>{n(total((x) => x.s.social))}</Td>
                {PAY_ITEMS.slice(9).map((i) => (
                  <Td key={i.key}>{n(total((x) => x.r[i.key] ?? 0))}</Td>
                ))}
                <Td>{n(total((x) => x.s.net))}</Td>
                <Td>{n(transfers.reduce((a, x) => a + x.s.net, 0))}</Td>
                <Td>{n(cash.reduce((a, x) => a + x.s.net, 0))}</Td>
              </tr>
            </tbody>
          </table>

          <div className="mt-3 grid grid-cols-2 gap-6 text-[9pt]">
            <table className="border-collapse">
              <thead>
                <tr>
                  <Th>租税公課・社会保険料</Th>
                  <Th>給与分</Th>
                  <Th>事業所分</Th>
                  <Th>合計</Th>
                </tr>
              </thead>
              <tbody>
                {EMPLOYER_ITEMS.map((it) => {
                  const emp = it.key === "childAllowance" ? 0 : total((x) => x.r[it.key as keyof typeof x.r] ?? 0);
                  const biz = payroll.employer[it.key] ?? 0;
                  return (
                    <tr key={it.key}>
                      <Td left>{it.label}</Td>
                      <Td>{n(emp)}</Td>
                      <Td>{n(biz)}</Td>
                      <Td>{n(emp + biz)}</Td>
                    </tr>
                  );
                })}
                <tr>
                  <Td left>源泉所得税</Td>
                  <Td>{n(total((x) => x.r.incomeTax ?? 0))}</Td>
                  <Td />
                  <Td>{n(total((x) => x.r.incomeTax ?? 0))}</Td>
                </tr>
                <tr>
                  <Td left>住民税</Td>
                  <Td>{n(total((x) => x.r.residentTax ?? 0))}</Td>
                  <Td />
                  <Td>{n(total((x) => x.r.residentTax ?? 0))}</Td>
                </tr>
              </tbody>
            </table>
            <table className="self-start border-collapse">
              <tbody>
                <tr>
                  <Td left>支給合計（労賃）</Td>
                  <Td strong>{n(total((x) => x.s.pay))}</Td>
                </tr>
                <tr>
                  <Td left>事業所負担の合計</Td>
                  <Td strong>{n(employerTotal)}</Td>
                </tr>
                <tr>
                  <Td left>差引支給の合計</Td>
                  <Td strong>{n(total((x) => x.s.net))}</Td>
                </tr>
              </tbody>
            </table>
          </div>
          {payroll.memo && <p className="mt-2 text-[9pt]">メモ：{payroll.memo}</p>}
        </section>

        {/* 2枚目：振込一覧 */}
        <section className="mt-8 break-before-page print:mt-0">
          <div className="flex items-end justify-between">
            <h1 className="text-lg font-bold">{title} 給与 振込一覧</h1>
            <div className="text-right text-xs">
              {pay && (
                <div>
                  振込日：{pay[0]}年{pay[1]}月{pay[2]}日
                </div>
              )}
              <div>{settings.storeName}</div>
            </div>
          </div>
          <table className="mt-2 w-full border-collapse text-[10pt]">
            <thead>
              <tr>
                <Th>番号</Th>
                <Th>入金者氏名</Th>
                <Th>銀行名</Th>
                <Th>支店名</Th>
                <Th>種別</Th>
                <Th>口座番号</Th>
                <Th>入金金額</Th>
              </tr>
            </thead>
            <tbody>
              {transfers.map(({ e, s }) => (
                <tr key={e.id}>
                  <Td left>{e.code}</Td>
                  <Td left>{e.name}</Td>
                  <Td left>{e.bankName}</Td>
                  <Td left>{e.branchName}</Td>
                  <Td left>{e.accountType}</Td>
                  <Td left>{e.accountNumber}</Td>
                  <Td strong>{n(s.net)}</Td>
                </tr>
              ))}
              <tr className="font-bold">
                <Td left>合計</Td>
                <Td left>{transfers.length}名</Td>
                <Td left />
                <Td left />
                <Td left />
                <Td left />
                <Td>{n(transfers.reduce((a, x) => a + x.s.net, 0))}</Td>
              </tr>
            </tbody>
          </table>

          {cash.length > 0 && (
            <>
              <h2 className="mt-6 font-bold">現金支給</h2>
              <table className="mt-1 w-1/2 border-collapse text-[10pt]">
                <tbody>
                  {cash.map(({ e, s }) => (
                    <tr key={e.id}>
                      <Td left>{e.code}</Td>
                      <Td left>{e.name}</Td>
                      <Td strong>{n(s.net)}</Td>
                      <Td left>受取印</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } body { background: #fff !important; } }`}</style>
    </>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="border border-black bg-gray-100 px-1 py-0.5 text-center font-semibold whitespace-nowrap">{children}</th>;
}

function Td({ children, left, strong }: { children?: React.ReactNode; left?: boolean; strong?: boolean }) {
  return <td className={`border border-black px-1 py-0.5 whitespace-nowrap tabular-nums ${left ? "text-left" : "text-right"} ${strong ? "font-bold" : ""}`}>{children}</td>;
}
