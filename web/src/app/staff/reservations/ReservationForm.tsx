"use client";

import { FirebaseError } from "firebase/app";
import { useState, type FormEvent } from "react";
import { callFunction, cleanMessage, errorText } from "@/lib/callFunction";
import { formatJa, isValidYmd } from "@/lib/date";
import {
  STATUS_LABEL,
  countsTowardCapacity,
  useAvailability,
  yen,
  type Contact,
  type Reservation,
  type ReservationStatus,
} from "@/lib/reservations";
import type { Settings } from "@/lib/settings";

const input = "mt-1 w-full rounded-lg border px-3 py-2 text-base";
const label = "block text-sm text-gray-600";

type Props = {
  settings: Settings;
  initialDate: string;
  reservation: Reservation | null;
  contact?: Contact;
  onClose: () => void;
  onSaved: (date: string) => void;
};

export function ReservationForm({ settings, initialDate, reservation: r, contact, onClose, onSaved }: Props) {
  const firstSlot = settings.timeSlots[0]?.id ?? "";
  const firstPlan = settings.plans[0]?.id ?? "";
  const [date, setDate] = useState(r?.date ?? initialDate);
  const [slotId, setSlotId] = useState(r?.slotId ?? firstSlot);
  const [planId, setPlanId] = useState(r?.planId ?? firstPlan);
  const [counts, setCounts] = useState<Record<string, number>>(
    r ? Object.fromEntries(r.lines.map((l) => [l.categoryId, l.qty])) : {},
  );
  const [customerName, setCustomerName] = useState(r?.customerName ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [memo, setMemo] = useState(r?.memo ?? "");
  const [status, setStatus] = useState<ReservationStatus>(r?.status ?? "confirmed");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const { value: booked } = useAvailability(isValidYmd(date) ? date : null);

  const plan = settings.plans.find((p) => p.id === planId);
  const categories = settings.priceCategories.filter((c) => plan?.prices[c.id] !== undefined);
  const people = categories.reduce((n, c) => n + (counts[c.id] ?? 0), 0);
  const amount = categories.reduce((n, c) => n + (counts[c.id] ?? 0) * (plan?.prices[c.id] ?? 0), 0);

  /** その枠の残り人数（編集中の予約自身の分は除いて数える） */
  function remainingFor(sid: string): number | null {
    const cap = settings.timeSlots.find((t) => t.id === sid)?.capacity;
    if (cap === undefined || !booked) return null;
    const own = r && r.date === date && r.slotId === sid && countsTowardCapacity(r.status) ? r.people : 0;
    return cap - ((booked[sid] ?? 0) - own);
  }
  const remaining = remainingFor(slotId);
  const over = countsTowardCapacity(status) && remaining !== null && people > remaining;

  async function submit(force: boolean) {
    setError("");
    setSaving(true);
    try {
      const res = await callFunction<Record<string, unknown>, { id: string }>("saveReservation", {
        ...(r ? { id: r.id } : {}),
        date,
        slotId,
        planId,
        // このプランで選べる区分の人数だけを送る
        counts: Object.fromEntries(categories.map((c) => [c.id, counts[c.id] ?? 0])),
        customerName,
        phone,
        email,
        memo,
        status,
        force,
      });
      if (res.id) onSaved(date);
    } catch (e) {
      if (e instanceof FirebaseError && e.code === "functions/resource-exhausted" && !force) {
        if (window.confirm(`${cleanMessage(e.message)}\nそれでも登録しますか？`)) return submit(true);
      } else {
        setError(errorText(e));
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!r || !window.confirm(`${r.customerName} 様の予約を削除しますか？\n元に戻せません。キャンセルの場合は、ステータスを「キャンセル」にしてください。`)) return;
    setSaving(true);
    try {
      await callFunction("deleteReservation", { id: r.id });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (people < 1) return setError("人数を1人以上にしてください");
    submit(false);
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">{r ? "予約を編集" : "予約を追加"}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-2xl text-gray-500" aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>日付</span>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={input} />
          </label>
          <label className="block">
            <span className={label}>時間枠</span>
            <select value={slotId} onChange={(e) => setSlotId(e.target.value)} className={input}>
              {r && !settings.timeSlots.some((t) => t.id === r.slotId) && <option value={r.slotId}>{r.slotTime}（削除済み）</option>}
              {settings.timeSlots.map((t) => {
                const rem = remainingFor(t.id);
                return (
                  <option key={t.id} value={t.id}>
                    {t.time}
                    {rem === null ? "" : rem <= 0 ? "（満員）" : `（残り${rem}人）`}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
        {isValidYmd(date) && <p className="mt-1 text-xs text-gray-500">{formatJa(date, true)}</p>}

        <label className="mt-3 block">
          <span className={label}>プラン</span>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={input}>
            {r && !plan && <option value={r.planId}>{r.planName}（削除済み）</option>}
            {settings.plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.minutes}分）
              </option>
            ))}
          </select>
        </label>

        <fieldset className="mt-3">
          <legend className={label}>人数</legend>
          <div className="mt-1 space-y-2">
            {categories.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <span className="w-24">{c.name}</span>
                <span className="w-20 text-right text-sm text-gray-500">{yen(plan!.prices[c.id])}</span>
                <Stepper value={counts[c.id] ?? 0} onChange={(v) => setCounts({ ...counts, [c.id]: v })} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-sm">
            合計 <b>{people}人</b>・{yen(amount)}
            {remaining !== null && countsTowardCapacity(status) && (
              <span className={`ml-2 ${over ? "font-bold text-red-600" : "text-gray-500"}`}>
                {over ? `⚠ 定員を${people - remaining}人超えます` : `この枠の残り${remaining}人`}
              </span>
            )}
          </p>
        </fieldset>

        <label className="mt-3 block">
          <span className={label}>お名前（必須）</span>
          <input required maxLength={50} value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={input} />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>電話番号</span>
            <input type="tel" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} className={input} />
          </label>
          <label className="block">
            <span className={label}>メール</span>
            <input type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          </label>
        </div>
        <label className="mt-3 block">
          <span className={label}>メモ</span>
          <textarea maxLength={500} rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} className={input} />
        </label>

        <fieldset className="mt-3">
          <legend className={label}>ステータス</legend>
          <div className="mt-1 grid grid-cols-3 gap-1 sm:grid-cols-5">
            {(Object.keys(STATUS_LABEL) as ReservationStatus[]).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatus(st)}
                className={`rounded-lg border py-2 text-sm ${status === st ? "border-berry bg-berry text-white" : ""}`}
              >
                {STATUS_LABEL[st]}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex items-center gap-2">
          <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50">
            {saving ? "保存中…" : "保存する"}
          </button>
          {r && (
            <button type="button" onClick={remove} disabled={saving} className="rounded-lg border px-4 py-3 text-red-700">
              削除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** ＋−ボタン付きの人数入力 */
function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="ml-auto flex items-center gap-1">
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} className="h-10 w-10 rounded-lg border text-xl" aria-label="減らす">
        −
      </button>
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^0-9]/g, "") || 0);
          onChange(Math.min(999, n));
        }}
        className="h-10 w-14 rounded-lg border text-center text-base"
      />
      <button type="button" onClick={() => onChange(Math.min(999, value + 1))} className="h-10 w-10 rounded-lg border text-xl" aria-label="増やす">
        ＋
      </button>
    </span>
  );
}
