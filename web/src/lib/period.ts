// 実績集計の区切り（週ごと・月ごと）
import { addDays, shiftMonth, weeksOf } from "./date";

export type Unit = "week" | "month";
export type Period = { no: number; from: string; to: string };

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

/** 1年を週（日曜〜土曜の52週）か月（12か月）に分ける */
export function periodsOf(year: number, unit: Unit): Period[] {
  if (unit === "week") return weeksOf(year);
  return Array.from({ length: 12 }, (_, i) => {
    const ym = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { no: i + 1, from: `${ym}-01`, to: addDays(`${shiftMonth(ym, 1)}-01`, -1) };
  });
}

/** 画面の言葉（「週」か「月」か） */
export function unitText(unit: Unit) {
  const week = unit === "week";
  return {
    unit,
    week,
    /** 「週」「月」 */
    word: week ? "週" : "月",
    /** 見出しの「週ごと」「月ごと」 */
    each: week ? "週ごと" : "月ごと",
    /** 第3週 / 6月 */
    name: (no: number) => (week ? `第${no}週` : `${no}月`),
    /** 期間（週のときだけ。6/1〜6/7） */
    span: (p?: Period) => (p && week ? `${md(p.from)}〜${md(p.to)}` : ""),
    /** グラフの説明のはじめ */
    axisNote: week ? "横の数字は第何週か（日曜〜土曜）です。" : "横の数字は月です。",
    showAll: week ? "52週すべて表示" : "12か月すべて表示",
    best: week ? "いちばん多かった週" : "いちばん多かった月",
  };
}
export type UnitText = ReturnType<typeof unitText>;
