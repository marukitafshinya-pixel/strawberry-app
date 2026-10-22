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
import { naturalMove, type TbMonth, type TbParsed } from "./tbImport";

/** 科目の種類：資産・負債・純資産・収益・費用 */
export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "expense";
export const KIND_LABEL: Record<AccountKind, string> = { asset: "資産", liability: "負債", equity: "純資産", revenue: "収益", expense: "費用" };
export const KINDS: AccountKind[] = ["asset", "liability", "equity", "revenue", "expense"];
/** 借方に残る科目（資産・費用）か */
export const debitSide = (k: AccountKind) => k === "asset" || k === "expense";

/**
 * 損益計算書・製造原価報告書のどこに出すか（収益と費用だけ）。
 * 丸北農場の合計残高試算表（損益計算書・製造原価報告書）と同じ並び
 */
export type Section =
  | "sales"
  | "nonOpIncome"
  | "extraGain"
  | "purchase"
  | "material"
  | "labor"
  | "overhead"
  | "personnel"
  | "sgaOther"
  | "nonOpExpense"
  | "extraLoss"
  | "tax";
export const SECTIONS: { key: Section; kind: AccountKind; label: string }[] = [
  { key: "sales", kind: "revenue", label: "売上高" },
  { key: "nonOpIncome", kind: "revenue", label: "営業外収益" },
  { key: "extraGain", kind: "revenue", label: "特別利益" },
  { key: "purchase", kind: "expense", label: "売上原価（商品仕入）" },
  { key: "material", kind: "expense", label: "製造原価：材料費" },
  { key: "labor", kind: "expense", label: "製造原価：労務費" },
  { key: "overhead", kind: "expense", label: "製造原価：製造経費" },
  { key: "personnel", kind: "expense", label: "販管費：人件費" },
  { key: "sgaOther", kind: "expense", label: "販管費：その他経費" },
  { key: "nonOpExpense", kind: "expense", label: "営業外費用" },
  { key: "extraLoss", kind: "expense", label: "特別損失" },
  { key: "tax", kind: "expense", label: "法人税等" },
];
/** 製造原価（当期製品製造原価）に入る区分 */
export const MFG_SECTIONS: Section[] = ["material", "labor", "overhead"];

export type Account = {
  code: string;
  name: string;
  kind: AccountKind;
  /** 損益計算書のどこに出すか（収益・費用だけ。なければ 収益→売上高、費用→販管費のその他経費） */
  section?: Section;
  /** 補助科目のときの、親の科目コード（試算表の字下げの科目。親の金額は、自分と子の合計） */
  parent?: string;
};
export const sectionOf = (a: Account): Section | null =>
  a.kind === "revenue" || a.kind === "expense"
    ? a.section && SECTIONS.some((x) => x.key === a.section && x.kind === a.kind)
      ? a.section
      : a.kind === "revenue"
        ? "sales"
        : "sgaOther"
    : null;

/** 現金（現金出納帳の相手）・開始残高（出納帳のいちばん最初の繰越金の相手）・未分類（出納帳の項目に科目をまだ決めていないとき） */
export const CASH = "100";
export const OPENING = "A90";
export const UNSORTED = "999";
/** 試算表の取り込みの相手（借方と貸方が合っていれば、残高はいつも0になる） */
export const TB_CLEAR = "A99";
/** 繰越利益剰余金（試算表では、その期の利益も入っている。取り込むときは期首の分だけ使い、利益は損益の科目から計算する） */
export const RETAINED = "490";

/**
 * はじめの勘定科目：丸北農場の会計ソフトの科目コードと補助科目（合計残高試算表 2026年2月度〜8月度に出てくるもの）。
 * 補助科目のコードは「親-子」。A で始まるのはこのアプリで足した科目（会計ソフトのコードとぶつからないように）
 */
export const DEFAULT_ACCOUNTS: Account[] = [
  { code: "100", name: "現金", kind: "asset" },
  { code: "101", name: "現金(平山)", kind: "asset" },
  { code: "106", name: "普通預金", kind: "asset" },
  { code: "106-1", name: "北洋銀行", kind: "asset", parent: "106" },
  { code: "106-2", name: "JAびえい", kind: "asset", parent: "106" },
  { code: "106-3", name: "営農貯金", kind: "asset", parent: "106" },
  { code: "106-4", name: "旭川信用金庫", kind: "asset", parent: "106" },
  { code: "106-5", name: "北海道銀行", kind: "asset", parent: "106" },
  { code: "107", name: "組勘勘定", kind: "asset" },
  { code: "172", name: "前払費用", kind: "asset" },
  { code: "178", name: "仮払金", kind: "asset" },
  { code: "178-1", name: "JCB", kind: "asset", parent: "178" },
  { code: "178-2", name: "三井住友カード", kind: "asset", parent: "178" },
  { code: "178-10", name: "その他", kind: "asset", parent: "178" },
  { code: "180", name: "短期貸付金", kind: "asset" },
  { code: "197", name: "未収消費税等", kind: "asset" },
  { code: "200", name: "建物", kind: "asset" },
  { code: "202", name: "建物附属設備", kind: "asset" },
  { code: "204", name: "構築物", kind: "asset" },
  { code: "206", name: "機械及び装置", kind: "asset" },
  { code: "208", name: "車両運搬具", kind: "asset" },
  { code: "212", name: "工具器具備品", kind: "asset" },
  { code: "222", name: "土地", kind: "asset" },
  { code: "254", name: "出資金", kind: "asset" },
  { code: "257", name: "保険積立金", kind: "asset" },
  { code: "306", name: "未払金", kind: "liability" },
  { code: "307", name: "給与未払金", kind: "liability" },
  { code: "320", name: "短期借入金", kind: "liability" },
  { code: "320-1", name: "社長", kind: "liability", parent: "320" },
  { code: "320-2", name: "丸北北海道", kind: "liability", parent: "320" },
  { code: "320-3", name: "丸北", kind: "liability", parent: "320" },
  { code: "322", name: "預り金", kind: "liability" },
  { code: "322-1", name: "源泉所得税", kind: "liability", parent: "322" },
  { code: "322-2", name: "町民市民税", kind: "liability", parent: "322" },
  { code: "330", name: "仮受金", kind: "liability" },
  { code: "350", name: "未払法人税等", kind: "liability" },
  { code: "370", name: "長期借入金", kind: "liability" },
  { code: "400", name: "資本金", kind: "equity" },
  { code: "490", name: "繰越利益剰余金", kind: "equity" },
  { code: "500", name: "野菜等収入", kind: "revenue", section: "sales" },
  { code: "500-3", name: "イチゴ", kind: "revenue", section: "sales", parent: "500" },
  { code: "501", name: "飲食売上高", kind: "revenue", section: "sales" },
  { code: "501-1", name: "いちご狩り", kind: "revenue", section: "sales", parent: "501" },
  { code: "501-3", name: "いちご販売", kind: "revenue", section: "sales", parent: "501" },
  { code: "501-5", name: "イチゴ狩りチケット代", kind: "revenue", section: "sales", parent: "501" },
  { code: "501-6", name: "イチゴジャム販売", kind: "revenue", section: "sales", parent: "501" },
  { code: "501-7", name: "その他", kind: "revenue", section: "sales", parent: "501" },
  { code: "716", name: "法定福利費", kind: "expense", section: "personnel" },
  { code: "718", name: "福利厚生費", kind: "expense", section: "personnel" },
  { code: "720", name: "外注費", kind: "expense", section: "sgaOther" },
  { code: "722", name: "通信費", kind: "expense", section: "sgaOther" },
  { code: "724", name: "荷造運賃", kind: "expense", section: "sgaOther" },
  { code: "726", name: "水道光熱費", kind: "expense", section: "sgaOther" },
  { code: "726-2", name: "水道代", kind: "expense", section: "sgaOther", parent: "726" },
  { code: "726-4", name: "LPガス", kind: "expense", section: "sgaOther", parent: "726" },
  { code: "728", name: "旅費交通費", kind: "expense", section: "sgaOther" },
  { code: "730", name: "広告宣伝費", kind: "expense", section: "sgaOther" },
  { code: "734", name: "接待交際費", kind: "expense", section: "sgaOther" },
  { code: "734-1", name: "飲食代", kind: "expense", section: "sgaOther", parent: "734" },
  { code: "734-3", name: "お土産代", kind: "expense", section: "sgaOther", parent: "734" },
  { code: "738", name: "事務用品費", kind: "expense", section: "sgaOther" },
  { code: "740", name: "消耗品費", kind: "expense", section: "sgaOther" },
  { code: "744", name: "修繕費", kind: "expense", section: "sgaOther" },
  { code: "750", name: "車両燃料費", kind: "expense", section: "sgaOther" },
  { code: "751", name: "車両費", kind: "expense", section: "sgaOther" },
  { code: "756", name: "租税公課", kind: "expense", section: "sgaOther" },
  { code: "756-1", name: "固定資産税", kind: "expense", section: "sgaOther", parent: "756" },
  { code: "756-2", name: "印紙代", kind: "expense", section: "sgaOther", parent: "756" },
  { code: "756-10", name: "その他", kind: "expense", section: "sgaOther", parent: "756" },
  { code: "760", name: "リース料", kind: "expense", section: "sgaOther" },
  { code: "762", name: "支払手数料", kind: "expense", section: "sgaOther" },
  { code: "776", name: "減価償却費", kind: "expense", section: "sgaOther" },
  { code: "790", name: "雑費", kind: "expense", section: "sgaOther" },
  { code: "790-1", name: "課税", kind: "expense", section: "sgaOther", parent: "790" },
  { code: "790-2", name: "不課税", kind: "expense", section: "sgaOther", parent: "790" },
  { code: "798", name: "管理諸費", kind: "expense", section: "sgaOther" },
  { code: "810", name: "材料仕入高", kind: "expense", section: "material" },
  { code: "811", name: "種苗費", kind: "expense", section: "material" },
  { code: "812", name: "肥料費", kind: "expense", section: "material" },
  { code: "813", name: "農薬費", kind: "expense", section: "material" },
  { code: "814", name: "燃料費", kind: "expense", section: "material" },
  { code: "815", name: "諸材料費", kind: "expense", section: "material" },
  { code: "840", name: "(製)給料手当", kind: "expense", section: "labor" },
  { code: "840-1", name: "給与", kind: "expense", section: "labor", parent: "840" },
  { code: "840-2", name: "交通費", kind: "expense", section: "labor", parent: "840" },
  { code: "842", name: "(製)賃金", kind: "expense", section: "labor" },
  { code: "854", name: "(製)法定福利費", kind: "expense", section: "labor" },
  { code: "856", name: "(製)福利厚生費", kind: "expense", section: "labor" },
  { code: "856-1", name: "おやつ外", kind: "expense", section: "labor", parent: "856" },
  { code: "857", name: "(製)作業用衣料費", kind: "expense", section: "labor" },
  { code: "860", name: "(製)外注加工費", kind: "expense", section: "overhead" },
  { code: "861", name: "(製)作業委託料", kind: "expense", section: "overhead" },
  { code: "864", name: "(製)荷造運賃手数料", kind: "expense", section: "overhead" },
  { code: "865", name: "(製)農具費", kind: "expense", section: "overhead" },
  { code: "866", name: "(製)修繕費", kind: "expense", section: "overhead" },
  { code: "867", name: "(製)動力光熱費", kind: "expense", section: "overhead" },
  { code: "868", name: "(製)共済掛金", kind: "expense", section: "overhead" },
  { code: "877", name: "(製)土地改良費", kind: "expense", section: "overhead" },
  { code: "886", name: "(製)消耗品費", kind: "expense", section: "overhead" },
  { code: "890", name: "(製)車両燃料費", kind: "expense", section: "overhead" },
  { code: "890-1", name: "ガソリン外", kind: "expense", section: "overhead", parent: "890" },
  { code: "890-2", name: "自動車税", kind: "expense", section: "overhead", parent: "890" },
  { code: "890-3", name: "整備等課税", kind: "expense", section: "overhead", parent: "890" },
  { code: "890-4", name: "整備等不課税", kind: "expense", section: "overhead", parent: "890" },
  { code: "890-5", name: "軽油配送", kind: "expense", section: "overhead", parent: "890" },
  { code: "890-6", name: "自賠責共済", kind: "expense", section: "overhead", parent: "890" },
  { code: "890-7", name: "軽油引取税", kind: "expense", section: "overhead", parent: "890" },
  { code: "894", name: "(製)雑費", kind: "expense", section: "overhead" },
  { code: "894-1", name: "課税", kind: "expense", section: "overhead", parent: "894" },
  { code: "900", name: "受取利息", kind: "revenue", section: "nonOpIncome" },
  { code: "910", name: "雑収入", kind: "revenue", section: "nonOpIncome" },
  { code: "910-1", name: "課税", kind: "revenue", section: "nonOpIncome", parent: "910" },
  { code: "910-2", name: "不課税", kind: "revenue", section: "nonOpIncome", parent: "910" },
  { code: "A01", name: "レジ現金", kind: "asset" },
  { code: "A02", name: "売掛金", kind: "asset" },
  { code: "A10", name: "役員報酬", kind: "expense", section: "personnel" },
  { code: OPENING, name: "開始残高", kind: "equity" },
  { code: TB_CLEAR, name: "試算表の取り込み", kind: "equity" },
  { code: UNSORTED, name: "未分類", kind: "expense", section: "sgaOther" },
];
/** 消せない科目（自動の仕訳で使う） */
export const FIXED_CODES = [CASH, OPENING, UNSORTED, TB_CLEAR, RETAINED];

/** 科目の名前（補助科目は「親／子」。プルダウンや元帳で使う） */
export function fullName(accounts: Account[], a: Account): string {
  const p = a.parent ? accounts.find((x) => x.code === a.parent) : undefined;
  return p ? `${p.name}／${a.name}` : a.name;
}

/** 自動仕訳（レジの売上・売掛・給与）に使う科目。サーバー（functions/src/ledgerAuto.ts）の DEFAULT_AUTO と同じ */
export const DEFAULT_AUTO = {
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
export type AutoCodes = typeof DEFAULT_AUTO;
export const AUTO_LABELS: { key: keyof AutoCodes; label: string; note: string }[] = [
  { key: "sales", label: "売上（分類で決めていないもの）", note: "下の「レジの分類と売上の科目」で決めていない分類の売上・手で入れた売掛の相手" },
  { key: "cashSales", label: "レジの現金売上", note: "現金で受け取った売上を入れておく科目（預金に入れたら通帳の取り込みで動く）" },
  { key: "creditSales", label: "売掛", note: "売掛の会計・手で入れた売掛" },
  { key: "collect", label: "売掛の入金先", note: "売掛管理で「入金済み」にしたとき、お金が入った科目" },
  { key: "wages", label: "給料", note: "月給・時給" },
  { key: "commute", label: "通勤費", note: "非課税通勤費" },
  { key: "officer", label: "役員報酬", note: "役員報酬" },
  { key: "unpaid", label: "振り込む給与", note: "手取り（通帳から振り込んだときに減らす）" },
  { key: "social", label: "天引きした社会保険料", note: "本人負担分。会計ソフトと同じく法定福利費から引く（納めたときに全額を法定福利費にする）" },
  { key: "incomeTax", label: "天引きした所得税", note: "源泉所得税（年末調整の還付もここ）" },
  { key: "residentTax", label: "天引きした住民税", note: "町民市民税" },
];
/** レジの分類（商品・プランの分類）→ 売上の科目。はじめの対応 */
export const DEFAULT_SALES_MAP: Record<string, string> = { いちご狩り: "501-1" };

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
  /** レジの分類 → 売上の科目 */
  salesMap: Record<string, string>;
};
/** 勘定科目の版。3＝丸北農場の会計ソフトの科目コード。これより前に保存した科目は、はじめの科目に置き換えて読む */
export const CHART_VERSION = 3;
export const DEFAULT_BANK_RULES: BankRule[] = [
  // ホーブへの出荷は入金のときに売上にする（会計ソフトと同じ入金ベース。入金は手数料を引いた額のまま）
  { keyword: "ホーブ", code: "500-3" },
  { keyword: "給与", code: "307" },
  { keyword: "社会保険", code: "854" },
  { keyword: "厚生年金", code: "854" },
  { keyword: "所得税", code: "322-1" },
  { keyword: "住民税", code: "322-2" },
  { keyword: "利息", code: "900" },
  { keyword: "手数料", code: "762" },
  { keyword: "電気", code: "867" },
  { keyword: "電力", code: "867" },
  { keyword: "デンリョク", code: "867" },
  { keyword: "デンキ", code: "867" },
  { keyword: "水道", code: "726-2" },
  { keyword: "スイドウ", code: "726-2" },
  { keyword: "NTT", code: "722" },
];
export const DEFAULT_CONFIG: LedgerConfig = {
  accounts: DEFAULT_ACCOUNTS,
  itemMap: {},
  fiscalStart: 2,
  auto: DEFAULT_AUTO,
  bankRules: DEFAULT_BANK_RULES,
  salesMap: DEFAULT_SALES_MAP,
};

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
          // 前の版の科目（試算表の科目にする前）は使わず、はじめの科目にする。出納帳の項目の対応は、同じコードの科目があれば残す
          const old = s.get("chartVersion") !== CHART_VERSION;
          const codes = new Set(DEFAULT_ACCOUNTS.map((a) => a.code));
          const accounts = old ? DEFAULT_ACCOUNTS : ((s.get("accounts") as Account[] | undefined) ?? []);
          const auto = old ? DEFAULT_AUTO : { ...DEFAULT_AUTO, ...((s.get("auto") as Partial<AutoCodes> | undefined) ?? {}) };
          const itemMap = (s.get("itemMap") as Record<string, string> | undefined) ?? {};
          // 消せない科目と、自動仕訳に使う科目が入っていなければ足す（あとから足した「レジ現金」など）
          const need = new Set([...FIXED_CODES, ...Object.values(auto)]);
          const missing = DEFAULT_ACCOUNTS.filter((a) => need.has(a.code) && !accounts.some((b) => b.code === a.code));
          setState({
            value: {
              accounts: sortAccounts([...accounts, ...missing]),
              itemMap: old ? Object.fromEntries(Object.entries(itemMap).filter(([, v]) => codes.has(v))) : itemMap,
              fiscalStart: old ? DEFAULT_CONFIG.fiscalStart : ((s.get("fiscalStart") as number | undefined) ?? DEFAULT_CONFIG.fiscalStart),
              auto,
              bankRules: old ? DEFAULT_BANK_RULES : ((s.get("bankRules") as BankRule[] | undefined) ?? DEFAULT_BANK_RULES),
              salesMap: old ? DEFAULT_SALES_MAP : ((s.get("salesMap") as Record<string, string> | undefined) ?? DEFAULT_SALES_MAP),
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
      .map((a) => {
        const section = sectionOf(a);
        const parent = a.parent && a.parent !== a.code && codes.has(a.parent) ? a.parent : null;
        return { code: a.code.trim().slice(0, 10), name: a.name.trim().slice(0, 40), kind: a.kind, ...(section ? { section } : {}), ...(parent ? { parent } : {}) };
      }),
    chartVersion: CHART_VERSION,
    itemMap,
    fiscalStart: Math.min(12, Math.max(1, Math.round(c.fiscalStart))),
    auto: Object.fromEntries(Object.entries(c.auto).filter(([, v]) => codes.has(v))),
    bankRules: c.bankRules
      .map((r) => ({ keyword: r.keyword.trim().slice(0, 40), code: r.code }))
      .filter((r) => r.keyword && (r.code === SKIP || codes.has(r.code)))
      .slice(0, 300),
    salesMap: Object.fromEntries(
      Object.entries(c.salesMap)
        .map(([k, v]) => [k.trim().slice(0, 40), v] as const)
        .filter(([k, v]) => k && codes.has(v))
        .slice(0, 200),
    ),
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
  source: "cash" | "manual" | "auto" | "bank" | "imported";
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
/** imported：いまの会計ソフトから取り込んだ試算表（その月は、試算表の数字だけを使う） */
export type Books = { cash: CashMonth[]; journal: JournalMonth[]; auto: AutoMonth[]; bank: BankMonth[]; imported: TbMonth[] };

/** 帳簿の元になるデータがある月（古い順） */
export function monthsWithData(b: Books): string[] {
  return [...new Set([...b.cash, ...b.journal, ...b.auto, ...b.bank, ...b.imported].map((x) => x.month))].sort();
}

/** その月の全部の仕訳 */
export function monthPostings(b: Books, config: LedgerConfig, month: string): Posting[] {
  // 試算表を取り込んだ月は、会計ソフトでつけ終わった月なので、試算表の数字だけを使う（ほかの元からの仕訳は数えない。二重にしない）
  if (b.imported.some((x) => x.month === month)) return importedPostings(b.imported, month, config.accounts);
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
/** categories：その月のレジの分類ごとの売上（分類と科目の対応を決める画面で使う） */
export type AutoMonth = { month: string; entries: AutoEntry[]; generatedAt: Date | null; categories: Record<string, number> };
export const AUTO_KIND_LABEL: Record<AutoEntry["kind"], string> = { sales: "レジ", receivable: "売掛", payroll: "給与" };

export function autoPostings(auto: AutoMonth[], month: string): Posting[] {
  return (auto.find((x) => x.month === month)?.entries ?? []).map((e) => ({ date: e.date, debit: e.debit, credit: e.credit, amount: e.amount, memo: e.memo, source: "auto" as const }));
}

export function useAutoJournal() {
  return useMonthDocs<AutoMonth>("autoJournal", (id, d) => ({
    month: id,
    entries: (d.entries as AutoEntry[] | undefined) ?? [],
    generatedAt: (d.generatedAt as { toDate?: () => Date } | undefined)?.toDate?.() ?? null,
    categories: (d.categories as Record<string, number> | undefined) ?? {},
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
  const imported = useTbImport();
  const error = cash.error || journal.error || auto.error || bank.error || imported.error;
  if (error) return { value: null, error };
  if (!cash.value || !journal.value || !auto.value || !bank.value || !imported.value) return { value: null, error: null };
  return { value: { cash: cash.value, journal: journal.value, auto: auto.value, bank: bank.value, imported: imported.value }, error: null };
}

// ---------- いまの会計ソフトの試算表 ----------

export function useTbImport() {
  return useMonthDocs<TbMonth>("tbImport", (id, d) => ({ month: id, rows: (d.rows as TbMonth["rows"] | undefined) ?? [], fileName: d.fileName as string | undefined }));
}

/**
 * 取り込んだ月の仕訳：科目ごとに、その月の借方・貸方を「試算表の取り込み」を相手にして入れる（月末の日付）。
 * いちばん古い取り込んだ月は、繰越金額を期首の残高として入れる（その月の1日）。
 * 繰越利益剰余金は、試算表ではその期の利益も動くので、動きは入れない（利益は損益の科目から計算する）。
 * 期の途中の月から取り込んだときは、損益の科目の繰越（その月までの累計）も入れ、繰越利益剰余金の繰越からその分の利益を引く
 */
export function importedPostings(imported: TbMonth[], month: string, accounts: Account[]): Posting[] {
  const m = imported.find((x) => x.month === month);
  if (!m) return [];
  const out: Posting[] = [];
  const first = !imported.some((x) => x.month < month);
  const day1 = `${month}-01`;
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  const kindOf = (code: string) => accountOf(accounts, code).kind;
  /** その科目の残る側に amount を入れる仕訳（マイナスなら反対側） */
  const natural = (code: string, amount: number, date: string, memo: string) => {
    if (!amount) return;
    const debitNatural = debitSide(kindOf(code));
    const toDebit = debitNatural === amount > 0;
    out.push({ date, debit: toDebit ? code : TB_CLEAR, credit: toDebit ? TB_CLEAR : code, amount: Math.abs(amount), memo, source: "imported" });
  };
  if (first) {
    let ytd = 0;
    for (const r of m.rows) {
      const k = kindOf(r.code);
      if (k === "revenue") ytd += r.carry;
      if (k === "expense") ytd -= r.carry;
    }
    for (const r of m.rows) natural(r.code, r.code === RETAINED ? r.carry - ytd : r.carry, day1, "期首の残高（試算表の繰越）");
  }
  for (const r of m.rows) {
    if (r.code === RETAINED) continue;
    if (r.debit) out.push({ date: end, debit: r.debit > 0 ? r.code : TB_CLEAR, credit: r.debit > 0 ? TB_CLEAR : r.code, amount: Math.abs(r.debit), memo: "試算表の借方金額", source: "imported" });
    if (r.credit) out.push({ date: end, debit: r.credit > 0 ? TB_CLEAR : r.code, credit: r.credit > 0 ? r.code : TB_CLEAR, amount: Math.abs(r.credit), memo: "試算表の貸方金額", source: "imported" });
  }
  return out;
}

/** 取り込む前の確かめ：借方と貸方の合計が合っているか・繰越＋借方−貸方＝残高か（繰越利益剰余金を除く） */
export function checkTb(t: TbParsed, accounts: Account[]) {
  const all = [...accounts, ...t.accounts];
  const kindOf = (code: string) => (all.find((a) => a.code === code) ?? { kind: "expense" as AccountKind }).kind;
  const rows = t.rows.filter((r) => r.code !== RETAINED);
  const debit = rows.reduce((n, r) => n + r.debit, 0);
  const credit = rows.reduce((n, r) => n + r.credit, 0);
  const wrong = rows.filter((r) => r.carry + naturalMove(kindOf(r.code), r.debit, r.credit) !== r.balance).map((r) => r.code);
  return { debit, credit, balanced: debit === credit, wrong };
}

/** 取り込む：月ごとに置き換え、まだない科目は勘定科目に足す（ある科目の名前などはそのまま） */
export async function saveTbImport(list: TbParsed[], config: LedgerConfig) {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  for (const t of list) {
    batch.set(doc(db, `tbImport/${t.month}`), {
      rows: t.rows.slice(0, 1000).map((r) => ({ code: r.code, carry: r.carry, debit: r.debit, credit: r.credit, balance: r.balance })),
      fileName: (t.fileName ?? "").slice(0, 100),
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
  const have = new Set(config.accounts.map((a) => a.code));
  const added: Account[] = [];
  for (const t of list)
    for (const a of t.accounts) {
      if (have.has(a.code)) continue;
      have.add(a.code);
      added.push(a);
    }
  if (added.length) await saveLedgerConfig({ ...config, accounts: sortAccounts([...config.accounts, ...added]) });
  return added.length;
}

export async function deleteTbImport(month: string) {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  batch.delete(doc(db, `tbImport/${month}`));
  await batch.commit();
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


// ---------- 損益計算書・製造原価報告書の形 ----------

/** 表の1行。値は、terms の科目の金額（収益は貸方−借方、費用は借方−貸方）に sign をかけて足したもの */
export type StatementLine = { label: string; type: "head" | "sub" | "item" | "total" | "result"; indent: 0 | 1 | 2; terms: { code: string; sign: 1 | -1 }[] };

/**
 * 丸北農場の合計残高試算表と同じ並びの行を作る。
 * 科目は、金額のあるもの（used）だけ出す。補助科目は親の下に字下げして出し、親の金額は自分と補助科目の合計
 */
export function statementLines(accounts: Account[], used: Set<string>, which: "pl" | "mfg"): StatementLine[] {
  const all = [...accounts, ...[...used].filter((c) => !accounts.some((a) => a.code === c)).map((c) => accountOf(accounts, c))];
  const inSection = (s: Section) => sortAccounts(all.filter((a) => sectionOf(a) === s));
  const terms = (sections: Section[], sign: 1 | -1 = 1) => sections.flatMap((s) => inSection(s).map((a) => ({ code: a.code, sign })));
  const items = (s: Section): StatementLine[] => {
    const list = inSection(s);
    const isTop = (a: Account) => !a.parent || !list.some((p) => p.code === a.parent && !p.parent);
    return list.filter(isTop).flatMap((p) => {
      const children = isTop(p) ? list.filter((c) => c.parent === p.code && c.code !== p.code) : [];
      const own = [p, ...children].map((a) => ({ code: a.code, sign: 1 as const }));
      if (!own.some((t) => used.has(t.code))) return [];
      return [
        { label: p.name, type: "item" as const, indent: 1 as const, terms: own },
        ...children.filter((c) => used.has(c.code)).map((c) => ({ label: c.name, type: "item" as const, indent: 2 as const, terms: [{ code: c.code, sign: 1 as const }] })),
      ];
    });
  };
  const head = (label: string): StatementLine => ({ label, type: "head", indent: 0, terms: [] });
  const sub = (label: string): StatementLine => ({ label, type: "sub", indent: 0, terms: [] });
  const total = (label: string, t: StatementLine["terms"], type: "total" | "result" = "total"): StatementLine => ({ label, type, indent: 0, terms: t });
  const mfg = terms(MFG_SECTIONS);
  if (which === "mfg")
    return [
      head("【材料費】"),
      ...items("material"),
      total("材料費計", terms(["material"])),
      head("【労務費】"),
      ...items("labor"),
      total("労務費計", terms(["labor"])),
      head("【製造経費】"),
      ...items("overhead"),
      total("製造経費計", terms(["overhead"])),
      total("当期総製造費用", mfg),
      total("当期製品製造原価", mfg, "result"),
    ];
  const sales = terms(["sales"]);
  const cogs = terms(["purchase", ...MFG_SECTIONS], -1);
  const sga = terms(["personnel", "sgaOther"], -1);
  const nonOp = [...terms(["nonOpIncome"]), ...terms(["nonOpExpense"], -1)];
  const extra = [...terms(["extraGain"]), ...terms(["extraLoss"], -1)];
  return [
    head("【売上高】"),
    ...items("sales"),
    total("売上高計", sales),
    head("【売上原価】"),
    ...items("purchase"),
    { label: "当期製品製造原価", type: "item", indent: 1, terms: mfg },
    total("売上原価計", terms(["purchase", ...MFG_SECTIONS])),
    total("売上総利益", [...sales, ...cogs], "result"),
    head("【販売費および一般管理費】"),
    sub("（人件費）"),
    ...items("personnel"),
    total("人件費計", terms(["personnel"])),
    sub("（その他経費）"),
    ...items("sgaOther"),
    total("その他経費計", terms(["sgaOther"])),
    total("販売費・一般管理費計", terms(["personnel", "sgaOther"])),
    total("営業利益", [...sales, ...cogs, ...sga], "result"),
    head("【営業外収益】"),
    ...items("nonOpIncome"),
    total("営業外収益計", terms(["nonOpIncome"])),
    head("【営業外費用】"),
    ...items("nonOpExpense"),
    total("営業外費用計", terms(["nonOpExpense"])),
    total("経常利益", [...sales, ...cogs, ...sga, ...nonOp], "result"),
    head("【特別利益】"),
    ...items("extraGain"),
    total("特別利益計", terms(["extraGain"])),
    head("【特別損失】"),
    ...items("extraLoss"),
    total("特別損失計", terms(["extraLoss"])),
    total("税引前当期純利益", [...sales, ...cogs, ...sga, ...nonOp, ...extra], "result"),
    head("【法人税等】"),
    ...items("tax"),
    total("法人税等計", terms(["tax"])),
    total("当期純利益", [...sales, ...cogs, ...sga, ...nonOp, ...extra, ...terms(["tax"], -1)], "result"),
  ];
}

export const lineValue = (l: StatementLine, amounts: Map<string, number>) => l.terms.reduce((n, t) => n + t.sign * (amounts.get(t.code) ?? 0), 0);
