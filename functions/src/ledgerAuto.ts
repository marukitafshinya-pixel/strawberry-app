// 帳簿の自動仕訳：レジの売上・売掛・給与から、その月の仕訳を作って autoJournal/{YYYY-MM} に保存する（管理者と経理担当）。
// 売上・売掛・給与のデータは経理担当には読めないので、サーバーで読んで、仕訳（科目・金額・摘要）だけを保存する。
// 作り直すたびに、その月の自動仕訳をまるごと置き換える（会計を取り消した・給与を直したときは、作り直せば合う）
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertCan, db } from "./common.js";

/** 自動仕訳に使う科目（帳簿の画面の「勘定科目」で変えられる。画面側の DEFAULT_AUTO と同じ） */
const DEFAULT_AUTO = {
  cashSales: "A01",
  creditSales: "A02",
  sales: "501-7",
  collect: "106-1",
  wages: "840-1",
  commute: "840-2",
  officer: "A10",
  unpaid: "307",
  social: "854",
  incomeTax: "322-1",
  residentTax: "322-2",
};
/** レジの分類 → 売上の科目（画面側の DEFAULT_SALES_MAP と同じ） */
const DEFAULT_SALES_MAP: Record<string, string> = { いちご狩り: "501-1" };
/** 勘定科目の版。これより前の設定は使わず、はじめの科目にする（画面側の CHART_VERSION 3 以上なら設定を使う） */
const CHART_VERSION = 3;
type AutoCodes = typeof DEFAULT_AUTO;

/** tax：消費税率（10・8・0）。税抜きで見るときに使う。売掛の入金・給与は消費税がかからないので 0 */
type Entry = { date: string; debit: string; credit: string; amount: number; memo: string; kind: "sales" | "receivable" | "payroll"; tax?: number };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).toISOString().slice(0, 10);
const prevMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 2, 1)).toISOString().slice(0, 7);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const buildAutoJournal = onCall(async (req) => {
  // 管理者と、帳簿を見せている役割の人
  const uid = await assertCan(req, ["ledger"]);
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
  const current = Number(config.get("chartVersion") ?? 0) >= CHART_VERSION;
  const saved = current ? ((config.get("auto") as Partial<AutoCodes> | undefined) ?? {}) : {};
  const salesMap = current ? ((config.get("salesMap") as Record<string, string> | undefined) ?? DEFAULT_SALES_MAP) : DEFAULT_SALES_MAP;
  const c: AutoCodes = { ...DEFAULT_AUTO };
  for (const k of Object.keys(DEFAULT_AUTO) as (keyof AutoCodes)[]) if (typeof saved[k] === "string" && saved[k]) c[k] = saved[k]!;

  const entries: Entry[] = [];

  // レジの売上：明細の分類ごとに売上の科目を決める。現金は日ごと・科目ごとにまとめる。売掛は1件ずつ（お客様名を残す）
  const categories: Record<string, number> = {};
  const cashByDay = new Map<string, { date: string; code: string; tax: number; amount: number; count: number }>();
  for (const d of sales.docs) {
    if (d.get("status") === "voided") continue;
    const total = n(d.get("total"));
    if (!total) continue;
    const date = String(d.get("date"));
    // 分類・税率ごとの金額。明細の合計と会計の合計がちがう分（古い会計など）は、決めていない売上（10％）にする
    const byCode = new Map<string, { code: string; tax: number; amount: number }>();
    const add = (code: string, tax: number, amount: number) => {
      const k = `${code}|${tax}`;
      const v = byCode.get(k) ?? { code, tax, amount: 0 };
      v.amount += amount;
      byCode.set(k, v);
    };
    let lineSum = 0;
    for (const l of (d.get("lines") as { category?: unknown; amount?: unknown; taxRate?: unknown }[] | undefined) ?? []) {
      const cat = typeof l.category === "string" && l.category.trim() ? l.category.trim() : "その他";
      const amount = n(l.amount);
      categories[cat] = (categories[cat] ?? 0) + amount;
      add(salesMap[cat] ?? c.sales, l.taxRate === 8 ? 8 : 10, amount);
      lineSum += amount;
    }
    if (total !== lineSum) add(c.sales, 10, total - lineSum);
    for (const { code, tax, amount } of byCode.values()) {
      if (!amount) continue;
      if (d.get("payment") === "credit") {
        entries.push({ date, debit: c.creditSales, credit: code, amount, memo: `レジ売上（売掛）${String(d.get("customerName") ?? "")}`.trim(), kind: "sales", tax });
      } else {
        const key = `${date}|${code}|${tax}`;
        const v = cashByDay.get(key) ?? { date, code, tax, amount: 0, count: 0 };
        v.amount += amount;
        v.count++;
        cashByDay.set(key, v);
      }
    }
  }
  for (const v of cashByDay.values()) entries.push({ date: v.date, debit: c.cashSales, credit: v.code, amount: v.amount, memo: `レジ売上（現金）${v.count}件`, kind: "sales", tax: v.tax });

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
    entries.push({ date: String(d.get("collectedDate")), debit: c.collect, credit: c.creditSales, amount, memo: `売掛の入金 ${String(d.get("customerName") ?? "")}`.trim(), kind: "receivable", tax: 0 });
  }

  // 給与：支給日（なければその月の末日）の月に入れる。前の月の分を今月払うことが多いので、前の月と今月の給与を見る
  for (const p of [payPrev, payThis]) {
    if (!p.exists) continue;
    const paymentDate = String(p.get("paymentDate") ?? "");
    const date = DATE_RE.test(paymentDate) ? paymentDate : lastDay(p.id);
    if (!date.startsWith(month)) continue;
    const label = `${Number(p.id.slice(5))}月分給与`;
    let wages = 0,
      commute = 0,
      officer = 0,
      social = 0,
      incomeTax = 0,
      residentTax = 0;
    for (const r of Object.values((p.get("rows") as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      const w = n(r.monthly) + n(r.hourly);
      const cm = n(r.commute);
      const o = n(r.officer);
      wages += w;
      commute += cm;
      officer += o;
      social += n(r.health) + n(r.care) + n(r.pension) + n(r.employment) + n(r.socialAdj);
      // 年末調整は、還付（プラス）なら所得税の預りを減らし、徴収（マイナス）なら増やす
      incomeTax += n(r.incomeTax) - n(r.yearEnd);
      residentTax += n(r.residentTax);
    }
    // 支給額（給料・通勤費・役員報酬）を「振り込む給与」に入れ、天引きした分をそこから移す：
    // 社会保険料の本人負担分は法定福利費から引き（会計ソフトと同じ。納めたときに全額を法定福利費にする）、所得税・住民税は預り金へ
    const push = (debit: string, credit: string, amount: number, memo: string) => {
      if (amount > 0) entries.push({ date, debit, credit, amount, memo: `${label}（${memo}）`, kind: "payroll", tax: 0 });
      if (amount < 0) entries.push({ date, debit: credit, credit: debit, amount: -amount, memo: `${label}（${memo}）`, kind: "payroll", tax: 0 });
    };
    push(c.wages, c.unpaid, wages, "給料");
    push(c.commute, c.unpaid, commute, "通勤費");
    push(c.officer, c.unpaid, officer, "役員報酬");
    push(c.unpaid, c.social, social, "社会保険料の天引き");
    push(c.unpaid, c.incomeTax, incomeTax, "所得税の天引き");
    push(c.unpaid, c.residentTax, residentTax, "住民税の天引き");
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  await db.doc(`autoJournal/${month}`).set({ entries: entries.map((e) => ({ ...e, amount: Math.round(e.amount) })), categories, generatedAt: FieldValue.serverTimestamp(), generatedBy: uid });
  return { count: entries.length };
});
