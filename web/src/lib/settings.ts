// お店の設定（Firestore の settings/main に1件だけ保存する）
// お客様用の予約ページでも使うため、個人情報は入れない。

/** 月日（毎年くり返す日付） 例: "06-15" */
export type MonthDay = string;

export type TimeSlot = {
  id: string;
  /** 開始時刻 "10:00" */
  time: string;
  /** この枠の定員（人） */
  capacity: number;
};

/** 料金区分（大人・子ども・幼児など） */
export type PriceCategory = { id: string; name: string };

export type Plan = {
  id: string;
  name: string;
  /** 所要時間（分） */
  minutes: number;
  /** 料金区分ごとの1人あたり料金（税込・円）。区分がないものは対象外 */
  prices: Record<string, number>;
  /** お客様用の予約ページに表示するか */
  public: boolean;
};

export type Settings = {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  /** 営業期間（毎年） */
  seasonStart: MonthDay;
  seasonEnd: MonthDay;
  openTime: string;
  closeTime: string;
  /** 臨時休業日 "2026-07-01" */
  closedDates: string[];
  /** Web予約を何日先まで受け付けるか */
  bookingDaysAhead: number;
  /** Web予約の締切：来園日の何日前まで（1 = 前日まで） */
  bookingCutoffDays: number;
  timeSlots: TimeSlot[];
  priceCategories: PriceCategory[];
  plans: Plan[];
};

export const SETTINGS_DOC = "settings/main";

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** まだ設定が保存されていないときの初期値 */
export function defaultSettings(): Settings {
  const adult = { id: "adult", name: "大人" };
  const child = { id: "child", name: "子ども" };
  return {
    storeName: "",
    storePhone: "",
    storeAddress: "",
    seasonStart: "06-15",
    seasonEnd: "10-15",
    openTime: "08:00",
    closeTime: "17:00",
    closedDates: [],
    bookingDaysAhead: 30,
    bookingCutoffDays: 1,
    timeSlots: [
      { id: newId(), time: "10:00", capacity: 30 },
      { id: newId(), time: "12:00", capacity: 30 },
      { id: newId(), time: "14:00", capacity: 30 },
    ],
    priceCategories: [adult, child],
    plans: [{ id: newId(), name: "いちご狩り 30分", minutes: 30, prices: { adult: 0, child: 0 }, public: true }],
  };
}

/** 保存されたデータを、足りない項目を初期値で補って読み込む */
export function normalizeSettings(data: Partial<Settings> | undefined): Settings {
  return { ...defaultSettings(), ...(data ?? {}) };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 保存前のチェック。問題があれば日本語の説明を返す */
export function validateSettings(s: Settings): string[] {
  const errors: string[] = [];
  if (s.storeName.length > 50) errors.push("店名は50文字以内にしてください");
  if (!MONTH_DAY_RE.test(s.seasonStart) || !MONTH_DAY_RE.test(s.seasonEnd)) errors.push("営業期間の日付が正しくありません");
  if (!TIME_RE.test(s.openTime) || !TIME_RE.test(s.closeTime)) errors.push("営業時間が正しくありません");
  if (s.openTime >= s.closeTime) errors.push("営業時間の終わりは始まりより後にしてください");
  if (!Number.isInteger(s.bookingDaysAhead) || s.bookingDaysAhead < 1 || s.bookingDaysAhead > 365)
    errors.push("予約の受付期間は1〜365日にしてください");
  if (!Number.isInteger(s.bookingCutoffDays) || s.bookingCutoffDays < 0 || s.bookingCutoffDays > 30)
    errors.push("予約の締切は0〜30日前にしてください");

  if (s.timeSlots.length === 0) errors.push("時間枠を1つ以上作ってください");
  const times = new Set<string>();
  for (const t of s.timeSlots) {
    if (!TIME_RE.test(t.time)) errors.push(`時間枠「${t.time || "（空）"}」の時刻が正しくありません`);
    if (times.has(t.time)) errors.push(`時間枠「${t.time}」が重複しています`);
    times.add(t.time);
    if (!Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > 1000)
      errors.push(`時間枠「${t.time}」の定員は1〜1000人にしてください`);
  }

  if (s.priceCategories.length === 0) errors.push("料金区分を1つ以上作ってください");
  const catNames = new Set<string>();
  for (const c of s.priceCategories) {
    if (!c.name.trim()) errors.push("料金区分の名前が空です");
    if (catNames.has(c.name.trim())) errors.push(`料金区分「${c.name}」が重複しています`);
    catNames.add(c.name.trim());
  }

  if (s.plans.length === 0) errors.push("プランを1つ以上作ってください");
  for (const p of s.plans) {
    const label = p.name.trim() || "（名前なし）";
    if (!p.name.trim()) errors.push("プランの名前が空です");
    if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 600) errors.push(`プラン「${label}」の時間は1〜600分にしてください`);
    const priced = Object.entries(p.prices).filter(([catId]) => s.priceCategories.some((c) => c.id === catId));
    if (priced.length === 0) errors.push(`プラン「${label}」に料金を1つ以上入れてください`);
    for (const [, yen] of priced) {
      if (!Number.isInteger(yen) || yen < 0 || yen > 1_000_000) errors.push(`プラン「${label}」の料金が正しくありません`);
    }
  }
  return [...new Set(errors)];
}

/** 保存用に整える（前後の空白を取る・時間枠を時刻順に・削除した区分の料金を消す） */
export function cleanSettings(s: Settings): Settings {
  const catIds = new Set(s.priceCategories.map((c) => c.id));
  return {
    ...s,
    storeName: s.storeName.trim(),
    storePhone: s.storePhone.trim(),
    storeAddress: s.storeAddress.trim(),
    closedDates: [...new Set(s.closedDates)].sort(),
    timeSlots: [...s.timeSlots].sort((a, b) => a.time.localeCompare(b.time)),
    priceCategories: s.priceCategories.map((c) => ({ ...c, name: c.name.trim() })),
    plans: s.plans.map((p) => ({
      ...p,
      name: p.name.trim(),
      prices: Object.fromEntries(Object.entries(p.prices).filter(([id]) => catIds.has(id))),
    })),
  };
}
