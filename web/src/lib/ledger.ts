"use client";

// 帳簿（経理）：複式簿記の仕訳帳・勘定科目・試算表・損益計算書・貸借対照表・総勘定元帳。
// - 仕訳は「借方の科目・貸方の科目・金額」の1行ずつ。月ごとに保存する（journal/{YYYY-MM}）
// - 現金出納帳の出入りは、項目ごとに決めた勘定科目で、自動で仕訳にする（出納帳を直せば帳簿も変わる。二重に入れない）
// - レジの売上・売掛・給与からの仕訳は、サーバー（buildAutoJournal）で作って autoJournal/{YYYY-MM} に保存する
// - 預金通帳のCSVは bank/{YYYY-MM} に取り込み、摘要の言葉ごとに決めた科目で仕訳にする
// - 勘定科目・出納帳の項目と科目の対応・決算月・自動仕訳の科目・通帳の言葉と科目は config/accounts に保存する
import { collection, doc, onSnapshot, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useCashbook, type CashMonth } from "./cashbook";
import { shiftMonth } from "./date";
import { getFirebase } from "./firebase";

/** 科目の種類：資産・負債・純資産・収益・費用 */
export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "expense";
export const KIND_LABEL: Record<AccountKind, string> = { asset: "資産", liability: "負債", equity: "純資産", revenue: "収益", expense: "費用" };
export const KINDS: AccountKind[] = ["asset", "liability", "equity", "revenue", "expense"];
/** 借方に残る科目（資産・費用）か */
export const debitSide = (k: AccountKind) => k === "asset" || k === "expense";

export type Account = { code: string; name: string; kind: AccountKind };

/** 現金（現金出納帳の相手）・開始残高（出納帳のいちばん最初の繰越金の相手）・未分類（出納帳の項目に科目をまだ決めていないとき） */
export const CASH = "100";
export const OPENING = "390";
export const UNSORTED = "999";

export const DEFAULT_ACCOUNTS: Account[] = [
  { code: CASH, name: "現金", kind: "asset" },
  { code: "101", name: "レジ現金", kind: "asset" },
  { code: "110", name: "普通預金", kind: "asset" },
  { code: "120", name: "売掛金", kind: "asset" },
  { code: "130", name: "棚卸資産", kind: "asset" },
  { code: "140", name: "前払金", kind: "asset" },
  { code: "150", name: "仮払金", kind: "asset" },
  { code: "160", name: "建物", kind: "asset" },
  { code: "161", name: "機械装置", kind: "asset" },
  { code: "162", name: "車両運搬具", kind: "asset" },
  { code: "163", name: "工具器具備品", kind: "asset" },
  { code: "170", name: "土地", kind: "asset" },
  { code: "200", name: "買掛金", kind: "liability" },
  { code: "210", name: "未払金", kind: "liability" },
  { code: "220", name: "預り金", kind: "liability" },
  { code: "230", name: "未払法人税等", kind: "liability" },
  { code: "240", name: "借入金", kind: "liability" },
  { code: "300", name: "資本金", kind: "equity" },
  { code: OPENING, name: "開始残高", kind: "equity" },
  { code: "400", name: "売上高", kind: "revenue" },
  { code: "410", name: "交付金・助成金", kind: "revenue" },
  { code: "420", name: "雑収入", kind: "revenue" },
  { code: "430", name: "受取利息", kind: "revenue" },
  { code: "500", name: "仕入高", kind: "expense" },
  { code: "510", name: "種苗費", kind: "expense" },
  { code: "511", name: "肥料費", kind: "expense" },
  { code: "512", name: "農薬費", kind: "expense" },
  { code: "513", name: "諸材料費", kind: "expense" },
  { code: "520", name: "給料手当", kind: "expense" },
  { code: "521", name: "役員報酬", kind: "expense" },
  { code: "522", name: "法定福利費", kind: "expense" },
  { code: "523", name: "福利厚生費", kind: "expense" },
  { code: "530", name: "荷造運賃", kind: "expense" },
  { code: "531", name: "支払手数料", kind: "expense" },
  { code: "540", name: "水道光熱費", kind: "expense" },
  { code: "541", name: "燃料費", kind: "expense" },
  { code: "542", name: "修繕費", kind: "expense" },
  { code: "543", name: "消耗品費", kind: "expense" },
  { code: "544", name: "減価償却費", kind: "expense" },
  { code: "545", name: "地代家賃", kind: "expense" },
  { code: "546", name: "賃借料", kind: "expense" },
  { code: "547", name: "保険料", kind: "expense" },
  { code: "548", name: "租税公課", kind: "expense" },
  { code: "549", name: "通信費", kind: "expense" },
  { code: "550", name: "旅費交通費", kind: "expense" },
  { code: "551", name: "広告宣伝費", kind: "expense" },
  { code: "552", name: "接待交際費", kind: "expense" },
  { code: "553", name: "会議費", kind: "expense" },
  { code: "554", name: "車両費", kind: "expense" },
  { code: "555", name: "諸会費", kind: "expense" },
  { code: "560", name: "支払利息", kind: "expense" },
  { code: "599", name: "雑費", kind: "expense" },
  { code: UNSORTED, name: "未分類", kind: "expense" },
];
/** 消せない科目（自動の仕訳で使う） */
export const FIXED_CODES = [CASH, OPENING, UNSORTED];

/** 自動仕訳（レジの売上・売掛・給与）に使う科目。サーバー（functions/src/ledgerAuto.ts）の DEFAULT_AUTO と同じ */
export const DEFAULT_AUTO = {
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
export type AutoCodes = typeof DEFAULT_AUTO;
export const AUTO_LABELS: { key: keyof AutoCodes; label: string; note: string }[] = [
  { key: "sales", label: "売上", note: "レジの売上・手で入れた売掛の相手" },
  { key: "cashSales", label: "レジの現金売上", note: "現金で受け取った売上を入れておく科目（預金に入れたら通帳の取り込みで動く）" },
  { key: "creditSales", label: "売掛", note: "売掛の会計・手で入れた売掛" },
  { key: "collect", label: "売掛の入金先", note: "売掛管理で「入金済み」にしたとき、お金が入った科目" },
  { key: "wages", label: "給料", note: "月給・時給・通勤費" },
  { key: "officer", label: "役員報酬", note: "役員報酬" },
  { key: "withheld", label: "天引きした分", note: "社会保険料・所得税・住民税（会社負担の社会保険料もここに入れ、納めたときに減らす）" },
  { key: "unpaid", label: "振り込む給与", note: "手取り（通帳から振り込んだときに減らす）" },
  { key: "welfare", label: "会社負担の社会保険料", note: "法定福利費" },
];

/** 通帳の摘要に keyword が入っていたら、code の科目にする（code が SKIP なら帳簿に入れない） */
export type BankRule = { keyword: string; code: string };
/** 帳簿に入れない（ほかの仕訳ですでに入っている入出金） */
export const SKIP = "skip";

export type LedgerConfig = {
  accounts: Account[];
  /** 現金出納帳の項目 → 勘定科目のコード */
  itemMap: Record<string, string>;
  /** 期首の月（1〜12）。4 なら 4月〜翌3月が1期 */
  fiscalStart: number;
  auto: AutoCodes;
  bankRules: BankRule[];
};
export const DEFAULT_BANK_RULES: BankRule[] = [
  { keyword: "給与", code: "210" },
  { keyword: "社会保険", code: "220" },
  { keyword: "厚生年金", code: "220" },
  { keyword: "所得税", code: "220" },
  { keyword: "住民税", code: "220" },
  { keyword: "利息", code: "430" },
  { keyword: "手数料", code: "531" },
  { keyword: "電気", code: "540" },
  { keyword: "電力", code: "540" },
  { keyword: "水道", code: "540" },
  { keyword: "NTT", code: "549" },
];
export const DEFAULT_CONFIG: LedgerConfig = { accounts: DEFAULT_ACCOUNTS, itemMap: {}, fiscalStart: 1, auto: DEFAULT_AUTO, bankRules: DEFAULT_BANK_RULES };

export function useLedgerConfig() {
  const [state, setState] = useState<{ value: LedgerConfig | null; error: unknown }>({ value: null, error: null });
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "config/accounts"),
        (s) => {
          if (!s.exists()) return setState({ value: DEFAULT_CONFIG, error: null });
          const accounts = (s.get("accounts") as Account[] | undefined) ?? [];
          const auto = { ...DEFAULT_AUTO, ...((s.get("auto") as Partial<AutoCodes> | undefined) ?? {}) };
          // 消せない科目と、自動仕訳に使う科目が入っていなければ足す（あとから足した「レジ現金」など）
          const need = new Set([...FIXED_CODES, ...Object.values(auto)]);
          const missing = DEFAULT_ACCOUNTS.filter((a) => need.has(a.code) && !accounts.some((b) => b.code === a.code));
          setState({
            value: {
              accounts: sortAccounts([...accounts, ...missing]),
              itemMap: (s.get("itemMap") as Record<string, string> | undefined) ?? {},
              fiscalStart: (s.get("fiscalStart") as number | undefined) ?? 1,
              auto,
              bankRules: (s.get("bankRules") as BankRule[] | undefined) ?? DEFAULT_BANK_RULES,
            },
            error: null,
          });
        },
        (error) => setState({ value: null, error }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return state;
}

export const sortAccounts = (list: Account[]) => [...list].sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true }));

export async function saveLedgerConfig(c: LedgerConfig) {
  const { db } = await getFirebase();
  const codes = new Set(c.accounts.map((a) => a.code));
  const itemMap = Object.fromEntries(
    Object.entries(c.itemMap)
      .map(([k, v]) => [k.trim().slice(0, 80), v] as const)
      .filter(([k, v]) => k && codes.has(v) && v !== UNSORTED)
      .slice(0, 1000),
  );
  await setDoc(doc(db, "config/accounts"), {
    accounts: sortAccounts(c.accounts)
      .slice(0, 300)
      .map((a) => ({ code: a.code.trim().slice(0, 10), name: a.name.trim().slice(0, 40), kind: a.kind })),
    itemMap,
    fiscalStart: Math.min(12, Math.max(1, Math.round(c.fiscalStart))),
    auto: Object.fromEntries(Object.entries(c.auto).filter(([, v]) => codes.has(v))),
    bankRules: c.bankRules
      .map((r) => ({ keyword: r.keyword.trim().slice(0, 40), code: r.code }))
      .filter((r) => r.keyword && (r.code === SKIP || codes.has(r.code)))
      .slice(0, 300),
    updatedAt: serverTimestamp(),
  });
}

// ---------- 仕訳 ----------

export type JournalEntry = {
  /** 日付（YYYY-MM-DD） */
  date: string;
  /** 借方の科目コード */
  debit: string;
  /** 貸方の科目コード */
  credit: string;
  amount: number | null;
  /** 摘要 */
  memo: string;
};
export type JournalMonth = { month: string; entries: JournalEntry[] };

/** 帳簿に載せる1行（手で入れた仕訳と、現金出納帳から作った仕訳） */
export type Posting = {
  date: string;
  debit: string;
  credit: string;
  amount: number;
  memo: string;
  /** cash＝現金出納帳から（item は出納帳の項目）。manual＝手で入れた仕訳。auto＝レジ・売掛・給与から。bank＝預金通帳から */
  source: "cash" | "manual" | "auto" | "bank";
  item?: string;
};

export const emptyJournal = (date = ""): JournalEntry => ({ date, debit: "", credit: "", amount: null, memo: "" });
export const isBlankJournal = (e: JournalEntry) => !e.debit && !e.credit && e.amount === null && !e.memo.trim();
/** 保存できない行の理由（なければ ""） */
export function journalProblem(e: JournalEntry, month: string): string {
  if (isBlankJournal(e)) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !e.date.startsWith(month)) return "日付がこの月ではありません";
  if (!e.debit || !e.credit) return "借方・貸方の科目を選んでください";
  if (e.debit === e.credit) return "借方と貸方が同じ科目です";
  if (e.amount === null || !Number.isFinite(e.amount) || e.amount <= 0) return "金額を入れてください";
  return "";
}

/** 全部の月の仕訳（古い順） */
export function useJournal() {
  const [state, setState] = useState<{ value: JournalMonth[] | null; error: unknown }>({ value: null, error: null });
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, "journal"),
        (snap) =>
          setState({
            value: snap.docs
              .map((d) => ({ month: d.id, entries: (d.get("entries") as JournalEntry[] | undefined) ?? [] }))
              .sort((a, b) => a.month.localeCompare(b.month)),
            error: null,
          }),
        (error) => setState({ value: null, error }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return state;
}

export async function saveJournalMonth(month: string, entries: JournalEntry[]) {
  const { db } = await getFirebase();
  const list = entries
    .filter((e) => !isBlankJournal(e))
    .map((e) => ({ date: e.date, debit: e.debit, credit: e.credit, amount: Math.round(e.amount ?? 0), memo: e.memo.trim().slice(0, 80) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  await setDoc(doc(db, `journal/${month}`), { entries: list, updatedAt: serverTimestamp() });
}

/** 現金出納帳のその月の出入りを仕訳にする。日付がない行はその月の1日にする */
export function cashPostings(cash: CashMonth[], month: string, itemMap: Record<string, string>): Posting[] {
  const out: Posting[] = [];
  const m = cash.find((x) => x.month === month);
  // いちばん最初の月の繰越金：現金／開始残高
  const isFirst = !!m && !cash.some((x) => x.month < month);
  if (isFirst && m?.opening) {
    out.push({ date: `${month}-01`, debit: m.opening > 0 ? CASH : OPENING, credit: m.opening > 0 ? OPENING : CASH, amount: Math.abs(m.opening), memo: "現金出納帳の繰越金", source: "cash" });
  }
  for (const e of m?.entries ?? []) {
    const date = e.date.startsWith(month) ? e.date : `${month}-01`;
    const item = e.item.trim();
    const code = itemMap[item] ?? UNSORTED;
    const memo = [item, e.memo.trim()].filter(Boolean).join("　");
    if (e.income) out.push({ date, debit: e.income > 0 ? CASH : code, credit: e.income > 0 ? code : CASH, amount: Math.abs(e.income), memo, source: "cash", item });
    if (e.expense) out.push({ date, debit: e.expense > 0 ? code : CASH, credit: e.expense > 0 ? CASH : code, amount: Math.abs(e.expense), memo, source: "cash", item });
  }
  return out;
}

export function manualPostings(journal: JournalMonth[], month: string): Posting[] {
  return (journal.find((x) => x.month === month)?.entries ?? [])
    .filter((e) => e.amount && e.debit && e.credit)
    .map((e) => ({ date: e.date, debit: e.debit, credit: e.credit, amount: e.amount ?? 0, memo: e.memo, source: "manual" as const }));
}

/** 帳簿の元になるもの全部 */
export type Books = { cash: CashMonth[]; journal: JournalMonth[]; auto: AutoMonth[]; bank: BankMonth[] };

/** 帳簿の元になるデータがある月（古い順） */
export function monthsWithData(b: Books): string[] {
  return [...new Set([...b.cash, ...b.journal, ...b.auto, ...b.bank].map((x) => x.month))].sort();
}

/** その月の全部の仕訳 */
export function monthPostings(b: Books, config: LedgerConfig, month: string): Posting[] {
  return [...cashPostings(b.cash, month, config.itemMap), ...manualPostings(b.journal, month), ...autoPostings(b.auto, month), ...bankPostings(b.bank, month, config.bankRules)];
}

/** 期間（from〜to の月、両端を含む）の全部の仕訳（日付順） */
export function postingsInRange(b: Books, config: LedgerConfig, from: string, to: string): Posting[] {
  return monthsWithData(b)
    .filter((m) => m >= from && m <= to)
    .flatMap((m) => monthPostings(b, config, m))
    .sort((x, y) => x.date.localeCompare(y.date));
}

// ---------- 自動仕訳（レジの売上・売掛・給与） ----------

export type AutoEntry = { date: string; debit: string; credit: string; amount: number; memo: string; kind: "sales" | "receivable" | "payroll" };
export type AutoMonth = { month: string; entries: AutoEntry[]; generatedAt: Date | null };
export const AUTO_KIND_LABEL: Record<AutoEntry["kind"], string> = { sales: "レジ", receivable: "売掛", payroll: "給与" };

export function autoPostings(auto: AutoMonth[], month: string): Posting[] {
  return (auto.find((x) => x.month === month)?.entries ?? []).map((e) => ({ date: e.date, debit: e.debit, credit: e.credit, amount: e.amount, memo: e.memo, source: "auto" as const }));
}

export function useAutoJournal() {
  return useMonthDocs<AutoMonth>("autoJournal", (id, d) => ({
    month: id,
    entries: (d.entries as AutoEntry[] | undefined) ?? [],
    generatedAt: (d.generatedAt as { toDate?: () => Date } | undefined)?.toDate?.() ?? null,
  }));
}

// ---------- 預金通帳 ----------

export type BankRow = {
  date: string;
  /** 摘要（通帳に書いてある取引の内容） */
  desc: string;
  deposit: number;
  withdrawal: number;
  balance: number | null;
  /** どの預金の科目の行か（例 110 普通預金） */
  account: string;
  /** この行だけ科目を決めたとき（SKIP なら帳簿に入れない） */
  code?: string;
};
export type BankMonth = { month: string; rows: BankRow[] };

export function useBank() {
  return useMonthDocs<BankMonth>("bank", (id, d) => ({ month: id, rows: (d.rows as BankRow[] | undefined) ?? [] }));
}

/** 全角・半角（ｶﾅ も）をそろえ、小文字にする */
const normalize = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();

/** 摘要に合う言葉の科目（なければ null）。全角・半角（ｶﾅ も）、大文字・小文字は区別しない */
export function ruleFor(desc: string, rules: BankRule[]): BankRule | null {
  const d = normalize(desc);
  return rules.find((r) => r.keyword.trim() && d.includes(normalize(r.keyword.trim()))) ?? null;
}
/** 通帳の行の科目（行で決めた科目 → 言葉の科目 → 未分類） */
export const bankCodeOf = (r: BankRow, rules: BankRule[]) => r.code || ruleFor(r.desc, rules)?.code || UNSORTED;

export function bankPostings(bank: BankMonth[], month: string, rules: BankRule[]): Posting[] {
  const out: Posting[] = [];
  for (const r of bank.find((x) => x.month === month)?.rows ?? []) {
    const code = bankCodeOf(r, rules);
    if (code === SKIP) continue;
    if (r.deposit) out.push({ date: r.date, debit: r.account, credit: code, amount: r.deposit, memo: r.desc, source: "bank", item: r.desc });
    if (r.withdrawal) out.push({ date: r.date, debit: code, credit: r.account, amount: r.withdrawal, memo: r.desc, source: "bank", item: r.desc });
  }
  return out;
}

const z2h = (s: string) => s.replace(/[０-９．／－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
/** 通帳の日付（2026/10/5・2026-10-05・2026年10月5日・20261005・R8.10.5・令和8年10月5日）→ YYYY-MM-DD */
export function parseBankDate(v: string): string | null {
  const t = z2h(v);
  let ymd: number[] | null = null;
  let x: RegExpMatchArray | null;
  if ((x = t.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/))) ymd = [Number(x[1]), Number(x[2]), Number(x[3])];
  else if ((x = t.match(/^(\d{4})(\d{2})(\d{2})$/))) ymd = [Number(x[1]), Number(x[2]), Number(x[3])];
  else if ((x = t.match(/^(R|r|令和)\s*(\d{1,2})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/))) ymd = [2018 + Number(x[2]), Number(x[3]), Number(x[4])];
  if (!ymd) return null;
  const [y, m, d] = ymd;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const money = (v: string | undefined): number => {
  const t = z2h(v ?? "").replace(/[,，\s￥¥円+]/g, "");
  const n = Number(t);
  return t && Number.isFinite(n) ? Math.round(n) : 0;
};

/** 通帳のCSVの列（-1 は無い） */
export type BankColumns = { date: number; desc: number; deposit: number; withdrawal: number; balance: number; header: number };

/** 見出しの行と列を探す（銀行ごとに名前が違うので、よくある名前で探す） */
export function guessBankColumns(rows: string[][]): BankColumns | null {
  const find = (row: string[], words: string[]) => row.findIndex((c) => words.some((w) => c.replace(/\s/g, "").includes(w)));
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i] ?? [];
    const date = find(row, ["取引日", "年月日", "日付", "お取引日", "勘定日"]);
    const deposit = find(row, ["お預り", "お預かり", "預入", "入金", "受入"]);
    const withdrawal = find(row, ["お支払", "お引出", "引出", "出金", "払出", "支払"]);
    if (date < 0 || (deposit < 0 && withdrawal < 0)) continue;
    return { header: i, date, deposit, withdrawal, desc: find(row, ["摘要", "お取引内容", "取引内容", "内容", "お取引", "備考"]), balance: find(row, ["残高"]) };
  }
  return null;
}

/** 通帳のCSVを行にする（日付が読めない行と、入出金のない行は入れない） */
export function readBankRows(rows: string[][], col: BankColumns, account: string): BankRow[] {
  const out: BankRow[] = [];
  for (const row of rows.slice(col.header + 1)) {
    const date = parseBankDate(row[col.date] ?? "");
    if (!date) continue;
    const deposit = col.deposit >= 0 ? Math.abs(money(row[col.deposit])) : 0;
    const withdrawal = col.withdrawal >= 0 ? Math.abs(money(row[col.withdrawal])) : 0;
    if (!deposit && !withdrawal) continue;
    const balance = col.balance >= 0 && (row[col.balance] ?? "").trim() ? money(row[col.balance]) : null;
    out.push({ date, desc: col.desc >= 0 ? (row[col.desc] ?? "").trim().slice(0, 80) : "", deposit, withdrawal, balance, account });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 取り込む：同じ預金の科目で、CSVの最初の日〜最後の日にある行は、CSVの行で置き換える（同じファイルを2回入れても二重にならない）。
 * 前に行ごとに決めた科目は、日付・摘要・金額が同じ行に引き継ぐ
 */
export function mergeBankImport(bank: BankMonth[], rows: BankRow[], account: string): BankMonth[] {
  if (rows.length === 0) return [];
  const from = rows[0].date;
  const to = rows[rows.length - 1].date;
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))];
  const key = (r: BankRow) => `${r.date}|${r.desc}|${r.deposit}|${r.withdrawal}`;
  return months.map((month) => {
    const old = bank.find((x) => x.month === month)?.rows ?? [];
    const replaced = old.filter((r) => r.account === account && r.date >= from && r.date <= to);
    const codes = new Map(replaced.filter((r) => r.code).map((r) => [key(r), r.code!]));
    const keep = old.filter((r) => !replaced.includes(r));
    const added = rows.filter((r) => r.date.startsWith(month)).map((r) => (codes.has(key(r)) ? { ...r, code: codes.get(key(r)) } : r));
    return { month, rows: [...keep, ...added].sort((a, b) => a.date.localeCompare(b.date)) };
  });
}

export async function saveBankMonths(months: BankMonth[]) {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  for (const m of months) {
    const rows = m.rows.slice(0, 1000).map((r) => ({
      date: r.date,
      desc: r.desc.slice(0, 80),
      deposit: Math.round(r.deposit),
      withdrawal: Math.round(r.withdrawal),
      balance: r.balance === null ? null : Math.round(r.balance),
      account: r.account,
      ...(r.code ? { code: r.code } : {}),
    }));
    if (rows.length === 0) batch.delete(doc(db, `bank/${m.month}`));
    else batch.set(doc(db, `bank/${m.month}`), { rows, updatedAt: serverTimestamp() });
  }
  await batch.commit();
}

/** 月ごとのドキュメント（ID が YYYY-MM）を全部読む（古い順） */
function useMonthDocs<T extends { month: string }>(name: string, read: (id: string, d: Record<string, unknown>) => T) {
  const [state, setState] = useState<{ value: T[] | null; error: unknown }>({ value: null, error: null });
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, name),
        (snap) => setState({ value: snap.docs.map((d) => read(d.id, d.data())).sort((a, b) => a.month.localeCompare(b.month)), error: null }),
        (error) => setState({ value: null, error }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return state;
}

/** 帳簿の元になるもの全部を読む */
export function useBooks(): { value: Books | null; error: unknown } {
  const cash = useCashbook();
  const journal = useJournal();
  const auto = useAutoJournal();
  const bank = useBank();
  const error = cash.error || journal.error || auto.error || bank.error;
  if (error) return { value: null, error };
  if (!cash.value || !journal.value || !auto.value || !bank.value) return { value: null, error: null };
  return { value: { cash: cash.value, journal: journal.value, auto: auto.value, bank: bank.value }, error: null };
}

// ---------- 期（会計年度） ----------

/** その月が入る期の最初の月 */
export function fiscalStartOf(month: string, fiscalStart: number): string {
  const [y, m] = month.split("-").map(Number);
  const year = m >= fiscalStart ? y : y - 1;
  return `${year}-${String(fiscalStart).padStart(2, "0")}`;
}
/** 期の12か月 */
export const fiscalMonths = (start: string) => Array.from({ length: 12 }, (_, i) => shiftMonth(start, i));
/** 期の名前（例：2026年1月〜12月期、2026年4月〜2027年3月期） */
export function fiscalLabel(start: string): string {
  const end = shiftMonth(start, 11);
  const [y1, m1] = start.split("-").map(Number);
  const [y2, m2] = end.split("-").map(Number);
  return y1 === y2 ? `${y1}年${m1}月〜${m2}月期` : `${y1}年${m1}月〜${y2}年${m2}月期`;
}

// ---------- 集計 ----------

/** 科目ごとの 借方合計・貸方合計 */
export function totalsByAccount(postings: Posting[]): Map<string, { debit: number; credit: number }> {
  const t = new Map<string, { debit: number; credit: number }>();
  const get = (c: string) => t.get(c) ?? (t.set(c, { debit: 0, credit: 0 }), t.get(c)!);
  for (const p of postings) {
    get(p.debit).debit += p.amount;
    get(p.credit).credit += p.amount;
  }
  return t;
}

/** 科目の残高（その科目の残る側をプラスにする） */
export const balanceOf = (kind: AccountKind, t: { debit: number; credit: number } | undefined) =>
  t ? (debitSide(kind) ? t.debit - t.credit : t.credit - t.debit) : 0;

/** 科目表にないコード（科目を消したあとの仕訳など）は、未登録として出す */
export function accountOf(accounts: Account[], code: string): Account {
  return accounts.find((a) => a.code === code) ?? { code, name: `（未登録 ${code}）`, kind: "expense" };
}

/** 収益の合計 − 費用の合計 */
export function profitOf(accounts: Account[], postings: Posting[]): number {
  const t = totalsByAccount(postings);
  let n = 0;
  for (const [code, v] of t) {
    const kind = accountOf(accounts, code).kind;
    if (kind === "revenue") n += v.credit - v.debit;
    if (kind === "expense") n -= v.debit - v.credit;
  }
  return n;
}

/**
 * 期の数字をまとめて作る。
 * - 資産・負債・純資産は、はじめからの累計（期首の残高＋期中の動き）
 * - 収益・費用は、その期の分だけ。前の期までの利益は「繰越利益」として純資産に入れる
 */
export function buildPeriod(books: Books, config: LedgerConfig, start: string, toMonth?: string) {
  const end = toMonth ?? shiftMonth(start, 11);
  const before = postingsInRange(books, config, "0000-00", shiftMonth(start, -1));
  const during = postingsInRange(books, config, start, end);
  const accounts = config.accounts;
  const beforeT = totalsByAccount(before);
  const duringT = totalsByAccount(during);
  const isBs = (code: string) => {
    const k = accountOf(accounts, code).kind;
    return k === "asset" || k === "liability" || k === "equity";
  };
  const codes = sortAccounts([...new Set([...accounts.map((a) => a.code), ...beforeT.keys(), ...duringT.keys()])].map((c) => accountOf(accounts, c))).map((a) => a.code);
  /** 試算表：期首残高・借方・貸方・期末残高 */
  const rows = codes
    .map((code) => {
      const a = accountOf(accounts, code);
      const opening = isBs(code) ? balanceOf(a.kind, beforeT.get(code)) : 0;
      const d = duringT.get(code) ?? { debit: 0, credit: 0 };
      const closing = opening + balanceOf(a.kind, d);
      return { account: a, opening, debit: d.debit, credit: d.credit, closing };
    })
    .filter((r) => r.opening || r.debit || r.credit);
  const priorProfit = profitOf(accounts, before);
  const profit = profitOf(accounts, during);
  return { start, end, before, during, rows, priorProfit, profit };
}

/** 月ごとの科目別の金額（損益計算書の月別の表に使う。収益は貸方−借方、費用は借方−貸方） */
export function monthlyAmounts(books: Books, config: LedgerConfig, months: string[]) {
  return months.map((m) => {
    const t = totalsByAccount(postingsInRange(books, config, m, m));
    const byCode = new Map<string, number>();
    for (const [code, v] of t) byCode.set(code, balanceOf(accountOf(config.accounts, code).kind, v));
    return byCode;
  });
}

/** 総勘定元帳：その科目の行と、行ごとの残高 */
export function ledgerOf(account: Account, opening: number, postings: Posting[]) {
  let bal = opening;
  return postings
    .filter((p) => p.debit === account.code || p.credit === account.code)
    .map((p) => {
      const isDebit = p.debit === account.code;
      const debit = isDebit ? p.amount : 0;
      const credit = isDebit ? 0 : p.amount;
      bal += debitSide(account.kind) ? debit - credit : credit - debit;
      return { ...p, other: isDebit ? p.credit : p.debit, debit, credit, balance: bal };
    });
}

/** 現金出納帳の項目ごとの件数と金額（科目を決める画面に使う。よく使う順） */
export function cashItemsUsage(cash: CashMonth[]) {
  const map = new Map<string, { count: number; income: number; expense: number }>();
  for (const m of cash)
    for (const e of m.entries) {
      const k = e.item.trim();
      if (!k) continue;
      const v = map.get(k) ?? { count: 0, income: 0, expense: 0 };
      v.count++;
      v.income += e.income ?? 0;
      v.expense += e.expense ?? 0;
      map.set(k, v);
    }
  return [...map.entries()].map(([item, v]) => ({ item, ...v })).sort((a, b) => b.count - a.count || a.item.localeCompare(b.item, "ja"));
}

