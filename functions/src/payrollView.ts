// 経理担当が給与を見る（見るだけ）。給与のデータ（payrolls）は管理者だけが読めるので、サーバーで読んで必要なものだけ渡す。
// 従業員は 名前・社員番号・区分 だけ（口座・時給・交通費などは渡さない）。会社の支払口座も渡さない。タイムカードも渡さない
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "./common.js";

export const viewPayroll = onCall(async (req) => {
  const uid = req.auth?.uid;
  const role = req.auth?.token.role;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  if (role !== "accounting" && role !== "admin") throw new HttpsError("permission-denied", "経理担当と管理者だけが見られます");
  const me = await db.doc(`staff/${uid}`).get();
  if (!me.exists || me.get("active") !== true) throw new HttpsError("permission-denied", "経理担当と管理者だけが見られます");
  const month = String((req.data as { month?: unknown } | undefined)?.month ?? "");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "月が正しくありません");

  const [p, emps] = await Promise.all([db.doc(`payrolls/${month}`).get(), db.collection("employees").get()]);
  if (!p.exists) return { exists: false, paymentDate: "", rows: {}, employer: {}, memo: "", people: [] };
  const rows = (p.get("rows") as Record<string, Record<string, number>> | undefined) ?? {};
  // その月に給与のある人だけ（名前・社員番号・区分だけ）
  const people = emps.docs
    .filter((d) => rows[d.id])
    .map((d) => ({ id: d.id, code: String(d.get("code") ?? ""), name: String(d.get("name") ?? ""), kind: (d.get("kind") as string | undefined) ?? null }))
    .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true }));
  return {
    exists: true,
    paymentDate: String(p.get("paymentDate") ?? ""),
    rows,
    employer: (p.get("employer") as Record<string, number> | undefined) ?? {},
    memo: String(p.get("memo") ?? ""),
    people,
  };
});
