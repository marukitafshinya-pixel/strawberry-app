"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import {
  STATUS_LABEL,
  STATUS_STYLE,
  countsTowardCapacity,
  peopleText,
  useContacts,
  useReservations,
  useSettings,
  type Reservation,
} from "@/lib/reservations";
import type { Settings } from "@/lib/settings";
import { ReservationForm } from "./ReservationForm";

export default function ReservationsPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <ReservationsView />
    </Suspense>
  );
}

function ReservationsView() {
  const params = useSearchParams();
  const router = useRouter();
  const date = isValidYmd(params.get("date")) ? params.get("date")! : todayJST();
  const setDate = (d: string) => router.replace(`/staff/reservations/?date=${d}`);

  const { value: settings } = useSettings();
  const { value: reservations, error } = useReservations(date);
  const { value: contacts } = useContacts(date);
  const [editing, setEditing] = useState<Reservation | "new" | null>(null);

  const bySlot = useMemo(() => {
    const m = new Map<string, Reservation[]>();
    for (const r of reservations ?? []) m.set(r.slotId, [...(m.get(r.slotId) ?? []), r]);
    return m;
  }, [reservations]);

  if (!settings) return <p className="text-gray-500">読み込み中…</p>;

  // 設定にない（削除された）時間枠の予約も表示できるようにする
  const slotRows = [
    ...settings.timeSlots.map((t) => ({ id: t.id, time: t.time, capacity: t.capacity as number | null })),
    ...[...bySlot.keys()]
      .filter((id) => !settings.timeSlots.some((t) => t.id === id))
      .map((id) => ({ id, time: bySlot.get(id)![0].slotTime, capacity: null })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  const active = (reservations ?? []).filter((r) => countsTowardCapacity(r.status));
  const totalPeople = active.reduce((n, r) => n + r.people, 0);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">予約管理</h1>
        <button onClick={() => setEditing("new")} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
          ＋ 予約を追加
        </button>
      </div>

      {/* 日付の切り替え */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm">
        <button onClick={() => setDate(addDays(date, -1))} className="rounded-lg border px-3 py-2">
          ‹ 前日
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => isValidYmd(e.target.value) && setDate(e.target.value)}
          className="rounded-lg border px-3 py-2 text-base"
        />
        <button onClick={() => setDate(addDays(date, 1))} className="rounded-lg border px-3 py-2">
          翌日 ›
        </button>
        {date !== todayJST() && (
          <button onClick={() => setDate(todayJST())} className="rounded-lg border px-3 py-2">
            今日
          </button>
        )}
        <div className="ml-auto text-right">
          <div className="font-bold">{formatJa(date, true)}</div>
          <div className="text-sm text-gray-600">
            {active.length}件・{totalPeople}人
          </div>
        </div>
      </div>
      <DayNotice date={date} settings={settings} />

      {error ? <p className="mt-4 text-red-600">{errorText(error)}</p> : null}
      {!reservations && !error && <p className="mt-4 text-gray-500">読み込み中…</p>}

      {/* 時間枠ごとの埋まり具合と予約一覧 */}
      <div className="mt-4 space-y-4">
        {slotRows.map((slot) => {
          const list = (bySlot.get(slot.id) ?? []).sort((a, b) => Number(a.status === "cancelled") - Number(b.status === "cancelled"));
          const booked = list.filter((r) => countsTowardCapacity(r.status)).reduce((n, r) => n + r.people, 0);
          return (
            <section key={slot.id} className="rounded-2xl bg-white p-3 shadow-sm">
              <SlotHeader time={slot.time} booked={booked} capacity={slot.capacity} />
              {list.length === 0 ? (
                <p className="mt-2 text-sm text-gray-400">予約なし</p>
              ) : (
                <ul className="mt-2 divide-y">
                  {list.map((r) => (
                    <ReservationRow key={r.id} r={r} phone={contacts?.[r.id]?.phone} onEdit={() => setEditing(r)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {editing && (
        <ReservationForm
          settings={settings}
          initialDate={date}
          reservation={editing === "new" ? null : editing}
          contact={editing === "new" ? undefined : contacts?.[editing.id]}
          onClose={() => setEditing(null)}
          onSaved={(savedDate) => {
            setEditing(null);
            if (savedDate !== date) setDate(savedDate);
          }}
        />
      )}
    </>
  );
}

/** 営業期間外・臨時休業日のお知らせ */
function DayNotice({ date, settings }: { date: string; settings: Settings }) {
  const md = date.slice(5);
  const inSeason =
    settings.seasonStart <= settings.seasonEnd
      ? md >= settings.seasonStart && md <= settings.seasonEnd
      : md >= settings.seasonStart || md <= settings.seasonEnd;
  const closed = settings.closedDates.includes(date);
  if (inSeason && !closed) return null;
  return (
    <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
      {closed ? "この日は臨時休業日に設定されています。" : "この日は営業期間外です。"}
    </p>
  );
}

function SlotHeader({ time, booked, capacity }: { time: string; booked: number; capacity: number | null }) {
  if (capacity === null) {
    return (
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">{time}</h2>
        <span className="text-sm text-gray-500">この時間枠は設定から削除されています（{booked}人）</span>
      </div>
    );
  }
  const remaining = capacity - booked;
  const ratio = Math.min(1, booked / capacity);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{time}</h2>
        <span className="text-sm">
          {booked} / {capacity}人
          <span className={`ml-2 font-bold ${remaining < 0 ? "text-red-600" : remaining === 0 ? "text-gray-500" : "text-leaf"}`}>
            {remaining < 0 ? `${-remaining}人 定員超過` : remaining === 0 ? "満員" : `残り${remaining}人`}
          </span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full ${remaining < 0 ? "bg-red-500" : "bg-berry"}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

function ReservationRow({ r, phone, onEdit }: { r: Reservation; phone?: string; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function markVisited() {
    setBusy(true);
    setError("");
    try {
      await callFunction("setReservationStatus", { id: r.id, status: "visited" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const cancelled = r.status === "cancelled";
  return (
    <li className={`py-2 ${cancelled ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
        <span className={`font-semibold ${cancelled ? "line-through" : ""}`}>{r.customerName} 様</span>
        <span className="text-sm">{r.people}人</span>
        {r.source === "web" && <span className="rounded bg-berry/10 px-1.5 text-xs text-berry-dark">Web {r.code}</span>}
        <div className="ml-auto flex gap-2">
          {!cancelled && r.status !== "visited" && (
            <button onClick={markVisited} disabled={busy} className="rounded-lg bg-leaf px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">
              {busy ? "…" : "来店"}
            </button>
          )}
          <button onClick={onEdit} className="rounded-lg border px-3 py-1.5 text-sm">
            編集
          </button>
        </div>
      </div>
      <div className="mt-1 text-sm text-gray-600">
        {r.planName}（{peopleText(r)}）
        {phone && (
          <a href={`tel:${phone}`} className="ml-2 underline">
            {phone}
          </a>
        )}
      </div>
      {r.memo && <div className="mt-1 whitespace-pre-wrap text-sm text-gray-500">📝 {r.memo}</div>}
      {error && <div className="mt-1 text-sm text-red-600">{error}</div>}
    </li>
  );
}
