"use client";

import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { billingPeriod, dueDateOf, termsText, useCustomers, type Customer } from "@/lib/customers";
import { formatJa, shiftMonth, todayJST } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { useSettings } from "@/lib/reservations";
import { lineTaxRate, useReceivablesByCustomer, useSalesByCustomer, type Receivable, type Sale } from "@/lib/sales";
import type { Settings, TaxRate } from "@/lib/settings";

export default function InvoicePage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <InvoiceLoader />
    </Suspense>
  );
}

/** 振込先など（スタッフだけが見られる場所に保存） */
function useInvoiceConfig() {
  const [value, setValue] = useState<{ bankInfo: string; note: string } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "config/invoice"),
        (s) => setValue({ bankInfo: (s.get("bankInfo") as string) ?? "", note: (s.get("note") as string) ?? "" }),
        () => setValue({ bankInfo: "", note: "" }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return value;
}

function InvoiceLoader() {
  const params = useSearchParams();
  const id = params.get("customer") ?? "";
  const { value: customers } = useCustomers();
  const { value: settings } = useSettings();
  const config = useInvoiceConfig();
  const customer = customers?.find((c) => c.id === id);
  if (!customers || !settings || !config) return <p className="text-gray-500">読み込み中…</p>;
  if (!customer) return <p className="text-red-600">顧客が見つかりません</p>;
  return <Invoice key={customer.id} customer={customer} settings={settings} config={config} />;
}

/**
 * はじめに開く請求期間：いちばん最近に締めた期間。
 * そこに未回収の売掛がなく、いまの期間（まだ締めていない）にあるなら、いまの期間。
 */
function autoMonth(c: Customer, receivables: Receivable[]): string {
  const today = todayJST();
  const ym = today.slice(0, 7);
  const currentYm = billingPeriod(c.terms, ym).to >= today ? ym : shiftMonth(ym, 1);
  const closedYm = shiftMonth(currentYm, -1);
  const has = (m: string) => {
    const p = billingPeriod(c.terms, m);
    return receivables.some((r) => r.status === "open" && r.date >= p.from && r.date <= p.to);
  };
  return !has(closedYm) && has(currentYm) ? currentYm : closedYm;
}

function Invoice({ customer: c, settings: s, config }: { customer: Customer; settings: Settings; config: { bankInfo: string; note: string } }) {
  const { role } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const qm = params.get("month");
  const { value: receivables } = useReceivablesByCustomer(c.name);
  const month = qm && /^\d{4}-\d{2}$/.test(qm) ? qm : autoMonth(c, receivables ?? []);
  const setMonth = (m: string) => router.replace(`/staff/receivables/invoice/?customer=${c.id}&month=${m}`);
  const period = billingPeriod(c.terms, month);
  const { value: sales } = useSalesByCustomer(c.name);
  const [includeCollected, setIncludeCollected] = useState(false);
  const [issueDate, setIssueDate] = useState(todayJST());
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [bankInfo, setBankInfo] = useState(config.bankInfo);
  const [note, setNote] = useState(config.note);
  const [message, setMessage] = useState("");

  const due = dueDate ?? dueDateOf(c.terms, period.to);
  const saleById = new Map((sales ?? []).map((x) => [x.id, x]));
  const rows = (receivables ?? [])
    .filter((r) => r.date >= period.from && r.date <= period.to && (includeCollected || r.status === "open"))
    .sort((a, b) => a.date.localeCompare(b.date));
  const total = rows.reduce((n, r) => n + r.amount, 0);
  const taxes = taxSummary(rows, saleById, s);

  async function saveConfig() {
    try {
      const { db } = await getFirebase();
      await setDoc(doc(db, "config/invoice"), { bankInfo: bankInfo.trim().slice(0, 500), note: note.trim().slice(0, 500), updatedAt: serverTimestamp() });
      setMessage("振込先・備考を保存しました（次の請求書にも使われます）");
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  const invoiceNo = `${c.id.slice(0, 4).toUpperCase()}-${period.to.replaceAll("-", "")}`;

  return (
    <>
      {/* 画面だけに出す操作部分 */}
      <div className="print:hidden">
        <p className="text-sm">
          <Link href="/staff/receivables/" className="text-gray-500 underline">
            ← 売掛管理
          </Link>
        </p>
        <h1 className="mt-2 text-xl font-bold">請求書（{c.name} 様）</h1>
        <p className="mt-1 text-sm text-gray-600">
          支払い条件：{c.terms ? termsText(c.terms) : "未設定（月末締め・翌月末払いで計算しています。顧客リストの詳細で設定できます）"}
        </p>
        <div className="mt-3 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => { setMonth(shiftMonth(month, -1)); setDueDate(null); }} className="rounded-lg border px-3 py-2">
              ‹ 前の締め
            </button>
            <span className="font-bold">
              {formatJa(period.from, true)} 〜 {formatJa(period.to)} 締め分
            </span>
            <button onClick={() => { setMonth(shiftMonth(month, 1)); setDueDate(null); }} className="rounded-lg border px-3 py-2">
              次の締め ›
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-gray-600">請求日</span>
              <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">お支払期限</span>
              <input type="date" value={due} onChange={(e) => setDueDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={includeCollected} onChange={(e) => setIncludeCollected(e.target.checked)} />
              回収済みの分も載せる
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-gray-600">お振込先</span>
            <textarea value={bankInfo} rows={2} maxLength={500} placeholder="例：〇〇銀行 〇〇支店 普通 1234567 名義 マルキタイチゴノウエン" onChange={(e) => setBankInfo(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">備考</span>
            <textarea value={note} rows={2} maxLength={500} placeholder="例：振込手数料はご負担ください" onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {role === "admin" && (bankInfo !== config.bankInfo || note !== config.note) && (
              <button onClick={saveConfig} className="rounded-lg border px-3 py-2 text-sm">
                振込先・備考を保存
              </button>
            )}
            {message && <span className="text-sm text-green-700">{message}</span>}
          </div>
          <button onClick={() => window.print()} disabled={rows.length === 0} className="w-full rounded-lg bg-berry py-3 text-lg font-bold text-white disabled:opacity-40">
            印刷する
          </button>
          {receivables && rows.length === 0 && <p className="text-sm text-gray-500">この期間の売掛はありません。</p>}
          <p className="text-xs text-gray-500">用紙はA4（縦）です。PDFにしたいときは、印刷の画面で「PDFに保存」を選びます。</p>
        </div>
        <p className="mt-4 text-sm text-gray-500">印刷のイメージ</p>
      </div>

      {/* 印刷される部分 */}
      <div className="mt-2 flex justify-center print:mt-0 print:block">
        <article className="w-[190mm] bg-white px-[12mm] py-[12mm] text-[10.5pt] text-black shadow print:w-auto print:p-0 print:shadow-none">
          <h2 className="text-center text-[20pt] font-bold tracking-[0.6em]">請求書</h2>
          <div className="mt-2 text-right text-[9pt]">
            <div>請求日：{formatJa(issueDate, true)}</div>
            <div>請求番号：{invoiceNo}</div>
          </div>
          <div className="mt-4 flex justify-between gap-6">
            <div className="flex-1">
              <div className="border-b border-black pb-1 text-[14pt]">{c.name} 御中</div>
              {c.address && <div className="mt-1 text-[9pt]">{c.address}</div>}
              <p className="mt-4">下記のとおりご請求申し上げます。</p>
              <div className="mt-3 flex items-end gap-3 border-b-2 border-black pb-1">
                <span>ご請求金額</span>
                <span className="text-[18pt] font-bold">¥{total.toLocaleString("ja-JP")}-</span>
                <span className="text-[9pt]">（税込）</span>
              </div>
              <table className="mt-3 text-[9.5pt]">
                <tbody>
                  <tr>
                    <td className="pr-3">請求期間</td>
                    <td>
                      {formatJa(period.from, true)} 〜 {formatJa(period.to, true)}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-3">お支払期限</td>
                    <td className="font-bold">{formatJa(due, true)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="w-[65mm] text-right text-[9pt]">
              <div className="text-[11pt] font-bold">{s.storeName}</div>
              {s.storeAddress && <div>{s.storeAddress}</div>}
              {s.storePhone && <div>TEL {s.storePhone}</div>}
              {s.invoiceNumber && <div>登録番号 {s.invoiceNumber}</div>}
            </div>
          </div>

          <table className="mt-5 w-full border-collapse text-[9.5pt]">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-black px-2 py-1 text-left">日付</th>
                <th className="border border-black px-2 py-1 text-left">内容</th>
                <th className="border border-black px-2 py-1 text-right">金額（税込）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sale = r.saleId ? saleById.get(r.saleId) : undefined;
                return (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap border border-black px-2 py-1">{formatJa(r.date)}</td>
                    <td className="border border-black px-2 py-1">
                      {sale
                        ? sale.lines.map((l, i) => (
                            <div key={i}>
                              {l.name} {l.unitPrice.toLocaleString("ja-JP")}円 × {l.qty}
                              {l.discountRate > 0 && `（${l.discountRate}%引）`}
                              {lineTaxRate(l, s) === 8 && " ※"}
                            </div>
                          ))
                        : r.memo || "（手入力の売掛）"}
                    </td>
                    <td className="border border-black px-2 py-1 text-right tabular-nums">{r.amount.toLocaleString("ja-JP")}</td>
                  </tr>
                );
              })}
              <tr className="font-bold">
                <td className="border border-black px-2 py-1" colSpan={2}>
                  合計
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">{total.toLocaleString("ja-JP")}</td>
              </tr>
            </tbody>
          </table>

          <table className="ml-auto mt-2 border-collapse text-[9pt]">
            <tbody>
              {taxes.map((t) => (
                <tr key={t.rate}>
                  <td className="border border-black px-2 py-0.5">
                    {t.rate}%対象{t.rate === 8 && "※"}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right tabular-nums">{t.total.toLocaleString("ja-JP")}円</td>
                  <td className="border border-black px-2 py-0.5">内消費税</td>
                  <td className="border border-black px-2 py-0.5 text-right tabular-nums">{t.tax.toLocaleString("ja-JP")}円</td>
                </tr>
              ))}
            </tbody>
          </table>
          {taxes.some((t) => t.rate === 8) && <p className="mt-1 text-right text-[8.5pt]">※は軽減税率対象</p>}

          {bankInfo.trim() && (
            <div className="mt-5 border border-black p-2 text-[9.5pt]">
              <div className="font-bold">お振込先</div>
              <div className="whitespace-pre-wrap">{bankInfo}</div>
            </div>
          )}
          {note.trim() && <div className="mt-3 whitespace-pre-wrap text-[9pt]">備考：{note}</div>}
        </article>
      </div>
      <style>{`@media print { @page { size: A4 portrait; margin: 14mm; } body { background: #fff !important; } }`}</style>
    </>
  );
}

/** 税率ごとの合計と消費税（請求書全体で、税率ごとに1回だけ切り捨て）。手入力の売掛は10%として数える */
function taxSummary(rows: Receivable[], saleById: Map<string, Sale>, s: Settings) {
  const totals = new Map<TaxRate, number>();
  for (const r of rows) {
    const sale = r.saleId ? saleById.get(r.saleId) : undefined;
    if (!sale) {
      totals.set(10, (totals.get(10) ?? 0) + r.amount);
      continue;
    }
    for (const l of sale.lines) {
      const rate = lineTaxRate(l, s);
      totals.set(rate, (totals.get(rate) ?? 0) + l.amount);
    }
  }
  return ([10, 8] as TaxRate[])
    .map((rate) => ({ rate, total: totals.get(rate) ?? 0, tax: Math.floor(((totals.get(rate) ?? 0) * rate) / (100 + rate)) }))
    .filter((x) => x.total > 0);
}
