"use client";

// 個別の連絡（収穫管理。管理者・集荷係）：今日出勤している従業員から相手を選び、言葉を選ぶか打って送る。
// 相手の携帯（収穫報告・勤務の画面）で、効果音と声で読み上げ、画面いっぱいに出す。
// 相手のアプリが開いていなければ、送った人に「アプリが開いていません」と出す（連絡は残り、相手が開いたときに出る）
import { useEffect, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { PRESENCE_MS, sendMessages, useMessages, usePresenceAll } from "@/lib/harvestTap";
import { isWorking, useShiftConfig, useShiftDays, type ShiftMember } from "@/lib/shift";

/** よく使う言葉（押すとコメント欄に入る。入れたあと直せる） */
const PRESETS = ["集荷場に来てください", "事務所に来てください", "電話に出てください", "休憩に入ってください"];
const hm = (ms: number | null) => (ms == null ? "" : new Date(ms + 9 * 3600e3).toISOString().slice(11, 16));

export function MessageButton({ date, members }: { date: string; members: ShiftMember[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border-2 border-sky-600 bg-sky-50 px-3 py-1.5 text-sm font-bold whitespace-nowrap text-sky-800"
      >
        📣 個別に連絡
      </button>
      {open && <MessageDialog date={date} members={members} onClose={() => setOpen(false)} />}
    </>
  );
}

function MessageDialog({ date, members, onClose }: { date: string; members: ShiftMember[]; onClose: () => void }) {
  const days = useShiftDays(date, date);
  const cfg = useShiftConfig();
  const presence = usePresenceAll(date);
  const sent = useMessages(date, null);
  const [pick, setPick] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // 開いているかの表示を、10秒ごとに見直す
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "（いない人）";
  const isOpen = (m: ShiftMember) => (presence?.[m.id] ?? 0) > now - PRESENCE_MS;
  // 今日出勤している人（勤務管理表で、休みでない記号が入っている人）
  const cells = days?.[date]?.cells ?? {};
  const working = cfg ? members.filter((m) => m.active && isWorking(cfg, cells[m.id])).sort((a, b) => a.order - b.order) : [];

  async function send() {
    const body = text.trim();
    if (!pick.length || !body) return;
    setBusy(true);
    setResult(null);
    try {
      await sendMessages(date, pick, body);
      const closed = working.filter((m) => pick.includes(m.id) && (!m.uid || !isOpen(m)));
      setResult(
        closed.length
          ? { ok: false, text: `送りました。ただし ${closed.map((m) => `${m.name}さん`).join("・")} のアプリが開いていません（開いたときに出ます）` }
          : { ok: true, text: "送りました。相手の携帯で読み上げています" },
      );
      setPick([]);
      setText("");
    } catch (e) {
      setResult({ ok: false, text: `送れませんでした：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">📣 個別に連絡</h2>
          <button onClick={onClose} className="rounded-lg border bg-white px-3 py-1.5 font-bold">
            ✕ 閉じる
          </button>
        </div>

        <p className="mt-3 text-sm font-bold text-gray-700">送る相手（今日出勤している人）</p>
        {!days || !cfg ? (
          <p className="mt-1 text-sm text-gray-500">読み込み中…</p>
        ) : working.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">今日の勤務管理表に、出勤の人が入っていません。</p>
        ) : (
          <ul className="mt-1 grid grid-cols-2 gap-1.5">
            {working.map((m) => {
              const on = pick.includes(m.id);
              const status = !m.uid ? "ログインなし" : isOpen(m) ? "開いている" : "開いていない";
              return (
                <li key={m.id}>
                  <button
                    disabled={!m.uid}
                    onClick={() => setPick(on ? pick.filter((x) => x !== m.id) : [...pick, m.id])}
                    className={`w-full rounded-xl border-2 px-2 py-2 text-left disabled:opacity-40 ${on ? "border-sky-600 bg-sky-100" : "border-gray-200 bg-white"}`}
                  >
                    <span className="font-bold">
                      {on ? "☑ " : "☐ "}
                      {m.name}
                    </span>
                    <span className={`block text-xs ${status === "開いている" ? "text-emerald-700" : "text-gray-500"}`}>
                      {status === "開いている" ? "🟢 " : "⚪ "}
                      {status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 text-sm font-bold text-gray-700">メッセージ</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p} onClick={() => setText(p)} className="rounded-full border bg-gray-50 px-3 py-1 text-sm">
              {p}
            </button>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 200))}
          rows={3}
          placeholder="ここに打つか、上の言葉を押す"
          className="mt-2 w-full rounded-xl border-2 px-3 py-2 text-base"
        />
        <button
          disabled={busy || !pick.length || !text.trim()}
          onClick={send}
          className="mt-2 w-full rounded-xl bg-sky-600 py-3 text-lg font-bold text-white disabled:opacity-40"
        >
          {busy ? "送っています…" : pick.length ? `${pick.map(name).join("・")}さんに送る` : "相手を選んでください"}
        </button>
        {result && (
          <p className={`mt-2 rounded-lg p-2 text-sm font-bold ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
            {result.text}
          </p>
        )}

        {sent && sent.length > 0 && (
          <div className="mt-4 border-t pt-2">
            <p className="text-sm font-bold text-gray-700">今日送った連絡</p>
            <ul className="mt-1 space-y-1 text-sm">
              {[...sent].reverse().map((m) => (
                <li key={m.id} className="flex gap-2">
                  <span className="text-gray-500 tabular-nums">{hm(m.at)}</span>
                  <span className="font-bold whitespace-nowrap">{name(m.to)}</span>
                  <span className="flex-1">{m.text}</span>
                  <span className={`whitespace-nowrap ${m.ackAt ? "text-emerald-700" : "text-gray-400"}`}>
                    {m.ackAt ? `✓ 了解です ${hm(m.ackAt)}` : "返事まだ"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
