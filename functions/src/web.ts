// お客様用：Webからの予約受付（ログイン不要）
// ・入力内容と受付期間をサーバー側で確認する
// ・残り人数の確認と保存を1つのトランザクションで行い、同時に申し込まれても定員を超えない
// ・連続送信を制限する（いたずら対策）
// ・お客様には予約番号だけを返し、他の予約の内容は一切返さない
import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "./common.js";
import { buildReservation, capacityFor, parseReservationInput, type ReservationDoc } from "./reservations.js";

type WebSettings = {
  seasonStart: string;
  seasonEnd: string;
  closedDates: string[];
  bookingDaysAhead: number;
  bookingCutoffDays: number;
  timeSlots: { id: string; time: string; capacity: number }[];
  priceCategories: { id: string; name: string }[];
  plans: { id: string; name: string; minutes: number; prices: Record<string, number>; public: boolean }[];
};

/** 連続送信の上限 */
const LIMITS = {
  /** 同じ接続元からの送信回数（失敗も含む）：1時間に10回まで */
  perIpPerHour: 10,
  /** 同じ電話番号での予約成立：1日に3件まで */
  perPhonePerDay: 3,
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** 日本時間の今日 "YYYY-MM-DD" */
function todayJST(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function inSeason(date: string, s: WebSettings): boolean {
  const md = date.slice(5);
  return s.seasonStart <= s.seasonEnd ? md >= s.seasonStart && md <= s.seasonEnd : md >= s.seasonStart || md <= s.seasonEnd;
}

/** 個人を特定できる値（IPアドレス・電話番号）はそのまま保存せず、元に戻せない形（ハッシュ）にする */
function hashKey(kind: string, value: string): string {
  return `${kind}_${createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 32)}`;
}

function clientIp(req: CallableRequest): string {
  // 送信元が先頭に好きな値を書き足せるため、Googleの受付サーバーが最後に付け加えた値を使う
  const fwd = req.rawRequest.headers["x-forwarded-for"];
  const last = (Array.isArray(fwd) ? fwd.join(",") : fwd)?.split(",").map((v) => v.trim()).filter(Boolean).at(-1);
  return last || req.rawRequest.ip || "unknown";
}

/** 決められた時間内の回数を数え、上限を超えていたら断る */
async function hitRateLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const ref = db.doc(`rateLimits/${key}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const start = (snap.get("windowStart") as Timestamp | undefined)?.toMillis() ?? 0;
    const inWindow = now - start < windowMs;
    const count = inWindow ? ((snap.get("count") as number | undefined) ?? 0) : 0;
    if (count >= limit) {
      throw new HttpsError("resource-exhausted", "短い時間に何度も予約が送られたため、受付を止めています。お手数ですがお電話でご予約ください。");
    }
    tx.set(ref, {
      count: count + 1,
      windowStart: inWindow ? Timestamp.fromMillis(start) : Timestamp.fromMillis(now),
      // 自動削除（Firestore の TTL）用
      expireAt: Timestamp.fromMillis(now + windowMs * 2),
    });
  });
}

/** 予約番号（お客様に伝える短い番号） */
function reservationCode(id: string): string {
  return id.slice(0, 6).toUpperCase();
}

export const createWebReservation = onCall(
  {
    // 予約ページからの呼び出しだけを受け付ける
    cors: [/^https:\/\/ichigo-[a-z0-9-]+\.(web\.app|firebaseapp\.com)$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
    maxInstances: 3,
  },
  async (req) => {
    // ロボットがよく埋める、画面には見えない入力欄（入っていたら受け付けたふりをして何もしない）
    if (typeof req.data?.website === "string" && req.data.website !== "") {
      logger.warn("honeypot hit");
      return { code: "------", status: "confirmed" };
    }

    const input = parseReservationInput({ ...req.data, memo: req.data?.memo ?? "", status: "confirmed" });
    /** 満員のときはリクエストとして送ってよいか（お客様が画面で同意したときだけ true） */
    const wantsRequest = req.data?.request === true;
    if (!input.phone) throw new HttpsError("invalid-argument", "電話番号を入力してください");
    if (input.phone.replace(/[^0-9]/g, "").length < 10) throw new HttpsError("invalid-argument", "電話番号が正しくありません");
    if (!input.email) throw new HttpsError("invalid-argument", "メールアドレスを入力してください");
    if (input.memo.length > 200) throw new HttpsError("invalid-argument", "ご要望は200文字以内にしてください");

    await hitRateLimit(hashKey("ip", clientIp(req)), LIMITS.perIpPerHour, 60 * 60 * 1000);
    const phoneRef = db.doc(`rateLimits/${hashKey("tel", input.phone.replace(/[^0-9]/g, ""))}`);

    const result = await db.runTransaction(async (tx) => {
      const sSnap = await tx.get(db.doc("settings/main"));
      if (!sSnap.exists) throw new HttpsError("unavailable", "ただいま予約を受け付けていません");
      const s = sSnap.data() as WebSettings;

      // 受付期間・休業日の確認（日付はすべて日本時間）
      const today = todayJST();
      const first = addDays(today, s.bookingCutoffDays ?? 1);
      const last = addDays(today, s.bookingDaysAhead ?? 30);
      if (input.date < first) throw new HttpsError("failed-precondition", "この日のWeb予約は締め切りました。お電話でお問い合わせください");
      if (input.date > last) throw new HttpsError("failed-precondition", "この日はまだ予約を受け付けていません");
      if (!inSeason(input.date, s) || (s.closedDates ?? []).includes(input.date)) {
        throw new HttpsError("failed-precondition", "この日は休業日です");
      }
      const plan = s.plans?.find((p) => p.id === input.planId);
      if (!plan?.public) throw new HttpsError("invalid-argument", "このプランはWebでは予約できません");

      const next: ReservationDoc = buildReservation(input, s, "web");

      // 同じ電話番号での予約が多すぎないか
      const pSnap = await tx.get(phoneRef);
      const nowMs = Date.now();
      const pStart = (pSnap.get("windowStart") as Timestamp | undefined)?.toMillis() ?? 0;
      const pInWindow = nowMs - pStart < DAY_MS;
      const pCount = pInWindow ? ((pSnap.get("count") as number | undefined) ?? 0) : 0;
      if (pCount >= LIMITS.perPhonePerDay) {
        throw new HttpsError("resource-exhausted", "同じ電話番号でのWeb予約が多いため、受付を止めています。お手数ですがお電話でご予約ください。");
      }

      const aRef = db.doc(`availability/${input.date}`);
      const aSnap = await tx.get(aRef);
      const slots = { ...((aSnap.get("slots") as Record<string, number> | undefined) ?? {}) };
      const capacity = await capacityFor(tx, input.date, next.slotId, s);
      const booked = slots[next.slotId] ?? 0;
      if (booked + next.people <= capacity) {
        // 定員以内：その場で確定
        next.status = "confirmed";
        slots[next.slotId] = booked + next.people;
      } else if (wantsRequest) {
        // 定員を超える：お店の承認待ちのリクエストとして受け付ける（定員には数えない）
        next.status = "request";
      } else {
        // 画面を見ている間に埋まった：リクエストとして送るかをお客様に確認してもらう
        const rest = Math.max(0, capacity - booked);
        throw new HttpsError(
          "resource-exhausted",
          rest === 0 ? "申し訳ありません。この時間はちょうど満員になりました。" : `申し訳ありません。この時間の残りは${rest}人になりました。`,
          { canRequest: true },
        );
      }

      const ref = db.collection("reservations").doc();
      const now = FieldValue.serverTimestamp();
      tx.set(ref, { ...next, code: reservationCode(ref.id), createdAt: now, updatedAt: now, createdBy: "web" });
      tx.set(db.doc(`reservationContacts/${ref.id}`), { date: next.date, phone: input.phone, email: input.email });
      if (next.status === "confirmed") tx.set(aRef, { slots, updatedAt: now });
      tx.set(phoneRef, {
        count: pCount + 1,
        windowStart: Timestamp.fromMillis(pInWindow ? pStart : nowMs),
        expireAt: Timestamp.fromMillis(nowMs + DAY_MS * 2),
      });
      return { id: ref.id, status: next.status };
    });

    return { code: reservationCode(result.id), status: result.status };
  },
);
