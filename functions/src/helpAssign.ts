// 収穫報告の応援の割り当て：自分の予定が終わった人（手のあいた人）を、終わっていないハウスへまんべんなく応援に行かせる。
// ・応援先は、終わっていない収穫のハウスすべて（人が入っているハウスもふくむ。「応援なし」のハウスは除く）
// ・いまの人数のままだと、いちばん終わるのがおそくなりそうなハウスへ行く（応援に向かっている途中の人も人数に数える）
// ・終わるのがおそいかは、朝の予測（ハウスごとの入る・終わる・人数）から仕事の量（のべ時間）を出し、入ってからの時間と人数で残りを見積もる

export type HelpHouse = {
  members?: string[];
  membersEdited?: boolean;
  start?: number | null;
  end?: number | null;
  cases?: number;
  /** 終わる前にほかのハウスへ移った人 */
  left?: string[];
  /** 収穫報告で応援として入った人 */
  helpers?: string[];
  /** 🏁ここで終了：このハウスを終えた人は、その日の収穫をここまでにする（次のハウス・応援に行かない） */
  stopHere?: boolean;
};
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

/**
 * 🏁ここで終了のハウスで収穫を終えた人なら、そのハウス（なければ null）。
 * そのハウスにいた人（入ったを押した・収穫者に名前がある・応援で入った。移った人は除く）で、
 * 自分で「終わった」を押したかハウスに「終わった」が入っていて、そのあとほかのハウスに入っていない人
 */
export function stoppedAt(i: Pick<HelpInput, "houses" | "taps" | "fh">, id: string): string | null {
  const mine = i.taps[id] ?? {};
  for (const [h, r] of Object.entries(i.houses)) {
    if (!r?.stopHere) continue;
    const was = mine[h]?.start != null || [...(r.members ?? i.fh[h]?.members ?? []), ...(r.helpers ?? [])].includes(id);
    if (!was || (r.left ?? []).includes(id)) continue;
    const end = mine[h]?.end ?? r.end;
    if (end == null) continue;
    if (Object.entries(mine).some(([x, v]) => x !== h && v?.start != null && (v.start >= end || v.end == null))) continue;
    return h;
  }
  return null;
}

/** そのハウスが、いまの人数（＋向かっている人）のままで終わる見込みの時刻（分） */
export function finishOf(i: HelpInput, h: string, me: string | null): number {
  return estimate(i, h, me).finish;
}

/** そのハウスの見込み：終わる時刻（分）、いまの人数（向かっている人もふくむ）、もう入っているか */
function estimate(i: HelpInput, h: string, me: string | null): { finish: number; crew: number; started: boolean } {
  const inside = Object.keys(i.taps).filter((id) => i.taps[id]?.[h]?.start != null && i.taps[id]?.[h]?.end == null);
  const f = i.fh[h];
  // 収穫管理で名前が入っている人（応援で足された人もふくむ。携帯を忘れた人の分を集荷係が入れたときも数える）。
  // そのハウスで「終わった」を押した人、ほかへ移った人、携帯でほかのハウスの「入った」を押している人は数えない
  // 🏁ここで終了のハウスで終えた人は、あとのハウスには来ない
  const listed = [...new Set([...(i.houses[h]?.members ?? f?.members ?? []), ...(i.houses[h]?.helpers ?? [])])].filter(
    (id) =>
      i.taps[id]?.[h]?.end == null &&
      stoppedAt(i, id) == null &&
      !(i.houses[h]?.left ?? []).includes(id) &&
      !Object.entries(i.taps[id] ?? {}).some(([x, v]) => x !== h && v?.start != null && v?.end == null),
  );
  const pending = Object.entries(i.assigns).filter(([id, x]) => x === h && id !== me && !inside.includes(id) && !listed.includes(id)).length;
  const tapStarts = Object.values(i.taps)
    .map((t) => t[h]?.start)
    .filter((s): s is number => s != null);
  const start = i.houses[h]?.start ?? (tapStarts.length ? Math.min(...tapStarts) : null);
  // 収穫している人：携帯で「入った」を押した人と、収穫管理で名前が入っている人（ハウスに「入った」があるとき）
  const nowCrew = start != null ? Math.max(1, new Set([...inside, ...listed]).size) : inside.length;
  // 仕事の量（のべ時間）：朝の予測の（終わる−入る）× 人数。なければ株数 × 平均の速さ
  const use = i.usage[h] ?? "harvest";
  const p = (i.plants[h] ?? 0) * (use === "half" || use === "halfBack" ? 0.5 : 1);
  const work =
    f?.start != null && f?.end != null && f.end > f.start ? (f.end - f.start) * Math.max(1, (f.members ?? []).length) : i.avg != null ? (p / 1000) * i.avg : 60;
  const crew = nowCrew + pending;
  if (start == null) {
    // まだだれも入っていない：向かっている人がいればその人数で、いなければ朝の予測どおり（予定の人があとから入る）
    if (crew > 0) return { finish: i.now + work / crew, crew, started: false };
    // 予定の人がみんな🏁で終了したハウスは、だれも来ない（まだだれも入っていないハウスとして、応援を先に出す）
    const planned = i.houses[h]?.members ?? f?.members ?? [];
    if (planned.length > 0 && planned.every((id) => stoppedAt(i, id) != null)) return { finish: i.now + work, crew: 0, started: false };
    return { finish: f?.end ?? i.now + work, crew, started: false };
  }
  // もう終わった作業（のべ時間）：一人ひとりが入ってからの時間を足す（途中から入った応援の人は、入った時刻から）。
  // 携帯で押した人はその時刻、収穫管理に名前があるだけの人はハウスの「入った」から。そのハウスを終えた人も、いた間の分を足す
  const joinOf = (id: string) => Math.max(start, i.taps[id]?.[h]?.start ?? start);
  let doneWork = 0;
  for (const id of new Set([...inside, ...listed])) doneWork += Math.max(0, i.now - joinOf(id));
  for (const [id, t] of Object.entries(i.taps)) if (t[h]?.start != null && t[h]?.end != null) doneWork += Math.max(0, t[h].end! - joinOf(id));
  const left = Math.max(work * 0.05, work - doneWork);
  return { finish: i.now + left / Math.max(1, crew), crew, started: true };
}

/** 応援が必要な順：終わっていないハウスを、いまのままだと終わるのがおそい順に並べる（収穫管理の指示一覧に出す） */
export function helpRanking(i: HelpInput): { house: string; finish: number; crew: number; started: boolean }[] {
  return helpCandidates(i)
    .map((h) => {
      const e = estimate(i, h, null);
      return { house: h, finish: Math.round(e.finish), crew: e.crew, started: e.started };
    })
    .sort(byNeed);
}

/** まだだれも入っていなくて、向かっている人もいないハウスか（me の割り当ては数えない） */
export function isEmptyHouse(i: HelpInput, h: string, me: string | null): boolean {
  const e = estimate(i, h, me);
  return !e.started && e.crew === 0;
}

/** 応援が必要な順：① まだだれも入っていない（向かっている人もいない）ハウス ② いまのままだと終わるのがおそいハウス */
const byNeed = (a: { finish: number; crew: number; started: boolean }, b: { finish: number; crew: number; started: boolean }) => {
  const ea = !a.started && a.crew === 0 ? 0 : 1;
  const eb = !b.started && b.crew === 0 ? 0 : 1;
  return ea - eb || b.finish - a.finish;
};

/** ハウスの地区（離れている）：1〜10番・17〜20番・21〜27番。それ以外は null */
export function areaOf(h: string): string | null {
  const n = Number(h);
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 10) return "1-10";
  if (n >= 17 && n <= 20) return "17-20";
  if (n >= 21 && n <= 27) return "21-27";
  return null;
}

/**
 * 手のあいた人（me）の応援先：① まだだれも入っていないハウス（1人ずつ）② いまのままだといちばん終わるのがおそいハウス。終わっていないハウスがなければ null。
 * ただし1位が別の地区で、2位がいまいる地区（最後に「終わった」を押したハウスの地区）にあれば、移動が少ないよう2位にする
 */
export function pickHelp(i: HelpInput, me: string): string | null {
  // 🏁ここで終了した人には、応援を出さない
  if (stoppedAt(i, me) != null) return null;
  const list = helpCandidates(i)
    // 自分が「終わった」を押したハウスには戻さない（ハウスの「終わった」が入る前に聞かれたときのため）
    .filter((h) => i.taps[me]?.[h]?.end == null)
    .map((h) => ({ h, ...estimate(i, h, me) }))
    .sort(byNeed);
  if (!list.length) return null;
  const last = Object.entries(i.taps[me] ?? {})
    .filter(([, v]) => v?.end != null)
    .sort((x, y) => y[1].end! - x[1].end!)[0]?.[0];
  const here = last ? areaOf(last) : null;
  // 地区の入れ替えは、同じ段（だれも入っていないハウスどうし・人がいるハウスどうし）のときだけ
  const tier = (x: { crew: number; started: boolean }) => (!x.started && x.crew === 0 ? 0 : 1);
  if (here && areaOf(list[0].h) !== here && list[1] && tier(list[1]) === tier(list[0]) && areaOf(list[1].h) === here) return list[1].h;
  return list[0].h;
}
