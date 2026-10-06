// 気象データ：気象庁「過去の気象データ検索」の日ごとの値（アメダス）を読み込んで、月ごとに保存する。
// 使う項目：降水量の合計、気温（平均・最高・最低）、日照時間
// 気象庁のページは表（HTML）なので、見出しの文字から列を探して読む（列の並びが少し違っても読めるように）。
// 取り込みは1回に1か月分だけ。気象庁のサイトに負担をかけないよう、画面からは間をあけて順に呼ぶ。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertStaff, db } from "./common.js";

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
};
type Key = keyof WeatherDay;

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

/** 1か月分の気象データを、気象庁から取り込んで保存する（スタッフ） */
export const importWeatherMonth = onCall({ timeoutSeconds: 60 }, async (req) => {
  await assertStaff(req);
  const year = Number(req.data?.year);
  const month = Number(req.data?.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpsError("invalid-argument", "年月が正しくありません");
  }
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const nowJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
  if (ym > nowJst) throw new HttpsError("invalid-argument", "まだ先の月です");
  let days: Record<string, WeatherDay>;
  try {
    days = parseJmaDaily(await fetchMonthHtml(year, month));
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("internal", e instanceof Error ? e.message : "気象庁のページを読めませんでした");
  }
  await db.doc(`weather/${ym}`).set({ station: WEATHER_STATION.name, days, fetchedAt: FieldValue.serverTimestamp() });
  return { month: ym, count: Object.keys(days).length };
});
