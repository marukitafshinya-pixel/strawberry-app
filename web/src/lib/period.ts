// 実績集計の区切り（日ごと・週ごと・月ごと）
import { addDays, shiftMonth, weeksOf } from "./date";

export type Unit = "day" | "week" | "month";
export type Period = { no: number; from: string; to: string };

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

/** 日ごとの区切りの番号（1〜365）→ 日付（うるう年でない年で数える。2月29日は数えない） */
const dayOfNo = (no: number) => addDays("2025-01-01", no - 1).slice(5);

/**
 * 1年を日（365日）・週（日曜〜土曜の52週）・月（12か月）に分ける。
 * 日ごとは、前の年と同じ日付どうしを比べられるよう、2月29日を除いた365日にする
 */
export function periodsOf(year: number, unit: Unit): Period[] {
  if (unit === "week") return weeksOf(year);
  if (unit === "day")
    return Array.from({ length: 365 }, (_, i) => {
      const d = `${year}-${dayOfNo(i + 1)}`;
      return { no: i + 1, from: d, to: d };
    });
  return Array.from({ length: 12 }, (_, i) => {
    const ym = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { no: i + 1, from: `${ym}-01`, to: addDays(`${shiftMonth(ym, 1)}-01`, -1) };
  });
}

/** 画面の言葉（「日」「週」「月」） */
export function unitText(unit: Unit) {
  const week = unit === "week";
  const day = unit === "day";
  const dayName = (no: number) => {
    const d = dayOfNo(no);
    return `${Number(d.slice(0, 2))}/${Number(d.slice(3))}`;
  };
  return {
    unit,
    week,
    day,
    /** 「日」「週」「月」 */
    word: day ? "日" : week ? "週" : "月",
    /** 見出しの「日ごと」「週ごと」「月ごと」 */
    each: day ? "日ごと" : week ? "週ごと" : "月ごと",
    /** 6/15 / 第3週 / 6月 */
    name: (no: number) => (day ? dayName(no) : week ? `第${no}週` : `${no}月`),
    /** グラフの横の短い名前（6/15 / 3 / 6月） */
    short: (no: number) => (day ? dayName(no) : week ? `${no}` : `${no}月`),
    /** 期間（週のときだけ。6/1〜6/7） */
    span: (p?: Period) => (p && week ? `${md(p.from)}〜${md(p.to)}` : ""),
    /** グラフの説明のはじめ */
    axisNote: day ? "横は日付です。" : week ? "横の数字は第何週か（日曜〜土曜）です。" : "横の数字は月です。",
    showAll: day ? "1年の全部の日を表示" : week ? "52週すべて表示" : "12か月すべて表示",
    best: day ? "いちばん多かった日" : week ? "いちばん多かった週" : "いちばん多かった月",
  };
}
export type UnitText = ReturnType<typeof unitText>;
