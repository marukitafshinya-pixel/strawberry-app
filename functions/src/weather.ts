// 気象データ：気象庁「過去の気象データ検索」の日ごとの値（アメダス）を読み込んで、月ごとに保存する。
// 使う項目：降水量の合計、気温（平均・最高・最低）、日照時間
// 気象庁のページは表（HTML）なので、見出しの文字から列を探して読む（列の並びが少し違っても読めるように）。
// 取り込みは1回に1か月分だけ。気象庁のサイトに負担をかけないよう、画面からは間をあけて順に呼ぶ。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertCan, db } from "./common.js";

/** 美瑛のアメダス（気象庁の地点番号） */
export const WEATHER_STATION = { name: "美瑛", precNo: 12, blockNo: "1052" };

export type WeatherDay = {
  /** 降水量の合計（mm） */
  precip?: number | null;
  /** 気温（℃） 平均・最高・最低 */
  tAvg?: number | null;
  tMax?: number | null;
  tMin?: number | null;
  /** 日照時間（h） */
  sun?: number | null;
  /** 夜温：前の日の18時からこの日の9時までで、いちばん低かった気温（℃）と、その時刻（"HH:MM"、前の日なら "前日HH:MM"） */
  nightMin?: number | null;
  nightMinAt?: string | null;
};
type Key = "precip" | "tAvg" | "tMax" | "tMin" | "sun";

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, "")
    .trim();

/** 表を、見出しの結合（colspan / rowspan）をほどいた2次元の表にする */
function tableGrid(tableHtml: string): { cells: string[]; header: boolean }[] {
  const rows: { cells: string[]; header: boolean }[] = [];
  const pending: (string | undefined)[][] = []; // rowspan で下の行に続くセル
  const trs = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  trs.forEach((tr, r) => {
    const out: string[] = [];
    let header = true;
    let c = 0;
    const skip = () => {
      while (pending[r]?.[c] !== undefined) {
        out[c] = pending[r][c]!;
        c++;
      }
    };
    for (const m of tr.matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)) {
      if (m[1].toLowerCase() === "td") header = false;
      const attrs = m[2];
      const colspan = Number(attrs.match(/colspan="?(\d+)/i)?.[1] ?? 1);
      const rowspan = Number(attrs.match(/rowspan="?(\d+)/i)?.[1] ?? 1);
      const text = decode(m[3]);
      for (let k = 0; k < colspan; k++) {
        skip();
        for (let d = 1; d < rowspan; d++) (pending[r + d] ??= [])[c] = text;
        out[c++] = text;
      }
    }
    skip();
    rows.push({ cells: out, header });
  });
  return rows;
}

/** 数字を読む。"--"（現象なし）は0、"///"・"×"（観測なし・欠測）は null。")" "]" "#" などの品質の印は取る */
export function weatherNum(s: string, key: Key): number | null {
  const t = s.replace(/[)\]#*\s]/g, "");
  if (t === "--" || t === "-") return key === "precip" || key === "sun" ? 0 : null;
  if (!t || /[/×]/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 列の見出し（上から順につないだもの）から、どの項目かを決める */
function keyOf(label: string): Key | null {
  if (label.includes("降水量") && label.includes("合計")) return "precip";
  if (label.includes("気温") && label.includes("平均")) return "tAvg";
  if (label.includes("気温") && label.includes("最高")) return "tMax";
  if (label.includes("気温") && label.includes("最低")) return "tMin";
  if (label.includes("日照")) return "sun";
  return null;
}

/** 気象庁の「日ごとの値」のページから、日（"01"〜"31"）→ 値 を読む */
export function parseJmaDaily(html: string): Record<string, WeatherDay> {
  const table = html.match(/<table[^>]*id="tablefix1"[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error("気象庁のページに、日ごとの表が見つかりませんでした");
  const grid = tableGrid(table);
  const head = grid.filter((r) => r.header);
  const width = Math.max(...grid.map((r) => r.cells.length));
  const labels = Array.from({ length: width }, (_, c) => [...new Set(head.map((r) => r.cells[c] ?? ""))].join("/"));
  const cols = labels.map((l, c) => ({ c, key: keyOf(l) })).filter((x): x is { c: number; key: Key } => x.key !== null);
  // 同じ項目の列が2つ見つかったら、左の方を使う
  const seen = new Set<Key>();
  const use = cols.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)));
  if (!use.some((x) => x.key === "tAvg") && !use.some((x) => x.key === "precip")) throw new Error("気象庁の表の見出しが読めませんでした");
  const out: Record<string, WeatherDay> = {};
  for (const r of grid) {
    if (r.header) continue;
    const d = Number(r.cells[0]);
    if (!Number.isInteger(d) || d < 1 || d > 31) continue;
    const day: WeatherDay = {};
    for (const { c, key } of use) day[key] = weatherNum(r.cells[c] ?? "", key);
    // 何も入っていない日（まだ先の日など）は入れない
    if (Object.values(day).some((v) => v !== null && v !== undefined)) out[String(d).padStart(2, "0")] = day;
  }
  return out;
}

const jmaUrl = (year: number, month: number) =>
  `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no=${WEATHER_STATION.precNo}&block_no=${WEATHER_STATION.blockNo}&year=${year}&month=${month}&day=&view=`;

async function fetchMonthHtml(year: number, month: number): Promise<string> {
  // テスト環境（エミュレーター）では、気象庁には取りに行かず、用意したページを使う
  if (process.env.FUNCTIONS_EMULATOR === "true") return readFileSync(join(__dirname, "../test-fixtures/jma-daily-a1.html"), "utf8");
  const res = await fetch(jmaUrl(year, month), { headers: { "User-Agent": "ichigo-app (weather import; once per month page)" } });
  if (!res.ok) throw new HttpsError("unavailable", `気象庁のページを読めませんでした（${res.status}）。少し時間をおいてやり直してください`);
  return await res.text();
}

/** 1か月分の日ごとの値を読み込んで保存する（夜温など、ほかの項目は消さない） */
export async function importMonth(year: number, month: number) {
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  let days: Record<string, WeatherDay>;
  try {
    days = parseJmaDaily(await fetchMonthHtml(year, month));
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("internal", e instanceof Error ? e.message : "気象庁のページを読めませんでした");
  }
  await db.doc(`weather/${ym}`).set({ station: WEATHER_STATION.name, days, fetchedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { month: ym, count: Object.keys(days).length };
}

/** 1か月分の気象データを、気象庁から取り込んで保存する（スタッフ） */
export const importWeatherMonth = onCall({ timeoutSeconds: 60 }, async (req) => {
  await assertCan(req, ["weather", "harvest", "shipping"]);
  const year = Number(req.data?.year);
  const month = Number(req.data?.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpsError("invalid-argument", "年月が正しくありません");
  }
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const nowJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
  if (ym > nowJst) throw new HttpsError("invalid-argument", "まだ先の月です");
  return await importMonth(year, month);
});

// ---------- 夜温（10分ごとの値から、その夜でいちばん低い気温） ----------

/** 10分ごとの値のページから、時刻（"00:10"〜"24:00"）→ 気温 を読む */
export function parseJma10min(html: string): { time: string; temp: number | null }[] {
  const table = html.match(/<table[^>]*id="tablefix1"[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error("気象庁のページに、10分ごとの表が見つかりませんでした");
  const grid = tableGrid(table);
  const head = grid.filter((r) => r.header);
  const width = Math.max(...grid.map((r) => r.cells.length));
  const labels = Array.from({ length: width }, (_, c) => head.map((r) => r.cells[c] ?? "").join("/"));
  const col = labels.findIndex((l) => l.includes("気温"));
  if (col < 0) throw new Error("気象庁の表に、気温の列が見つかりませんでした");
  const out: { time: string; temp: number | null }[] = [];
  for (const r of grid) {
    if (r.header) continue;
    const time = r.cells[0] ?? "";
    if (!/^\d{2}:\d{2}$/.test(time)) continue;
    out.push({ time, temp: weatherNum(r.cells[col] ?? "", "tMin") });
  }
  return out;
}

/** 夜の時間（前の日の18時すぎ〜この日の9時）で、いちばん低い気温。どちらかの日の表が足りなければ null */
export function nightMinOf(prev: { time: string; temp: number | null }[], day: { time: string; temp: number | null }[]) {
  const evening = prev.filter((x) => x.time > "18:00").map((x) => ({ ...x, at: `前日${x.time}` }));
  const morning = day.filter((x) => x.time <= "09:00").map((x) => ({ ...x, at: x.time }));
  // 夜の時間の表がそろっていないとき（まだ9時前など）は出さない
  if (prev.find((x) => x.time === "24:00")?.temp == null || day.find((x) => x.time === "09:00")?.temp == null) return null;
  let best: { temp: number; at: string } | null = null;
  for (const x of [...evening, ...morning]) if (x.temp != null && (best == null || x.temp < best.temp)) best = { temp: x.temp, at: x.at };
  return best;
}

const jma10minUrl = (date: string) =>
  `https://www.data.jma.go.jp/stats/etrn/view/10min_a1.php?prec_no=${WEATHER_STATION.precNo}&block_no=${WEATHER_STATION.blockNo}&year=${Number(date.slice(0, 4))}&month=${Number(date.slice(5, 7))}&day=${Number(date.slice(8, 10))}&view=`;

async function fetch10minHtml(date: string): Promise<string> {
  if (process.env.FUNCTIONS_EMULATOR === "true") return readFileSync(join(__dirname, "../test-fixtures/jma-10min-a1.html"), "utf8");
  const res = await fetch(jma10minUrl(date), { headers: { "User-Agent": "ichigo-app (night temperature; a few pages per day)" } });
  if (!res.ok) throw new Error(`気象庁のページを読めませんでした（${res.status}）`);
  return await res.text();
}

const shiftDate = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 1回に読む10分ごとのページの数（気象庁のサイトに負担をかけない） */
const MAX_PAGES = 8;
/** 夜温をさかのぼって集める日数 */
const NIGHT_DAYS = 45;
/** 日ごとの値（日照時間など）を読み直す間隔 */
const DAILY_MAX_AGE_MS = 6 * 3600_000;

/**
 * 収穫の振り返りに使う気象データを集める（管理者・スタッフ）。画面を開いたときに呼ぶ。
 * ・今月（月のはじめは先月も）の日ごとの値（日照時間など）を、6時間に1回まで読み直す
 * ・夜温がまだない日を、新しい日から順に、1回に数ページずつ集める（足りない分は次に開いたときに続ける）
 */
export const refreshHarvestWeather = onCall({ timeoutSeconds: 120 }, async (req) => {
  await assertCan(req, ["weather", "harvest", "shipping"]);
  const now = new Date(Date.now() + 9 * 3600_000);
  const today = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16);

  // 日ごとの値（日照時間・気温など）
  const months = [today.slice(0, 7)];
  if (Number(today.slice(8, 10)) <= 2) months.unshift(shiftDate(`${today.slice(0, 7)}-01`, -1).slice(0, 7));
  const docs = new Map<string, Record<string, WeatherDay>>();
  for (const ym of months) {
    const snap = await db.doc(`weather/${ym}`).get();
    const at = snap.get("fetchedAt") as { toMillis: () => number } | undefined;
    if (!at || Date.now() - at.toMillis() > DAILY_MAX_AGE_MS) await importMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
  }

  // 夜温がまだない日（9時を過ぎていれば今日も）
  const last = hhmm >= "09:20" ? today : shiftDate(today, -1);
  const first = shiftDate(last, -(NIGHT_DAYS - 1));
  const ymSet = new Set<string>();
  for (let d = first; d <= last; d = shiftDate(d, 1)) ymSet.add(d.slice(0, 7));
  for (const ym of ymSet) docs.set(ym, ((await db.doc(`weather/${ym}`).get()).get("days") as Record<string, WeatherDay>) ?? {});
  const missing: string[] = [];
  for (let d = last; d >= first; d = shiftDate(d, -1)) if (docs.get(d.slice(0, 7))?.[d.slice(8, 10)]?.nightMin == null) missing.push(d);

  const pages = new Map<string, { time: string; temp: number | null }[]>();
  let fetched = 0;
  const page = async (date: string) => {
    if (!pages.has(date)) {
      if (fetched > 0) await sleep(500);
      fetched++;
      pages.set(date, parseJma10min(await fetch10minHtml(date)));
    }
    return pages.get(date)!;
  };
  let saved = 0;
  for (const d of missing) {
    const need = [shiftDate(d, -1), d].filter((x) => !pages.has(x)).length;
    if (fetched + need > MAX_PAGES) break;
    let m: ReturnType<typeof nightMinOf>;
    try {
      m = nightMinOf(await page(shiftDate(d, -1)), await page(d));
    } catch {
      break; // 読めなければ、次に開いたときにやり直す
    }
    if (!m) continue;
    await db
      .doc(`weather/${d.slice(0, 7)}`)
      .set({ station: WEATHER_STATION.name, days: { [d.slice(8, 10)]: { nightMin: m.temp, nightMinAt: m.at } } }, { merge: true });
    saved++;
  }
  return { saved, remaining: missing.length - saved };
});
