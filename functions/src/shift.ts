// 勤務管理表：従業員のログインと、休みの希望の受付
// 従業員（role = worker）は、勤務の表と自分の希望しか見られない。希望の受付は締め切りなどを確かめるためサーバー側で行う。
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { assertAdmin, db, requirePassword, requireString } from "./common.js";

/** ログインIDだけでログインする従業員のための、決まったメールアドレスの形（実在しないドメイン） */
export const WORKER_EMAIL_DOMAIN = "ichigo-staff.invalid";

function requireLoginId(v: unknown): string {
  const s = requireString(v, "ログインID", 30, 3).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(s)) throw new HttpsError("invalid-argument", "ログインIDは、半角の英字・数字（3〜30文字）にしてください");
  return s;
}

/** 従業員のログインを作る（管理者） */
export const createWorkerLogin = onCall(async (req) => {
  await assertAdmin(req);
  const memberId = requireString(req.data?.memberId, "従業員", 64);
  const loginId = requireLoginId(req.data?.loginId);
  const password = requirePassword(req.data?.password);
  const mRef = db.doc(`shiftMembers/${memberId}`);
  const m = await mRef.get();
  if (!m.exists) throw new HttpsError("not-found", "従業員が見つかりません");
  if (m.get("uid")) throw new HttpsError("already-exists", "この従業員には、すでにログインがあります");
  const name = String(m.get("name") ?? "").slice(0, 30) || loginId;

  let uid: string;
  try {
    uid = (await getAuth().createUser({ email: `${loginId}@${WORKER_EMAIL_DOMAIN}`, password, displayName: name })).uid;
  } catch (e) {
    if ((e as { code?: string }).code === "auth/email-already-exists") throw new HttpsError("already-exists", "このログインIDはすでに使われています");
    throw e;
  }
  await getAuth().setCustomUserClaims(uid, { role: "worker" });
  const now = FieldValue.serverTimestamp();
  await db.doc(`workers/${uid}`).set({ memberId, loginId, active: true, createdAt: now, updatedAt: now });
  await mRef.update({ uid, loginId, updatedAt: now });
  return { uid };
});

/** 従業員のログインを変える（パスワードの変更・使えなくする・使えるようにする）（管理者） */
export const updateWorkerLogin = onCall(async (req) => {
  await assertAdmin(req);
  const memberId = requireString(req.data?.memberId, "従業員", 64);
  const m = await db.doc(`shiftMembers/${memberId}`).get();
  const uid = m.get("uid") as string | undefined;
  if (!m.exists || !uid) throw new HttpsError("not-found", "この従業員にはログインがありません");
  const authPatch: { password?: string; disabled?: boolean } = {};
  const patch: Record<string, unknown> = {};
  if (req.data?.password !== undefined) authPatch.password = requirePassword(req.data.password);
  if (req.data?.active !== undefined) {
    if (typeof req.data.active !== "boolean") throw new HttpsError("invalid-argument", "指定が正しくありません");
    authPatch.disabled = !req.data.active;
    patch.active = req.data.active;
  }
  if (Object.keys(authPatch).length) await getAuth().updateUser(uid, authPatch);
  if (authPatch.password || patch.active === false) await getAuth().revokeRefreshTokens(uid);
  await db.doc(`workers/${uid}`).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

/**
 * 従業員を勤務管理表から削除する（管理者）。ログインがあればログインも消す。
 * その人の休みの希望と、勤務表のマスの記号も消す（残したいときは「表に出す」を外す）
 */
export const deleteShiftMember = onCall(async (req) => {
  await assertAdmin(req);
  const memberId = requireString(req.data?.memberId, "従業員", 64);
  const mRef = db.doc(`shiftMembers/${memberId}`);
  const m = await mRef.get();
  if (!m.exists) throw new HttpsError("not-found", "従業員が見つかりません");
  const uid = m.get("uid") as string | undefined;
  if (uid) {
    try {
      await getAuth().deleteUser(uid);
    } catch (e) {
      if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
    }
    await db.doc(`workers/${uid}`).delete();
  }
  const writer = db.bulkWriter();
  const reqs = await db.collection("shiftRequests").where("memberId", "==", memberId).get();
  for (const r of reqs.docs) void writer.delete(r.ref);
  const days = await db.collection("shiftDays").get();
  for (const d of days.docs) {
    const cells = (d.get("cells") as Record<string, unknown> | undefined) ?? {};
    if (memberId in cells) void writer.update(d.ref, { [`cells.${memberId}`]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  }
  void writer.delete(mRef);
  await writer.close();
  return { ok: true };
});

/** 呼び出した人が有効な従業員なら、その従業員（勤務の表の行）のIDを返す */
async function assertWorker(req: CallableRequest): Promise<{ uid: string; memberId: string }> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  if (req.auth?.token.role !== "worker") throw new HttpsError("permission-denied", "従業員のログインで操作してください");
  const w = await db.doc(`workers/${uid}`).get();
  if (!w.exists || w.get("active") !== true) throw new HttpsError("permission-denied", "このログインは使えません");
  const memberId = w.get("memberId") as string;
  const m = await db.doc(`shiftMembers/${memberId}`).get();
  if (!m.exists || m.get("uid") !== uid || m.get("active") === false) throw new HttpsError("permission-denied", "勤務の表に名前がありません。管理者に確認してください");
  return { uid, memberId };
}

/** 日本時間の今日（YYYY-MM-DD） */
function todayJST(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** 休みの希望を出す（従業員）。同じ日の、まだ決まっていない希望は出しなおせる */
export const submitShiftRequest = onCall(async (req) => {
  const { uid, memberId } = await assertWorker(req);
  const date = requireString(req.data?.date, "日付", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new HttpsError("invalid-argument", "日付が正しくありません");
  const code = requireString(req.data?.code, "希望", 20);
  const memo = typeof req.data?.memo === "string" ? req.data.memo.trim().slice(0, 100) : "";

  const cfg = await db.doc("config/shift").get();
  const codes = (cfg.get("codes") as { code: string; req?: boolean }[] | undefined) ?? DEFAULT_REQUEST_CODES.map((c) => ({ code: c, req: true }));
  if (!codes.some((c) => c.code === code && c.req)) throw new HttpsError("invalid-argument", "この希望は出せません");
  const cutoff = Number(cfg.get("cutoffDays") ?? 7);
  const first = addDays(todayJST(), cutoff);
  if (date < first) throw new HttpsError("failed-precondition", `希望は${cutoff}日前までです（${Number(first.slice(5, 7))}月${Number(first.slice(8))}日から出せます）`);
  if (date > addDays(todayJST(), 400)) throw new HttpsError("invalid-argument", "先すぎる日付です");

  const ref = db.doc(`shiftRequests/${memberId}_${date}`);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (cur.exists && cur.get("status") !== "pending") throw new HttpsError("failed-precondition", "この日の希望はもう決まっています。変えたいときは管理者に伝えてください");
    tx.set(ref, { memberId, uid, date, code, memo, status: "pending", createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

/** 出した希望を取り消す（従業員。まだ決まっていないものだけ） */
export const cancelShiftRequest = onCall(async (req) => {
  const { uid } = await assertWorker(req);
  const id = requireString(req.data?.id, "希望", 80);
  const ref = db.doc(`shiftRequests/${id}`);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists) return;
    if (cur.get("uid") !== uid) throw new HttpsError("permission-denied", "自分の希望だけ取り消せます");
    if (cur.get("status") !== "pending") throw new HttpsError("failed-precondition", "この希望はもう決まっています。変えたいときは管理者に伝えてください");
    tx.delete(ref);
  });
  return { ok: true };
});

/** 設定がまだないときに、従業員が出せる希望 */
export const DEFAULT_REQUEST_CODES = ["希休", "AM", "PM", "～12:00", "～13:00", "～14:00", "～15:00", "～16:00"];
