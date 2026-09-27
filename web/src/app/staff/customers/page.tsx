"use client";

import { deleteDoc, doc, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { CUSTOMER_PRICES, emptyCustomer, matchCustomer, useCustomers, type Customer } from "@/lib/customers";
import { getFirebase } from "@/lib/firebase";
import { yen } from "@/lib/reservations";
import { newId } from "@/lib/settings";

const input = "mt-1 w-full rounded-lg border px-3 py-2 text-base";

export default function CustomersPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { value: list, error } = useCustomers();
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  const shown = (list ?? []).filter((c) => (showInactive || c.active) && matchCustomer(c, q));

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">顧客リスト</h1>
        {isAdmin && (
          <button onClick={() => setEditing(emptyCustomer(newId()))} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
            ＋ 顧客を追加
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-600">
        団体・取引先などの顧客と、その顧客のいちご狩りの単価を登録します。会計で顧客を選ぶと、この単価で入ります。
        {!isAdmin && "（登録・変更は管理者だけができます）"}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前・ふりがな・電話で探す" className="w-64 rounded-lg border px-3 py-2 text-base" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          取引をやめた顧客も表示する
        </label>
      </div>

      {editing && <CustomerForm key={editing.id} customer={editing} canEdit={isAdmin} onClose={() => setEditing(null)} />}

      {error ? <p className="mt-3 text-red-600">{errorText(error)}</p> : null}
      {!list && !error && <p className="mt-3 text-gray-500">読み込み中…</p>}
      {list && shown.length === 0 && <p className="mt-3 text-sm text-gray-400">{q ? "見つかりません" : "まだ登録されていません"}</p>}
      {shown.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">名前</th>
                <th className="px-3 py-2">電話</th>
                {CUSTOMER_PRICES.map((p) => (
                  <th key={p.key} className="px-3 py-2 text-right">
                    {p.label}
                  </th>
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className={`border-t ${c.active ? "" : "text-gray-400"}`}>
                  <td className="px-3 py-2">
                    <span className="font-semibold">{c.name}</span>
                    {c.kana && <span className="ml-1 text-xs text-gray-500">{c.kana}</span>}
                    {!c.active && <span className="ml-1 text-xs">（取引終了）</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{c.phone}</td>
                  {CUSTOMER_PRICES.map((p) => (
                    <td key={p.key} className="px-3 py-2 text-right tabular-nums">
                      {c.prices[p.key] !== undefined ? yen(c.prices[p.key]!) : "—"}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setEditing(c)} className="rounded-lg border px-3 py-1">
                      詳細
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CustomerForm({ customer, canEdit, onClose }: { customer: Customer; canEdit: boolean; onClose: () => void }) {
  const [c, setC] = useState(customer);
  const [priceText, setPriceText] = useState<Record<string, string>>(
    Object.fromEntries(CUSTOMER_PRICES.map((p) => [p.key, customer.prices[p.key] !== undefined ? String(customer.prices[p.key]) : ""])),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Customer>) => setC({ ...c, ...patch });

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    if (!c.name.trim()) return setError("名前を入れてください");
    const prices: Customer["prices"] = {};
    for (const p of CUSTOMER_PRICES) {
      const t = priceText[p.key].trim();
      if (t === "") continue;
      const v = Number(t);
      if (!Number.isInteger(v) || v < 0 || v > 1_000_000) return setError(`${p.label}の単価を正しく入れてください`);
      prices[p.key] = v;
    }
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await setDoc(doc(db, `customers/${c.id}`), {
        name: c.name.trim().slice(0, 100),
        kana: c.kana.trim().slice(0, 100),
        phone: c.phone.trim().slice(0, 30),
        address: c.address.trim().slice(0, 200),
        memo: c.memo.trim().slice(0, 500),
        prices,
        active: c.active,
        updatedAt: serverTimestamp(),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`「${c.name}」を削除しますか？\n（過去の会計の記録はそのまま残ります。取引をやめただけなら「取引中」を外すのがおすすめです）`)) return;
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await deleteDoc(doc(db, `customers/${c.id}`));
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  const digits = (v: string) => v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");

  return (
    <form onSubmit={save} className="mt-3 space-y-3 rounded-2xl border border-berry/30 bg-white p-4 shadow-sm sm:max-w-2xl">
      <h2 className="font-bold">{customer.name ? `${customer.name} の詳細` : "新しい顧客"}</h2>
      <fieldset disabled={!canEdit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-gray-600">名前（会社名・団体名など）</span>
            <input value={c.name} maxLength={100} required onChange={(e) => set({ name: e.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">ふりがな</span>
            <input value={c.kana} maxLength={100} onChange={(e) => set({ kana: e.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">電話</span>
            <input type="tel" value={c.phone} maxLength={30} onChange={(e) => set({ phone: e.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">住所</span>
            <input value={c.address} maxLength={200} onChange={(e) => set({ address: e.target.value })} className={input} />
          </label>
        </div>

        <div>
          <p className="text-sm font-semibold">いちご狩りの単価（税込）</p>
          <p className="text-xs text-gray-500">この顧客だけの料金です。空欄の区分は、会計に出ません。</p>
          <div className="mt-2 grid grid-cols-3 gap-3">
            {CUSTOMER_PRICES.map((p) => (
              <label key={p.key} className="block text-sm">
                <span className="text-gray-600">{p.label}</span>
                <span className="mt-1 flex items-center gap-1">
                  <input
                    inputMode="numeric"
                    value={priceText[p.key]}
                    onChange={(e) => setPriceText({ ...priceText, [p.key]: digits(e.target.value).slice(0, 7) })}
                    className="w-full rounded-lg border px-3 py-2 text-right text-base tabular-nums"
                    aria-label={`${p.label}の単価`}
                  />
                  <span className="text-sm">円</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <span className="text-gray-600">メモ</span>
          <textarea value={c.memo} maxLength={500} rows={2} onChange={(e) => set({ memo: e.target.value })} className={input} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.active} onChange={(e) => set({ active: e.target.checked })} />
          取引中（外すと会計で選べなくなります）
        </label>
      </fieldset>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-berry py-2 font-bold text-white disabled:opacity-50">
            {saving ? "保存中…" : "保存する"}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2">
          {canEdit ? "やめる" : "閉じる"}
        </button>
        {canEdit && customer.name && (
          <button type="button" onClick={remove} disabled={saving} className="rounded-lg border px-4 py-2 text-red-700">
            削除
          </button>
        )}
      </div>
    </form>
  );
}
