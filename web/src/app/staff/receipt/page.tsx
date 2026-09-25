"use client";

import { doc, getDoc } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { formatJa } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { useSettings, yen } from "@/lib/reservations";
import { PAYMENT_LABEL, type Sale } from "@/lib/sales";
import type { Settings } from "@/lib/settings";

type Kind = "receipt" | "invoice";
type Paper = "narrow" | "a4";

/** 収入印紙が必要になる金額（税込の受取金額）。実際の要否は税理士に確認する */
const STAMP_THRESHOLD = 50000;

export default function ReceiptPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <ReceiptLoader />
    </Suspense>
  );
}

function ReceiptLoader() {
  const id = useSearchParams().get("sale");
  const { value: settings } = useSettings();
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState(id ? "" : "会計が指定されていません");

  useEffect(() => {
    if (!id) return;
    getFirebase()
      .then(({ db }) => getDoc(doc(db, `sales/${id}`)))
      .then((snap) => (snap.exists() ? setSale({ id: snap.id, ...(snap.data() as Omit<Sale, "id">) }) : setError("会計が見つかりません")))
      .catch((e) => setError(errorText(e)));
  }, [id]);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!settings || !sale) return <p className="text-gray-500">読み込み中…</p>;
  return <Receipt settings={settings} sale={sale} />;
}

function Receipt({ settings: s, sale }: { settings: Settings; sale: Sale }) {
  const [kind, setKind] = useState<Kind>("receipt");
  const [paper, setPaper] = useState<Paper>("narrow");
  const [addressee, setAddressee] = useState(sale.customerName);
  const [note, setNote] = useState("いちご狩り代として");
  const [issueDate, setIssueDate] = useState(sale.date);
  const voided = sale.status === "voided";
  const issued = sale.createdAt?.toDate();
  const time = issued?.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      {/* 画面だけに出す操作部分（印刷されない） */}
      <div className="print:hidden">
        <p className="text-sm">
          <Link href={`/staff/sales/?date=${sale.date}`} className="text-gray-500 underline">
            ← 日次締め
          </Link>
        </p>
        <h1 className="mt-2 text-xl font-bold">レシート・領収書</h1>
        {voided && <p className="mt-2 rounded-lg bg-red-50 p-3 text-red-700">この会計は取り消されています。印刷すると「取消」と表示されます。</p>}
        <div className="mt-3 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["receipt", "レシート"],
                ["invoice", "領収書"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} onClick={() => setKind(k)} className={`rounded-lg border px-4 py-2 ${kind === k ? "border-berry bg-berry font-bold text-white" : ""}`}>
                {label}
              </button>
            ))}
            <span className="mx-2 border-l" />
            {(
              [
                ["narrow", "レシート幅"],
                ["a4", "A4"],
              ] as const
            ).map(([p, label]) => (
              <button key={p} onClick={() => setPaper(p)} className={`rounded-lg border px-3 py-2 text-sm ${paper === p ? "border-gray-800 bg-gray-800 text-white" : ""}`}>
                {label}
              </button>
            ))}
          </div>
          {kind === "invoice" && (
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm">
                <span className="text-gray-600">宛名</span>
                <input value={addressee} maxLength={50} onChange={(e) => setAddressee(e.target.value)} placeholder="空欄なら「上様」" className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">但し書き</span>
                <input value={note} maxLength={40} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">発行日</span>
                <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
              </label>
            </div>
          )}
          <button onClick={() => window.print()} className="w-full rounded-lg bg-berry py-3 text-lg font-bold text-white">
            印刷する
          </button>
          <p className="text-xs text-gray-500">
            iPad・iPhoneでは、印刷の画面でプリンター（AirPrint）を選びます。PDFとして保存したいときは、印刷の画面でプレビューを2本指で広げると保存・共有できます。
          </p>
        </div>
        <p className="mt-4 text-sm text-gray-500">印刷のイメージ</p>
      </div>

      {/* 印刷される部分 */}
      <div className="mt-2 flex justify-center print:mt-0 print:block">
        <article
          className={`relative bg-white text-black shadow print:shadow-none ${
            paper === "narrow" ? "w-[76mm] px-[3mm] py-[4mm] text-[11pt]" : "w-[180mm] px-[12mm] py-[12mm] text-[12pt]"
          }`}
        >
          {voided && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-6xl font-bold text-red-500/40">取消</div>
          )}
          {kind === "receipt" ? (
            <ReceiptBody s={s} sale={sale} time={time} />
          ) : (
            <InvoiceBody s={s} sale={sale} addressee={addressee} note={note} issueDate={issueDate} wide={paper === "a4"} />
          )}
        </article>
      </div>

      {/* 用紙の余白を小さくする */}
      <style>{`@media print { @page { margin: ${paper === "narrow" ? "4mm" : "12mm"}; } body { background: #fff !important; } }`}</style>
    </>
  );
}

function StoreInfo({ s, center = true }: { s: Settings; center?: boolean }) {
  return (
    <div className={center ? "text-center" : "ml-auto text-right"}>
      <div className="text-[1.2em] font-bold">{s.storeName || "（店名を設定してください）"}</div>
      {s.storeAddress && <div className="text-[0.85em]">{s.storeAddress}</div>}
      {s.storePhone && <div className="text-[0.85em]">TEL {s.storePhone}</div>}
      {/*
        インボイス（適格請求書）対応で追加する項目：
        - 登録番号（T+13桁）
        - 税率ごとの対象金額と消費税額
        税理士に確認のうえ、設定画面に項目を足してここに表示する
      */}
    </div>
  );
}

function ReceiptBody({ s, sale, time }: { s: Settings; sale: Sale; time?: string }) {
  return (
    <>
      <StoreInfo s={s} />
      <div className="mt-3 flex justify-between border-b border-dashed border-black pb-1 text-[0.85em]">
        <span>
          {formatJa(sale.date, true)} {time}
        </span>
        <span>No.{sale.id.slice(0, 6).toUpperCase()}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {sale.lines.map((l, i) => (
          <li key={i}>
            <div>{l.name}</div>
            <div className="flex justify-between pl-3 text-[0.9em]">
              <span>
                {yen(l.unitPrice)} × {l.qty}
                {l.discountRate > 0 && `（${l.discountRate}%引）`}
              </span>
              <span>{yen(l.amount)}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-2 space-y-0.5 border-t border-dashed border-black pt-2">
        <Row label="小計" value={yen(sale.subtotal)} />
        {sale.discountTotal > 0 && <Row label="値引き" value={`−${yen(sale.discountTotal)}`} />}
        <Row label="合計" value={yen(sale.total)} big />
        <div className="text-right text-[0.8em]">（税込）</div>
        <Row label="お支払い" value={sale.payment === "credit" ? "後日のお支払い（売掛）" : PAYMENT_LABEL.cash} />
      </div>
      <p className="mt-3 text-center text-[0.85em]">ご来園ありがとうございました</p>
    </>
  );
}

function InvoiceBody({
  s,
  sale,
  addressee,
  note,
  issueDate,
  wide,
}: {
  s: Settings;
  sale: Sale;
  addressee: string;
  note: string;
  issueDate: string;
  wide: boolean;
}) {
  return (
    <>
      <h2 className="text-center text-[1.6em] font-bold tracking-[0.5em]">領収書</h2>
      <div className="mt-1 text-right text-[0.85em]">
        No.{sale.id.slice(0, 6).toUpperCase()}　{formatJa(issueDate, true)}
      </div>
      <div className="mt-3 border-b border-black pb-1 text-[1.2em]">{addressee.trim() || "上"} 様</div>
      <div className="mt-4 border-2 border-black py-2 text-center text-[1.8em] font-bold">¥{sale.total.toLocaleString("ja-JP")}-</div>
      <div className="mt-1 text-right text-[0.85em]">（税込）</div>
      <div className="mt-3">但し　{note}</div>
      <div className="mt-1">上記正に領収いたしました</div>
      <div className={`mt-6 flex items-end ${wide ? "justify-between" : "flex-col gap-3"}`}>
        {sale.total >= STAMP_THRESHOLD && (
          <div className="flex h-[22mm] w-[22mm] items-center justify-center border border-dashed border-black text-[0.75em]">収入印紙</div>
        )}
        <StoreInfo s={s} center={!wide} />
      </div>
    </>
  );
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className={`flex justify-between ${big ? "text-[1.3em] font-bold" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
