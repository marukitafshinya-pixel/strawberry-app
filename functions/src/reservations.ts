// 予約の保存・削除（スタッフ用）
// 予約・連絡先・空き状況の3つを、1つのトランザクション（途中で他の人が割り込めない処理）でまとめて書き込む。
// これにより、同時に予約が入っても「残り人数」がずれない。
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertStaff, db, requireString } from "./common.js";

/** request = 定員を超えたためのリクエスト（お店の承認待ち） */
export type ReservationStatus = "request" | "tentative" | "confirmed" | "visited" | "cancelled";
const STATUSES: ReservationStatus[] = ["request", "tentative", "confirmed", "visited", "cancelled"];

type SettingsLite = {
  timeSlots: { id: string; time: string; capacity: number }[];
  priceCategories: { id: string; name: string }[];
  plans: { id: string; name: string; minutes: number; prices: Record<string, number>; public: boolean }[];
};

/** 予約1件の中身（Firestore の reservations/{id}） */
export type ReservationDoc = {
  date: string;
  slotId: string;
  slotTime: string;
  planId: string;
  planName: string;
  planMinutes: number;
  /** 料金区分ごとの人数と単価（予約時点の料金を控えておく） */
  lines: { categoryId: string; name: string; unitPrice: number; qty: number }[];
  people: number;
  amount: number;
  customerName: string;
  memo: string;
  status: ReservationStatus;
  source: "staff" | "web";
};

/** 定員に数える予約か（キャンセルと、承認前のリクエストは数えない） */
export function countsTowardCapacity(status: ReservationStatus): boolean {
  return status !== "cancelled" && status !== "request";
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export async function loadSettings(tx: Transaction): Promise<SettingsLite> {
  const snap = await tx.get(db.doc("settings/main"));
  if (!snap.exists) throw new HttpsError("failed-precondition", "先に設定画面で時間枠やプランを保存してください");
  const s = snap.data() as Partial<SettingsLite>;
  return { timeSlots: s.timeSlots ?? [], priceCategories: s.priceCategories ?? [], plans: s.plans ?? [] };
}

export type ReservationInput = {
  date: string;
  slotId: string;
  planId: string;
  counts: Record<string, number>;
  customerName: string;
  phone: string;
  email: string;
  memo: string;
  status: ReservationStatus;
};

/** 画面から届いた内容をチェックして整える */
export function parseReservationInput(data: Record<string, unknown> | undefined): ReservationInput {
  const date = requireString(data?.date, "日付", 10);
  if (!DATE_RE.test(date)) throw new HttpsError("invalid-argument", "日付が正しくありません");
  const slotId = requireString(data?.slotId, "時間枠", 50);
  const planId = requireString(data?.planId, "プラン", 50);
  const rawCounts = data?.counts;
  if (typeof rawCounts !== "object" || rawCounts === null) throw new HttpsError("invalid-argument", "人数を入力してください");
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawCounts)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 999) throw new HttpsError("invalid-argument", "人数が正しくありません");
    if (v > 0) counts[k] = v;
  }
  const customerName = requireString(data?.customerName, "お名前", 50);
  const phone = typeof data?.phone === "string" ? data.phone.trim() : "";
  if (phone.length > 20 || (phone && !/^[0-9+\-() ]+$/.test(phone))) throw new HttpsError("invalid-argument", "電話番号が正しくありません");
  const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new HttpsError("invalid-argument", "メールアドレスが正しくありません");
  const memo = typeof data?.memo === "string" ? data.memo.trim() : "";
  if (memo.length > 500) throw new HttpsError("invalid-argument", "メモは500文字以内にしてください");
  const status = (data?.status ?? "confirmed") as ReservationStatus;
  if (!STATUSES.includes(status)) throw new HttpsError("invalid-argument", "ステータスが正しくありません");
  return { date, slotId, planId, counts, customerName, phone, email, memo, status };
}

/** 設定と照らし合わせて、保存する予約の中身を作る */
export function buildReservation(input: ReservationInput, s: SettingsLite, source: "staff" | "web"): ReservationDoc {
  const slot = s.timeSlots.find((t) => t.id === input.slotId);
  if (!slot) throw new HttpsError("invalid-argument", "時間枠が見つかりません。設定が変わった可能性があります");
  const plan = s.plans.find((p) => p.id === input.planId);
  if (!plan) throw new HttpsError("invalid-argument", "プランが見つかりません。設定が変わった可能性があります");
  const lines = Object.entries(input.counts).map(([categoryId, qty]) => {
    const cat = s.priceCategories.find((c) => c.id === categoryId);
    const unitPrice = plan.prices[categoryId];
    if (!cat || unitPrice === undefined) throw new HttpsError("invalid-argument", "このプランでは選べない料金区分があります");
    return { categoryId, name: cat.name, unitPrice, qty };
  });
  // 設定画面の区分の並び順にそろえる
  const order = s.priceCategories.map((c) => c.id);
  lines.sort((a, b) => order.indexOf(a.categoryId) - order.indexOf(b.categoryId));
  const people = lines.reduce((n, l) => n + l.qty, 0);
  if (people < 1) throw new HttpsError("invalid-argument", "人数を1人以上にしてください");
  return {
    date: input.date,
    slotId: slot.id,
    slotTime: slot.time,
    planId: plan.id,
    planName: plan.name,
    planMinutes: plan.minutes,
    lines,
    people,
    amount: lines.reduce((n, l) => n + l.unitPrice * l.qty, 0),
    customerName: input.customerName,
    memo: input.memo,
    status: input.status,
    source,
  };
}

/** 空き状況のドキュメント（availability/{日付}）: 時間枠ごとの予約人数だけを持つ。誰でも読める */
const availabilityRef = (date: string) => db.doc(`availability/${date}`);

/**
 * その日・その時間枠の定員。
 * 「この日だけの定員」（dailyCapacity/{日付}）があればそれを、なければ設定画面の定員を使う。
 * トランザクションの中で読むので、定員の変更と予約が同時に起きてもずれない。
 */
/** Web予約の受付を止めている時間枠か（dailyCapacity/{日付} の stopped） */
export async function isWebStopped(tx: Transaction, date: string, slotId: string): Promise<boolean> {
  const snap = await tx.get(db.doc(`dailyCapacity/${date}`));
  return (snap.get("stopped") as Record<string, boolean> | undefined)?.[slotId] === true;
}

export async function capacityFor(tx: Transaction, date: string, slotId: string, s: SettingsLite): Promise<number> {
  const snap = await tx.get(db.doc(`dailyCapacity/${date}`));
  const override = (snap.get("slots") as Record<string, number> | undefined)?.[slotId];
  if (typeof override === "number") return override;
  return s.timeSlots.find((t) => t.id === slotId)?.capacity ?? Infinity;
}

// ---------- スタッフ用：予約の追加・変更 ----------

export const saveReservation = onCall(async (req) => {
  const uid = await assertStaff(req);
  const input = parseReservationInput(req.data);
  const id = req.data?.id === undefined ? null : requireString(req.data.id, "予約", 64);
  const force = req.data?.force === true;

  return db.runTransaction(async (tx) => {
    const settings = await loadSettings(tx);
    const ref = id ? db.doc(`reservations/${id}`) : db.collection("reservations").doc();
    const old = id ? await tx.get(ref) : null;
    if (id && !old?.exists) throw new HttpsError("not-found", "予約が見つかりません。削除された可能性があります");
    const before = old?.data() as ReservationDoc | undefined;

    const next = buildReservation(input, settings, before?.source ?? "staff");

    // 空き状況を読む（日付が変わるときは両方の日）
    const dates = [...new Set([next.date, before?.date].filter((d): d is string => !!d))];
    const avail = new Map<string, Record<string, number>>();
    for (const d of dates) {
      const snap = await tx.get(availabilityRef(d));
      avail.set(d, { ...((snap.get("slots") as Record<string, number> | undefined) ?? {}) });
    }
    const capacity = await capacityFor(tx, next.date, next.slotId, settings);

    // 古い予約の分を引いて、新しい予約の分を足す
    if (before && countsTowardCapacity(before.status)) {
      const m = avail.get(before.date)!;
      m[before.slotId] = Math.max(0, (m[before.slotId] ?? 0) - before.people);
    }
    if (countsTowardCapacity(next.status)) {
      const m = avail.get(next.date)!;
      const booked = m[next.slotId] ?? 0;
      if (booked + next.people > capacity && !force) {
        // 画面で「それでも登録しますか？」と確認するための情報を返す
        throw new HttpsError("resource-exhausted", `定員を超えます（${next.slotTime}の枠：残り${Math.max(0, capacity - booked)}人）`, {
          remaining: Math.max(0, capacity - booked),
          capacity,
        });
      }
      m[next.slotId] = booked + next.people;
    }

    const now = FieldValue.serverTimestamp();
    tx.set(ref, {
      ...next,
      updatedAt: now,
      updatedBy: uid,
      ...(before ? {} : { createdAt: now, createdBy: uid }),
    }, { merge: true });
    // 連絡先はスタッフだけが読める別の場所に保存する
    tx.set(db.doc(`reservationContacts/${ref.id}`), { date: next.date, phone: input.phone, email: input.email });
    for (const [d, slots] of avail) tx.set(availabilityRef(d), { slots, updatedAt: now });
    return { id: ref.id };
  });
});

// ---------- スタッフ用：予約の削除 ----------

export const deleteReservation = onCall(async (req) => {
  await assertStaff(req);
  const id = requireString(req.data?.id, "予約", 64);
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`reservations/${id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const r = snap.data() as ReservationDoc;
    if (snap.get("saleId")) throw new HttpsError("failed-precondition", "会計済みの予約は削除できません。先に会計を取り消してください");
    const aRef = availabilityRef(r.date);
    const a = await tx.get(aRef);
    if (countsTowardCapacity(r.status)) {
      const slots = { ...((a.get("slots") as Record<string, number> | undefined) ?? {}) };
      slots[r.slotId] = Math.max(0, (slots[r.slotId] ?? 0) - r.people);
      tx.set(aRef, { slots, updatedAt: FieldValue.serverTimestamp() });
    }
    tx.delete(ref);
    tx.delete(db.doc(`reservationContacts/${id}`));
  });
  return { ok: true };
});

// ---------- スタッフ用：ステータスだけを変える（「来店」ボタンなど） ----------

export const setReservationStatus = onCall(async (req) => {
  const uid = await assertStaff(req);
  const id = requireString(req.data?.id, "予約", 64);
  const status = req.data?.status as ReservationStatus;
  if (!STATUSES.includes(status)) throw new HttpsError("invalid-argument", "ステータスが正しくありません");
  const force = req.data?.force === true;

  await db.runTransaction(async (tx) => {
    const ref = db.doc(`reservations/${id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "予約が見つかりません。削除された可能性があります");
    const r = snap.data() as ReservationDoc;
    const wasCounted = countsTowardCapacity(r.status);
    const willCount = countsTowardCapacity(status);
    if (wasCounted !== willCount) {
      const settings = await loadSettings(tx);
      const capacity = await capacityFor(tx, r.date, r.slotId, settings);
      const aRef = availabilityRef(r.date);
      const a = await tx.get(aRef);
      const slots = { ...((a.get("slots") as Record<string, number> | undefined) ?? {}) };
      const booked = slots[r.slotId] ?? 0;
      if (willCount) {
        // キャンセルを取り消すときは、また定員に数えるので空きを確認する
        if (booked + r.people > capacity && !force) {
          throw new HttpsError("resource-exhausted", `定員を超えます（${r.slotTime}の枠：残り${Math.max(0, capacity - booked)}人）`);
        }
        slots[r.slotId] = booked + r.people;
      } else {
        slots[r.slotId] = Math.max(0, booked - r.people);
      }
      tx.set(aRef, { slots, updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  });
  return { ok: true };
});
