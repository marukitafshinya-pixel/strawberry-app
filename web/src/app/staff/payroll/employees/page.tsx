"use client";

import { deleteDoc, doc, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";
import { EMPLOYEE_KINDS, useEmployees, type Employee } from "@/lib/payroll";
import { newId } from "@/lib/settings";
import { RateFromPayroll } from "./RateFromPayroll";

const input = "mt-1 w-full rounded-lg border px-3 py-2 text-base";

const blank = (): Employee => ({
  id: newId(),
  code: "",
  name: "",
  payMethod: "transfer",
  bankName: "",
  branchName: "",
  accountType: "普通",
  accountNumber: "",
  active: true,
});

export default function EmployeesPage() {
  const { role } = useAuth();
  const { value: list, error } = useEmployees();
  const [editing, setEditing] = useState<Employee | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  const shown = (list ?? []).filter((e) => showInactive || e.active);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/payroll/" className="text-gray-500 underline">
          ← 給与
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">従業員の登録</h1>
        <button onClick={() => setEditing(blank())} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
          ＋ 従業員を追加
        </button>
      </div>
      <p className="mt-1 text-sm text-gray-600">口座番号などの情報は、管理者だけが見られます。</p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        退職した人も表示する
      </label>

      {editing && (
        <EmployeeForm
          key={editing.id}
          employee={editing}
          onClose={() => setEditing(null)}
          // 一覧にいる人なら、矢印で前・次の人に切り替えられる（同じ項目を続けて直しやすいように）
          nav={(() => {
            const i = shown.findIndex((x) => x.id === editing.id);
            if (i < 0) return undefined;
            return { pos: `${i + 1} / ${shown.length}`, prev: shown[i - 1], next: shown[i + 1], go: setEditing };
          })()}
        />
      )}
      {list && <RateFromPayroll employees={list} />}

      {error ? <p className="mt-3 text-red-600">{errorText(error)}</p> : null}
      {!list && !error && <p className="mt-3 text-gray-500">読み込み中…</p>}
      {list && shown.length === 0 && <p className="mt-3 text-sm text-gray-400">まだ登録されていません</p>}
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="px-3 py-2">番号</th>
              <th className="px-3 py-2">氏名</th>
              <th className="px-3 py-2">区分</th>
              <th className="px-3 py-2">支払</th>
              <th className="px-3 py-2">振込先</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className={`border-t ${e.active ? "" : "text-gray-400"}`}>
                <td className="px-3 py-2 tabular-nums">{e.code}</td>
                <td className="px-3 py-2 font-semibold">
                  {e.name}
                  {!e.active && <span className="ml-1 text-xs">（退職）</span>}
                </td>
                <td className="px-3 py-2">
                  <KindBadge kind={e.kind} />
                  {e.manager && <span className="ml-1 rounded bg-gray-200 px-1.5 text-xs text-gray-700">管理職</span>}
                  {e.commutePerDay ? (
                    <span className="ml-1 text-xs text-gray-600 tabular-nums">交通費 {e.commutePerDay.toLocaleString("ja-JP")}円/日</span>
                  ) : null}
                  {e.hourlyRate ? <span className="ml-1 text-xs text-gray-600 tabular-nums">時給 {e.hourlyRate.toLocaleString("ja-JP")}円</span> : null}
                </td>
                <td className="px-3 py-2">{e.payMethod === "cash" ? "現金" : "振込"}</td>
                <td className="px-3 py-2">
                  {e.payMethod === "transfer" && [e.bankName, e.branchName, e.accountType, e.accountNumber].filter(Boolean).join(" ")}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setEditing(e)} className="rounded-lg border px-3 py-1">
                    編集
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type FormNav = { pos: string; prev?: Employee; next?: Employee; go: (e: Employee) => void };

function EmployeeForm({ employee, onClose, nav }: { employee: Employee; onClose: () => void; nav?: FormNav }) {
  const [e, setE] = useState(employee);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Employee>) => setE({ ...e, ...patch });
  const dirty = JSON.stringify(e) !== JSON.stringify(employee);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (await persist()) onClose();
  }

  /** 前・次の人へ。直したところがあれば保存してから切り替える */
  async function move(to: Employee | undefined) {
    if (!to || !nav) return;
    if (dirty && !(await persist())) return;
    nav.go(to);
  }

  /** 保存する。できたら true */
  async function persist(): Promise<boolean> {
    setError("");
    if (!e.name.trim()) return (setError("氏名を入れてください"), false);
    if (e.accountNumber && !/^[0-9-]{1,20}$/.test(e.accountNumber)) return (setError("口座番号は数字で入れてください"), false);
    setSaving(true);
    try {
      const { db } = await getFirebase();
      const { id, ...data } = e;
      const { hourlyRate, commutePerDay, ...rest } = data;
      await setDoc(doc(db, `employees/${id}`), {
        ...rest,
        ...(hourlyRate ? { hourlyRate } : {}),
        ...(commutePerDay ? { commutePerDay } : {}),
        code: rest.code.trim(),
        name: rest.name.trim(),
        bankName: rest.bankName.trim(),
        branchName: rest.branchName.trim(),
        accountNumber: rest.accountNumber.trim(),
        updatedAt: serverTimestamp(),
      });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`${e.name} さんを削除しますか？\n過去の給与の記録に名前が出なくなります。辞めた人は「在籍中」のチェックを外すのがおすすめです。`))
      return;
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await deleteDoc(doc(db, `employees/${e.id}`));
      onClose();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-3 rounded-2xl bg-white p-4 shadow-sm sm:max-w-lg">
      {nav && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void move(nav.prev)}
            disabled={!nav.prev || saving}
            className="rounded-lg border px-4 py-2 font-bold disabled:opacity-30"
          >
            ◀ 前の人
          </button>
          <span className="flex-1 text-center text-sm text-gray-500 tabular-nums">{nav.pos}</span>
          <button
            type="button"
            onClick={() => void move(nav.next)}
            disabled={!nav.next || saving}
            className="rounded-lg border px-4 py-2 font-bold disabled:opacity-30"
          >
            次の人 ▶
          </button>
        </div>
      )}
      {nav && <p className="-mt-1 text-xs text-gray-500">直したところは、前・次の人に切り替えるときに保存されます。</p>}
      <div className="grid grid-cols-[6rem_1fr] gap-3">
        <label className="block text-sm">
          <span className="text-gray-600">社員番号</span>
          <input value={e.code} maxLength={10} onChange={(x) => set({ code: x.target.value })} className={input} />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">氏名</span>
          <input value={e.name} maxLength={30} required onChange={(x) => set({ name: x.target.value })} className={input} />
        </label>
      </div>
      <fieldset className="text-sm">
        <legend className="text-gray-600">区分</legend>
        <div className="mt-1 flex gap-4">
          {EMPLOYEE_KINDS.map((k) => (
            <label key={k.key} className="flex items-center gap-1">
              <input type="radio" name="kind" checked={e.kind === k.key} onChange={() => set({ kind: k.key })} />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!e.manager} onChange={(x) => set({ manager: x.target.checked })} />
        管理職（残業がつかない。タイムカードの集計で残業を数えません）
      </label>
      <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
        <label className="block text-sm">
          <span className="text-gray-600">時給（円）</span>
          <input
            value={e.hourlyRate ?? ""}
            inputMode="numeric"
            placeholder="時給の人だけ"
            onChange={(x) => {
              const v = x.target.value.replace(/[^0-9]/g, "");
              set({ hourlyRate: v ? Math.min(Number(v), 99999) : undefined });
            }}
            className={input}
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">交通費（1日・円）</span>
          <input
            value={e.commutePerDay ?? ""}
            inputMode="numeric"
            placeholder="日額の人だけ"
            onChange={(x) => {
              const v = x.target.value.replace(/[^0-9]/g, "");
              set({ commutePerDay: v ? Math.min(Number(v), 99999) : undefined });
            }}
            className={input}
          />
        </label>
      </div>
      <fieldset className="text-sm">
        <legend className="text-gray-600">支払方法</legend>
        <div className="mt-1 flex gap-4">
          {(["transfer", "cash"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" name="payMethod" checked={e.payMethod === m} onChange={() => set({ payMethod: m })} />
              {m === "transfer" ? "振込" : "現金"}
            </label>
          ))}
        </div>
      </fieldset>
      {e.payMethod === "transfer" && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-gray-600">銀行名</span>
            <input value={e.bankName} maxLength={30} placeholder="例：JAびえい" onChange={(x) => set({ bankName: x.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">支店名</span>
            <input value={e.branchName} maxLength={30} onChange={(x) => set({ branchName: x.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">種別</span>
            <select value={e.accountType} onChange={(x) => set({ accountType: x.target.value as Employee["accountType"] })} className={input}>
              <option>普通</option>
              <option>当座</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">口座番号</span>
            <input value={e.accountNumber} maxLength={20} inputMode="numeric" onChange={(x) => set({ accountNumber: x.target.value })} className={input} />
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={e.active} onChange={(x) => set({ active: x.target.checked })} />
        在籍中（外すと給与の表に出なくなります）
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-berry py-2 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "保存する"}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2">
          やめる
        </button>
        <button type="button" onClick={remove} disabled={saving} className="rounded-lg border px-4 py-2 text-red-700">
          削除
        </button>
      </div>
    </form>
  );
}

/** 区分（役員・社員・アルバイト）の印。決めていなければ「未設定」 */
function KindBadge({ kind }: { kind?: Employee["kind"] }) {
  const k = EMPLOYEE_KINDS.find((x) => x.key === kind);
  if (!k) return <span className="text-xs text-gray-400">未設定</span>;
  return <span className={`rounded px-2 py-0.5 text-xs font-bold ${k.badge}`}>{k.label}</span>;
}
