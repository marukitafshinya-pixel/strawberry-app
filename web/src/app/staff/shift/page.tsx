"use client";

// 勤務管理表（管理者は入力、スタッフは見るだけ）
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import { downloadCsv } from "@/lib/report";
import {
  decideRequest,
  isWorking,
  renameMemberGroup,
  saveMember,
  saveShiftConfig,
  setShiftCell,
  setShiftNote,
  useReservedPeople,
  useShiftConfig,
  useShiftDays,
  useGrowingSpan,
  useShiftMembers,
  useShiftRequests,
  type ShiftCode,
  type ShiftConfig,
  type ShiftMember,
  type ShiftRequest,
} from "@/lib/shift";
import { ShiftImport } from "./ShiftImport";
import { ShiftTable, sortMembers } from "./ShiftTable";


export default function ShiftPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <ShiftView />
    </Suspense>
  );
}

type Tab = "table" | "requests" | "members" | "settings";

function ShiftView() {
  const { role, user } = useAuth();
  const isAdmin = role === "admin";
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("from");
  // 選んだ日（最初は今日）を先頭に表示する
  const from = isValidYmd(q) ? q : todayJST();
  const tabQ = params.get("tab") as Tab | null;
  const tab: Tab = isAdmin && tabQ && ["requests", "members", "settings"].includes(tabQ) ? tabQ : "table";
  const go = (f: string, t: Tab = tab) => router.replace(`/staff/shift/?from=${f}${t !== "table" ? `&tab=${t}` : ""}`);

  const cfg = useShiftConfig();
  const members = useShiftMembers();
  const [span, more] = useGrowingSpan(from);
  /** 「今日」を押したら、今日を先頭にして表を左端に戻す */
  const [reset, setReset] = useState(0);
  const to = addDays(from, span - 1);
  const days = useShiftDays(from, to);
  const reserved = useReservedPeople(from, to);
  const requests = useShiftRequests();
  /** 記号を選んでいるマス（押したマスの位置に、記号のリストを出す） */
  const [picking, setPicking] = useState<{ date: string; memberId: string; rect: DOMRect } | null>(null);
  const [error, setError] = useState("");

  const active = (members ?? []).filter((m) => m.active);

  // まとまり「その他」を「女性」に変えた（一度だけ。設定と従業員の両方を付け替える）
  const migrated = useRef(false);
  useEffect(() => {
    if (!isAdmin || !cfg || !members || migrated.current) return;
    const OLD = "その他";
    const NEW = "女性";
    if (cfg.groups.includes(OLD) && !cfg.groups.includes(NEW)) {
      migrated.current = true;
      saveShiftConfig({ ...cfg, groups: cfg.groups.map((g) => (g === OLD ? NEW : g)) })
        .then(() => renameMemberGroup(members, OLD, NEW))
        .catch((e) => setError(errorText(e)));
    } else if (cfg.groups.includes(NEW) && !cfg.groups.includes(OLD) && members.some((m) => m.group === OLD)) {
      migrated.current = true;
      renameMemberGroup(members, OLD, NEW).catch((e) => setError(errorText(e)));
    }
  }, [isAdmin, cfg, members]);

  /** 勤務表のマスで決める希望 */
  const [deciding, setDeciding] = useState<ShiftRequest | null>(null);
  const [decidingBusy, setDecidingBusy] = useState(false);
  async function decideHere(ok: boolean) {
    if (!deciding) return;
    setDecidingBusy(true);
    setError("");
    try {
      await decideRequest(deciding, ok, user?.uid ?? "");
      setDeciding(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDecidingBusy(false);
    }
  }
  function tapCell(date: string, memberId: string, rect: DOMRect) {
    if (!isAdmin) return;
    setPicking({ date, memberId, rect });
  }
  async function pickCode(code: string) {
    if (!picking) return;
    const { date, memberId } = picking;
    setPicking(null);
    setError("");
    try {
      await setShiftCell(date, memberId, code);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function editNote(date: string) {
    if (!isAdmin) return;
    const v = window.prompt(`${formatJa(date)}の予定`, days?.[date]?.note ?? "");
    if (v === null) return;
    try {
      await setShiftNote(date, v);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function exportCsv() {
    if (!cfg || !days) return;
    const dates = Array.from({ length: span }, (_, i) => addDays(from, i));
    const sorted = sortMembers(active, cfg);
    downloadCsv(`kinmu_${from}_${to}.csv`, [
      ["日付", ...dates.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`)],
      ["いちご狩り予約数", ...dates.map((d) => reserved?.[d] ?? "")],
      ["予定", ...dates.map((d) => days[d]?.note ?? "")],
      ...sorted.map((m) => [m.name, ...dates.map((d) => days[d]?.cells[m.id] ?? "")]),
      ["売り場対応人数", ...dates.map((d) => sorted.filter((m) => m.floor && isWorking(cfg, days[d]?.cells[m.id])).length)],
      ["収穫人数", ...dates.map((d) => sorted.filter((m) => m.harvest && isWorking(cfg, days[d]?.cells[m.id])).length)],
      ["出勤人数", ...dates.map((d) => sorted.filter((m) => isWorking(cfg, days[d]?.cells[m.id])).length)],
    ]);
  }

  const pending = requests ?? [];
  return (
    <>
      <p className="text-sm print:hidden">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">勤務管理表</h1>

      {isAdmin && (
        <div className="mt-3 flex flex-wrap gap-1 border-b print:hidden">
          {(
            [
              ["table", "勤務表"],
              ["requests", `休みの希望${pending.length ? `（${pending.length}件）` : ""}`],
              ["members", "従業員リスト"],
              ["settings", "設定"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} onClick={() => go(from, t)} className={`-mb-px rounded-t-lg border px-4 py-2 text-sm ${tab === t ? "border-b-white bg-white font-bold" : "bg-gray-50 text-gray-600"}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {!cfg || !members ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : tab === "requests" ? (
        <Requests cfg={cfg} members={members} requests={pending} by={user?.uid ?? ""} />
      ) : tab === "members" ? (
        <Members cfg={cfg} members={members} />
      ) : tab === "settings" ? (
        <Settings cfg={cfg} members={members ?? []} />
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
            <button onClick={() => go(addDays(from, -14))} className="rounded-lg border bg-white px-3 py-2 text-sm">
              ‹ 2週前
            </button>
            <input type="date" value={from} onChange={(e) => isValidYmd(e.target.value) && go(e.target.value)} className="rounded-lg border px-2 py-1.5 text-sm" />
            <span className="text-sm text-gray-600">から表示（右へ動かすと先の日も出ます）</span>
            <button onClick={() => go(addDays(from, 14))} className="rounded-lg border bg-white px-3 py-2 text-sm">
              2週後 ›
            </button>
            <button
              onClick={() => {
                go(todayJST());
                setReset(reset + 1);
              }}
              className="rounded-lg border bg-white px-3 py-2 text-sm">
              今日
            </button>
            <span className="flex-1" />
            {isAdmin && <ShiftImport cfg={cfg} members={members} />}
            <button onClick={exportCsv} className="text-sm text-gray-600 underline">
              CSVで書き出す
            </button>
            <button onClick={() => window.print()} className="text-sm text-gray-600 underline">
              印刷
            </button>
          </div>
          {isAdmin && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50 p-2 text-sm print:hidden">
              <span className="mr-1 text-sky-900">マスを押すと、この記号のリストから選べます：</span>
              {cfg.codes.map((c) => (
                <span key={c.code} className="rounded border bg-white px-2 py-0.5">
                  {c.code}
                </span>
              ))}
              <button onClick={() => go(from, "settings")} className="ml-1 text-xs text-sky-800 underline">
                記号のリストを作る・変える（設定）
              </button>
            </div>
          )}
          {pending.length > 0 && isAdmin && (
            <p className="mt-2 text-sm text-purple-800 print:hidden">
              紫の点線は、まだ決まっていない休みの希望です。マスを押すと、その場で承認・却下できます。
              <button onClick={() => go(from, "requests")} className="ml-1 font-bold underline">
                希望の一覧で決める（{pending.length}件）
              </button>
            </p>
          )}
          <div className="mt-3">
            {active.length === 0 ? (
              <p className="rounded-xl bg-white p-4 text-gray-600">
                まだ従業員が登録されていません。{isAdmin ? "「従業員リスト」で登録するか、Excelから取り込んでください。" : "管理者に登録してもらってください。"}
              </p>
            ) : !days ? (
              <p className="text-gray-500">読み込み中…</p>
            ) : (
              <ShiftTable
                from={from}
                span={span}
                onMore={more}
                resetKey={reset}
                cfg={cfg}
                members={active}
                days={days}
                reserved={reserved}
                requests={isAdmin ? pending : undefined}
                onCell={isAdmin ? tapCell : undefined}
                onNote={isAdmin ? editNote : undefined}
                onRequest={isAdmin ? setDeciding : undefined}
              />
            )}
          </div>
          {picking && (
            <CodePicker
              rect={picking.rect}
              title={`${members?.find((m) => m.id === picking.memberId)?.name ?? ""}さん・${formatJa(picking.date)}`}
              codes={cfg.codes.map((c) => c.code)}
              current={days?.[picking.date]?.cells[picking.memberId] ?? ""}
              onPick={pickCode}
              onClose={() => setPicking(null)}
            />
          )}
          {deciding && (
            <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center print:hidden" onClick={() => !decidingBusy && setDeciding(null)}>
              <div onClick={(e) => e.stopPropagation()} className="w-full rounded-t-2xl bg-white p-5 sm:max-w-sm sm:rounded-2xl">
                <p className="text-sm text-gray-500">休みの希望</p>
                <p className="mt-1 text-lg font-bold">
                  {members?.find((m) => m.id === deciding.memberId)?.name ?? "（名前なし）"}さん・{formatJa(deciding.date, true)}
                </p>
                <p className="mt-2">
                  希望：<b className="text-purple-800">{deciding.code}</b>
                </p>
                {deciding.memo && <p className="mt-1 text-sm text-gray-600">メモ：{deciding.memo}</p>}
                {days?.[deciding.date]?.cells[deciding.memberId] && (
                  <p className="mt-1 text-xs text-amber-700">いまのマス：{days[deciding.date].cells[deciding.memberId]}（承認すると「{deciding.code}」に変わります）</p>
                )}
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button onClick={() => decideHere(true)} disabled={decidingBusy} className="rounded-lg bg-emerald-700 py-3 font-bold text-white disabled:opacity-50">
                    承認
                  </button>
                  <button onClick={() => decideHere(false)} disabled={decidingBusy} className="rounded-lg border border-red-300 py-3 font-bold text-red-700 disabled:opacity-50">
                    却下
                  </button>
                </div>
                <button onClick={() => setDeciding(null)} disabled={decidingBusy} className="mt-2 w-full py-2 text-sm text-gray-500">
                  あとで決める
                </button>
              </div>
            </div>
          )}
          <style>{`@media print { @page { size: A4 landscape; margin: 6mm; } body { background: #fff !important; } }`}</style>
        </>
      )}
    </>
  );
}

/** 押したマスのすぐ下（下に入らなければ上）に出す、記号のリスト */
function CodePicker({ rect, title, codes, current, onPick, onClose }: { rect: DOMRect; title: string; codes: string[]; current: string; onPick: (code: string) => void; onClose: () => void }) {
  const W = 176;
  const H = Math.min(44 * (codes.length + 1) + 40, 360);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8));
  const below = rect.bottom + H + 8 <= window.innerHeight;
  const top = below ? rect.bottom + 2 : Math.max(8, rect.top - H - 2);
  return (
    <div className="fixed inset-0 z-30 print:hidden" onClick={onClose}>
      <div
        role="listbox"
        aria-label="記号を選ぶ"
        onClick={(e) => e.stopPropagation()}
        style={{ left, top, width: W, maxHeight: H }}
        className="fixed flex flex-col overflow-hidden rounded-xl border bg-white shadow-xl"
      >
        <p className="border-b px-3 py-1.5 text-xs text-gray-500">{title}</p>
        <div className="overflow-y-auto">
          {codes.map((c) => (
            <button
              key={c}
              role="option"
              aria-selected={c === current}
              onClick={() => onPick(c)}
              className={`block w-full px-3 py-2 text-left text-base ${c === current ? "bg-sky-100 font-bold" : "hover:bg-gray-100"}`}
            >
              {c}
            </button>
          ))}
          <button onClick={() => onPick("")} disabled={!current} className="block w-full border-t px-3 py-2 text-left text-base text-red-700 hover:bg-red-50 disabled:text-gray-300">
            空にする
          </button>
        </div>
      </div>
    </div>
  );
}

/** まだ決まっていない休みの希望 */
function Requests({ cfg, members, requests, by }: { cfg: ShiftConfig; members: ShiftMember[]; requests: ShiftRequest[]; by: string }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "（削除された人）";
  async function decide(r: (typeof requests)[number], ok: boolean) {
    setBusy(r.id);
    setError("");
    try {
      await decideRequest(r, ok, by);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  if (requests.length === 0) return <p className="mt-4 rounded-xl bg-white p-4 text-gray-600">まだ決まっていない休みの希望はありません。</p>;
  return (
    <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
      <p className="text-sm text-gray-600">「承認」を押すと、勤務表のその日のマスに希望の記号が入ります。「却下」はマスを変えません（本人の画面に「却下」と出ます）。</p>
      <ul className="mt-2 divide-y">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-semibold">{name(r.memberId)}</span>
            <span>{formatJa(r.date)}</span>
            <span className={`rounded px-2 py-0.5 text-sm font-bold ${cfg.codes.find((c) => c.code === r.code)?.off ? "bg-pink-100 text-pink-900" : "bg-sky-100 text-sky-900"}`}>{r.code}</span>
            {r.memo && <span className="text-sm text-gray-600">「{r.memo}」</span>}
            <span className="ml-auto flex gap-2">
              <button disabled={!!busy} onClick={() => decide(r, true)} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">
                承認
              </button>
              <button disabled={!!busy} onClick={() => decide(r, false)} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50">
                却下
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}

/** 従業員リスト（まとまり・売り場対応可・収穫可・並び順・ログイン） */
function Members({ cfg, members }: { cfg: ShiftConfig; members: ShiftMember[] }) {
  const sorted = sortMembers(members, cfg);
  const [name, setName] = useState("");
  const [group, setGroup] = useState(cfg.groups[0] ?? "");
  const [error, setError] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const nextOrder = () => (members.length ? Math.max(...members.map((m) => m.order)) + 1 : 0);

  async function add() {
    if (!name.trim()) return;
    setError("");
    try {
      await saveMember({ name, group, floor: group === "売り場担当可", order: nextOrder(), active: true });
      setName("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function patch(m: ShiftMember, p: Partial<ShiftMember>) {
    setError("");
    try {
      await saveMember({ ...m, ...p });
    } catch (e) {
      setError(errorText(e));
    }
  }
  /** 同じまとまりの中で、上か下の人と入れ替える */
  async function move(m: ShiftMember, delta: number) {
    const list = sorted.filter((x) => x.group === m.group);
    const i = list.findIndex((x) => x.id === m.id);
    const other = list[i + delta];
    if (!other) return;
    await patch(m, { order: other.order });
    await patch(other, { order: m.order });
  }

  const shown = sorted.filter((m) => showInactive || m.active);
  return (
    <section className="mt-4 space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">従業員を追加</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="名前" className="rounded-lg border px-3 py-2 text-base" />
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-lg border px-2 py-2 text-base">
            {cfg.groups.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
          <button onClick={add} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
            追加
          </button>
          <ShiftImport cfg={cfg} members={members} />
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">従業員リスト</h2>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            表に出さない人も表示
          </label>
        </div>
        <table className="mt-2 w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-1">並び</th>
              <th className="py-1">名前</th>
              <th className="py-1">まとまり</th>
              <th className="py-1">売り場対応可</th>
              <th className="py-1">収穫可</th>
              <th className="py-1">表に出す</th>
              <th className="py-1">ログイン（スマホで見る）</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} className={`border-b ${m.active ? "" : "text-gray-400"}`}>
                <td className="whitespace-nowrap py-1">
                  <button onClick={() => move(m, -1)} className="rounded border px-1.5" aria-label="上へ">
                    ↑
                  </button>
                  <button onClick={() => move(m, 1)} className="ml-1 rounded border px-1.5" aria-label="下へ">
                    ↓
                  </button>
                </td>
                <td className="py-1">
                  <input defaultValue={m.name} maxLength={30} onBlur={(e) => e.target.value.trim() && e.target.value !== m.name && patch(m, { name: e.target.value })} className="w-36 rounded border px-2 py-1" />
                </td>
                <td className="py-1">
                  <select value={m.group} onChange={(e) => patch(m, { group: e.target.value })} className="rounded border px-1 py-1">
                    {[...new Set([...cfg.groups, m.group])].map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                </td>
                <td className="py-1 text-center">
                  <input type="checkbox" checked={m.floor} aria-label="売り場対応可" onChange={(e) => patch(m, { floor: e.target.checked })} className="h-5 w-5" />
                </td>
                <td className="py-1 text-center">
                  <input type="checkbox" checked={m.harvest === true} aria-label="収穫可" onChange={(e) => patch(m, { harvest: e.target.checked })} className="h-5 w-5" />
                </td>
                <td className="py-1 text-center">
                  <input type="checkbox" checked={m.active} onChange={(e) => patch(m, { active: e.target.checked })} className="h-5 w-5" />
                </td>
                <td className="py-1">
                  <LoginCell m={m} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">
          辞めた人は「表に出す」を外してください（これまでの勤務は残ります）。ログインIDは、半角の英字・数字で作ります（例：tanaka）。従業員の方は、スタッフ用のページ（{typeof window !== "undefined" ? window.location.origin : ""}/staff/）で、ログインIDとパスワードを入れてログインします。
        </p>
      </div>
    </section>
  );
}

function LoginCell({ m }: { m: ShiftMember }) {
  const [open, setOpen] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      setMsg(done);
      setOpen(false);
      setPassword("");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!m.loginId && !open)
    return (
      <button onClick={() => setOpen(true)} className="rounded border px-2 py-1 text-xs">
        ログインを作る
      </button>
    );
  return (
    <div className="text-xs">
      {m.loginId && (
        <span>
          ID：<b className="font-mono">{m.loginId}</b>
          {!open && (
            <button onClick={() => setOpen(true)} className="ml-2 underline">
              パスワードを変える
            </button>
          )}
        </span>
      )}
      {open && (
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {!m.loginId && <input value={loginId} onChange={(e) => setLoginId(e.target.value.toLowerCase())} placeholder="ログインID" className="w-24 rounded border px-1 py-1 font-mono" />}
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="パスワード（8文字以上）" className="w-36 rounded border px-1 py-1" />
          <button
            disabled={busy}
            onClick={() =>
              m.loginId
                ? run(() => callFunction("updateWorkerLogin", { memberId: m.id, password }), "パスワードを変えました")
                : run(() => callFunction("createWorkerLogin", { memberId: m.id, loginId, password }), "ログインを作りました")
            }
            className="rounded bg-berry px-2 py-1 font-bold text-white disabled:opacity-50"
          >
            {m.loginId ? "変える" : "作る"}
          </button>
          <button onClick={() => setOpen(false)} className="underline">
            やめる
          </button>
        </span>
      )}
      {msg && <span className="block text-gray-600">{msg}</span>}
    </div>
  );
}

/** 記号・まとまり・希望の締め切り */
function Settings({ cfg, members }: { cfg: ShiftConfig; members: ShiftMember[] }) {
  const [codes, setCodes] = useState<ShiftCode[]>(cfg.codes);
  const [groups, setGroups] = useState(cfg.groups.join("\n"));
  const [cutoff, setCutoff] = useState(String(cfg.cutoffDays));
  const [msg, setMsg] = useState("");
  const newCode = useRef<HTMLInputElement>(null);
  async function save() {
    setMsg("");
    try {
      const g = groups
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const next = g.length ? g : cfg.groups;
      await saveShiftConfig({ codes: codes.filter((c) => c.code.trim()), groups: next, cutoffDays: Math.max(0, Math.min(60, Number(cutoff) || 7)) });
      // 同じ行のまとまりの名前を変えたら、その従業員も新しい名前にする
      if (next.length === cfg.groups.length)
        for (let i = 0; i < next.length; i++) if (next[i] !== cfg.groups[i] && !next.includes(cfg.groups[i])) await renameMemberGroup(members, cfg.groups[i], next[i]);
      setMsg("保存しました");
    } catch (e) {
      setMsg(errorText(e));
    }
  }
  const set = (i: number, p: Partial<ShiftCode>) => setCodes(codes.map((c, j) => (j === i ? { ...c, ...p } : c)));
  return (
    <section className="mt-4 space-y-4 rounded-2xl bg-white p-4 text-sm shadow-sm">
      <div>
        <h2 className="font-bold">勤務の記号</h2>
        <table className="mt-2 text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="pr-3">記号</th>
              <th className="pr-3">休みとして数える</th>
              <th className="pr-3">従業員が希望で出せる</th>
              <th className="pr-3">色</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {codes.map((c, i) => (
              <tr key={i}>
                <td className="py-1 pr-3">
                  <input value={c.code} maxLength={10} onChange={(e) => set(i, { code: e.target.value })} className="w-24 rounded border px-2 py-1" />
                </td>
                <td className="py-1 pr-3 text-center">
                  <input type="checkbox" checked={c.off} onChange={(e) => set(i, { off: e.target.checked })} className="h-5 w-5" />
                </td>
                <td className="py-1 pr-3 text-center">
                  <input type="checkbox" checked={c.req} onChange={(e) => set(i, { req: e.target.checked })} className="h-5 w-5" />
                </td>
                <td className="py-1 pr-3">
                  <select value={c.color} onChange={(e) => set(i, { color: e.target.value })} className="rounded border px-1 py-1">
                    {[
                      ["none", "なし"],
                      ["pink", "ピンク"],
                      ["gray", "灰色"],
                      ["yellow", "黄色"],
                      ["blue", "水色"],
                      ["green", "緑"],
                    ].map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1">
                  <button onClick={() => setCodes(codes.filter((_, j) => j !== i))} className="text-xs text-red-700 underline">
                    消す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex gap-2">
          <input ref={newCode} maxLength={10} placeholder="新しい記号（例：～17:00）" className="rounded border px-2 py-1" />
          <button
            onClick={() => {
              const v = newCode.current?.value.trim();
              if (v && !codes.some((c) => c.code === v)) setCodes([...codes, { code: v, off: false, req: true, color: "blue" }]);
              if (newCode.current) newCode.current.value = "";
            }}
            className="rounded border px-3 py-1"
          >
            追加
          </button>
        </div>
      </div>
      <div>
        <h2 className="font-bold">まとまり（表の並び順。1行に1つ）</h2>
        <p className="text-xs text-gray-500">名前を書き換えて保存すると、そのまとまりの従業員もまとめて新しい名前になります。</p>
        <textarea value={groups} onChange={(e) => setGroups(e.target.value)} rows={4} className="mt-1 w-64 rounded border px-2 py-1" />
      </div>
      <div>
        <h2 className="font-bold">休みの希望の締め切り</h2>
        <label className="mt-1 flex items-center gap-2">
          その日の
          <input inputMode="numeric" value={cutoff} onChange={(e) => setCutoff(e.target.value.replace(/\D/g, ""))} className="w-16 rounded border px-2 py-1 text-right" />
          日前まで出せる
        </label>
      </div>
      <button onClick={save} className="rounded-lg bg-berry px-5 py-2 font-bold text-white">
        保存する
      </button>
      {msg && <span className="ml-3 text-gray-600">{msg}</span>}
    </section>
  );
}
