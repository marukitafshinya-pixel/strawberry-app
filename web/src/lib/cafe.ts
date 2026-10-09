"use client";

// カフェの注文書（呼出番号つき）。支払いの前に、注文リストのカフェの分だけを印刷する
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { todayJST } from "./date";
import { getFirebase } from "./firebase";
import type { RLine } from "./receiptPrinter";
import type { Settings } from "./settings";

/** カフェの商品か（分類に「カフェ」が入っている）。店舗実績の分け方と同じ */
export const isCafeLine = (l: { kind: string; category: string }) => l.kind !== "plan" && l.category.includes("カフェ");

/** 今日の次の呼出番号（毎日1番から）。複数の端末で同時に押しても重ならないよう、サーバーの連番を1つ進める */
export async function nextCafeCallNo(): Promise<number> {
  const { db } = await getFirebase();
  const ref = doc(db, "cafeCalls", todayJST());
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists() ? Number(snap.get("last")) || 0 : 0;
    const next = last + 1;
    tx.set(ref, { last: next, updatedAt: serverTimestamp() });
    return next;
  });
}

/** 注文書1枚分（売り場控え・お客様控え）。品名と数量だけ（金額は会計のレシートに出る） */
export function cafeOrderSlip(
  s: Settings,
  o: { no: number; copy: "売り場控え" | "お客様控え"; lines: { name: string; qty: number }[]; customerName?: string; at?: Date },
): RLine[] {
  const when = (o.at ?? new Date()).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const count = o.lines.reduce((n, l) => n + l.qty, 0);
  const out: RLine[] = [
    { t: "row", left: `カフェ 注文書`, right: `【${o.copy}】`, bold: true },
    { t: "row", left: s.storeName || "", right: when, size: 0.85 },
    { t: "rule" },
    { t: "text", text: "お呼出番号", align: "center", size: 1.1 },
    { t: "box", text: String(o.no), size: 5 },
    { t: "space", h: 0.4 },
    ...(o.customerName ? [{ t: "text", text: `${o.customerName} 様`, align: "center", size: 1.1 } as RLine] : []),
    { t: "rule" },
  ];
  for (const l of o.lines) out.push({ t: "row", left: l.name, right: `× ${l.qty}`, size: 1.3, bold: true });
  out.push({ t: "rule" });
  out.push({ t: "row", left: "合計", right: `${count}点`, size: 1.1 });
  out.push({ t: "space" });
  out.push({
    t: "text",
    text: o.copy === "お客様控え" ? "番号をお呼びしますので、この控えをお持ちください" : "お渡しのときに、この控えの番号をお確かめください",
    align: "center",
    size: 0.85,
  });
  return out;
}
