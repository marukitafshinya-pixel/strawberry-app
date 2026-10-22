// サーバー側の処理で共通して使う小道具
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

initializeApp();
setGlobalOptions({ region: "asia-northeast1", maxInstances: 5 });

export const db = getFirestore();

/** admin=管理者、staff=スタッフ、accounting=経理（現金出納帳を見るだけ） */
export type Role = "admin" | "staff" | "accounting";

// ---------- 入力チェックの小道具 ----------

export function requireString(v: unknown, label: string, max: number, min = 1): string {
  if (typeof v !== "string") throw new HttpsError("invalid-argument", `${label}を入力してください`);
  const s = v.trim();
  if (s.length < min) throw new HttpsError("invalid-argument", `${label}を入力してください`);
  if (s.length > max) throw new HttpsError("invalid-argument", `${label}は${max}文字以内にしてください`);
  return s;
}

export function requireEmail(v: unknown): string {
  const s = requireString(v, "メールアドレス", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpsError("invalid-argument", "メールアドレスの形が正しくありません");
  return s;
}

export function requirePassword(v: unknown): string {
  if (typeof v !== "string" || v.length < 8) throw new HttpsError("invalid-argument", "パスワードは8文字以上にしてください");
  if (v.length > 128) throw new HttpsError("invalid-argument", "パスワードが長すぎます");
  return v;
}

export function requireRole(v: unknown): Role {
  if (v !== "admin" && v !== "staff" && v !== "accounting") throw new HttpsError("invalid-argument", "権限を選んでください");
  return v;
}

/** 呼び出した人が、有効な管理者かを確認する */
export async function assertAdmin(req: CallableRequest): Promise<string> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  if (req.auth?.token.role !== "admin") throw new HttpsError("permission-denied", "管理者だけが操作できます");
  const me = await db.doc(`staff/${uid}`).get();
  if (!me.exists || me.get("active") !== true || me.get("role") !== "admin") {
    throw new HttpsError("permission-denied", "管理者だけが操作できます");
  }
  return uid;
}

/** 呼び出した人が、有効なスタッフ（管理者を含む）かを確認する */
export async function assertStaff(req: CallableRequest): Promise<string> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  const role = req.auth?.token.role;
  if (role !== "admin" && role !== "staff") throw new HttpsError("permission-denied", "スタッフだけが操作できます");
  const me = await db.doc(`staff/${uid}`).get();
  if (!me.exists || me.get("active") !== true) throw new HttpsError("permission-denied", "スタッフだけが操作できます");
  return uid;
}

// ---------- 役割ごとに見せる画面（設定 →「役割ごとの見せる画面」。config/rolePerms） ----------
// 画面の名前は web/src/lib/perms.ts と firestore.rules の permsOf と同じ

/** 決めていないときの、はじめの見せ方 */
export const DEFAULT_PERMS: Record<"staff" | "accounting", string[]> = {
  staff: ["reservations", "checkout", "receivables", "customers", "dashboard", "reservationReport", "shift", "harvest", "shipping", "store", "weather"],
  accounting: ["cashbook", "payrollView", "ledger"],
};

/**
 * 呼び出した人が、fs のどれかの画面を使える人かを確認する（管理者はいつも使える）。
 * スタッフ・経理は、スタッフ名簿で有効で、その役割に画面を見せているとき
 */
export async function assertCan(req: CallableRequest, fs: string[]): Promise<string> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  const role = req.auth?.token.role;
  if (role !== "admin" && role !== "staff" && role !== "accounting") throw new HttpsError("permission-denied", "この操作はできません");
  const me = await db.doc(`staff/${uid}`).get();
  if (!me.exists || me.get("active") !== true || me.get("role") !== role) throw new HttpsError("permission-denied", "この操作はできません");
  if (role === "admin") return uid;
  const saved = (await db.doc("config/rolePerms").get()).get(role) as string[] | undefined;
  const perms = Array.isArray(saved) ? saved : DEFAULT_PERMS[role as "staff" | "accounting"];
  if (!fs.some((f) => perms.includes(f))) throw new HttpsError("permission-denied", "この画面は使えません。管理者に頼んでください");
  return uid;
}
