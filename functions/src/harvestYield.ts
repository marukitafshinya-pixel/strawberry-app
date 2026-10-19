// 収穫ケース数の予測（朝の見込み）に使う数字を、最近の記録から計算する（stats/harvestYield）。
// ・まとまりごとの「1,000株あたりのケース数」：最近の収穫した日（7日分）の、終わったハウスのケース数 ÷ 株数
// ・夜温・日照の影響：その日の「1,000株あたりのケース数」が、前の7日の平均より多いか少ないか（比）を、
//   その日の朝の夜温（前の日18時〜9時でいちばん低い外の気温）と前の日の日照時間で説明する式（記録が14日分たまってから）
// 収穫が始まってからの見直し（終わったハウスの実際のケース数で直す）は画面側（web/src/lib/harvestForecast.ts）で行う

/** 1日分の、終わったハウスのケース数と株数（まとまりごと） */
export type YieldDay = { date: string; groups: Record<string, { cases: number; plants: number }> };
/** 日付 → 夜温（その日の朝まで）と日照時間（その日） */
export type YieldWeather = Record<string, { nightMin?: number | null; sun?: number | null }>;
export type YieldModel = { n: number; a: number; b: number; c: number };
export type YieldStats = {
  /** まとまり → 1,000株あたりのケース数 */
  groups: Record<string, number>;
  /** 全体の 1,000株あたりのケース数 */
  all: number | null;
  /** 使った日数 */
  days: number;
  /** 今日の天気の影響（かけ算。1＝ふだんどおり。式がまだなければ 1） */
  factor: number;
  model: YieldModel | null;
  /** 今日の朝の夜温と、前の日の日照（式に入れた値） */
  nightMin: number | null;
  sun: number | null;
};

/** 平均に使う日数 */
const WINDOW = 7;
/** 天気の式を作るのに要る日数 */
const MIN_MODEL_DAYS = 14;
/** 1日の株数がこれより少ない日は使わない（少しだけ収穫した日） */
const MIN_PLANTS = 3000;

const shift = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const sum = (g: YieldDay["groups"]) => Object.values(g).reduce((s, x) => ({ cases: s.cases + x.cases, plants: s.plants + x.plants }), { cases: 0, plants: 0 });
const rate = (x: { cases: number; plants: number }) => (x.plants > 0 ? (x.cases / x.plants) * 1000 : null);

/** 3つの値の連立方程式（最小二乗）。解けなければ null */
function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((r, i) => [...r, v[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    if (Math.abs(a[p][i]) < 1e-9) return null;
    [a[i], a[p]] = [a[p], a[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let k = i; k < 4; k++) a[r][k] -= f * a[i][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/** 最近の記録と天気から、今日の朝の見込みに使う数字を出す（today の分は使わない） */
export function yieldFrom(daysIn: YieldDay[], weather: YieldWeather, today: string): YieldStats {
  const days = daysIn.filter((d) => d.date < today && sum(d.groups).plants >= MIN_PLANTS).sort((a, b) => a.date.localeCompare(b.date));
  const recent = days.slice(-WINDOW);
  const groups: Record<string, number> = {};
  const byGroup: Record<string, { cases: number; plants: number }> = {};
  for (const d of recent)
    for (const [g, x] of Object.entries(d.groups)) {
      byGroup[g] ??= { cases: 0, plants: 0 };
      byGroup[g].cases += x.cases;
      byGroup[g].plants += x.plants;
    }
  for (const [g, x] of Object.entries(byGroup)) if (x.plants >= 1000) groups[g] = Math.round(rate(x)! * 100) / 100;
  const tot = recent.reduce((s, d) => ({ cases: s.cases + sum(d.groups).cases, plants: s.plants + sum(d.groups).plants }), { cases: 0, plants: 0 });
  const all = rate(tot);

  // 天気の式：y＝その日の比（前の7日の平均に対して）、x＝その日の朝の夜温・前の日の日照
  const rows: { y: number; night: number; sun: number }[] = [];
  days.forEach((d, i) => {
    const prev = days.slice(Math.max(0, i - WINDOW), i);
    if (prev.length < 3) return;
    const base = prev.reduce((s, p) => s + rate(sum(p.groups))!, 0) / prev.length;
    const night = weather[d.date]?.nightMin;
    const sun = weather[shift(d.date, -1)]?.sun;
    if (base > 0 && night != null && sun != null) rows.push({ y: rate(sum(d.groups))! / base, night, sun });
  });
  let model: YieldModel | null = null;
  if (rows.length >= MIN_MODEL_DAYS) {
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const v = [0, 0, 0];
    for (const r of rows) {
      const x = [1, r.night, r.sun];
      for (let i = 0; i < 3; i++) {
        v[i] += x[i] * r.y;
        for (let k = 0; k < 3; k++) m[i][k] += x[i] * x[k];
      }
    }
    // 夜温・日照がほとんど同じ値ばかりでも解けるよう、ごく小さい値を足す（係数を0に寄せる）
    m[1][1] += 0.01 * rows.length;
    m[2][2] += 0.01 * rows.length;
    const s = solve3(m, v);
    if (s) model = { n: rows.length, a: s[0], b: s[1], c: s[2] };
  }
  const nightMin = weather[today]?.nightMin ?? null;
  const sun = weather[shift(today, -1)]?.sun ?? null;
  const raw = model && nightMin != null && sun != null ? model.a + model.b * nightMin + model.c * sun : 1;
  // 外れた値にならないよう、ふだんの7割〜1.3倍におさめる
  const factor = Math.round(Math.min(1.3, Math.max(0.7, raw)) * 1000) / 1000;
  return { groups, all: all == null ? null : Math.round(all * 100) / 100, days: recent.length, factor, model, nightMin, sun };
}
