// 「仕切単価連絡表」（期間と、規格ごとの産地仕切価格が書かれた紙）を、文字読み取り（Google Cloud Vision）の結果から読む。
// 読んだ期間と単価は「期間でまとめて単価を入れる」の欄に入れ、画面で確かめて直してから表に入れる。
import { rotateWords, type OcrPage } from "./shikiriOcr";
import type { Grade } from "./shipping";

export type NoticeRow = { group: string; size: number; price: number };
export type PriceNotice = { from: string | null; to: string | null; rows: NoticeRow[]; notes: string[] };

type W = ReturnType<typeof rotateWords>[number];

const median = (a: number[]) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const pad = (n: number) => String(n).padStart(2, "0");
/** 区分の名前（全角のＡなども半角にそろえる） */
const groupKey = (s: string) => s.normalize("NFKC").replace(/\s/g, "").toUpperCase();
const GROUP_LABEL = /^(秀|優|A|B|M|L)$/;

/** 同じ高さに並んだ単語を1行にまとめる（左から右へ） */
function lines(ws: W[]): W[][] {
  const h = median(ws.map((w) => w.h)) || 10;
  const out: { y: number; ws: W[] }[] = [];
  for (const w of [...ws].sort((a, b) => a.y - b.y)) {
    const l = out.find((x) => Math.abs(x.y - w.y) < h * 0.5);
    if (l) {
      l.ws.push(w);
      l.y = l.ws.reduce((a, b) => a + b.y, 0) / l.ws.length;
    } else out.push({ y: w.y, ws: [w] });
  }
  return out.map((l) => l.ws.sort((a, b) => a.x0 - b.x0));
}

/** 行の中の数字を、離れているところで区切って取り出す（近い数字どうしはつなげる：「8」「50」→ 850） */
function numbersOf(l: W[]): { n: number; x: number }[] {
  const h = median(l.map((w) => w.h)) || 10;
  const out: { s: string; x0: number; x1: number }[] = [];
  for (const w of l) {
    const t = w.t.replace(/[,，]/g, "");
    if (!/^\d+$/.test(t)) {
      out.push({ s: "", x0: w.x0, x1: w.x1 });
      continue;
    }
    const last = out.at(-1);
    if (last && last.s && w.x0 - last.x1 < h * 0.35) {
      last.s += t;
      last.x1 = w.x1;
    } else out.push({ s: t, x0: w.x0, x1: w.x1 });
  }
  return out.filter((o) => o.s).map((o) => ({ n: Number(o.s), x: (o.x0 + o.x1) / 2 }));
}

function readOne(ws: W[], fallbackYear: number): PriceNotice {
  const ls = lines(ws);
  const notes: string[] = [];
  // 期間：「2026年8月9日〜2026年8月15日」（終わりの年は書いていなくてもよい）
  let from: string | null = null;
  let to: string | null = null;
  for (const l of ls) {
    const s = l.map((w) => w.t).join("");
    const m = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日[^\d]{0,3}?[～〜~\-ー―から]+[^\d]{0,2}(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/.exec(s);
    if (m) {
      const y1 = Number(m[1] ?? fallbackYear);
      const y2 = Number(m[4] ?? y1);
      from = `${y1}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
      to = `${y2}-${pad(Number(m[5]))}-${pad(Number(m[6]))}`;
      break;
    }
  }
  if (!from) notes.push("期間（〇月〇日〜〇月〇日）が読み取れませんでした");

  // 表：1行に「入数（8・16・20…）」と「単価」が並ぶ行。日付や時刻の行は除く
  const labels: { name: string; y: number }[] = [];
  const raw: { size: number; price: number; y: number }[] = [];
  for (const l of ls) {
    const s = l.map((w) => w.t).join("");
    for (const w of l) if (GROUP_LABEL.test(groupKey(w.t))) labels.push({ name: groupKey(w.t), y: w.y });
    if (/[年月:：]/.test(s)) continue;
    const nums = numbersOf(l);
    const i = nums.findIndex((x) => x.n >= 1 && x.n <= 60);
    const p = i >= 0 ? nums.slice(i + 1).find((x) => x.n >= 50 && x.n <= 50000) : undefined;
    if (i >= 0 && p) raw.push({ size: nums[i].n, price: p.n, y: l[0].y });
  }
  // 区分は、入数が小さくなったところで次の区分に変わる（秀 8→35、A 16→30）
  const order = labels
    .sort((a, b) => a.y - b.y)
    .map((x) => x.name)
    .filter((n, i, a) => a.indexOf(n) === i);
  const names = order.length ? order : ["秀", "A"];
  const rows: NoticeRow[] = [];
  let block = 0;
  raw.forEach((r, i) => {
    if (i > 0 && r.size <= raw[i - 1].size) block++;
    rows.push({ group: names[block] ?? `区分${block + 1}`, size: r.size, price: r.price });
  });
  if (!rows.length) notes.push("規格ごとの単価の表が読み取れませんでした");
  return { from, to, rows, notes };
}

/** 読み取り結果から、期間と単価を読む（紙が横向き・逆さでも読めるよう、4つの向きで試していちばん読めたものを使う） */
export function parsePriceNotice(page: OcrPage, fallbackYear: number): PriceNotice {
  let best: PriceNotice | null = null;
  for (const r of [0, 90, 180, 270] as const) {
    const res = readOne(rotateWords(page, r), fallbackYear);
    const score = res.rows.length * 2 + (res.from ? 3 : 0);
    const bestScore = best ? best.rows.length * 2 + (best.from ? 3 : 0) : -1;
    if (score > bestScore) best = res;
  }
  return best ?? { from: null, to: null, rows: [], notes: ["読み取れませんでした"] };
}

/** 読んだ行を、出荷の規格に当てはめる（区分が同じで、入数＝粒数が同じもの） */
export function matchGrades(rows: NoticeRow[], grades: Grade[]): { prices: Record<string, number>; matched: string[]; unmatched: string[] } {
  const prices: Record<string, number> = {};
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const r of rows) {
    const g = grades.find((x) => groupKey(x.group) === groupKey(r.group) && x.count === r.size);
    if (g) {
      prices[g.id] = r.price;
      matched.push(`${g.group}${g.name} ${r.price}円`);
    } else unmatched.push(`${r.group}${r.size} ${r.price}円`);
  }
  return { prices, matched, unmatched };
}
