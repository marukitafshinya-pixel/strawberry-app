"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { FirebaseError } from "firebase/app";
import { doc, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { useAuth } from "@/lib/auth";
import { getFirebase } from "@/lib/firebase";
import { callFunction, cleanMessage, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import {
  STATUS_LABEL,
  STATUS_STYLE,
  capacityOf,
  countsTowardCapacity,
  peopleText,
  useDailyCapacity,
  useWebStopped,
  useContacts,
  usePendingRequests,
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
  const { value: daily } = useDailyCapacity(date);
  const { value: stopped } = useWebStopped(date);
  const { role } = useAuth();
  const [bulkOpen, setBulkOpen] = useState(false);

  /** この日だけの定員を保存する（null なら標準に戻す） */
  async function saveDailyCapacity(slotId: string, value: number | null) {
    const { db } = await getFirebase();
    const slots = { ...(daily ?? {}) };
    if (value === null) delete slots[slotId];
    else slots[slotId] = value;
    // slots だけを置き換える（受付停止の設定は残す）
    await setDoc(doc(db, `dailyCapacity/${date}`), { slots, updatedAt: serverTimestamp() }, { mergeFields: ["slots", "updatedAt"] });
  }

  /** この日のこの時間のWeb受付を止める／再開する */
  async function setWebStopped(slotId: string, value: boolean) {
    const { db } = await getFirebase();
    await setDoc(doc(db, `dailyCapacity/${date}`), { stopped: { [slotId]: value }, updatedAt: serverTimestamp() }, { merge: true });
  }
  const [editing, setEditing] = useState<Reservation | "new" | null>(null);

  const bySlot = useMemo(() => {
    const m = new Map<string, Reservation[]>();
    for (const r of reservations ?? []) m.set(r.slotId, [...(m.get(r.slotId) ?? []), r]);
    return m;
  }, [reservations]);

  if (!settings) return <p className="text-gray-500">読み込み中…</p>;

  // 設定にない（削除された）時間枠の予約も表示できるようにする
  const slotRows = [
    ...settings.timeSlots.map((t) => ({
      id: t.id,
      time: t.time,
      capacity: (capacityOf(settings, daily, t.id) ?? t.capacity) as number | null,
      standard: t.capacity,
    })),
    ...[...bySlot.keys()]
      .filter((id) => !settings.timeSlots.some((t) => t.id === id))
      .map((id) => ({ id, time: bySlot.get(id)![0].slotTime, capacity: null, standard: 0 })),
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
        <div className="flex gap-2">
          {role === "admin" && (
            <button onClick={() => setBulkOpen(true)} className="rounded-lg border bg-white px-3 py-2 text-sm">
              まとめて受付停止・再開
            </button>
          )}
          <button onClick={() => setEditing("new")} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
            ＋ 予約を追加
          </button>
        </div>
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
      <PendingRequests current={date} onOpen={setDate} />

      {error ? <p className="mt-4 text-red-600">{errorText(error)}</p> : null}
      {!reservations && !error && <p className="mt-4 text-gray-500">読み込み中…</p>}

      {/* 時間枠ごとの埋まり具合と予約一覧 */}
      <div className="mt-4 space-y-4">
        {slotRows.map((slot) => {
          const rank = (r: Reservation) => (r.status === "request" ? 0 : r.status === "cancelled" ? 2 : 1);
          const list = (bySlot.get(slot.id) ?? []).sort((a, b) => rank(a) - rank(b));
          const booked = list.filter((r) => countsTowardCapacity(r.status)).reduce((n, r) => n + r.people, 0);
          const requests = list.filter((r) => r.status === "request");
          return (
            <section key={slot.id} className="rounded-2xl bg-white p-3 shadow-sm">
              <SlotHeader
                time={slot.time}
                booked={booked}
                capacity={slot.capacity}
                standard={slot.standard}
                canEdit={role === "admin"}
                onChangeCapacity={(v) => saveDailyCapacity(slot.id, v)}
                webStopped={stopped?.[slot.id] === true}
                onToggleWeb={(v) => setWebStopped(slot.id, v)}
              />
              {requests.length > 0 && (
                <p className="mt-1 text-sm text-purple-800">
                  リクエスト {requests.length}件（{requests.reduce((n, r) => n + r.people, 0)}人）…承認すると定員に数えます
                </p>
              )}
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

      {bulkOpen && <BulkStopDialog settings={settings} initialDate={date} onClose={() => setBulkOpen(false)} />}
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

/** 期間と時間枠を選んで、Web予約の受付をまとめて止める／再開する */
function BulkStopDialog({ settings, initialDate, onClose }: { settings: Settings; initialDate: string; onClose: () => void }) {
  const [from, setFrom] = useState(initialDate);
  const [to, setTo] = useState(initialDate);
  const [slotIds, setSlotIds] = useState<string[]>(settings.timeSlots.map((t) => t.id));
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);

  const days = isValidYmd(from) && isValidYmd(to) && from <= to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0;

  async function apply(stop: boolean) {
    setError("");
    setDone("");
    if (days < 1) return setError("期間を正しく選んでください");
    if (days > 120) return setError("一度に選べるのは120日までです");
    if (slotIds.length === 0) return setError("時間枠を1つ以上選んでください");
    setSaving(true);
    try {
      const { db } = await getFirebase();
      const batch = writeBatch(db);
      const stopped = Object.fromEntries(slotIds.map((id) => [id, stop]));
      for (let i = 0; i < days; i++) {
        batch.set(doc(db, `dailyCapacity/${addDays(from, i)}`), { stopped, updatedAt: serverTimestamp() }, { merge: true });
      }
      await batch.commit();
      setDone(`${formatJa(from)}〜${formatJa(to)}（${days}日間）のWeb受付を${stop ? "止めました" : "再開しました"}。`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">まとめて受付停止・再開</h2>
          <button onClick={onClose} className="px-3 text-2xl text-gray-500" aria-label="閉じる">
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          お客様のWeb予約（リクエストも含む）を止めます。スタッフ画面からの予約はこれまでどおり入れられます。すでに入っている予約はそのままです。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border px-3 py-2 text-base" />
          〜
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border px-3 py-2 text-base" />
          {days > 0 && <span className="text-sm text-gray-600">{days}日間</span>}
        </div>
        <fieldset className="mt-3">
          <legend className="text-sm text-gray-600">時間枠</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {settings.timeSlots.map((t) => (
              <label key={t.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={slotIds.includes(t.id)}
                  onChange={(e) => setSlotIds(e.target.checked ? [...slotIds, t.id] : slotIds.filter((x) => x !== t.id))}
                />
                {t.time}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {done && <p className="mt-3 rounded-lg bg-green-50 p-2 text-sm text-green-800">{done}</p>}
        <div className="mt-4 flex gap-2">
          <button disabled={saving} onClick={() => apply(true)} className="flex-1 rounded-lg bg-gray-800 py-3 font-bold text-white disabled:opacity-50">
            受付を止める
          </button>
          <button disabled={saving} onClick={() => apply(false)} className="flex-1 rounded-lg border py-3 font-bold disabled:opacity-50">
            受付を再開する
          </button>
        </div>
      </div>
    </div>
  );
}

/** 承認待ちのリクエスト一覧（ほかの日付の分も含めて表示） */
function PendingRequests({ current, onOpen }: { current: string; onOpen: (d: string) => void }) {
  const { value } = usePendingRequests(todayJST());
  if (!value || value.length === 0) return null;
  return (
    <div className="mt-2 rounded-xl border border-purple-200 bg-purple-50 p-3 text-sm">
      <p className="font-bold text-purple-900">承認待ちのリクエスト {value.length}件</p>
      <p className="text-xs text-purple-800">お客様にお電話かメールで可否を連絡し、「承認」または「キャンセル」にしてください。</p>
      <ul className="mt-1 flex flex-wrap gap-2">
        {value.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onOpen(r.date)}
              className={`rounded-full border border-purple-300 bg-white px-3 py-1 ${r.date === current ? "font-bold" : ""}`}
            >
              {formatJa(r.date)} {r.slotTime} {r.customerName}様 {r.people}人
            </button>
          </li>
        ))}
      </ul>
    </div>
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

function SlotHeader({
  time,
  booked,
  capacity,
  standard,
  canEdit,
  onChangeCapacity,
  webStopped,
  onToggleWeb,
}: {
  time: string;
  booked: number;
  capacity: number | null;
  standard: number;
  canEdit: boolean;
  onChangeCapacity: (v: number | null) => Promise<void>;
  webStopped: boolean;
  onToggleWeb: (v: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(v: number | null) {
    setError("");
    setSaving(true);
    try {
      await onChangeCapacity(v);
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  if (capacity === null) {
    return (
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">{time}</h2>
        <span className="text-sm text-gray-500">この時間枠は設定から削除されています（{booked}人）</span>
      </div>
    );
  }
  const remaining = capacity - booked;
  const ratio = capacity > 0 ? Math.min(1, booked / capacity) : booked > 0 ? 1 : 0;
  const changed = capacity !== standard;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{time}</h2>
        <span className="text-sm">
          {booked} / {capacity}人
          {webStopped && <span className="ml-1 rounded bg-gray-700 px-1 text-xs text-white">Web受付停止中</span>}
          {changed && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">{capacity === 0 ? "この日は受付停止" : `この日だけ（標準${standard}人）`}</span>}
          <span className={`ml-2 font-bold ${remaining < 0 ? "text-red-600" : remaining === 0 ? "text-gray-500" : "text-leaf"}`}>
            {remaining < 0 ? `${-remaining}人 定員超過` : remaining === 0 ? "満員" : `残り${remaining}人`}
          </span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full ${remaining < 0 ? "bg-red-500" : "bg-berry"}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      {canEdit && !editing && (
        <div className="mt-1 flex flex-wrap gap-4 text-xs text-gray-500">
          <button
            onClick={() => {
              setText(String(capacity));
              setEditing(true);
            }}
            className="underline"
          >
            この日の定員を変える
          </button>
          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await onToggleWeb(!webStopped);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setSaving(false);
              }
            }}
            className="underline"
          >
            {webStopped ? "Web受付を再開する" : "Web受付を止める"}
          </button>
          {error && <span className="text-red-600">{error}</span>}
        </div>
      )}
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2 text-sm">
          <span>この日の定員</span>
          <input
            inputMode="numeric"
            value={text}
            onChange={(e) => setText(e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, ""))}
            className="w-20 rounded-lg border px-2 py-1 text-right text-base"
          />
          <span>人</span>
          <button
            disabled={saving || text === "" || Number(text) > 1000}
            onClick={() => save(Number(text))}
            className="rounded-lg bg-berry px-3 py-1 font-bold text-white disabled:opacity-50"
          >
            保存
          </button>
          {changed && (
            <button disabled={saving} onClick={() => save(null)} className="rounded-lg border px-3 py-1">
              標準（{standard}人）に戻す
            </button>
          )}
          <button disabled={saving} onClick={() => setEditing(false)} className="rounded-lg border px-3 py-1">
            やめる
          </button>
          <span className="w-full text-xs text-gray-500">0人にすると、この日のこの時間はWeb予約を受け付けません（リクエストのみ）。</span>
          {error && <span className="w-full text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}

function ReservationRow({ r, phone, onEdit }: { r: Reservation; phone?: string; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function changeStatus(status: "visited" | "confirmed", force = false): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await callFunction("setReservationStatus", { id: r.id, status, force });
    } catch (e) {
      if (e instanceof FirebaseError && e.code === "functions/resource-exhausted" && !force) {
        if (window.confirm(`${cleanMessage(e.message)}\nそれでも承認しますか？`)) return changeStatus(status, true);
      } else {
        setError(errorText(e));
      }
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
          {r.status === "request" ? (
            <button
              onClick={() => changeStatus("confirmed")}
              disabled={busy}
              className="rounded-lg bg-purple-700 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy ? "…" : "承認"}
            </button>
          ) : (
            !cancelled &&
            r.status !== "visited" && (
              <button
                onClick={() => changeStatus("visited")}
                disabled={busy}
                className="rounded-lg bg-leaf px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50"
              >
                {busy ? "…" : "来店"}
              </button>
            )
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
