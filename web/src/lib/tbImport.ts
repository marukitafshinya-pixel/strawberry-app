// いまの会計ソフトから書き出した「合計残高試算表」（1か月ずつ・貸借対照表／損益計算書／製造原価のシート）を読む。
// 列：補助科目有無（""・有・補）・勘定科目コード・勘定科目名称・繰越金額・借方金額・貸方金額・残高
// 補助科目（補）は、すぐ上の「有」の科目の子にする（コードは「親-子」。例 106-1 北洋銀行）。
// 合計の行（コードが9000番台）は見出しとして、科目の種類と損益計算書の区分を決めるのに使う
import type { Account, AccountKind, Section } from "./books";
import type { Workbook } from "./xlsx";

/** 1つの科目の1か月分。金額は試算表のまま（繰越・残高は、その科目の残る側をプラス） */
export type TbRow = { code: string; carry: number; debit: number; credit: number; balance: number };
export type TbMonth = { month: string; rows: TbRow[]; fileName?: string };
export type TbParsed = TbMonth & { accounts: Account[]; problems: string[] };

/** 名前のすき間を消し、半角カナなどをそろえる（"現      金" → "現金"、"ｲﾁｺﾞ" → "イチゴ"） */
export const cleanName = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const num = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** 見出しの行から、その下の科目の種類と区分を決める */
function headingOf(name: string): { kind: AccountKind; section?: Section } | null {
  const n = cleanName(name);
  if (n.includes("純資産の部")) return { kind: "equity" };
  if (n.includes("負債の部")) return { kind: "liability" };
  if (n.includes("資産の部")) return { kind: "asset" };
  if (n === "【売上高】") return { kind: "revenue", section: "sales" };
  if (n === "【売上原価】") return { kind: "expense", section: "purchase" };
  if (n === "【販売費および一般管理費】" || n === "(その他経費)") return { kind: "expense", section: "sgaOther" };
  if (n === "(人件費)") return { kind: "expense", section: "personnel" };
  if (n === "【営業外収益】") return { kind: "revenue", section: "nonOpIncome" };
  if (n === "【営業外費用】") return { kind: "expense", section: "nonOpExpense" };
  if (n === "【特別利益】") return { kind: "revenue", section: "extraGain" };
  if (n === "【特別損失】") return { kind: "expense", section: "extraLoss" };
  if (n.startsWith("税引前当期純利益")) return { kind: "expense", section: "tax" };
  if (n === "【材料費】") return { kind: "expense", section: "material" };
  if (n === "【労務費】") return { kind: "expense", section: "labor" };
  if (n === "【製造経費】" || n === "【仕掛品】") return { kind: "expense", section: "overhead" };
  return null;
}

/** "2026年 2月度" → "2026-02" */
function monthOf(s: string): string | null {
  const m = s.normalize("NFKC").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}` : null;
}

const SHEETS = ["貸借対照表", "損益計算書", "製造原価"];

/** 試算表のブックを読む。1か月分でないとき・形がちがうときは problems に理由を入れる */
export async function readTrialBalance(wb: Workbook, fileName: string): Promise<TbParsed> {
  const problems: string[] = [];
  const rows: TbRow[] = [];
  const accounts: Account[] = [];
  let month: string | null = null;
  const found = wb.sheetNames.filter((n) => SHEETS.includes(n.trim()));
  if (found.length === 0) problems.push("「貸借対照表」「損益計算書」「製造原価」のシートがありません");
  for (const name of found) {
    const t = await wb.readSheet(name);
    const head = t[1] ?? [];
    const from = monthOf(head[3] ?? "");
    const to = monthOf(head[4] ?? "");
    if (!from || from !== to) {
      problems.push(`「${name}」が1か月分ではありません（${head[3] ?? ""}〜${head[4] ?? ""}）。1か月ずつ書き出してください`);
      continue;
    }
    if (month && month !== from) problems.push(`シートの月がそろっていません（${month} と ${from}）`);
    month = month ?? from;
    if (!(t[2] ?? []).some((c) => c.includes("勘定科目コード"))) {
      problems.push(`「${name}」の見出しの形がちがいます`);
      continue;
    }
    let ctx: { kind: AccountKind; section?: Section } = { kind: "expense", section: "sgaOther" };
    let parent: string | null = null;
    for (const r of t.slice(3)) {
      const flag = (r[0] ?? "").trim();
      const codeNum = Number(r[1]);
      const label = r[2] ?? "";
      if (!r[1] || !Number.isFinite(codeNum)) continue;
      if (flag !== "補" && codeNum >= 9000) {
        ctx = headingOf(label) ?? ctx;
        // 見出しの「純資産」の中も、種類は純資産のまま
        parent = null;
        continue;
      }
      const isSub = flag === "補";
      if (isSub && !parent) continue;
      const code: string = isSub ? `${parent}-${String(codeNum)}` : String(codeNum);
      if (!isSub) parent = flag === "有" ? code : null;
      accounts.push({ code, name: cleanName(label), kind: ctx.kind, ...(ctx.section ? { section: ctx.section } : {}), ...(isSub ? { parent: code.split("-")[0] } : {}) });
      rows.push({ code, carry: num(r[3]), debit: num(r[4]), credit: num(r[5]), balance: num(r[6]) });
    }
  }
  // 補助科目のある科目は、補助科目の合計を引いた分だけを、その科目自身の金額にする（ふつうは0）
  const own = rows.map((r) => {
    const subs = rows.filter((s) => s.code.startsWith(`${r.code}-`));
    if (subs.length === 0) return r;
    const sum = (k: keyof Omit<TbRow, "code">) => subs.reduce((n, s) => n + s[k], 0);
    return { code: r.code, carry: r.carry - sum("carry"), debit: r.debit - sum("debit"), credit: r.credit - sum("credit"), balance: r.balance - sum("balance") };
  });
  if (!month && problems.length === 0) problems.push("月が読めません");
  return { month: month ?? "", rows: own.filter((r) => r.carry || r.debit || r.credit || r.balance), accounts, fileName, problems };
}

/** 残る側をプラスにした増え方（資産・費用は借方−貸方） */
export const naturalMove = (kind: AccountKind, debit: number, credit: number) => (kind === "asset" || kind === "expense" ? debit - credit : credit - debit);
