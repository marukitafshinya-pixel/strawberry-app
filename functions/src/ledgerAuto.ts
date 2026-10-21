// 帳簿の自動仕訳：レジの売上・売掛・給与から、その月の仕訳を作って autoJournal/{YYYY-MM} に保存する（管理者と経理担当）。
// 売上・売掛・給与のデータは経理担当には読めないので、サーバーで読んで、仕訳（科目・金額・摘要）だけを保存する。
// 作り直すたびに、その月の自動仕訳をまるごと置き換える（会計を取り消した・給与を直したときは、作り直せば合う）
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "./common.js";

/** 自動仕訳に使う科目（帳簿の画面の「勘定科目」で変えられる。画面側の DEFAULT_AUTO と同じ） */
const DEFAULT_AUTO = {
  cashSales: "101",
  creditSales: "120",
  sales: "400",
  collect: "110",
  wages: "520",
  officer: "521",
  withheld: "220",
  unpaid: "210",
  welfare: "522",
};
type AutoCodes = typeof DEFAULT_AUTO;

type Entry = { date: string; debit: string; credit: string; amount: number; memo: string; kind: "sales" | "receivable" | "payroll" };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).toISOString().slice(0, 10);
const prevMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 2, 1)).toISOString().slice(0, 7);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const buildAutoJournal = onCall(async (req) => {
  const uid = req.auth?.uid;
  const role = req.auth?.token.role;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  if (role !== "accounting" && role !== "admin") throw new HttpsError("permission-denied", "経理担当と管理者だけが使えます");
  const me = await db.doc(`staff/${uid}`).get();
  if (!me.exists || me.get("active") !== true) throw new HttpsError("permission-denied", "経理担当と管理者だけが使えます");
  const month = String((req.data as { month?: unknown } | undefined)?.month ?? "");
  if (!MONTH_RE.test(month)) throw new HttpsError("invalid-argument", "月が正しくありません");
  const from = `${month}-01`;
  const to = lastDay(month);

  const [config, sales, receivables, collected, payPrev, payThis] = await Promise.all([
    db.doc("config/accounts").get(),
    db.collection("sales").where("date", ">=", from).where("date", "<=", to).get(),
    db.collection("receivables").where("date", ">=", from).where("date", "<=", to).get(),
    db.collection("receivables").where("collectedDate", ">=", from).where("collectedDate", "<=", to).get(),
    db.doc(`payrolls/${prevMonth(month)}`).get(),
    db.doc(`payrolls/${month}`).get(),
  ]);
  const saved = (config.get("auto") as Partial<AutoCodes> | undefined) ?? {};
  const c: AutoCodes = { ...DEFAULT_AUTO };
  for (const k of Object.keys(DEFAULT_AUTO) as (keyof AutoCodes)[]) if (typeof saved[k] === "string" && saved[k]) c[k] = saved[k]!;

  const entries: Entry[] = [];

  // レジの売上：現金は日ごとにまとめる。売掛は1件ずつ（お客様名を残す）
  const cashByDay = new Map<string, { amount: number; count: number }>();
  for (const d of sales.docs) {
    if (d.get("status") === "voided") continue;
    const total = n(d.get("total"));
    if (!total) continue;
    const date = String(d.get("date"));
    if (d.get("payment") === "credit") {
      entries.push({ date, debit: c.creditSales, credit: c.sales, amount: total, memo: `レジ売上（売掛）${String(d.get("customerName") ?? "")}`.trim(), kind: "sales" });
    } else {
      const v = cashByDay.get(date) ?? { amount: 0, count: 0 };
      v.amount += total;
      v.count++;
      cashByDay.set(date, v);
    }
  }
  for (const [date, v] of cashByDay) entries.push({ date, debit: c.cashSales, credit: c.sales, amount: v.amount, memo: `レジ売上（現金）${v.count}件`, kind: "sales" });

  // 手で入れた売掛（会計からでないもの）は、売掛にした日に売上にする
  for (const d of receivables.docs) {
    if (d.get("source") !== "manual") continue;
    const amount = n(d.get("amount"));
    if (!amount) continue;
    const memo = [`売掛（手入力）${String(d.get("customerName") ?? "")}`, String(d.get("memo") ?? "")].filter(Boolean).join("　").slice(0, 80);
    entries.push({ date: String(d.get("date")), debit: c.creditSales, credit: c.sales, amount, memo, kind: "receivable" });
  }
  // 売掛の入金
  for (const d of collected.docs) {
    if (d.get("status") !== "collected") continue;
    const amount = n(d.get("amount"));
    if (!amount) continue;
    entries.push({ date: String(d.get("collectedDate")), debit: c.collect, credit: c.creditSales, amount, memo: `売掛の入金 ${String(d.get("customerName") ?? "")}`.trim(), kind: "receivable" });
  }

  // 給与：支給日（なければその月の末日）の月に入れる。前の月の分を今月払うことが多いので、前の月と今月の給与を見る
  for (const p of [payPrev, payThis]) {
    if (!p.exists) continue;
    const paymentDate = String(p.get("paymentDate") ?? "");
    const date = DATE_RE.test(paymentDate) ? paymentDate : lastDay(p.id);
    if (!date.startsWith(month)) continue;
    const label = `${Number(p.id.slice(5))}月分給与`;
    let wages = 0,
      officer = 0,
      withheld = 0;
    for (const r of Object.values((p.get("rows") as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      const w = n(r.monthly) + n(r.hourly) + n(r.commute);
      const o = n(r.officer);
      const net = w + o - (n(r.health) + n(r.care) + n(r.pension) + n(r.employment) + n(r.socialAdj)) - n(r.incomeTax) - n(r.residentTax) + n(r.yearEnd);
      wages += w;
      officer += o;
      withheld += w + o - net;
    }
    // 支給額は、給料・役員報酬（借方）と、預り金（引いた社会保険料・税金）・未払金（振り込む手取り）（貸方）に分ける
    if (wages) entries.push({ date, debit: c.wages, credit: c.unpaid, amount: wages, memo: `${label}（給料）`, kind: "payroll" });
    if (officer) entries.push({ date, debit: c.officer, credit: c.unpaid, amount: officer, memo: `${label}（役員報酬）`, kind: "payroll" });
    if (withheld > 0) entries.push({ date, debit: c.unpaid, credit: c.withheld, amount: withheld, memo: `${label}（社会保険料・税金の天引き）`, kind: "payroll" });
    if (withheld < 0) entries.push({ date, debit: c.withheld, credit: c.unpaid, amount: -withheld, memo: `${label}（年末調整の還付）`, kind: "payroll" });
    const employer = Object.values((p.get("employer") as Record<string, unknown> | undefined) ?? {}).reduce<number>((s, v) => s + n(v), 0);
    if (employer > 0) entries.push({ date, debit: c.welfare, credit: c.withheld, amount: employer, memo: `${label}（社会保険料の会社負担）`, kind: "payroll" });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  await db.doc(`autoJournal/${month}`).set({ entries: entries.map((e) => ({ ...e, amount: Math.round(e.amount) })), generatedAt: FieldValue.serverTimestamp(), generatedBy: uid });
  return { count: entries.length };
});
