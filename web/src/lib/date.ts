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
