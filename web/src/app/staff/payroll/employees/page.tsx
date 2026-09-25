"use client";

import { deleteDoc, doc, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";
import { useEmployees, type Employee } from "@/lib/payroll";
import { newId } from "@/lib/settings";

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

      {editing && <EmployeeForm employee={editing} onClose={() => setEditing(null)} />}

      {error ? <p className="mt-3 text-red-600">{errorText(error)}</p> : null}
      {!list && !error && <p className="mt-3 text-gray-500">読み込み中…</p>}
      {list && shown.length === 0 && <p className="mt-3 text-sm text-gray-400">まだ登録されていません</p>}
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="px-3 py-2">番号</th>
              <th className="px-3 py-2">氏名</th>
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

function EmployeeForm({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const [e, setE] = useState(employee);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Employee>) => setE({ ...e, ...patch });

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    if (!e.name.trim()) return setError("氏名を入れてください");
    if (e.accountNumber && !/^[0-9-]{1,20}$/.test(e.accountNumber)) return setError("口座番号は数字で入れてください");
    setSaving(true);
    try {
      const { db } = await getFirebase();
      const { id, ...data } = e;
      await setDoc(doc(db, `employees/${id}`), {
        ...data,
        code: data.code.trim(),
        name: data.name.trim(),
        bankName: data.bankName.trim(),
        branchName: data.branchName.trim(),
        accountNumber: data.accountNumber.trim(),
        updatedAt: serverTimestamp(),
      });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`${e.name} さんを削除しますか？\n過去の給与の記録に名前が出なくなります。辞めた人は「在籍中」のチェックを外すのがおすすめです。`)) return;
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
