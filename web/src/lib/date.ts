// 日付の小道具。日付はすべて日本時間の "YYYY-MM-DD" 文字列で扱う。

/** 日本時間の今日 */
export function todayJST(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

/** n日後（マイナスなら前） */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** 曜日（日〜土） */
export function weekday(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return "日月火水木金土"[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 「7月1日（火）」の形 */
export function formatJa(ymd: string, withYear = false): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${withYear ? `${y}年` : ""}${m}月${d}日（${weekday(ymd)}）`;
}

export function isValidYmd(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** "YYYY-MM" を n か月ずらす */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/**
 * 1年を52週（日曜はじまり〜土曜）に分ける。
 * 第1週は、1月1日を含む週（その前の日曜から）。年末の週が翌年にまたがるときは、その週までを数える（53週になる年もある）。
 */
export function weeksOf(year: number): { no: number; from: string; to: string }[] {
  const jan1 = `${year}-01-01`;
  const dow = new Date(`${jan1}T00:00:00Z`).getUTCDay();
  let start = addDays(jan1, -dow);
  const out: { no: number; from: string; to: string }[] = [];
  for (let no = 1; start <= `${year}-12-31`; no++) {
    out.push({ no, from: start, to: addDays(start, 6) });
    start = addDays(start, 7);
  }
  return out;
}
