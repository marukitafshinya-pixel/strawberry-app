"use client";

// 従業員の画面の中身：自分の勤務・休みの希望・全員の勤務表（見るだけ）。
// 従業員が自分の携帯で見る画面と、管理者の「携帯画面」タブ（確認用・送信はしない）の両方で使う
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST, weekday } from "@/lib/date";
import { useHaichiDay } from "@/lib/haichi";
import { useAuth } from "@/lib/auth";
import { useTempWatchers } from "@/lib/govee";
import { codeColor, useGrowingSpan, useReservedPeople, useShiftDays, type ShiftConfig, type ShiftMember, type ShiftRequest } from "@/lib/shift";
import { ShiftTable } from "./ShiftTable";

/** 定時出勤の記号（〇。似た字の ○ も同じに扱う） */
const WORK_CODES = ["〇", "○"];
/** 締め切り（2週間前）がある休みの希望の記号 */
const REST_CODES = ["希休", "希望休"];

/** 希望のボタンの名前 */
const codeLabel = (c: string) => (c === "AM" ? "AM（午前だけ）" : c === "PM" ? "PM（午後だけ）" : WORK_CODES.includes(c) ? `定時出勤（${c}）` : c);

/**
 * 希望で出せる記号の並び。「希望で出せる」にした記号に加えて、定時出勤（〇）を希休のすぐ後ろに入れる
 * （〇は「希望で出せる」にしていなくても出せる）
 */
function requestCodes(cfg: ShiftConfig): string[] {
  const work = cfg.codes.find((c) => WORK_CODES.includes(c.code))?.code;
  const list = cfg.codes.filter((c) => c.req && c.code !== work).map((c) => c.code);
  if (!work) return list;
  const at = list.findIndex((c) => c === "希休" || c === "希望休");
  list.splice(at < 0 ? 0 : at + 1, 0, work);
  return list;
}

const STATUS: Record<ShiftRequest["status"], { label: string; cls: string }> = {
  pending: { label: "確認待ち", cls: "bg-amber-100 text-amber-900" },
  approved: { label: "承認", cls: "bg-emerald-100 text-emerald-900" },
  rejected: { label: "却下", cls: "bg-gray-200 text-gray-700" },
};

/** preview＝管理者の「携帯画面」タブ（選んだ従業員の分として、希望を出す・取り消すが本当にできる） */
export function WorkerScreen({
  cfg,
  members,
  me,
  requests,
  preview,
}: {
  cfg: ShiftConfig;
  members: ShiftMember[];
  me: ShiftMember;
  requests: ShiftRequest[] | null;
  preview?: boolean;
}) {
  const today = todayJST();
  const [from, setFrom] = useState(today);
  const [span, more] = useGrowingSpan(from);
  const [reset, setReset] = useState(0);
  const days = useShiftDays(from, addDays(from, span - 1));
  const mine = useShiftDays(today, addDays(today, 13));
  const reserved = useReservedPeople(from, addDays(from, span - 1));
  const active = members.filter((m) => m.active);
  const haichi = useHaichiDay(today);
  // 今日の作業配置表で「集荷係」に入っているか、「収穫管理 毎日使える」の人なら、収穫管理（＋1で数える画面）を開けるボタンを出す
  const harvest = me.harvestEntry === true || !!haichi?.cells.pickup?.members.includes(me.id);
  // 温度の見張り担当なら、見張り画面を開くボタンを出す
  const tw = useTempWatchers();
  const watcherNo = preview ? -1 : (tw?.watchers.indexOf(me.id) ?? -1);
  // 管理者（平山さん）本人なら、管理者のログインに切り替えるボタンを出す
  const isOwner = !preview && !!tw?.owner && tw.owner === me.id;
  const { logout } = useAuth();
  const router = useRouter();
  async function toAdmin() {
    await logout();
    router.replace("/staff/login/");
  }

  return (
    <div className="space-y-5">
      {harvest && (
        <Link href="/staff/harvest/" className="block rounded-2xl bg-berry p-4 text-center text-xl font-bold text-white shadow">
          🍓 収穫管理（今日の集荷）を開く
        </Link>
      )}
      {isOwner && (
        <button onClick={() => void toAdmin()} className="block w-full rounded-2xl border-2 border-gray-700 bg-white p-3 text-center font-bold text-gray-800">
          🔑 管理者のログインに切り替える
        </button>
      )}
      {(watcherNo >= 0 || isOwner) && (
        <Link href="/staff/harvest/watch/" className="block rounded-2xl bg-indigo-700 p-4 text-center text-xl font-bold text-white shadow">
          🌙 温度の見張りを開く{watcherNo >= 0 ? `（担当${"①②③"[watcherNo]}）` : ""}
        </Link>
      )}
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
                  <span className={`min-w-[4rem] rounded px-2 py-0.5 text-center font-bold ${code ? codeColor(cfg, code) || "bg-gray-50" : "text-gray-300"}`}>
                    {code ?? "－"}
                  </span>
                  {mine[d]?.note && <span className="text-xs text-gray-600">{mine[d].note}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <RequestForm
        key={cfg.cutoffDays}
        asMember={preview ? me.id : undefined}
        cutoffDays={cfg.cutoffDays}
        contact={cfg.contact || "管理者"}
        codes={requestCodes(cfg)}
        requests={requests}
      />

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
                <MyRequest key={r.id} r={r} asMember={preview ? me.id : undefined} />
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
            className="rounded-lg border bg-white px-3 py-1.5 text-sm"
          >
            今日
          </button>
          <button onClick={() => setFrom(addDays(from, 7))} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            次の週 ›
          </button>
        </div>
        <p className="text-xs text-gray-500">表は横に動かせます。緑の行があなたです。</p>
        <div className="mt-2">
          {days ? (
            <ShiftTable
              compact
              from={from}
              span={span}
              onMore={more}
              resetKey={reset}
              cfg={cfg}
              members={active}
              days={days}
              reserved={reserved}
              myMemberId={me.id}
            />
          ) : (
            <p className="text-gray-500">読み込み中…</p>
          )}
        </div>
      </section>
    </div>
  );
}

/** asMember＝管理者がその従業員の分として出すとき（携帯画面タブ） */
function RequestForm({
  cutoffDays,
  contact,
  codes,
  asMember,
  requests,
}: {
  cutoffDays: number;
  contact: string;
  codes: string[];
  asMember?: string;
  /** 出した希望（カレンダーのマスに印を出す） */
  requests: ShiftRequest[] | null;
}) {
  const restFirst = addDays(todayJST(), cutoffDays);
  /** 休みの希望（希休）だけ締め切り（2週間前）まで。そのほか（定時出勤・AM・PM・時間など）は明日から出せる */
  const workFirst = addDays(todayJST(), 1);
  const [date, setDate] = useState(restFirst);
  const [code, setCode] = useState(codes[0] ?? "");
  const isWork = !REST_CODES.includes(code);
  const first = isWork ? workFirst : restFirst;
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function send() {
    setMsg(null);
    if (!isValidYmd(date) || date < first)
      return setMsg(
        isWork
          ? { ok: false, text: `「${codeLabel(code)}」の希望は、明日（${formatJa(workFirst)}）から出せます` }
          : {
              ok: false,
              text: `休みの希望は${cutoffDays}日前までです。${formatJa(restFirst)}から選べます。それより前の日は、${contact}に直接確認してください`,
            },
      );
    setBusy(true);
    try {
      await callFunction("submitShiftRequest", { date, code, memo, ...(asMember ? { memberId: asMember } : {}) });
      setMsg({ ok: true, text: `${formatJa(date)}「${codeLabel(code)}」の希望を出しました` });
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
      <div className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
        <p>
          休みの希望は、その日の<b>{cutoffDays === 14 ? "2週間前" : `${cutoffDays}日前`}まで</b>に出してください（{formatJa(restFirst)}から出せます）。
          <span className="block">
            「希休」のほか（定時出勤・AM・PM・時間の希望）は、<b>明日から</b>出せます。
          </span>
        </p>
        <p className="mt-0.5">
          明日から{cutoffDays}日以内の日の休みの希望・変更は、<b>{contact}に直接確認</b>してください。
        </p>
        <p className="mt-0.5">
          休みは、基本<b>週2日まで</b>にしてください。
        </p>
        <p className="mt-0.5">
          希望日は、<b>用事がある日だけ</b>にしてください。
          <span className="block text-xs text-amber-800">＊週2日の休みを全部希望日として出されると、ほかの人の休みが入れられなくなります。</span>
        </p>
      </div>
      <p className="mt-1 text-xs text-gray-500">時間だけの希望（午前だけ・14時まで など）も選べます。</p>
      <div className="mt-2 space-y-2">
        <div>
          <span className="text-sm text-gray-600">希望</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {codes.map((c) => (
              <button
                key={c}
                onClick={() => setCode(c)}
                className={`rounded-lg border px-3 py-2 font-bold ${code === c ? "border-berry bg-berry text-white" : "bg-white"}`}
              >
                {codeLabel(c)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="text-sm text-gray-600">日にち</span>
          <BigCalendar
            value={date}
            first={first}
            marks={Object.fromEntries((requests ?? []).filter((r) => r.status !== "rejected").map((r) => [r.date, r.code]))}
            onPick={(d) => {
              setDate(d);
              setMsg(null);
            }}
          />
          <p className="mt-1 text-center text-lg font-bold">
            {isValidYmd(date) && date >= first ? `${formatJa(date)} を選んでいます` : <span className="text-red-600">日にちを選んでください</span>}
          </p>
        </div>
        <label className="block">
          <span className="text-sm text-gray-600">ひとこと（任意）</span>
          <input
            value={memo}
            maxLength={100}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="例：通院のため"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-base"
          />
        </label>
        <button disabled={busy || !code} onClick={send} className="w-full rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50">
          {busy ? "送っています…" : "希望を出す"}
        </button>
        {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>}
      </div>
    </section>
  );
}

function MyRequest({ r, asMember }: { r: ShiftRequest; asMember?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = STATUS[r.status];
  async function cancel() {
    if (!window.confirm(`${formatJa(r.date)}の希望を取り消しますか？`)) return;
    setBusy(true);
    try {
      await callFunction("cancelShiftRequest", { id: r.id, ...(asMember ? { memberId: asMember } : {}) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="w-32 whitespace-nowrap">{formatJa(r.date)}</span>
      <span className="font-bold">{codeLabel(r.code)}</span>
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

/** 指で押しやすい大きなカレンダー（1か月分）。first より前の日は選べない。marks はすでに出した希望の印 */
function BigCalendar({ value, first, marks, onPick }: { value: string; first: string; marks: Record<string, string>; onPick: (d: string) => void }) {
  const [month, setMonth] = useState((isValidYmd(value) && value >= first ? value : first).slice(0, 7));
  const thisMonth = todayJST().slice(0, 7);
  const start = `${month}-01`;
  const lead = "日月火水木金土".indexOf(weekday(start));
  const days: string[] = [];
  for (let d = start; d.startsWith(month); d = addDays(d, 1)) days.push(d);
  const cells: (string | null)[] = [...Array(lead).fill(null), ...days];
  const [y, m] = month.split("-").map(Number);
  const shift = (n: number) => setMonth(addDays(`${month}-15`, n * 30).slice(0, 7));
  return (
    <div className="mt-1 rounded-xl border bg-white p-2">
      <div className="flex items-center justify-between">
        <button onClick={() => shift(-1)} disabled={month <= thisMonth} className="rounded-lg border px-4 py-2 text-lg disabled:opacity-30" aria-label="前の月">
          ‹
        </button>
        <span className="text-lg font-bold">
          {y}年{m}月
        </span>
        <button onClick={() => shift(1)} className="rounded-lg border px-4 py-2 text-lg" aria-label="次の月">
          ›
        </button>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1 text-center">
        {"日月火水木金土".split("").map((w, i) => (
          <span key={w} className={`text-xs font-bold ${i === 0 ? "text-red-600" : i === 6 ? "text-blue-700" : "text-gray-500"}`}>
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const w = weekday(d);
          const ok = d >= first;
          const on = d === value;
          return (
            <button
              key={d}
              disabled={!ok}
              onClick={() => onPick(d)}
              className={`flex h-14 flex-col items-center justify-center rounded-lg border text-lg font-bold ${
                on ? "border-berry bg-berry text-white" : ok ? "bg-white active:bg-rose-50" : "border-transparent bg-gray-100 text-gray-300"
              } ${!on && ok ? (w === "日" ? "text-red-600" : w === "土" ? "text-blue-700" : "") : ""}`}
              aria-label={`${formatJa(d)}${marks[d] ? `（${marks[d]}を出しています）` : ""}`}
            >
              {Number(d.slice(8))}
              {marks[d] && <span className={`text-[10px] leading-none font-normal ${on ? "text-white" : "text-amber-700"}`}>{marks[d]}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
