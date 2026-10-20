// 収穫報告の応援の割り当て：自分の予定が終わった人（手のあいた人）を、終わっていないハウスへまんべんなく応援に行かせる。
// ・応援先は、終わっていない収穫のハウスすべて（人が入っているハウスもふくむ。「応援なし」のハウスは除く）
// ・いまの人数のままだと、いちばん終わるのがおそくなりそうなハウスへ行く（応援に向かっている途中の人も人数に数える）
// ・終わるのがおそいかは、朝の予測（ハウスごとの入る・終わる・人数）から仕事の量（のべ時間）を出し、入ってからの時間と人数で残りを見積もる

export type HelpHouse = { members?: string[]; membersEdited?: boolean; start?: number | null; end?: number | null; cases?: number };
export type HelpForecast = { start?: number | null; end?: number | null; members?: string[] };
export type HelpTaps = Record<string, Record<string, { start?: number | null; end?: number | null }>>;

export type HelpInput = {
  /** 今の時刻（0時からの分） */
  now: number;
  /** 朝の予測（ハウス → 入る・終わる・収穫者） */
  fh: Record<string, HelpForecast>;
  /** 収穫管理の記録 */
  houses: Record<string, HelpHouse>;
  /** みんなの押した時刻（従業員の id → ハウス → 時刻） */
  taps: HelpTaps;
  /** ハウスの使い方 */
  usage: Record<string, string>;
  /** 応援を入れないハウス */
  noHelp: string[];
  /** ハウスの株数 */
  plants: Record<string, number>;
  /** 全員の平均の速さ（1人で 1,000株あたり何分）。なければ null */
  avg: number | null;
  /** ほかの人の応援の割り当て（従業員の id → ハウス） */
  assigns: Record<string, string>;
};

/** 収穫しない使い方 */
const NO_HARVEST = ["picking", "reserve", "off"];

/** 応援先になれるハウス：その日に収穫するハウス（予測があるか、入った・押した記録がある）で、まだ終わっていないもの */
export function helpCandidates(i: HelpInput): string[] {
  const tapped = new Set(Object.values(i.taps).flatMap((t) => Object.keys(t).filter((h) => t[h]?.start != null)));
  const all = [...new Set([...Object.keys(i.fh), ...Object.keys(i.houses).filter((h) => i.houses[h]?.start != null), ...tapped])];
  return all.filter((h) => i.houses[h]?.end == null && !NO_HARVEST.includes(i.usage[h] ?? "harvest") && !i.noHelp.includes(h));
}

/** そのハウスが、いまの人数（＋向かっている人）のままで終わる見込みの時刻（分） */
export function finishOf(i: HelpInput, h: string, me: string | null): number {
  return estimate(i, h, me).finish;
}

/** そのハウスの見込み：終わる時刻（分）、いまの人数（向かっている人もふくむ）、もう入っているか */
function estimate(i: HelpInput, h: string, me: string | null): { finish: number; crew: number; started: boolean } {
  const inside = Object.keys(i.taps).filter((id) => i.taps[id]?.[h]?.start != null && i.taps[id]?.[h]?.end == null);
  const pending = Object.entries(i.assigns).filter(([id, x]) => x === h && id !== me && !inside.includes(id)).length;
  const f = i.fh[h];
  const planned = Math.max(1, (i.houses[h]?.members ?? f?.members ?? []).length);
  const tapStarts = Object.values(i.taps)
    .map((t) => t[h]?.start)
    .filter((s): s is number => s != null);
  const start = i.houses[h]?.start ?? (tapStarts.length ? Math.min(...tapStarts) : null);
  // 収穫している人：押した人。だれも押していなくて「入った」があれば、予定の収穫者（集荷係が入れた分）
  const nowCrew = inside.length || (start != null ? planned : 0);
  // 仕事の量（のべ時間）：朝の予測の（終わる−入る）× 人数。なければ株数 × 平均の速さ
  const use = i.usage[h] ?? "harvest";
  const p = (i.plants[h] ?? 0) * (use === "half" || use === "halfBack" ? 0.5 : 1);
  const work =
    f?.start != null && f?.end != null && f.end > f.start ? (f.end - f.start) * Math.max(1, (f.members ?? []).length) : i.avg != null ? (p / 1000) * i.avg : 60;
  const crew = nowCrew + pending;
  if (start == null) {
    // まだだれも入っていない：向かっている人がいればその人数で、いなければ朝の予測どおり（予定の人があとから入る）
    if (crew > 0) return { finish: i.now + work / crew, crew, started: false };
    return { finish: f?.end ?? i.now + work, crew, started: false };
  }
  const left = Math.max(work * 0.1, work - Math.max(0, i.now - start) * Math.max(1, nowCrew));
  return { finish: i.now + left / Math.max(1, crew), crew, started: true };
}

/** 応援が必要な順：終わっていないハウスを、いまのままだと終わるのがおそい順に並べる（収穫管理の指示一覧に出す） */
export function helpRanking(i: HelpInput): { house: string; finish: number; crew: number; started: boolean }[] {
  return helpCandidates(i)
    .map((h) => {
      const e = estimate(i, h, null);
      return { house: h, finish: Math.round(e.finish), crew: e.crew, started: e.started };
    })
    .sort((a, b) => b.finish - a.finish);
}

/** 手のあいた人（me）の応援先：いまのままだといちばん終わるのがおそいハウス。終わっていないハウスがなければ null */
export function pickHelp(i: HelpInput, me: string): string | null {
  let best: string | null = null;
  let bestF = -Infinity;
  for (const h of helpCandidates(i)) {
    // 自分が「終わった」を押したハウスには戻さない（ハウスの「終わった」が入る前に聞かれたときのため）
    if (i.taps[me]?.[h]?.end != null) continue;
    const f = finishOf(i, h, me);
    if (f > bestF) [best, bestF] = [h, f];
  }
  return best;
}
