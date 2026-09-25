// サーバー側の処理（Cloud Functions）
// お客様やスタッフの端末では任せられない処理（権限の付与・スタッフ追加・予約の受付など）をここで行う。
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertAdmin, db, requireEmail, requirePassword, requireRole, requireString } from "./common.js";

export { deleteReservation, saveReservation, setReservationStatus } from "./reservations.js";
export { createWebReservation } from "./web.js";
export { checkout, deleteReceivable, saveReceivable, voidSale } from "./sales.js";

async function countActiveAdmins(): Promise<number> {
  const snap = await db.collection("staff").where("role", "==", "admin").where("active", "==", true).count().get();
  return snap.data().count;
}

// ---------- 最初の管理者の登録 ----------

/**
 * まだ管理者が1人もいないときだけ、呼び出した人を管理者にする。
 * 一度でも管理者が登録されたら、二度と使えない。
 * （Authentication の「新規登録」をオフにしておくことで、Firebaseの画面で作ったアカウントしか呼べない）
 */
export const claimFirstAdmin = onCall(async (req) => {
  const uid = req.auth?.uid;
  const email = req.auth?.token.email;
  if (!uid || !email) throw new HttpsError("unauthenticated", "ログインしてください");

  const bootstrapRef = db.doc("system/bootstrap");
  await db.runTransaction(async (tx) => {
    const b = await tx.get(bootstrapRef);
    // 前回、途中で失敗した本人のやり直しは認める
    if (b.exists && b.get("firstAdminUid") === uid) return;
    if (b.exists) throw new HttpsError("failed-precondition", "管理者はすでに登録されています。管理者に追加を頼んでください");
    tx.set(bootstrapRef, { firstAdminUid: uid, at: FieldValue.serverTimestamp() });
    tx.set(db.doc(`staff/${uid}`), {
      email,
      displayName: req.auth?.token.name ?? email.split("@")[0],
      role: "admin",
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await getAuth().setCustomUserClaims(uid, { role: "admin" });
  return { ok: true };
});

// ---------- スタッフの追加・変更（管理者のみ） ----------

export const createStaff = onCall(async (req) => {
  await assertAdmin(req);
  const email = requireEmail(req.data?.email);
  const password = requirePassword(req.data?.password);
  const displayName = requireString(req.data?.displayName, "名前", 30);
  const role = requireRole(req.data?.role);

  let uid: string;
  try {
    const user = await getAuth().createUser({ email, password, displayName });
    uid = user.uid;
  } catch (e) {
    if ((e as { code?: string }).code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "このメールアドレスはすでに登録されています");
    }
    throw e;
  }
  await getAuth().setCustomUserClaims(uid, { role });
  await db.doc(`staff/${uid}`).set({
    email,
    displayName,
    role,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { uid };
});

/**
 * スタッフの名前・権限・有効/無効・パスワードを変更する。
 * 管理者が0人になる変更はできない。
 */
export const updateStaff = onCall(async (req) => {
  const myUid = await assertAdmin(req);
  const uid = requireString(req.data?.uid, "対象", 128);
  const ref = db.doc(`staff/${uid}`);
  const current = await ref.get();
  if (!current.exists) throw new HttpsError("not-found", "スタッフが見つかりません");

  const patch: Record<string, unknown> = {};
  const authPatch: { displayName?: string; password?: string; disabled?: boolean } = {};

  if (req.data?.displayName !== undefined) {
    patch.displayName = authPatch.displayName = requireString(req.data.displayName, "名前", 30);
  }
  if (req.data?.role !== undefined) patch.role = requireRole(req.data.role);
  if (req.data?.active !== undefined) {
    if (typeof req.data.active !== "boolean") throw new HttpsError("invalid-argument", "有効/無効の指定が正しくありません");
    patch.active = req.data.active;
    authPatch.disabled = !req.data.active;
  }
  if (req.data?.password !== undefined) authPatch.password = requirePassword(req.data.password);

  const willBeAdmin = (patch.role ?? current.get("role")) === "admin" && (patch.active ?? current.get("active")) === true;
  const isAdminNow = current.get("role") === "admin" && current.get("active") === true;
  if (isAdminNow && !willBeAdmin) {
    if (uid === myUid) throw new HttpsError("failed-precondition", "自分自身の管理者権限は外せません。別の管理者に頼んでください");
    if ((await countActiveAdmins()) <= 1) throw new HttpsError("failed-precondition", "管理者が0人になるため変更できません");
  }

  if (Object.keys(authPatch).length > 0) await getAuth().updateUser(uid, authPatch);
  if (patch.role !== undefined) await getAuth().setCustomUserClaims(uid, { role: patch.role });
  // 権限を変えた・無効にした・パスワードを変えたときは、その人を一度ログアウトさせる
  if (patch.role !== undefined || patch.active === false || authPatch.password) {
    await getAuth().revokeRefreshTokens(uid);
  }
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
