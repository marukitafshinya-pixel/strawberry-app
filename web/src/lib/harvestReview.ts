// 収穫の振り返り：その日の入力の記録（harvest/{日付}/log）と実績・朝の予測から、
// ケースの増え方・ハウスごとの予測とのずれ・入力の遅れ・応援などを読み取り、次の日に生かす「気づき」を出す
import { houseMinutes, type ForecastHouses, type HarvestBreak, type HarvestDoc, type HarvestLogRow } from "./harvest";

/** 日本時間の0時からの分 */
export const minOfDay = (ms: number) => Math.floor(((ms + 9 * 3600_000) % 86400_000) / 60_000);

export type HouseReview = {
  house: string;
  members: string[];
  start: number | null;
  end: number | null;
  /** 朝の予測 */
  fStart: number | null;
  fEnd: number | null;
  /** 終わりの差（実際−予測、分。＋＝おそい） */
  endDiff: number | null;
  cases: number;
  /** 1人1時間あたりのケース（休憩を抜く） */
  pace: number | null;
  /** ＋1・＋0.1を押した回数・最初と最後（分） */
  taps: number;
  firstTap: number | null;
  lastTap: number | null;
  /** 「終わった」を入れた時刻と、終わった時刻との差（分。大きい＝入れ忘れ・あとでまとめて入れた） */
  endEnteredAt: number | null;
  endLag: number | null;
  /** −1・確定数の直接入力（直し）の回数 */
  fixes: number;
  /** 途中から入った人（応援）：名前の id と時刻（分） */
  helpers: { id: string; at: number }[];
  /** ＋1 が長くあかなかったところ（休憩をのぞく。分） */
  gaps: { from: number; to: number }[];
};

export type Point = { kind: "late" | "early" | "lag" | "bulk" | "gap" | "help" | "fix"; house?: string; text: string };

/** ＋1 があかなかったと見なす長さ（分） */
const GAP_MIN = 40;
/** 「終わった」を入れるのがおそいと見なす長さ（分） */
const LAG_MIN = 15;
/** 予測とのずれを取り上げる長さ（分） */
const DIFF_MIN = 15;

const overlapsBreak = (from: number, to: number, brk: HarvestBreak) => from < brk.start + brk.minutes && to > brk.start;

/** ハウスごとの振り返り */
export function reviewHouses(houses: string[], rec: HarvestDoc, log: HarvestLogRow[], fh: ForecastHouses | null, brk: HarvestBreak): HouseReview[] {
  const out: HouseReview[] = [];
  for (const h of houses) {
    const r = rec[h];
    const f = fh?.[h];
    const mine = log.filter((x) => x.house === h);
    if (!r && !f && mine.length === 0) continue;
    const taps = mine.filter((x) => typeof x.delta === "number" && x.delta > 0).map((x) => minOfDay(x.at));
    const endLog = [...mine].reverse().find((x) => typeof x.end === "number" && !x.auto);
    const start = r?.start ?? null;
    const end = r?.end ?? null;
    const mins = r ? houseMinutes(r, brk) : null;
    const people = r?.members?.length ?? 0;
    // 途中から入った人：入ったあと・終わる前に、手で名前を足した
    // はじめの収穫者：朝の予測のときの収穫者（なければ最初に入れた名前）
    const before = new Set<string>(f?.members ?? []);
    const helpers: { id: string; at: number }[] = [];
    for (const x of mine) {
      if (!x.members) continue;
      const at = minOfDay(x.at);
      const late = !x.auto && start != null && at > start + 5 && (end == null || at < end);
      for (const m of x.members) if (!before.has(m) && late && before.size > 0) helpers.push({ id: m, at });
      x.members.forEach((m) => before.add(m));
    }
    // ＋1 のあいだがあいたところ（入った〜最初、あいだ、最後〜終わった）
    const marks = [...(start != null ? [start] : []), ...taps, ...(end != null ? [end] : [])].sort((a, b) => a - b);
    const gaps: { from: number; to: number }[] = [];
    if (taps.length)
      for (let i = 1; i < marks.length; i++)
        if (marks[i] - marks[i - 1] > GAP_MIN && !overlapsBreak(marks[i - 1], marks[i], brk)) gaps.push({ from: marks[i - 1], to: marks[i] });
    const endEnteredAt = endLog ? minOfDay(endLog.at) : null;
    out.push({
      house: h,
      members: r?.members ?? f?.members ?? [],
      start,
      end,
      fStart: f?.start ?? null,
      fEnd: f?.end ?? null,
      endDiff: end != null && f?.end != null ? end - f.end : null,
      cases: r?.cases ?? 0,
      pace: mins && mins > 0 && people > 0 && (r?.cases ?? 0) > 0 ? Math.round((r!.cases! / (mins * people)) * 60 * 10) / 10 : null,
      taps: taps.length,
      firstTap: taps.length ? taps[0] : null,
      lastTap: taps.length ? taps[taps.length - 1] : null,
      endEnteredAt,
      endLag: endEnteredAt != null && end != null ? endEnteredAt - end : null,
      // 直し：−1 と、＋1 を使っているハウスで確定数を直接直したとき（＋1 を使わずにまとめて入れたのは直しに数えない）
      fixes: mine.filter((x) => (typeof x.delta === "number" && x.delta < 0) || (typeof x.cases === "number" && taps.length > 0)).length,
      helpers,
      gaps,
    });
  }
  return out;
}

const clockOf = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/** 次の日に生かす気づき（大事なものから） */
export function reviewPoints(rows: HouseReview[], nameOf: (id: string) => string): Point[] {
  const pts: Point[] = [];
  const who = (r: HouseReview) => (r.members.length ? `（${r.members.map(nameOf).join("・")}）` : "");
  const diffs = rows.filter((r) => r.endDiff != null && Math.abs(r.endDiff) >= DIFF_MIN).sort((a, b) => Math.abs(b.endDiff!) - Math.abs(a.endDiff!));
  for (const r of diffs.slice(0, 5)) {
    const late = r.endDiff! > 0;
    const helped = r.helpers.length ? `。途中で応援が入っています` : "";
    pts.push({
      kind: late ? "late" : "early",
      house: r.house,
      text: `No.${r.house}${who(r)} は予測より ${Math.abs(r.endDiff!)}分${late ? "おそく" : "はやく"}終わりました${helped}`,
    });
  }
  for (const r of rows)
    for (const g of r.helpers)
      pts.push({ kind: "help", house: r.house, text: `No.${r.house} に ${nameOf(g.id)} さんが ${clockOf(g.at)} から応援に入りました` });
  for (const r of rows.filter((x) => x.endLag != null && x.endLag >= LAG_MIN))
    pts.push({ kind: "lag", house: r.house, text: `No.${r.house} の「終わった」（${clockOf(r.end!)}）は、${r.endLag}分あとに入力されました（入れ忘れ？）` });
  for (const r of rows.filter((x) => x.end != null && x.cases > 0 && x.taps === 0))
    pts.push({ kind: "bulk", house: r.house, text: `No.${r.house} はケースを最後にまとめて入れています（途中の進み方がわかりません。集荷のたびに＋1を）` });
  for (const r of rows)
    for (const g of r.gaps)
      pts.push({ kind: "gap", house: r.house, text: `No.${r.house} で ${clockOf(g.from)}〜${clockOf(g.to)}（${g.to - g.from}分）＋1 がありません` });
  for (const r of rows.filter((x) => x.fixes > 0)) pts.push({ kind: "fix", house: r.house, text: `No.${r.house} でケース数を ${r.fixes}回直しています` });
  return pts;
}

/** ケースの増え方（10分ごと、まとまりごとの合計）。x＝分 */
export function caseTimeline(log: HarvestLogRow[], groupOfHouse: (h: string) => string, step = 10) {
  const ev = log.filter((x) => x.house && (typeof x.delta === "number" || typeof x.cases === "number")).sort((a, b) => a.at - b.at);
  if (!ev.length) return { slots: [] as number[], byGroup: {} as Record<string, number[]>, total: [] as number[] };
  const first = Math.floor(minOfDay(ev[0].at) / step) * step;
  const last = Math.ceil((minOfDay(ev[ev.length - 1].at) + 1) / step) * step;
  const slots: number[] = [];
  for (let m = first; m <= last; m += step) slots.push(m);
  const cur: Record<string, number> = {};
  const byGroup: Record<string, number[]> = {};
  const total: number[] = [];
  let i = 0;
  for (const m of slots) {
    while (i < ev.length && minOfDay(ev[i].at) < m) {
      const x = ev[i++];
      cur[x.house!] = typeof x.cases === "number" ? x.cases : (cur[x.house!] ?? 0) + (x.delta ?? 0);
    }
    const sums: Record<string, number> = {};
    for (const [h, v] of Object.entries(cur)) sums[groupOfHouse(h)] = (sums[groupOfHouse(h)] ?? 0) + v;
    for (const g of new Set([...Object.keys(byGroup), ...Object.keys(sums)]))
      (byGroup[g] ??= Array(total.length).fill(0)).push(Math.round((sums[g] ?? 0) * 10) / 10);
    total.push(Math.round(Object.values(cur).reduce((n, v) => n + v, 0) * 10) / 10);
  }
  return { slots, byGroup, total };
}

// ---------- 総括（なぜずれたか）と、助言の候補 ----------

export type Summary = {
  /** 総括の文（上から順に読む） */
  lines: string[];
  /** 主な原因（短く） */
  causes: string[];
  /** 助言の候補（押すと「考えること」の欄に入る） */
  advice: string[];
};

/** 予測とのずれを取り上げる最小（分）。これより小さいずれは「予測どおり」とみなす */
const SMALL_MIN = 10;

/**
 * その日の総括：全体の終わりを決めたハウスから、同じ人の前のハウスへさかのぼって遅れのもとを探し、
 * それぞれのハウスの遅れを「入るのが遅れた」と「かかった時間が長かった」に分け、時間が長かった理由を
 * その日のほかのハウスとくらべて推しはかる（実が多い・1人あたりの進みが遅い・応援）
 */
export function reviewSummary(
  rows: HouseReview[],
  day: { endTime: number | null; forecast: number | null },
  plantsOf: (h: string) => number,
  nameOf: (id: string) => string,
  points: Point[],
): Summary {
  const lines: string[] = [];
  const causes: string[] = [];
  const advice: string[] = [];
  const done = rows.filter((r) => r.start != null && r.end != null);
  if (!done.length) return { lines: ["まだ終わったハウスがありません。"], causes, advice };
  const who = (r: HouseReview) => (r.members.length ? `（${r.members.map(nameOf).join("・")}）` : "");
  const diffText = (d: number) => (Math.abs(d) < SMALL_MIN ? "ほぼ予測どおり" : `予測より ${Math.abs(d)}分${d > 0 ? "おそく" : "はやく"}`);

  // その日の平均（くらべる基準）：1,000株あたりのケース、1人1時間あたりのケース
  const per1000 = (r: HouseReview) => (plantsOf(r.house) > 0 && r.cases > 0 ? (r.cases / plantsOf(r.house)) * 1000 : null);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((n, x) => n + x, 0) / v.length : null;
  };
  const avgPer1000 = avg(done.map(per1000));
  const avgPace = avg(done.map((r) => r.pace));
  const r1 = (n: number) => Math.round(n * 10) / 10;

  // 全体
  const last = done.reduce((a, b) => (b.end! > a.end! ? b : a));
  const overall = day.endTime != null && day.forecast != null ? day.endTime - day.forecast : null;
  lines.push(
    overall != null
      ? `収穫終了は${diffText(overall)}（${clockOf(day.endTime!)}）なりました。最後に終わったのは No.${last.house}${who(last)} で、これが全体の終わりを決めました。`
      : `収穫終了は ${clockOf(day.endTime ?? last.end!)}。朝の予測が残っていない日なので、ハウスごとの予測とくらべます。最後に終わったのは No.${last.house}${who(last)} です。`,
  );

  // 最後のハウスから、同じ人の前のハウスへさかのぼる（いちばん遅く終わった前のハウス）
  const chain: HouseReview[] = [last];
  for (let k = 0; k < 8; k++) {
    const cur = chain[0];
    const prev = done
      .filter((r) => !chain.includes(r) && r.members.some((m) => cur.members.includes(m)) && r.end! <= cur.start! + 5)
      .sort((a, b) => b.end! - a.end!)[0];
    if (!prev) break;
    chain.unshift(prev);
  }

  // それぞれのハウスの遅れを分ける
  type Part = { r: HouseReview; startDelay: number | null; durDiff: number | null; why: string[] };
  const parts: Part[] = chain.map((r) => {
    const startDelay = r.fStart != null ? r.start! - r.fStart : null;
    const durDiff = r.fStart != null && r.fEnd != null ? r.end! - r.start! - (r.fEnd - r.fStart) : null;
    const why: string[] = [];
    const p = per1000(r);
    if (durDiff != null && durDiff >= SMALL_MIN) {
      if (p != null && avgPer1000 != null && p >= avgPer1000 * 1.15) why.push(`実が多かった（1,000株あたり ${r1(p)}ケース・この日の平均 ${r1(avgPer1000)}）`);
      if (r.pace != null && avgPace != null && r.pace <= avgPace * 0.85) why.push(`1人あたりの進みが遅かった（1人1時間 ${r.pace}ケース・平均 ${r1(avgPace)}）`);
      if (!why.length) why.push("実の量・進みとも平均に近く、はっきりした理由は記録からは読み取れません");
    }
    if (durDiff != null && durDiff <= -SMALL_MIN && r.helpers.length) why.push(`${r.helpers.map((x) => nameOf(x.id)).join("・")}さんの応援で短くなった`);
    return { r, startDelay, durDiff, why };
  });
  for (let i = 0; i < parts.length; i++) {
    const { r, startDelay, durDiff, why } = parts[i];
    const bits: string[] = [];
    if (startDelay != null && Math.abs(startDelay) >= SMALL_MIN) {
      const prev = parts[i - 1];
      const because =
        startDelay > 0 && prev && prev.r.endDiff != null && prev.r.endDiff >= SMALL_MIN
          ? `（前の No.${prev.r.house} が ${prev.r.endDiff}分おそく終わったため）`
          : "";
      bits.push(`入るのが ${Math.abs(startDelay)}分${startDelay > 0 ? "おそく" : "はやく"}なりました${because}`);
    }
    if (durDiff != null && Math.abs(durDiff) >= SMALL_MIN)
      bits.push(`かかった時間が予測より ${Math.abs(durDiff)}分${durDiff > 0 ? "長く" : "短く"}なりました${why.length ? `。${why.join("。")}` : ""}`);
    if (bits.length) lines.push(`No.${r.house}${who(r)}：${bits.join("。")}。`);
  }

  // 主な原因：いちばん時間がのびたハウス、最初のハウスの開始の遅れ
  const worst = parts.filter((x) => x.durDiff != null && x.durDiff >= SMALL_MIN).sort((a, b) => b.durDiff! - a.durDiff!)[0];
  const first = parts[0];
  if (first.startDelay != null && first.startDelay >= SMALL_MIN) causes.push(`開始の遅れ（No.${first.r.house} が ${first.startDelay}分おそく入った）`);
  if (worst) causes.push(`No.${worst.r.house} で時間がかかったこと（+${worst.durDiff}分${worst.why.length ? `：${worst.why[0].replace(/（.*$/, "")}` : ""}）`);
  if (worst && worst !== parts[parts.length - 1]) causes.push(`そのしわ寄せで、あとのハウスの開始が遅れた`);
  const helped = parts.filter((x) => x.durDiff != null && x.durDiff <= -SMALL_MIN && x.r.helpers.length);
  if (helped.length) causes.push(`応援で取り戻せた（${helped.map((x) => `No.${x.r.house}`).join("・")}）`);
  if (!causes.length)
    causes.push(overall != null && Math.abs(overall) < SMALL_MIN ? "大きなずれはありませんでした" : "記録からははっきりした原因が読み取れません");

  // 助言の候補
  if (worst) {
    const w = worst.why.join("");
    if (w.includes("実が多かった")) advice.push(`No.${worst.r.house} は実が多い時期。最初から人を増やすか、早めに応援を回す`);
    if (w.includes("進みが遅かった"))
      advice.push(
        worst.r.members.length <= 1
          ? `No.${worst.r.house} は1人では時間がかかる。手のあく人を早めに応援に回す`
          : `No.${worst.r.house} の進み方（運ぶ距離・段取り）を見直す`,
      );
  }
  if (first.startDelay != null && first.startDelay >= SMALL_MIN) advice.push("開始時刻どおりに入れるよう、前の日に段取り（人・道具）を確かめる");
  if (points.some((p) => p.kind === "lag")) advice.push("「終わった」はハウスを出るときにすぐ押すよう、集荷係に伝える");
  if (points.some((p) => p.kind === "bulk")) advice.push("集荷のたびに＋1 を押す（途中の進み方がわかるように）");
  if (points.some((p) => p.kind === "gap")) advice.push("＋1 が長く止まる時間がないか、集荷の回り方を見直す");
  if (overall != null && Math.abs(overall) < SMALL_MIN && !worst) advice.push("予測どおりに終わった。今日の配置とやり方を続ける");
  return { lines, causes, advice };
}
