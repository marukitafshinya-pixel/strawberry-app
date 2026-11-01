// 従業員が携帯で、自分のタイムカード集計表と給与明細を見る。
// 給与・タイムカードのデータは管理者だけが読めるので、サーバーで「ログインした本人の分だけ」を読んで渡す。
// 本人は、勤務の画面のログイン（workers/{uid} の memberId）と、給与の従業員（employees の memberId）で結びつける。
// 給与明細は、管理者が「従業員に公開する」を押した月だけ。本人の時給・交通費の日額は、タイムカード集計表の金額の計算に渡す（口座などは渡さない）
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "./common.js";

/** タイムカード集計表の金額（時給 × 時間・交通費）の計算に使う、本人の決まり */
const PAY_FIELDS = ["kind", "manager", "hourlyRate", "commutePerDay", "commuteTaxable"];

/** ログインした従業員の、給与の従業員（id・社員番号・名前・管理職か） */
async function me(req: CallableRequest) {
  const uid = req.auth?.uid;
  if (!uid || req.auth?.token.role !== "worker") throw new HttpsError("permission-denied", "従業員のログインで使います");
  const w = await db.doc(`workers/${uid}`).get();
  const memberId = w.get("memberId") as string | undefined;
  if (w.get("active") !== true || !memberId) throw new HttpsError("permission-denied", "使えません");
  const q = await db.collection("employees").where("memberId", "==", memberId).limit(1).get();
  const e = q.docs[0];
  if (!e) throw new HttpsError("not-found", "給与の従業員の登録と結びついていません。管理者に「従業員の登録」で結びつけてもらってください");
  // 本人の給与の決まり（区分・管理職・時給・交通費）：タイムカード集計表の金額の計算に使う
  const pay = Object.fromEntries(PAY_FIELDS.filter((k) => e.get(k) !== undefined).map((k) => [k, e.get(k)]));
  return { id: e.id, code: String(e.get("code") ?? ""), name: String(e.get("name") ?? ""), manager: e.get("manager") === true, pay };
}

const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * 自分のタイムカード：給与の月（YYYY-MM）の計算に要る暦の月（その月と前の月）の、自分のカードの打刻と、計算のルール。
 * 計算は画面側（web/src/lib/timecard.ts の computePerson）で行う
 */
export const myTimecard = onCall(async (req) => {
  const e = await me(req);
  const month = String((req.data as { month?: unknown } | undefined)?.month ?? "");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "月が正しくありません");
  const months = [shiftMonth(month, -1), month];
  const [cfgSnap, lock, ...docs] = await Promise.all([
    db.doc("config/timecard").get(),
    db.doc(`timecardLocks/${month}`).get(),
    ...months.map((ym) => db.doc(`timecards/${ym}`).get()),
  ]);
  const cfg = cfgSnap.data() ?? {};
  const map = (cfg.cards ?? {}) as Record<string, string>;
  // 自分のカード：ひも付けがあればそれ。なければ社員番号と同じ番号のカード（ほかの人にひも付いていないもの）
  const isMine = (card: string) => (map[card] ? map[card] === e.id : /^\d+$/.test(e.code.trim()) && Number(card) === Number(e.code));
  const data: Record<string, { cards: Record<string, unknown> }> = {};
  let card: string | null = null;
  months.forEach((ym, i) => {
    const cards = (docs[i].get("cards") ?? {}) as Record<string, unknown>;
    const mine = Object.keys(cards).find(isMine);
    if (mine) card ??= mine;
    data[ym] = { cards: mine ? { [mine]: cards[mine] } : {} };
  });
  card ??= Object.keys(map).find((c) => map[c] === e.id) ?? null;
  // 計算のルールだけ（カードのひも付けは渡さない）
  const rules = Object.fromEntries(
    ["startTimes", "roundIn", "inDir", "roundOut", "outDir", "breaks", "overtimeOver", "closeDay"].filter((k) => k in cfg).map((k) => [k, cfg[k]]),
  );
  // 確定した月は、確定したときの時給・交通費で計算する
  const locked = ((lock.get("people") ?? {}) as Record<string, Record<string, unknown>>)[e.id];
  const pay = locked ? Object.fromEntries(PAY_FIELDS.filter((k) => locked[k] !== undefined).map((k) => [k, locked[k]])) : e.pay;
  return { name: e.name, card, manager: e.manager, rules, data, locked: lock.exists, pay };
});

/** 自分の給与明細：公開された月の、自分の分（月・支給日・金額）。新しい月から */
export const myPayslips = onCall(async (req) => {
  const e = await me(req);
  const [snap, inv] = await Promise.all([db.collection("payrolls").where("published", "==", true).get(), db.doc("config/invoice").get()]);
  const slips = snap.docs
    .map((d) => ({
      month: d.id,
      paymentDate: String(d.get("paymentDate") ?? ""),
      row: ((d.get("rows") ?? {}) as Record<string, Record<string, number>>)[e.id],
    }))
    .filter((s) => s.row)
    .sort((a, b) => b.month.localeCompare(a.month));
  // 明細に出す会社の名前（請求書の設定の発行者名）
  return { name: e.name, code: e.code, company: String(inv.get("issuerName") ?? ""), slips };
});
