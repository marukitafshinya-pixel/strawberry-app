"use client";

// 従業員の画面：自分の勤務・休みの希望・全員の勤務表（見るだけ）
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import { codeColor, useGrowingSpan, useReservedPeople, useShiftConfig, useShiftDays, useShiftMembers, useShiftRequests, type ShiftRequest } from "@/lib/shift";
import { ShiftTable } from "../ShiftTable";

const STATUS: Record<ShiftRequest["status"], { label: string; cls: string }> = {
  pending: { label: "確認待ち", cls: "bg-amber-100 text-amber-900" },
  approved: { label: "承認", cls: "bg-emerald-100 text-emerald-900" },
  rejected: { label: "却下", cls: "bg-gray-200 text-gray-700" },
};

export default function MyShiftPage() {
  const { user, role } = useAuth();
  const cfg = useShiftConfig();
  const members = useShiftMembers();
  const me = members?.find((m) => m.uid === user?.uid);
  const today = todayJST();
  const [from, setFrom] = useState(today);
  const [span, more] = useGrowingSpan(from);
  const [reset, setReset] = useState(0);
  const days = useShiftDays(from, addDays(from, span - 1));
  const mine = useShiftDays(today, addDays(today, 13));
  const reserved = useReservedPeople(from, addDays(from, span - 1));
  const requests = useShiftRequests(user?.uid);

  if (!cfg || !members) return <p className="text-gray-500">読み込み中…</p>;
  if (!me)
    return (
      <p className="rounded-xl bg-white p-4 text-gray-700">
        {role === "worker" ? "勤務の表に、あなたの名前がつながっていません。管理者に確認してください。" : "この画面は、従業員のログインで使います。"}
      </p>
    );
  const active = members.filter((m) => m.active);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">{me.name} さんの勤務</h1>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">これから2週間</h2>
        {!mine ? (
          <p className="mt-2 text-gray-500">読み込み中…</p>
        ) : (
          <ul className="mt-2 divide-y">
            {Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((d) => {
              const code = mine[d]?.cells[me.id];
              return (
                <li key={d} className="flex items-center gap-3 py-1.5">
                  <span className={`w-32 whitespace-nowrap ${d === today ? "font-bold" : ""}`}>{formatJa(d)}</span>
                  <span className={`min-w-[4rem] rounded px-2 py-0.5 text-center font-bold ${code ? codeColor(cfg, code) || "bg-gray-50" : "text-gray-300"}`}>{code ?? "－"}</span>
                  {mine[d]?.note && <span className="text-xs text-gray-600">{mine[d].note}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <RequestForm cutoffDays={cfg.cutoffDays} codes={cfg.codes.filter((c) => c.req).map((c) => c.code)} />

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">出した希望</h2>
        {!requests ? (
          <p className="mt-2 text-gray-500">読み込み中…</p>
        ) : requests.filter((r) => r.date >= today).length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">まだありません。</p>
        ) : (
          <ul className="mt-2 divide-y">
            {requests
              .filter((r) => r.date >= today)
              .map((r) => (
                <MyRequest key={r.id} r={r} />
              ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">みんなの勤務表</h2>
          <span className="flex-1" />
          <button onClick={() => setFrom(addDays(from, -7))} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            ‹ 前の週
          </button>
          <button
            onClick={() => {
              setFrom(today);
              setReset(reset + 1);
            }}
            className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            今日
          </button>
          <button onClick={() => setFrom(addDays(from, 7))} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            次の週 ›
          </button>
        </div>
        <p className="text-xs text-gray-500">表は横に動かせます。緑の行があなたです。</p>
        <div className="mt-2">{days ? <ShiftTable compact from={from} span={span} onMore={more} resetKey={reset} cfg={cfg} members={active} days={days} reserved={reserved} myMemberId={me.id} /> : <p className="text-gray-500">読み込み中…</p>}</div>
      </section>
    </div>
  );
}

function RequestForm({ cutoffDays, codes }: { cutoffDays: number; codes: string[] }) {
  const first = addDays(todayJST(), cutoffDays);
  const [date, setDate] = useState(first);
  const [code, setCode] = useState(codes[0] ?? "");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function send() {
    setMsg(null);
    if (!isValidYmd(date) || date < first) return setMsg({ ok: false, text: `希望は${cutoffDays}日前までです。${formatJa(first)}から選べます` });
    setBusy(true);
    try {
      await callFunction("submitShiftRequest", { date, code, memo });
      setMsg({ ok: true, text: `${formatJa(date)}「${code}」の希望を出しました` });
      setMemo("");
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-2xl border-2 border-berry/30 bg-white p-4 shadow-sm">
      <h2 className="font-bold">休みの希望を出す</h2>
      <p className="text-xs text-gray-500">その日の{cutoffDays}日前まで出せます。時間だけの希望（午前だけ・14時まで など）も選べます。</p>
      <div className="mt-2 space-y-2">
        <label className="block">
          <span className="text-sm text-gray-600">日にち</span>
          <input type="date" min={first} value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
        </label>
        <div>
          <span className="text-sm text-gray-600">希望</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {codes.map((c) => (
              <button key={c} onClick={() => setCode(c)} className={`rounded-lg border px-3 py-2 font-bold ${code === c ? "border-berry bg-berry text-white" : "bg-white"}`}>
                {c === "AM" ? "AM（午前だけ）" : c === "PM" ? "PM（午後だけ）" : c}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="text-sm text-gray-600">ひとこと（任意）</span>
          <input value={memo} maxLength={100} onChange={(e) => setMemo(e.target.value)} placeholder="例：通院のため" className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
        </label>
        <button disabled={busy || !code} onClick={send} className="w-full rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50">
          {busy ? "送っています…" : "希望を出す"}
        </button>
        {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>}
      </div>
    </section>
  );
}

function MyRequest({ r }: { r: ShiftRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = STATUS[r.status];
  async function cancel() {
    if (!window.confirm(`${formatJa(r.date)}の希望を取り消しますか？`)) return;
    setBusy(true);
    try {
      await callFunction("cancelShiftRequest", { id: r.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="w-32 whitespace-nowrap">{formatJa(r.date)}</span>
      <span className="font-bold">{r.code}</span>
      <span className={`rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>
      {r.memo && <span className="text-xs text-gray-500">{r.memo}</span>}
      {r.status === "pending" && (
        <button disabled={busy} onClick={cancel} className="ml-auto rounded border px-2 py-1 text-xs disabled:opacity-50">
          取り消す
        </button>
      )}
      {error && <span className="w-full text-xs text-red-600">{error}</span>}
    </li>
  );
}
