"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "@/lib/auth";
import { EMPLOYER_ITEMS, PAY_ITEMS, computeRow, reiwa, useEmployees, usePayroll, type Employee, type EmployerKey, type PayRow } from "@/lib/payroll";
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
  /**
   * 印刷で用紙の上下まん中に置くための、1枚分の高さ（mm）。
   * 表が用紙の幅より広いと印刷で縮小されるので、その分だけ高さを大きくしておく（縮小後にちょうど1枚の高さになる）
   */
  const sheet = useRef<HTMLDivElement>(null);
  const [sheetH, setSheetH] = useState(188);
  useEffect(() => {
    const fit = () => {
      const el = sheet.current;
      if (!el) return;
      const w = Math.max(1, ...[...el.querySelectorAll("section")].map((x) => x.scrollWidth));
      const pageW = (281 * 96) / 25.4; // A4横（297mm）から左右の余白 8mm ずつを引いた幅
      setSheetH(Math.floor(188 / Math.min(1, pageW / w)));
    };
    fit();
    window.addEventListener("beforeprint", fit);
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("beforeprint", fit);
      window.removeEventListener("resize", fit);
    };
  }, [payroll, employees, settings]);
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

      <div ref={sheet} style={{ "--sheet-h": `${sheetH}mm` } as CSSProperties} className="overflow-x-auto bg-white p-4 text-black shadow print:overflow-visible print:p-0 print:shadow-none">
        {/* 1枚目：給与集計表（印刷では用紙の上下まん中に置き、上にも余白を作る） */}
        <section className="print:flex print:min-h-[var(--sheet-h)] print:flex-col print:justify-center">
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

        {/* 2枚目：振込一覧（給与明細）。お送りいただいた「給与明細」の表と同じ並び */}
        <section className="mt-8 break-before-page print:mt-0 print:flex print:min-h-[var(--sheet-h)] print:flex-col print:justify-center">
          <TransferSheet
            storeName={settings.storeName}
            year={reiwa(y)}
            month={m}
            pay={pay}
            author={payroll.author}
            payer={payroll.payerAccount}
            rows={rows}
            employer={payroll.employer}
          />
          {cash.length > 0 && (
            <>
              <h2 className="mt-6 font-bold">現金支給（受取印）</h2>
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

type SheetRow = { e: Employee; r: PayRow; s: ReturnType<typeof computeRow> };

/**
 * 振込一覧（給与明細）
 * 左：会社の口座から払うもの（労賃と事業所負担分）
 * 右：入金先（一人ひとりの振込、保険料・税金の納付）
 * 左の「支払合計」と右の「入金合計」は同じ金額になる
 */
function TransferSheet({
  storeName,
  year,
  month,
  pay,
  author,
  payer,
  rows,
  employer,
}: {
  storeName: string;
  year: string;
  month: number;
  pay: number[] | null;
  author: string;
  payer: string;
  rows: SheetRow[];
  employer: Partial<Record<EmployerKey, number>>;
}) {
  const sum = (f: (x: SheetRow) => number) => rows.reduce((a, x) => a + f(x), 0);
  const emp = (k: keyof PayRow) => sum((x) => x.r[k] ?? 0);
  const biz = (k: EmployerKey) => employer[k] ?? 0;
  const totalPay = sum((x) => x.s.pay);
  const transferTotal = sum((x) => (x.e.payMethod === "transfer" ? x.s.net : 0));
  const cashTotal = sum((x) => (x.e.payMethod === "cash" ? x.s.net : 0));
  const yearEnd = emp("yearEnd");

  // 左（支払）：労賃のあとに事業所負担分
  const left: { label: string; account: string; amount: number | null }[] = [
    { label: "雇用保険料", account: payer, amount: biz("employment") },
    { label: "健康保険料", account: payer, amount: biz("health") },
    ...(biz("care") || emp("care") ? [{ label: "介護保険料", account: payer, amount: biz("care") }] : []),
    { label: "厚生年金保険料", account: payer, amount: biz("pension") },
    { label: "児童手当拠出金", account: payer, amount: biz("childAllowance") },
    { label: "住民税", account: "", amount: null },
    { label: "", account: "", amount: null },
    { label: "社会保険料調整", account: "", amount: 0 },
  ];
  // 右（入金）：保険料は給与分＋事業所分、税金は給与から預かった分
  const right: { label: string; account: string; amount: number }[] = [
    { label: "雇用保険料", account: payer, amount: emp("employment") + biz("employment") },
    { label: "健康保険料", account: payer, amount: emp("health") + biz("health") },
    ...(biz("care") || emp("care") ? [{ label: "介護保険料", account: payer, amount: emp("care") + biz("care") }] : []),
    { label: "厚生年金保険料", account: payer, amount: emp("pension") + biz("pension") },
    { label: "児童手当拠出金", account: payer, amount: biz("childAllowance") },
    { label: "源泉所得税", account: payer, amount: emp("incomeTax") },
    { label: "住民税", account: "", amount: emp("residentTax") },
    ...(yearEnd ? [{ label: "年末調整", account: "", amount: -yearEnd }] : []),
    { label: "社会保険料調整", account: "", amount: emp("socialAdj") },
  ];
  while (left.length < right.length) left.splice(left.length - 1, 0, { label: "", account: "", amount: null });
  const payTotal = totalPay + left.reduce((a, x) => a + (x.amount ?? 0), 0);
  const inTotal = transferTotal + cashTotal + right.reduce((a, x) => a + x.amount, 0);

  const C = "border border-black px-1 py-0.5 whitespace-nowrap";
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : n(v));

  return (
    <table className="w-full border-collapse text-[9pt] tabular-nums">
      <thead>
        <tr className="text-[10pt]">
          <th colSpan={3} className="px-1 pb-1 text-left font-normal">
            株）{storeName}
            <span className="ml-6 text-[13pt] font-bold">{year}</span>
          </th>
          <th colSpan={3} className="px-1 pb-1 text-left text-[13pt] font-bold">
            {month}月度分給与明細
          </th>
          <th colSpan={2} className="px-1 pb-1 text-right font-normal">
            振替日：
          </th>
          <th colSpan={2} className="px-1 pb-1 text-left font-normal whitespace-nowrap">
            {pay ? `${pay[1]}月${pay[2]}日` : ""}
            {author && <span className="ml-3">作成 {author}</span>}
          </th>
        </tr>
        <tr className="bg-gray-100">
          {["適用", "支払口座番号", "支払金額", "入金者氏名", "銀行名", "支店名", "種別", "入金口座番号", "入金金額", "現金支給"].map((h) => (
            <th key={h} className={`${C} text-center font-semibold`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ e, s }) => (
          <tr key={e.id}>
            <td className={C} />
            <td className={C} />
            <td className={C} />
            <td className={`${C} text-left`}>{e.name}</td>
            <td className={`${C} text-center`}>{e.payMethod === "transfer" ? e.bankName : ""}</td>
            <td className={`${C} text-center`}>{e.payMethod === "transfer" ? e.branchName : ""}</td>
            <td className={`${C} text-center`}>{e.payMethod === "transfer" && e.bankName ? e.accountType : ""}</td>
            <td className={`${C} text-right`}>{e.payMethod === "transfer" ? e.accountNumber : ""}</td>
            <td className={`${C} text-right`}>{e.payMethod === "transfer" ? n(s.net) : ""}</td>
            <td className={`${C} text-right`}>{e.payMethod === "cash" ? n(s.net) : ""}</td>
          </tr>
        ))}
        <tr className="font-bold">
          <td className={`${C} text-center font-normal`}>労賃</td>
          <td className={`${C} text-center font-normal`}>{payer}</td>
          <td className={`${C} text-right font-normal`}>{n(totalPay)}</td>
          <td className={C} colSpan={5} />
          <td className={`${C} text-right`}>{n(transferTotal)}</td>
          <td className={`${C} text-right`}>{n(cashTotal)}</td>
        </tr>
        {right.map((rt, i) => {
          const lt = left[i];
          return (
            <tr key={i}>
              <td className={`${C} text-center`}>{lt.label}</td>
              <td className={`${C} text-center`}>{lt.amount !== null ? lt.account : ""}</td>
              <td className={`${C} text-right`}>{num(lt.amount)}</td>
              <td className={`${C} text-center`} colSpan={2}>
                {rt.label}
              </td>
              <td className={`${C} text-center`} colSpan={3}>
                {rt.account}
              </td>
              <td className={`${C} text-right`}>{n(rt.amount)}</td>
              {i === 0 ? (
                <td className={`${C} text-center text-[8pt] font-bold`}>支給合計</td>
              ) : i === 1 ? (
                <td className={`${C} text-right text-[12pt] font-bold`}>{n(transferTotal + cashTotal)}</td>
              ) : (
                <td className={C} />
              )}
            </tr>
          );
        })}
        <tr className="font-bold">
          <td className={`${C} py-1.5 text-center`}>支払合計</td>
          <td className={C} />
          <td className={`${C} text-right`}>{n(payTotal)}</td>
          <td className={`${C} text-left`} colSpan={5}>
            入金合計
          </td>
          <td className={`${C} text-right`}>{n(inTotal)}</td>
          <td className={`${C} text-center text-[8pt] font-normal`}>{payTotal === inTotal ? "" : "※合計が合いません"}</td>
        </tr>
      </tbody>
    </table>
  );
}
