// 会計・売掛（スタッフ用）
// 会計の確定・取消と、売掛の作成・削除は、1つのトランザクションでまとめて行う。
// こうすることで「会計はあるのに売掛がない」といったずれが起きない。
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertStaff, db, requireString } from "./common.js";

export type PaymentMethod = "cash" | "credit";

/** 会計の明細1行 */
export type SaleLine = {
  kind: "plan" | "product" | "custom";
  /** プランID・商品IDなど（手入力の行は空） */
  refId: string;
  name: string;
  /** 売上の分類（例：いちご狩り、お土産、ドリンク） */
  category: string;
  /** 税込の単価 */
  unitPrice: number;
  qty: number;
  /** 割引率（%）0〜100 */
  discountRate: number;
  /** この行の金額（値引き後・1円未満切り捨て） */
  amount: number;
  /** 消費税率（%）。8 は軽減税率 */
  taxRate: 8 | 10;
};

export type SaleDoc = {
  /** 売上日（日本時間 "YYYY-MM-DD"） */
  date: string;
  reservationId: string | null;
  customerName: string;
  lines: SaleLine[];
  /** 値引き前の合計 */
  subtotal: number;
  /** 値引きの合計 */
  discountTotal: number;
  /** お支払い金額 */
  total: number;
  payment: PaymentMethod;
  status: "completed" | "voided";
  receivableId: string | null;
  memo: string;
};

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function todayJST(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function requireInt(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpsError("invalid-argument", `${label}が正しくありません`);
  }
  return v;
}

/** 明細の金額を計算する（割引は1円未満切り捨て） */
export function lineAmount(unitPrice: number, qty: number, discountRate: number): number {
  return Math.floor((unitPrice * qty * (100 - discountRate)) / 100);
}

function parseLines(raw: unknown): SaleLine[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpsError("invalid-argument", "明細を1つ以上入れてください");
  if (raw.length > 100) throw new HttpsError("invalid-argument", "明細が多すぎます");
  return raw.map((l: Record<string, unknown>) => {
    const kind = l?.kind;
    if (kind !== "plan" && kind !== "product" && kind !== "custom") throw new HttpsError("invalid-argument", "明細の種類が正しくありません");
    const name = requireString(l.name, "明細の名前", 50);
    const category = typeof l.category === "string" && l.category.trim() ? l.category.trim().slice(0, 20) : "その他";
    const unitPrice = requireInt(l.unitPrice, `「${name}」の単価`, 0, 10_000_000);
    const qty = requireInt(l.qty, `「${name}」の数量`, 1, 9999);
    const discountRate = requireInt(l.discountRate ?? 0, `「${name}」の割引率`, 0, 100);
    const refId = typeof l.refId === "string" ? l.refId.slice(0, 64) : "";
    const taxRate = l.taxRate === 8 ? 8 : 10;
    // 金額は画面から届いた値を使わず、ここで計算し直す
    return { kind, refId, name, category, unitPrice, qty, discountRate, amount: lineAmount(unitPrice, qty, discountRate), taxRate };
  });
}

// ---------- 会計の確定 ----------

export const checkout = onCall(async (req) => {
  const uid = await assertStaff(req);
  const lines = parseLines(req.data?.lines);
  const payment = req.data?.payment as PaymentMethod;
  if (payment !== "cash" && payment !== "credit") throw new HttpsError("invalid-argument", "支払方法を選んでください");
  const customerName = typeof req.data?.customerName === "string" ? req.data.customerName.trim().slice(0, 50) : "";
  if (payment === "credit" && !customerName) throw new HttpsError("invalid-argument", "売掛のときは、お客様名が必要です");
  const memo = typeof req.data?.memo === "string" ? req.data.memo.trim().slice(0, 200) : "";
  const date = typeof req.data?.date === "string" && DATE_RE.test(req.data.date) ? req.data.date : todayJST();
  const reservationId = typeof req.data?.reservationId === "string" && req.data.reservationId ? req.data.reservationId : null;
  const dueDate = typeof req.data?.dueDate === "string" && DATE_RE.test(req.data.dueDate) ? req.data.dueDate : null;

  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const total = lines.reduce((n, l) => n + l.amount, 0);

  return db.runTransaction(async (tx) => {
    const rRef = reservationId ? db.doc(`reservations/${reservationId}`) : null;
    if (rRef) {
      const r = await tx.get(rRef);
      if (!r.exists) throw new HttpsError("not-found", "予約が見つかりません");
      if (r.get("saleId")) throw new HttpsError("already-exists", "この予約はすでに会計済みです。取り消してから会計し直してください");
    }
    const saleRef = db.collection("sales").doc();
    const recRef = payment === "credit" ? db.collection("receivables").doc() : null;
    const now = FieldValue.serverTimestamp();
    const sale: SaleDoc = {
      date,
      reservationId,
      customerName,
      lines,
      subtotal,
      discountTotal: subtotal - total,
      total,
      payment,
      status: "completed",
      receivableId: recRef?.id ?? null,
      memo,
    };
    tx.set(saleRef, { ...sale, createdAt: now, createdBy: uid });
    if (recRef) {
      tx.set(recRef, {
        customerName,
        amount: total,
        date,
        dueDate,
        status: "open",
        source: "sale",
        saleId: saleRef.id,
        memo,
        createdAt: now,
        createdBy: uid,
      });
    }
    if (rRef) tx.update(rRef, { saleId: saleRef.id, status: "visited", updatedAt: now, updatedBy: uid });
    return { id: saleRef.id, total };
  });
});

// ---------- 会計の取消 ----------

export const voidSale = onCall(async (req) => {
  const uid = await assertStaff(req);
  const id = requireString(req.data?.id, "会計", 64);
  const reason = typeof req.data?.reason === "string" ? req.data.reason.trim().slice(0, 200) : "";
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`sales/${id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "会計が見つかりません");
    const s = snap.data() as SaleDoc;
    if (s.status === "voided") return;
    const rRef = s.reservationId ? db.doc(`reservations/${s.reservationId}`) : null;
    const r = rRef ? await tx.get(rRef) : null;
    const now = FieldValue.serverTimestamp();
    tx.update(ref, { status: "voided", voidedAt: now, voidedBy: uid, voidReason: reason });
    // 会計から作られた売掛も消す
    if (s.receivableId) tx.delete(db.doc(`receivables/${s.receivableId}`));
    // 予約を「会計前」に戻す
    if (rRef && r?.exists && r.get("saleId") === id) tx.update(rRef, { saleId: FieldValue.delete(), updatedAt: now, updatedBy: uid });
  });
  return { ok: true };
});

// ---------- 売掛（手入力の追加・変更・削除） ----------

export const saveReceivable = onCall(async (req) => {
  const uid = await assertStaff(req);
  const id = req.data?.id === undefined ? null : requireString(req.data.id, "売掛", 64);
  const dueDate = req.data?.dueDate === null || req.data?.dueDate === "" ? null : req.data?.dueDate;
  if (dueDate !== null && dueDate !== undefined && (typeof dueDate !== "string" || !DATE_RE.test(dueDate))) {
    throw new HttpsError("invalid-argument", "回収予定日が正しくありません");
  }
  const memo = typeof req.data?.memo === "string" ? req.data.memo.trim().slice(0, 200) : undefined;
  const status = req.data?.status;
  if (status !== undefined && status !== "open" && status !== "collected") throw new HttpsError("invalid-argument", "状態が正しくありません");
  const now = FieldValue.serverTimestamp();

  if (!id) {
    // 手入力での新規追加
    const customerName = requireString(req.data?.customerName, "お客様名", 50);
    const amount = requireInt(req.data?.amount, "金額", 1, 100_000_000);
    const date = typeof req.data?.date === "string" && DATE_RE.test(req.data.date) ? req.data.date : todayJST();
    const ref = db.collection("receivables").doc();
    await ref.set({
      customerName,
      amount,
      date,
      dueDate: dueDate ?? null,
      status: "open",
      source: "manual",
      saleId: null,
      memo: memo ?? "",
      createdAt: now,
      createdBy: uid,
    });
    return { id: ref.id };
  }

  await db.runTransaction(async (tx) => {
    const ref = db.doc(`receivables/${id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "売掛が見つかりません");
    const patch: Record<string, unknown> = { updatedAt: now, updatedBy: uid };
    if (dueDate !== undefined) patch.dueDate = dueDate;
    if (memo !== undefined) patch.memo = memo;
    if (status === "collected") {
      patch.status = "collected";
      patch.collectedAt = now;
      patch.collectedDate =
        typeof req.data?.collectedDate === "string" && DATE_RE.test(req.data.collectedDate) ? req.data.collectedDate : todayJST();
    } else if (status === "open") {
      patch.status = "open";
      patch.collectedAt = FieldValue.delete();
      patch.collectedDate = FieldValue.delete();
    }
    // 手入力の売掛だけは、お客様名と金額も直せる（会計から作られたものは会計側が正）
    if (snap.get("source") === "manual") {
      if (req.data?.customerName !== undefined) patch.customerName = requireString(req.data.customerName, "お客様名", 50);
      if (req.data?.amount !== undefined) patch.amount = requireInt(req.data.amount, "金額", 1, 100_000_000);
    }
    tx.update(ref, patch);
  });
  return { id };
});

export const deleteReceivable = onCall(async (req) => {
  await assertStaff(req);
  const id = requireString(req.data?.id, "売掛", 64);
  const ref = db.doc(`receivables/${id}`);
  const snap = await ref.get();
  if (!snap.exists) return { ok: true };
  if (snap.get("source") === "sale") {
    throw new HttpsError("failed-precondition", "会計から作られた売掛は、会計を取り消すと消えます（日次締めの画面から取り消してください）");
  }
  await ref.delete();
  return { ok: true };
});
