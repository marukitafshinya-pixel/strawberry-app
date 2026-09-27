"use client";

import { deleteDoc, doc, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv, parseAmount, parseCsv } from "@/lib/csv";
import { CUSTOMER_PRICES, emptyCustomer, matchCustomer, parseCustomerCsv, useCustomers, type Customer } from "@/lib/customers";
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
  const [preview, setPreview] = useState<Omit<Customer, "id">[] | null>(null);
  const [importMsg, setImportMsg] = useState("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(f: File | undefined) {
    setImportMsg("");
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    const r = parseCustomerCsv(parseCsv(decodeCsv(await f.arrayBuffer()).text), parseAmount);
    if (r.error) return setImportMsg(r.error);
    setPreview(r.items);
  }

  /** 同じ名前の顧客があれば上書き、なければ追加する（CSVに書いていない欄は消さない） */
  async function applyImport() {
    if (!preview) return;
    setImporting(true);
    try {
      const { db } = await getFirebase();
      const batch = writeBatch(db);
      for (const it of preview) {
        const found = (list ?? []).find((c) => c.name === it.name);
        const id = found?.id ?? newId();
        const base = found ?? emptyCustomer(id);
        const merged = {
          name: it.name,
          kana: it.kana || base.kana,
          phone: it.phone || base.phone,
          address: it.address || base.address,
          contract: it.contract || base.contract,
          payment: it.payment || base.payment,
          memo: it.memo || base.memo,
          prices: { ...base.prices, ...it.prices },
          active: true,
          updatedAt: serverTimestamp(),
        };
        batch.set(doc(db, `customers/${id}`), merged);
      }
      await batch.commit();
      setImportMsg(`${preview.length}件を登録しました`);
      setPreview(null);
    } catch (e) {
      setImportMsg(errorText(e));
    } finally {
      setImporting(false);
    }
  }

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
          <div className="flex gap-2">
            <button onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-3 py-2 text-sm">
              CSVから取り込む
            </button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <button onClick={() => setEditing(emptyCustomer(newId()))} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
              ＋ 顧客を追加
            </button>
          </div>
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

      {importMsg && <p className="mt-3 rounded-lg bg-gray-50 p-2 text-sm">{importMsg}</p>}
      {preview && (
        <section className="mt-3 rounded-2xl border border-berry/40 bg-white p-4 shadow-sm">
          <h2 className="font-bold">CSVの顧客を登録（{preview.length}件）</h2>
          <p className="mt-1 text-sm text-gray-600">同じ名前の顧客があれば上書きし、なければ追加します。</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="py-1 pr-3">名前</th>
                  <th className="py-1 pr-3">契約内容</th>
                  {CUSTOMER_PRICES.map((p) => (
                    <th key={p.key} className="py-1 pr-3 text-right">
                      {p.label}
                    </th>
                  ))}
                  <th className="py-1 pr-3">支払</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {preview.map((it) => (
                  <tr key={it.name} className="border-t">
                    <td className="py-1 pr-3 font-semibold">{it.name}</td>
                    <td className="py-1 pr-3 text-gray-600">{it.contract}</td>
                    {CUSTOMER_PRICES.map((p) => (
                      <td key={p.key} className="py-1 pr-3 text-right tabular-nums">
                        {it.prices[p.key] !== undefined ? yen(it.prices[p.key]!) : "—"}
                      </td>
                    ))}
                    <td className="py-1 pr-3">{it.payment === "credit" ? "売掛" : it.payment === "cash" ? "現金" : "—"}</td>
                    <td className="py-1 text-xs">{(list ?? []).some((c) => c.name === it.name) ? <span className="text-amber-700">上書き</span> : <span className="text-green-700">追加</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={applyImport} disabled={importing} className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-50">
              {importing ? "登録中…" : `${preview.length}件を登録する`}
            </button>
            <button onClick={() => setPreview(null)} className="rounded-lg border px-4 py-2">
              やめる
            </button>
          </div>
        </section>
      )}

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
                <th className="px-3 py-2">契約内容</th>
                {CUSTOMER_PRICES.map((p) => (
                  <th key={p.key} className="px-3 py-2 text-right">
                    {p.label}
                  </th>
                ))}
                <th className="px-3 py-2">支払</th>
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
                  <td className="px-3 py-2 text-gray-600">{c.contract}</td>
                  {CUSTOMER_PRICES.map((p) => (
                    <td key={p.key} className="px-3 py-2 text-right tabular-nums">
                      {c.prices[p.key] !== undefined ? yen(c.prices[p.key]!) : "—"}
                    </td>
                  ))}
                  <td className="px-3 py-2">{c.payment === "credit" ? "売掛" : c.payment === "cash" ? "現金" : ""}</td>
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
        contract: c.contract.trim().slice(0, 200),
        payment: c.payment,
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

        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <label className="block text-sm">
            <span className="text-gray-600">契約内容</span>
            <input value={c.contract} maxLength={200} placeholder="例：通常価格から10%引き" onChange={(e) => set({ contract: e.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">いつもの支払方法</span>
            <select value={c.payment} onChange={(e) => set({ payment: e.target.value as Customer["payment"] })} className={input}>
              <option value="">決めない</option>
              <option value="cash">現金</option>
              <option value="credit">売掛</option>
            </select>
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
