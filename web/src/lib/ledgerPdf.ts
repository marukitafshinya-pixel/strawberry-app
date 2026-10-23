// 会計ソフトの「総勘定元帳」（PDF。文字が入っているもの）を読む。帳簿の「仕分けし直し」で使う。
// 1ページの文字を位置ごとに行にし、見出し（伝票№・日付・相手科目・摘要・借方金額・貸方金額・残高）の位置で列を決める。
// 1つの取引は2行：1行目＝伝票№・日付・相手科目／補助・摘要（品名）・金額、2行目＝摘要の続き（取引先、または「消費税」）。
// 「消費税」の行は、すぐ前の同じ品名の行に足す（税込の1行にする）

/** PDFの文字1つ（x・y は左下から。w は幅） */
export type PdfText = { str: string; x: number; y: number; w: number };

export type LedgerRow = {
  /** 伝票№ */
  no: string;
  date: string;
  /** 相手科目（補助があれば「普通預金／北洋銀行」） */
  counter: string;
  /** 品名（摘要の1行目） */
  item: string;
  /** 取引先（摘要の2行目） */
  partner: string;
  /** 借方−貸方（税込。消費税の行を足したもの） */
  amount: number;
  /** 消費税率（10・8・0）。読めなければ null */
  taxRate: number | null;
};
export type LedgerFile = {
  /** 科目コードと名前（例 "740"・"消耗品費"） */
  code: string;
  name: string;
  rows: LedgerRow[];
  /** 総合計（借方−貸方）。読み取りの確かめに使う */
  total: number | null;
  problems: string[];
};

const z2h = (s: string) => s.normalize("NFKC");
const amountOf = (s: string) => {
  const t = z2h(s).replace(/[,\s]/g, "");
  return /^-?\d+$/.test(t) ? Number(t) : null;
};

/** 同じ高さの文字を1行にまとめる（上の行から） */
function toLines(items: PdfText[]): PdfText[][] {
  const sorted = items.filter((t) => t.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfText[][] = [];
  for (const t of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - t.y) <= 2.5) last.push(t);
    else lines.push([t]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

type Cols = { no: number; date: number; counter: number; memo: number; debitRight: number; creditRight: number; balanceRight: number };

function findCols(lines: PdfText[][]): Cols | null {
  for (const l of lines) {
    const find = (re: RegExp) => l.find((t) => re.test(t.str.replace(/\s/g, "")));
    const no = find(/^伝票/);
    const date = find(/^日付/);
    const counter = find(/^相手科目/);
    const debit = find(/^借方金額/);
    const credit = find(/^貸方金額/);
    const balance = find(/^残/);
    if (!no || !date || !counter || !debit || !credit || !balance) continue;
    const memo = lines.flat().find((t) => t.str.trim() === "摘" && Math.abs(t.y - debit.y) < 12);
    const right = (t: PdfText) => t.x + t.w;
    // 残高は「残」「高」が離れて並ぶので、「高」の右端を使う
    const high = l.find((t) => t.str.trim() === "高" && t.x > balance.x);
    return {
      no: no.x,
      date: date.x,
      counter: counter.x,
      memo: memo ? memo.x - 30 : (counter.x + debit.x) / 2,
      debitRight: right(debit),
      creditRight: right(credit),
      balanceRight: high ? right(high) : right(balance) + 30,
    };
  }
  return null;
}

/** 1ページ分の文字から、取引の行を読む。前のページの最後の日付を引き継ぐ */
export function readLedgerPage(items: PdfText[], state: { year: number; startMonth: number; lastDate: string }): { code: string; name: string; rows: LedgerRow[]; total: number | null } {
  const lines = toLines(items);
  const all = lines.flat();
  // 科目：「総勘定元帳 ( 740:消耗品 費 )」。文字が分かれているので、見出しの行の文字をつなげて読む
  const titleY = all.find((t) => t.str.includes("総勘定元帳"))?.y;
  const titleText = titleY === undefined ? "" : z2h(lines.find((l) => Math.abs(l[0].y - titleY) <= 2.5)!.map((t) => t.str).join(""));
  const title = titleText.match(/\(\s*(\d+)\s*:\s*(.+)\s*\)\s*$/);
  // 期間：「2026年2月1日～2027年1月31日」
  const period = z2h(all.map((t) => t.str).join(" ")).match(/(\d{4})年(\d{1,2})月\d{1,2}日\s*[～~]/);
  if (period) {
    state.year = Number(period[1]);
    state.startMonth = Number(period[2]);
  }
  const cols = findCols(lines);
  const rows: LedgerRow[] = [];
  let total: number | null = null;
  if (!cols) return { code: title?.[1] ?? "", name: (title?.[2] ?? "").replace(/\s/g, ""), rows, total };
  const right = (t: PdfText) => t.x + t.w;
  /** 数の列：右端がいちばん近い見出し（どれからも離れている数は、品名の中の数なので金額にしない） */
  const numCol = (t: PdfText) => {
    const d = [Math.abs(right(t) - cols.debitRight), Math.abs(right(t) - cols.creditRight), Math.abs(right(t) - cols.balanceRight)];
    const min = Math.min(...d);
    return min > 25 ? null : (["debit", "credit", "balance"] as const)[d.indexOf(min)];
  };
  const memoOf = (l: PdfText[]) =>
    z2h(
      l
        .filter((t) => t.x >= cols.memo && t.x < cols.debitRight - 60 && amountOf(t.str) === null)
        .map((t) => t.str)
        .join(" "),
    ).trim();
  const moneyOf = (l: PdfText[]) => {
    let debit = 0;
    let credit = 0;
    for (const t of l) {
      if (t.x < cols.memo) continue;
      const n = amountOf(t.str);
      if (n === null) continue;
      const c = numCol(t);
      if (c === "debit") debit += n;
      if (c === "credit") credit += n;
    }
    return debit - credit;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const text = z2h(l.map((t) => t.str).join(""));
    if (text.replace(/\s/g, "").includes("総合計")) total = moneyOf(l);
    // 取引の1行目：左端に伝票№（数）がある
    const noItem = l.find((t) => t.x < cols.date - 2 && /^\d+$/.test(t.str.trim()));
    if (!noItem) continue;
    // 日付：「5 / 25」か「〃」（前の行と同じ）
    const dateText = z2h(
      l
        .filter((t) => t.x >= cols.date - 8 && t.x < cols.counter - 4)
        .map((t) => t.str)
        .join(""),
    ).replace(/\s/g, "");
    const md = dateText.match(/(\d{1,2})\/(\d{1,2})/);
    let date = state.lastDate;
    if (md) {
      const m = Number(md[1]);
      const y = m >= state.startMonth ? state.year : state.year + 1;
      date = `${y}-${String(m).padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    }
    state.lastDate = date;
    // 相手科目：日付の列より右・摘要より左の文字（「〃」は日付の続きなので消す）
    const counterText = z2h(
      l
        .filter((t) => t.x + t.w > cols.counter && t.x < cols.memo && t !== noItem)
        .map((t) => t.str)
        .join(""),
    )
      .replace(/〃/g, "")
      .replace(/\s/g, "")
      .replace(/^\d{1,2}\/\d{1,2}/, "");
    const [main, sub] = counterText.split("/");
    const next = lines[i + 1];
    const nextIsEntry = next?.some((t) => t.x < cols.date - 2 && /^\d+$/.test(t.str.trim()));
    const second = next && !nextIsEntry && next[0].y < l[0].y ? next : null;
    const partner = second ? memoOf(second) : "";
    // 税率：2行目の右の「( 21 10% )」。％がなければ消費税のかからない取引として 0
    const rateText = z2h([...l, ...(second ?? [])].filter((t) => t.x > cols.creditRight).map((t) => t.str).join(" "));
    const rateMatch = rateText.match(/(\d+)\s*%/);
    const taxRate = rateMatch ? Number(rateMatch[1]) : second || l.length ? 0 : null;
    rows.push({ no: noItem.str.trim(), date, counter: sub ? `${main}／${sub}` : main, item: memoOf(l), partner, amount: moneyOf(l), taxRate });
  }
  return { code: title?.[1] ?? "", name: (title?.[2] ?? "").replace(/\s/g, ""), rows, total };
}

/** 消費税の行（取引先が「消費税」）を、すぐ前の同じ日・同じ品名の行に足す */
export function mergeTaxRows(rows: LedgerRow[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (r.partner === "消費税" && prev && prev.date === r.date && prev.item === r.item && prev.partner !== "消費税") {
      out[out.length - 1] = { ...prev, amount: prev.amount + r.amount, no: `${prev.no}・${r.no}` };
    } else out.push(r);
  }
  return out;
}

/** PDFのファイルを読む（ブラウザ） */
export async function readLedgerPdf(file: File): Promise<LedgerFile> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: PdfText[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(
      tc.items.flatMap((it) => ("str" in it ? [{ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width }] : [])),
    );
  }
  await task.destroy();
  return readLedgerPages(pages);
}

/** ページごとの文字から、元帳1冊分を読む */
export function readLedgerPages(pages: PdfText[][]): LedgerFile {
  const state = { year: 0, startMonth: 1, lastDate: "" };
  let code = "";
  let name = "";
  let total: number | null = null;
  const rows: LedgerRow[] = [];
  for (const p of pages) {
    const r = readLedgerPage(p, state);
    code = code || r.code;
    name = name || r.name;
    if (r.total !== null) total = r.total;
    rows.push(...r.rows);
  }
  const problems: string[] = [];
  if (!code) problems.push("科目が読めません（会計ソフトの総勘定元帳のPDFか確かめてください）");
  if (!state.year) problems.push("期間が読めません");
  const sum = rows.reduce((n, r) => n + r.amount, 0);
  if (total === null) problems.push("総合計の行が見つかりません（途中のページだけかもしれません）");
  else if (sum !== total) problems.push(`読んだ金額の合計 ${sum.toLocaleString("ja-JP")} が総合計 ${total.toLocaleString("ja-JP")} と合いません`);
  if (rows.some((r) => !r.date)) problems.push("日付が読めない行があります");
  return { code, name, rows: mergeTaxRows(rows), total, problems };
}
