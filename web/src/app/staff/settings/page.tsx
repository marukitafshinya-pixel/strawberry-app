"use client";

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";
import {
  SETTINGS_DOC,
  cleanSettings,
  newId,
  normalizeSettings,
  validateSettings,
  type Plan,
  type Settings,
} from "@/lib/settings";

const input = "mt-1 w-full rounded-lg border px-3 py-2 text-base";
const timeInput = "mt-1 w-32 rounded-lg border px-2 py-2 text-base";
const smallButton = "rounded-lg border px-3 py-1.5 text-sm";

export default function SettingsPage() {
  const { role } = useAuth();
  const [s, setS] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    getFirebase()
      .then(({ db }) => getDoc(doc(db, SETTINGS_DOC)))
      .then((snap) => setS(normalizeSettings(snap.data() as Partial<Settings> | undefined)))
      .catch((e) => setErrors([errorText(e)]));
  }, []);

  // 保存せずに画面を閉じようとしたら確認する
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!s) return <p className="text-gray-500">{errors[0] ?? "読み込み中…"}</p>;

  /** 一部を書き換える */
  const update = (patch: Partial<Settings>) => {
    setS({ ...s, ...patch });
    setSaved(false);
    setDirty(true);
  };

  async function save() {
    if (!s) return;
    const cleaned = cleanSettings(s);
    const problems = validateSettings(cleaned);
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await setDoc(doc(db, SETTINGS_DOC), { ...cleaned, updatedAt: serverTimestamp() });
      setS(cleaned);
      setSaved(true);
      setDirty(false);
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pb-28">
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">設定</h1>
      <p className="mt-1 text-sm text-gray-600">変更したら、画面下の「保存する」を押してください。</p>

      <Section title="お店の情報" note="レシートなどに表示します。">
        <Field label="店名">
          <input value={s.storeName} maxLength={50} onChange={(e) => update({ storeName: e.target.value })} className={input} />
        </Field>
        <Field label="電話番号">
          <input
            type="tel"
            value={s.storePhone}
            maxLength={20}
            onChange={(e) => update({ storePhone: e.target.value })}
            className={input}
          />
        </Field>
        <Field label="住所">
          <input value={s.storeAddress} maxLength={100} onChange={(e) => update({ storeAddress: e.target.value })} className={input} />
        </Field>
      </Section>

      <Section title="営業日・営業時間">
        <div className="flex flex-wrap items-end gap-2">
          <MonthDayInput label="営業期間（毎年）" value={s.seasonStart} onChange={(v) => update({ seasonStart: v })} />
          <span className="pb-2">〜</span>
          <MonthDayInput label="" value={s.seasonEnd} onChange={(v) => update({ seasonEnd: v })} />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="営業時間">
            <input type="time" value={s.openTime} onChange={(e) => update({ openTime: e.target.value })} className={timeInput} />
          </Field>
          <span className="pb-2">〜</span>
          <Field label="">
            <input type="time" value={s.closeTime} onChange={(e) => update({ closeTime: e.target.value })} className={timeInput} />
          </Field>
        </div>
        <ClosedDates dates={s.closedDates} onChange={(closedDates) => update({ closedDates })} />
      </Section>

      <Section title="Web予約の受付">
        <div className="flex flex-wrap gap-4">
          <Field label="何日先まで受け付けるか">
            <span className="mt-1 block" />
            <NumberInput value={s.bookingDaysAhead} onChange={(v) => update({ bookingDaysAhead: v })} suffix="日先まで" />
          </Field>
          <Field label="締切">
            <select
              value={s.bookingCutoffDays}
              onChange={(e) => update({ bookingCutoffDays: Number(e.target.value) })}
              className={input}
            >
              <option value={0}>当日まで</option>
              <option value={1}>前日まで</option>
              <option value={2}>2日前まで</option>
              <option value={3}>3日前まで</option>
            </select>
          </Field>
        </div>
      </Section>

      <Section title="時間枠と定員" note="時刻順に並べて保存します。キャンセルの予約は定員に数えません。">
        <ul className="space-y-2">
          {s.timeSlots.map((t, i) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                value={t.time}
                aria-label="開始時刻"
                onChange={(e) => update({ timeSlots: s.timeSlots.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)) })}
                className={timeInput}
              />
              <span className="text-sm text-gray-600">定員</span>
              <NumberInput
                value={t.capacity}
                onChange={(v) => update({ timeSlots: s.timeSlots.map((x, j) => (j === i ? { ...x, capacity: v } : x)) })}
                suffix="人"
              />
              <button
                onClick={() => update({ timeSlots: s.timeSlots.filter((_, j) => j !== i) })}
                className={`${smallButton} text-red-700`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
        <button
          onClick={() => {
            const last = s.timeSlots.at(-1);
            update({ timeSlots: [...s.timeSlots, { id: newId(), time: "", capacity: last?.capacity ?? 30 }] });
          }}
          className={`${smallButton} mt-2`}
        >
          ＋ 時間枠を追加
        </button>
      </Section>

      <Section title="料金区分" note="大人・子ども・幼児など。プランごとに区分別の料金を決めます。">
        <ul className="space-y-2">
          {s.priceCategories.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2">
              <input
                value={c.name}
                maxLength={20}
                aria-label="区分名"
                onChange={(e) =>
                  update({ priceCategories: s.priceCategories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                }
                className="w-40 rounded-lg border px-3 py-2 text-base"
              />
              <button
                disabled={i === 0}
                onClick={() => update({ priceCategories: move(s.priceCategories, i, -1) })}
                className={`${smallButton} disabled:opacity-30`}
                aria-label="上へ"
              >
                ↑
              </button>
              <button
                disabled={i === s.priceCategories.length - 1}
                onClick={() => update({ priceCategories: move(s.priceCategories, i, 1) })}
                className={`${smallButton} disabled:opacity-30`}
                aria-label="下へ"
              >
                ↓
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`料金区分「${c.name}」を削除しますか？\n各プランのこの区分の料金も消えます。`))
                    update({ priceCategories: s.priceCategories.filter((_, j) => j !== i) });
                }}
                className={`${smallButton} text-red-700`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
        <button
          onClick={() => update({ priceCategories: [...s.priceCategories, { id: newId(), name: "" }] })}
          className={`${smallButton} mt-2`}
        >
          ＋ 料金区分を追加
        </button>
      </Section>

      <Section title="プラン" note="料金は1人あたり・税込です。空欄の区分は、そのプランでは選べません。">
        <ul className="space-y-3">
          {s.plans.map((p, i) => (
            <PlanEditor
              key={p.id}
              plan={p}
              settings={s}
              onChange={(plan) => update({ plans: s.plans.map((x, j) => (j === i ? plan : x)) })}
              onDelete={() => {
                if (window.confirm(`プラン「${p.name}」を削除しますか？\n（過去の予約の記録はそのまま残ります）`))
                  update({ plans: s.plans.filter((_, j) => j !== i) });
              }}
            />
          ))}
        </ul>
        <button
          onClick={() =>
            update({
              plans: [...s.plans, { id: newId(), name: "", minutes: 30, prices: {}, public: true }],
            })
          }
          className={`${smallButton} mt-2`}
        >
          ＋ プランを追加
        </button>
      </Section>

      {/* 画面下に固定の保存ボタン */}
      <div className="fixed inset-x-0 bottom-0 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <button onClick={save} disabled={saving} className="rounded-lg bg-berry px-6 py-3 font-bold text-white disabled:opacity-50">
            {saving ? "保存中…" : "保存する"}
          </button>
          {saved && <span className="text-sm text-green-700">保存しました</span>}
          {dirty && !saved && <span className="text-sm text-gray-500">まだ保存していない変更があります</span>}
        </div>
        {errors.length > 0 && (
          <ul className="mx-auto mt-2 max-h-32 max-w-5xl list-disc overflow-auto pl-5 text-sm text-red-600">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function move<T>(list: T[], i: number, delta: number): T[] {
  const next = [...list];
  [next[i], next[i + delta]] = [next[i + delta], next[i]];
  return next;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-6 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
      <div>
        <h2 className="font-bold">{title}</h2>
        {note && <p className="text-xs text-gray-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      {label && <span className="block text-sm text-gray-600">{label}</span>}
      {children}
    </label>
  );
}

/** 数字の入力欄（空にしている途中も入力できるようにする） */
function NumberInput({ value, onChange, suffix }: { value: number; onChange: (v: number) => void; suffix?: string }) {
  const [text, setText] = useState(String(value));
  // 外から値が変わったときは表示も合わせる
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(String(value));
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        inputMode="numeric"
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
          setText(t);
          if (t !== "") onChange(Number(t));
        }}
        onBlur={() => setText(String(value))}
        className="w-24 rounded-lg border px-3 py-2 text-right text-base"
      />
      {suffix && <span className="text-sm text-gray-600">{suffix}</span>}
    </span>
  );
}

function MonthDayInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [m, d] = value.split("-");
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <Field label={label}>
      <span className="mt-1 flex items-center gap-1">
        <select value={m} onChange={(e) => onChange(`${e.target.value}-${d}`)} className="rounded-lg border px-2 py-2 text-base">
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i} value={pad(i + 1)}>
              {i + 1}
            </option>
          ))}
        </select>
        月
        <select value={d} onChange={(e) => onChange(`${m}-${e.target.value}`)} className="rounded-lg border px-2 py-2 text-base">
          {Array.from({ length: 31 }, (_, i) => (
            <option key={i} value={pad(i + 1)}>
              {i + 1}
            </option>
          ))}
        </select>
        日
      </span>
    </Field>
  );
}

function ClosedDates({ dates, onChange }: { dates: string[]; onChange: (d: string[]) => void }) {
  const [adding, setAdding] = useState("");
  return (
    <div>
      <span className="text-sm text-gray-600">臨時休業日</span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input type="date" value={adding} onChange={(e) => setAdding(e.target.value)} className="rounded-lg border px-3 py-2 text-base" />
        <button
          disabled={!adding}
          onClick={() => {
            onChange([...new Set([...dates, adding])].sort());
            setAdding("");
          }}
          className={`${smallButton} disabled:opacity-40`}
        >
          追加
        </button>
      </div>
      {dates.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">なし</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {dates.map((d) => (
            <li key={d} className="flex items-center gap-1 rounded-full bg-gray-100 py-1 pl-3 pr-1 text-sm">
              {formatDate(d)}
              <button
                onClick={() => onChange(dates.filter((x) => x !== d))}
                className="rounded-full px-2 text-gray-500"
                aria-label={`${d} を削除`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const w = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${y}/${m}/${d}（${w}）`;
}

function PlanEditor({
  plan,
  settings,
  onChange,
  onDelete,
}: {
  plan: Plan;
  settings: Settings;
  onChange: (p: Plan) => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-xl border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="プラン名">
          <input
            value={plan.name}
            maxLength={30}
            onChange={(e) => onChange({ ...plan, name: e.target.value })}
            className="mt-1 w-56 rounded-lg border px-3 py-2 text-base"
          />
        </Field>
        <Field label="時間">
          <span className="mt-1 block">
            <NumberInput value={plan.minutes} onChange={(v) => onChange({ ...plan, minutes: v })} suffix="分" />
          </span>
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {settings.priceCategories.map((c) => (
          <PriceInput
            key={c.id}
            label={c.name || "（名前なし）"}
            value={plan.prices[c.id]}
            onChange={(v) => {
              const prices = { ...plan.prices };
              if (v === undefined) delete prices[c.id];
              else prices[c.id] = v;
              onChange({ ...plan, prices });
            }}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={plan.public} onChange={(e) => onChange({ ...plan, public: e.target.checked })} />
          お客様の予約ページに表示する
        </label>
        <button onClick={onDelete} className={`${smallButton} text-red-700`}>
          プランを削除
        </button>
      </div>
    </li>
  );
}

/** 料金の入力欄。空欄＝このプランでは対象外 */
function PriceInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(value === undefined ? "" : String(value));
  }
  return (
    <label className="block text-sm">
      <span className="text-gray-600">{label}</span>
      <span className="mt-1 flex items-center gap-1">
        <input
          inputMode="numeric"
          placeholder="対象外"
          value={text}
          onChange={(e) => {
            const t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
            setText(t);
            onChange(t === "" ? undefined : Number(t));
          }}
          className="w-full rounded-lg border px-3 py-2 text-right text-base"
        />
        円
      </span>
    </label>
  );
}
