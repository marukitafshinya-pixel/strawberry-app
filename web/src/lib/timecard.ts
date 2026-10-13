"use client";

// タイムカード（MAXのタイムレコーダーのUSBデータ）。管理者だけが使う。
// - 取り込んだ打刻は、暦の月ごとに timecards/{YYYY-MM} に入れる（カード番号 → 日 → 出勤・退勤）
// - 画面で直した時刻は、元の打刻とは別に e に入れる（取り込み直しても消えない）
// - 丸め・休憩・締め日・カード番号と従業員のひも付けは config/timecard
import { deleteField, doc, FieldPath, onSnapshot, setDoc, serverTimestamp, updateDoc, getDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { parseCsv } from "./csv";
import { getFirebase } from "./firebase";
import { shiftMonth } from "./date";

/**
 * 1日の打刻。時刻は0時からの分（USBのデータのまま。例 347 → 5:47、1041 → 17:21）。
 * x＝出勤・退勤のほかの欄に入っていた打刻（そのまま残す）
 */
export type TcPunch = { i: number | null; o: number | null; x?: string };
/** 1日分。e＝画面で直した時刻（あれば、こちらを使う）、bk＝画面で直した休憩（分。あれば、自動の休憩の代わりに使う） */
export type TcDay = TcPunch & { e?: { i: number | null; o: number | null }; bk?: number };
/** timecards/{YYYY-MM}：カード番号 → 日（"01"〜"31"）→ 打刻 */
export type TimecardMonth = { cards: Record<string, Record<string, TcDay>>; fileName?: string };

/** 休憩の時間帯（分。例 12:00〜13:00 → { start: 720, end: 780 }）。働いた時間と重なる分だけ引く */
export type BreakWindow = { start: number; end: number };
/** 会社の出勤時刻（時期によって変わる）。from の日から使う */
export type StartTime = { from: string; time: number };
export type RoundDir = "up" | "down";
export type TimecardConfig = {
  /** カード番号 → 従業員のID（給与の従業員） */
  cards: Record<string, string>;
  /** 会社の出勤時刻。これより前に押した分は数えない */
  startTimes: StartTime[];
  /** 出勤・退勤の時刻を何分単位で丸めるか（1＝丸めない）と、切り上げ・切り捨て */
  roundIn: number;
  inDir: RoundDir;
  roundOut: number;
  outDir: RoundDir;
  /** 休憩の時間帯 */
  breaks: BreakWindow[];
  /** 1日にこの分数をこえて働いた分は残業 */
  overtimeOver: number;
  /** 締め日（31＝月末） */
  closeDay: number;
  /** ルールの版（2＝丸めの向きを「出勤は切り上げ・退勤は切り捨て」に直したあと） */
  rulesVersion?: number;
};

export const DEFAULT_TIMECARD_CONFIG: TimecardConfig = {
  cards: {},
  startTimes: [],
  roundIn: 15,
  inDir: "up",
  roundOut: 15,
  outDir: "down",
  breaks: [{ start: 720, end: 780 }],
  overtimeOver: 480,
  closeDay: 31,
};
export const ROUND_CHOICES = [1, 5, 10, 15, 30] as const;
export const CLOSE_DAY_CHOICES = [31, 5, 10, 15, 20, 25] as const;

/** " 347" → 347（5:47）。空なら null。読めなければ undefined */
function readTime(v: string | undefined): number | null | undefined {
  const s = (v ?? "").trim();
  if (s === "") return null;
  if (!/^\d{1,4}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 48 * 60 ? undefined : n;
}

/** 分 → "5:47" */
export function hm(min: number | null | undefined): string {
  if (min === null || min === undefined) return "";
  const a = Math.round(Math.abs(min));
  return `${min < 0 ? "-" : ""}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** 分 → 時間（小数2けた） */
export const hours2 = (min: number) => (Math.round((min / 60) * 100) / 100).toFixed(2);

/** "17:21" や "17.21" → 1041。空なら null。読めなければ undefined */
export function parseHm(s: string): number | null | undefined {
  const t = s.trim().replace("：", ":").replace("．", ".");
  if (t === "") return null;
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(t);
  if (!m || Number(m[2]) >= 60 || Number(m[1]) >= 48) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

export type ParsedTimecard = {
  /** 暦の月 → カード番号 → 日 → 打刻 */
  months: Record<string, Record<string, Record<string, TcPunch>>>;
  count: number;
};

/**
 * MAXのタイムレコーダーのCSV（ER201001.csv など）を読む。
 * 1行＝「部門,カード番号,…,日付(YY/MM/DD),出勤,退勤,（ほかの打刻4つ）,…」。
 * SIFT〜の行（設定）と LAST_MONTH / THIS_MONTH の行（月の区切り）は飛ばす
 */
export function parseMaxTimecardCsv(text: string): { data?: ParsedTimecard; error?: string } {
  const rows = parseCsv(text);
  const months: ParsedTimecard["months"] = {};
  let count = 0;
  for (const [n, r] of rows.entries()) {
    const date = (r[3] ?? "").trim();
    if (!/^\d{2}\/\d{2}\/\d{2}$/.test(date)) continue;
    const card = (r[1] ?? "").trim();
    if (!/^\d{1,6}$/.test(card)) return { error: `${n + 1}行目：カード番号「${card}」が読めません` };
    const [yy, mm, dd] = date.split("/");
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return { error: `${n + 1}行目：日付「${date}」が読めません` };
    const i = readTime(r[4]);
    const o = readTime(r[5]);
    if (i === undefined || o === undefined)
      return { error: `${n + 1}行目（カード${card}・${date}）：時刻「${(r[4] ?? "").trim()}」「${(r[5] ?? "").trim()}」が読めません` };
    const other = [6, 7, 8, 9].map((k) => (r[k] ?? "").trim());
    const p: TcPunch = { i, o };
    if (other.some((s) => s !== "")) p.x = other.join("/");
    const month = `20${yy}-${mm}`;
    ((months[month] ??= {})[card] ??= {})[dd] = p;
    count++;
  }
  if (count === 0) return { error: "打刻の行が見つかりません。タイムレコーダーのCSV（ER201001.csv など）を選んでください" };
  return { data: { months, count } };
}

/** 楽々勤怠の統合用ファイルから読んだ、カード番号ごとの社員コードと氏名 */
export type FixedPeople = Record<string, { code: string; name: string }>;

/**
 * MAXの「楽々勤怠」から書き出した、修正後の打刻のファイルを読む。2つの形が読める（どちらも1人ごとに見出しの行、続けて1日1行）。
 * - 統合用ファイル（データ処理 → 統合用ファイル作成。〇〇.dat）
 *   見出し「1,カード番号,1,開始日,終了日,…,社員コード,氏名,…」、日「1,カード番号,1,YYYY/MM/DD,出勤,退勤,…」（時刻は0時からの分）
 * - 修正／参照の画面のCSV
 *   見出し「1,カード番号,1,グループ名,社員コード,氏名,…」、日「1,カード番号,1,YYYY/MM/DD,出勤(5:38),,退勤(17:04),…」
 * カード番号は、USBのデータ（001 など）に合わせて3けたにする
 */
export function parseRakurakuDat(text: string): { data?: ParsedTimecard; people?: FixedPeople; error?: string } {
  const rows = parseCsv(text);
  const months: ParsedTimecard["months"] = {};
  const people: FixedPeople = {};
  let count = 0;
  const DATE = /^\d{4}\/\d{2}\/\d{2}$/;
  const name = (v: string | undefined) => (v ?? "").replace(/\u3000/g, " ").trim();
  for (const [n, r] of rows.entries()) {
    const rawCard = (r[1] ?? "").trim();
    if (!/^\d{1,6}$/.test(rawCard)) continue;
    const card = rawCard.padStart(3, "0");
    const date = (r[3] ?? "").trim();
    if (!DATE.test(date)) {
      // 修正／参照のCSVの見出しの行（グループ名・社員コード・氏名）
      if (/^\d{1,8}$/.test((r[4] ?? "").trim()) && name(r[5])) people[card] = { code: r[4].trim(), name: name(r[5]) };
      continue;
    }
    // 統合用ファイルの見出しの行（開始日・終了日・…・社員コード・氏名）
    if (DATE.test((r[4] ?? "").trim())) {
      people[card] = { code: (r[7] ?? "").trim(), name: name(r[8]) };
      continue;
    }
    // 時刻が「5:38」の形なら修正／参照のCSV（出勤・（空き）・退勤の順）、数字だけなら統合用ファイル（0時からの分）
    const hmForm = [r[4], r[5], r[6]].some((v) => (v ?? "").includes(":"));
    const read = (v: string | undefined) => (hmForm ? parseHm(v ?? "") : readTime(v));
    const iRaw = r[4];
    const oRaw = hmForm ? r[6] : r[5];
    const i = read(iRaw);
    const o = read(oRaw);
    if (i === undefined || o === undefined)
      return { error: `${n + 1}行目（カード${rawCard}・${date}）：時刻「${(iRaw ?? "").trim()}」「${(oRaw ?? "").trim()}」が読めません` };
    const p: TcPunch = { i, o };
    if (!hmForm) {
      const other = [6, 7, 8, 9].map((k) => (r[k] ?? "").trim());
      if (other.some((x) => x !== "")) p.x = other.join("/");
    }
    const [yyyy, mm, dd] = date.split("/");
    // 打刻のない日も入れておく（楽々勤怠で打刻を消した日に気づけるように）
    ((months[`${yyyy}-${mm}`] ??= {})[card] ??= {})[dd] = p;
    if (i !== null || o !== null) count++;
  }
  if (!Object.keys(people).length || !count)
    return { error: "楽々勤怠のファイルとして読めませんでした（社員コードと氏名の行、または打刻の行が見つかりません）" };
  return { data: { months, count }, people };
}

/**
 * 楽々勤怠の修正後の打刻を、今の月のデータに「画面で直した時刻（e）」として重ねる。
 * USBの元の打刻はそのまま残すので、「元の打刻 → 直した時刻」が確認欄に出る。
 * 元の打刻と同じ日は何もしない（前に直した時刻があれば、楽々勤怠に合わせて元に戻す）
 */
export function mergeFixed(
  cur: TimecardMonth["cards"] | undefined,
  add: Record<string, Record<string, TcPunch>>,
): { cards: TimecardMonth["cards"]; changed: number } {
  const out: TimecardMonth["cards"] = structuredClone(cur ?? {});
  let changed = 0;
  for (const [card, days] of Object.entries(add)) {
    for (const [dd, p] of Object.entries(days)) {
      const day = out[card]?.[dd];
      if (!day) {
        if (p.i === null && p.o === null) continue;
        // USBのデータにない日（楽々勤怠で足した日）
        (out[card] ??= {})[dd] = { i: null, o: null, e: { i: p.i, o: p.o } };
        changed++;
        continue;
      }
      const same = day.i === p.i && day.o === p.o;
      if (same) {
        if (day.e) delete day.e;
        continue;
      }
      day.e = { i: p.i, o: p.o };
      changed++;
    }
  }
  return { cards: out, changed };
}

/**
 * 取り込んだ打刻を、今の月のデータに重ねる。
 * 元の打刻は新しいもので置き換え、画面で直した時刻（e）は残す。CSVにない日はそのまま残す
 */
export function mergeTimecard(cur: TimecardMonth["cards"] | undefined, add: Record<string, Record<string, TcPunch>>): TimecardMonth["cards"] {
  const out: TimecardMonth["cards"] = structuredClone(cur ?? {});
  for (const [card, days] of Object.entries(add)) {
    const c = (out[card] ??= {});
    for (const [dd, p] of Object.entries(days)) {
      const e = c[dd]?.e;
      const bk = c[dd]?.bk;
      c[dd] = { ...p, ...(e ? { e } : {}), ...(typeof bk === "number" ? { bk } : {}) };
    }
  }
  return out;
}

export type DayResult = {
  date: string;
  raw: TcDay | null;
  /** 使う出勤・退勤（直した時刻があればそちら） */
  i: number | null;
  o: number | null;
  edited: boolean;
  /** 丸めたあとの出勤・退勤 */
  ri: number | null;
  ro: number | null;
  /** 休憩（分）と、働いた時間（分）、そのうちの残業（分） */
  brk: number;
  /** 自動で決まる休憩（分）。brkEdited のときは brk が画面で直した休憩 */
  autoBrk: number;
  brkEdited: boolean;
  work: number;
  over: number;
  /** その日の会社の出勤時刻（決めていなければ null） */
  start: number | null;
  /** 打刻もれなど、確かめてほしいこと */
  problem: string | null;
};

const roundTo = (min: number, unit: number, dir: RoundDir) => (unit <= 1 ? min : (dir === "up" ? Math.ceil(min / unit) : Math.floor(min / unit)) * unit);

/** その日の会社の出勤時刻（その日までに始まったうち、いちばん新しいもの） */
export function startTimeOn(date: string, cfg: TimecardConfig): number | null {
  let best: StartTime | null = null;
  for (const s of cfg.startTimes) if (s.from <= date && (!best || s.from > best.from)) best = s;
  return best ? best.time : null;
}

/** 1日分の計算（時刻・時間はすべて分） */
export function computeDay(date: string, raw: TcDay | null, cfg: TimecardConfig): DayResult {
  const src = raw?.e ?? raw;
  const i = src?.i ?? null;
  const o = src?.o ?? null;
  const brkEdited = typeof raw?.bk === "number";
  // 直した時刻が元の打刻と同じなら、直していないのと同じに扱う
  const timeEdited = !!raw?.e && (raw.e.i !== raw.i || raw.e.o !== raw.o);
  const edited = timeEdited || brkEdited;
  const start = startTimeOn(date, cfg);
  const base = { date, raw, i, o, edited, start, brkEdited };
  const none = { ri: null, ro: null, brk: raw?.bk ?? 0, autoBrk: 0, work: 0, over: 0 };
  if (!raw || (i === null && o === null)) return { ...base, ...none, problem: null };
  if (i === null || o === null) return { ...base, ...none, problem: i === null ? "出勤の打刻がありません" : "退勤の打刻がありません" };
  // 会社の出勤時刻より前に押した分は数えない
  const ii = start !== null && i < start ? start : i;
  const ri = roundTo(ii, cfg.roundIn, cfg.inDir);
  // 退勤が出勤より前なら、日をまたいだとみなす
  const ro = roundTo(o < i ? o + 1440 : o, cfg.roundOut, cfg.outDir);
  const span = Math.max(0, ro - ri);
  // 休憩：休憩の時間帯と、働いた時間が重なる分だけ引く
  // 画面で休憩を直した日は、その分を引く
  const autoBrk = cfg.breaks.reduce((a, b) => a + Math.max(0, Math.min(ro, b.end) - Math.max(ri, b.start)), 0);
  const brk = brkEdited ? (raw.bk as number) : autoBrk;
  const work = Math.max(0, span - brk);
  const over = Math.max(0, work - cfg.overtimeOver);
  const problem = raw.x && !raw.e ? `ほかの欄にも打刻があります（${raw.x}）` : span > 16 * 60 ? "16時間をこえています" : null;
  return { ...base, ri, ro, brk, autoBrk, work, over, problem };
}

/** 給与の月（"YYYY-MM"）の日にちの並び。締め日が月末でなければ、前の月の締め日の翌日から */
export function periodDays(month: string, closeDay: number): string[] {
  const [y, m] = month.split("-").map(Number);
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const out: string[] = [];
  if (closeDay >= 28) {
    for (let d = 1; d <= last(y, m); d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
    return out;
  }
  const prev = shiftMonth(month, -1);
  const [py, pm] = prev.split("-").map(Number);
  for (let d = closeDay + 1; d <= last(py, pm); d++) out.push(`${prev}-${String(d).padStart(2, "0")}`);
  for (let d = 1; d <= closeDay; d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return out;
}

/** その給与の月に使う、暦の月のデータ（締め日が月末でなければ前の月も） */
export function periodMonths(month: string, closeDay: number): string[] {
  return closeDay >= 28 ? [month] : [shiftMonth(month, -1), month];
}

export type PersonResult = { card: string; days: DayResult[]; workDays: number; work: number; over: number; problems: number; edited: number };

/** 1人分（1枚のカード）の給与の月の集計。noOvertime（管理職）のときは残業を数えない */
export function computePerson(
  card: string,
  month: string,
  data: Record<string, TimecardMonth | null>,
  cfg: TimecardConfig,
  opts: { noOvertime?: boolean } = {},
): PersonResult {
  const days = periodDays(month, cfg.closeDay)
    .map((date) => computeDay(date, data[date.slice(0, 7)]?.cards[card]?.[date.slice(8)] ?? null, cfg))
    .map((d) => (opts.noOvertime ? { ...d, over: 0 } : d));
  return {
    card,
    days,
    workDays: days.filter((d) => d.work > 0).length,
    work: days.reduce((a, d) => a + d.work, 0),
    over: days.reduce((a, d) => a + d.over, 0),
    problems: days.filter((d) => d.problem).length,
    edited: days.filter((d) => d.edited).length,
  };
}

/** その給与の月に打刻がある（または直した）カード番号 */
export function cardsIn(month: string, data: Record<string, TimecardMonth | null>, cfg: TimecardConfig): string[] {
  const dates = new Set(periodDays(month, cfg.closeDay));
  const set = new Set<string>();
  for (const ym of periodMonths(month, cfg.closeDay))
    for (const [card, days] of Object.entries(data[ym]?.cards ?? {})) if (Object.keys(days).some((dd) => dates.has(`${ym}-${dd}`))) set.add(card);
  return [...set].sort();
}

/** カード番号から従業員を探す（ひも付けがなければ、社員番号が同じ人） */
export function employeeForCard<E extends { id: string; code: string }>(card: string, cfg: TimecardConfig, employees: E[]): E | null {
  const id = cfg.cards[card];
  if (id) return employees.find((e) => e.id === id) ?? null;
  const n = Number(card);
  return employees.find((e) => /^\d+$/.test(e.code.trim()) && Number(e.code) === n) ?? null;
}

export function useTimecardConfig(): { value: TimecardConfig | null; error: string } {
  const [value, setValue] = useState<TimecardConfig | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/timecard"),
        (s) => {
          const v = { ...DEFAULT_TIMECARD_CONFIG, ...((s.data() as Partial<TimecardConfig> | undefined) ?? {}) };
          // 前の形の休憩（「○時間をこえたら△分」）は使わない
          v.breaks = (v.breaks ?? []).filter((b) => typeof b?.start === "number" && typeof b?.end === "number");
          setValue(v);
        },
        () => setError("タイムカードの設定を読めませんでした"),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return { value, error };
}

export async function saveTimecardConfig(cfg: Partial<TimecardConfig>) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/timecard"), { ...cfg, updatedAt: serverTimestamp() }, { merge: true });
}

/** 暦の月のデータをいくつか見る（"YYYY-MM" → データ。まだなければ null） */
export function useTimecardMonths(months: string[]): Record<string, TimecardMonth | null> | null {
  const key = months.join(",");
  const [state, setState] = useState<{ key: string; data: Record<string, TimecardMonth | null> } | null>(null);
  useEffect(() => {
    const list = key.split(",");
    const unsubs: (() => void)[] = [];
    let cancelled = false;
    const got: Record<string, TimecardMonth | null> = {};
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      for (const ym of list)
        unsubs.push(
          onSnapshot(
            doc(db, `timecards/${ym}`),
            (s) => {
              got[ym] = s.exists() ? ({ cards: {}, ...s.data() } as TimecardMonth) : null;
              if (list.every((m) => m in got)) setState({ key, data: { ...got } });
            },
            () => {},
          ),
        );
    });
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [key]);
  return state && state.key === key ? state.data : null;
}

/** 取り込み：月ごとに、今のデータに重ねて保存する */
/** 楽々勤怠の修正後の打刻を、直した時刻として重ねる。直した日数を返す */
export async function importFixed(parsed: ParsedTimecard): Promise<number> {
  const { db } = await getFirebase();
  let total = 0;
  for (const [ym, cards] of Object.entries(parsed.months)) {
    const ref = doc(db, `timecards/${ym}`);
    const cur = await getDoc(ref);
    const data = cur.data() as TimecardMonth | undefined;
    const { cards: merged, changed } = mergeFixed(data?.cards, cards);
    total += changed;
    await setDoc(ref, { cards: merged, ...(data?.fileName ? { fileName: data.fileName } : {}), updatedAt: serverTimestamp() });
  }
  return total;
}

export async function importTimecard(parsed: ParsedTimecard, fileName: string) {
  const { db } = await getFirebase();
  for (const [ym, cards] of Object.entries(parsed.months)) {
    const ref = doc(db, `timecards/${ym}`);
    const cur = await getDoc(ref);
    const merged = mergeTimecard((cur.data() as TimecardMonth | undefined)?.cards, cards);
    await setDoc(ref, { cards: merged, fileName: fileName.slice(0, 100), importedAt: serverTimestamp() });
  }
}

/** 1日分を直す。e＝時刻（null＝元の打刻に戻す）、bk＝休憩（null＝自動に戻す） */
export async function saveTimecardEdit(date: string, card: string, e: { i: number | null; o: number | null } | null) {
  await saveDayField(date, card, "e", e);
}
export async function saveTimecardBreak(date: string, card: string, minutes: number | null) {
  await saveDayField(date, card, "bk", minutes);
}

async function saveDayField(date: string, card: string, key: "e" | "bk", value: unknown) {
  const { db } = await getFirebase();
  const ref = doc(db, `timecards/${date.slice(0, 7)}`);
  const dd = date.slice(8);
  const snap = await getDoc(ref);
  const day = snap.exists() ? (snap.data() as TimecardMonth).cards?.[card]?.[dd] : undefined;
  if (!snap.exists()) {
    if (value === null) return;
    await setDoc(ref, { cards: { [card]: { [dd]: { i: null, o: null, [key]: value } } }, updatedAt: serverTimestamp() });
    return;
  }
  if (!day) {
    if (value === null) return;
    // 打刻がない日に入れる
    await updateDoc(ref, new FieldPath("cards", card, dd), { i: null, o: null, [key]: value }, "updatedAt", serverTimestamp());
    return;
  }
  const other = key === "e" ? typeof day.bk === "number" : !!day.e;
  if (value === null && day.i === null && day.o === null && !day.x && !other) {
    // 打刻がなく、直した分だけだった日は、日ごと消す
    await updateDoc(ref, new FieldPath("cards", card, dd), deleteField(), "updatedAt", serverTimestamp());
    return;
  }
  await updateDoc(ref, new FieldPath("cards", card, dd, key), value ?? deleteField(), "updatedAt", serverTimestamp());
}
