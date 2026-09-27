"use client";

import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { parseAirregiProducts, type AirregiProduct } from "@/lib/airregiProducts";
import { errorText } from "@/lib/callFunction";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { getFirebase } from "@/lib/firebase";
import { PLAN_CATEGORY_NAMES, suggestPrice, suggestTax, useItemRefs } from "@/lib/itemRefs";
import { DEFAULT_PRODUCT_TAX, SETTINGS_DOC, TAX_RATES, cleanProducts, newId, validateProducts, type Product, type TaxRate } from "@/lib/settings";

const smallButton = "rounded-lg border bg-white px-3 py-2 text-sm";

/** Airレジのカテゴリー番号の名前（去年の実績に名前がないときに使う） */
const AIRREGI_CATEGORY: Record<string, string> = { "0001": "直売", "0002": "カフェ", "0003": "いちご狩り" };

export default function ProductsPage() {
  const { role } = useAuth();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [exists, setExists] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    getFirebase()
      .then(({ db }) => getDoc(doc(db, SETTINGS_DOC)))
      .then((snap) => {
        setExists(snap.exists());
        setProducts((snap.get("products") as Product[] | undefined) ?? []);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (loadError) return <p className="text-red-600">{loadError}</p>;
  if (!products) return <p className="text-gray-500">読み込み中…</p>;
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">商品設定</h1>
      <p className="mt-1 text-sm text-gray-600">会計で売る商品です。金額は税込です。変更したら、画面下の「保存する」を押してください。</p>
      {!exists ? (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-amber-800">
          先に <Link href="/staff/settings/" className="underline">設定</Link> の画面で一度「保存する」を押してください。
        </p>
      ) : (
        <Editor initial={products} />
      )}
    </>
  );
}

function Editor({ initial }: { initial: Product[] }) {
  const [list, setList] = useState<Product[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ items: AirregiProduct[]; fileName: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { value: refs } = useItemRefs();

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (next: Product[]) => {
    setList(next);
    setDirty(true);
    setMessage("");
  };
  const setOne = (id: string, patch: Partial<Product>) => change(list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const groups = [...new Set(list.map((p) => p.group || "その他"))];
  const shown = list.filter((p) => !filter || (p.group || "その他") === filter);

  /** Airレジのカテゴリー番号 → 名前（去年の実績の商品名から推測） */
  function categoryName(id: string): string {
    const byName = new Map<string, string>();
    for (const r of refs ?? []) for (const it of r.items) if (it.category) byName.set(it.name, it.category);
    const votes = new Map<string, number>();
    for (const it of preview?.items ?? []) {
      const c = it.categoryId === id ? byName.get(it.name) : undefined;
      if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return best ?? AIRREGI_CATEGORY[id] ?? (id ? `分類${id}` : "その他");
  }

  /** 読み込む商品が、今の一覧のどれに当たるか（Airレジの商品ID → 名前の順で探す） */
  function match(it: AirregiProduct): Product | undefined {
    return list.find((p) => it.airregiId && p.airregiId === it.airregiId) ?? list.find((p) => p.name.trim() === it.name);
  }

  async function onFile(f: File | undefined) {
    setErrors([]);
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    const r = parseAirregiProducts(parseCsv(decodeCsv(await f.arrayBuffer()).text));
    if (r.error) return setErrors([r.error]);
    setPreview({ items: r.items, fileName: f.name });
  }

  function applyImport() {
    if (!preview) return;
    let next = [...list];
    for (const it of preview.items) {
      const group = categoryName(it.categoryId);
      const found = match(it);
      const data = { name: it.name, group, price: it.price, taxRate: it.taxRate, active: it.active, airregiId: it.airregiId || undefined };
      if (found) next = next.map((p) => (p.id === found.id ? { ...p, ...data } : p));
      else next.push({ id: newId(), ...data });
    }
    // 保存できない undefined の項目を取り除く
    next = next.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Product);
    change(next);
    setPreview(null);
    setMessage(`${preview.items.length}件を読み込みました。確かめてから「保存する」を押してください`);
  }

  async function save() {
    const cleaned = cleanProducts(list);
    const problems = validateProducts(cleaned);
    setErrors(problems);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await updateDoc(doc(db, SETTINGS_DOC), { products: cleaned, updatedAt: serverTimestamp() });
      setList(cleaned);
      setDirty(false);
      setMessage("保存しました");
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setSaving(false);
    }
  }

  function move(id: string, delta: number) {
    const i = list.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    change(next);
  }

  return (
    <div className="pb-28">
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            const group = filter || list.at(-1)?.group || "";
            change([...list, { id: newId(), name: "", group, price: 0, active: true, taxRate: DEFAULT_PRODUCT_TAX }]);
          }}
          className="rounded-lg bg-berry px-4 py-2 text-sm font-bold text-white"
        >
          ＋ 商品を追加
        </button>
        <button onClick={() => fileRef.current?.click()} className={smallButton}>
          AirレジのCSVから読み込む
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <ProductsFromRefs products={list} onAdd={(added) => change([...list, ...added])} />
      </div>

      {preview && (
        <section className="mt-3 rounded-2xl border border-berry/40 bg-white p-4 shadow-sm">
          <h2 className="font-bold">Airレジの商品を読み込む（{preview.items.length}件）</h2>
          <p className="mt-1 text-sm text-gray-600">
            同じ商品（Airレジの商品ID、または同じ名前）があれば上書きし、なければ追加します。ファイルにない商品はそのまま残ります。
          </p>
          <div className="mt-2 max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-gray-500">
                <tr>
                  <th className="py-1">商品名</th>
                  <th className="py-1">分類</th>
                  <th className="py-1 text-right">価格</th>
                  <th className="py-1 text-right">税率</th>
                  <th className="py-1 pl-2">表示</th>
                  <th className="py-1 pl-2" />
                </tr>
              </thead>
              <tbody>
                {preview.items.map((it) => {
                  const found = match(it);
                  return (
                    <tr key={it.name} className="border-t">
                      <td className="py-1">{it.name}</td>
                      <td className="py-1 text-gray-600">{categoryName(it.categoryId)}</td>
                      <td className="py-1 text-right tabular-nums">{it.price.toLocaleString("ja-JP")}円</td>
                      <td className="py-1 text-right">{it.taxRate}%</td>
                      <td className="py-1 pl-2">{it.active ? "表示" : "非表示"}</td>
                      <td className="py-1 pl-2 text-xs">{found ? <span className="text-amber-700">上書き</span> : <span className="text-green-700">追加</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={applyImport} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
              一覧に入れる
            </button>
            <button onClick={() => setPreview(null)} className={smallButton}>
              やめる
            </button>
          </div>
        </section>
      )}

      {groups.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {["", ...groups].map((g) => (
            <button
              key={g || "all"}
              onClick={() => setFilter(g)}
              className={`rounded-full border px-3 py-1 text-sm ${filter === g ? "border-berry bg-berry text-white" : "bg-white"}`}
            >
              {g || "すべて"}（{g ? list.filter((p) => (p.group || "その他") === g).length : list.length}）
            </button>
          ))}
        </div>
      )}

      <datalist id="product-groups">
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>

      {list.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">まだ商品がありません。「＋ 商品を追加」か「AirレジのCSVから読み込む」で入れてください。</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-2 py-2">商品名</th>
                <th className="px-2 py-2">分類</th>
                <th className="px-2 py-2 text-right">価格（税込）</th>
                <th className="px-2 py-2">税率</th>
                <th className="px-2 py-2">販売中</th>
                <th className="px-2 py-2">並び順</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className={`border-t ${p.active ? "" : "bg-gray-50 text-gray-500"}`}>
                  <td className="px-2 py-1">
                    <input
                      value={p.name}
                      maxLength={50}
                      aria-label="商品名"
                      onChange={(e) => setOne(p.id, { name: e.target.value })}
                      className="w-56 rounded border px-2 py-1 text-base"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={p.group}
                      maxLength={20}
                      list="product-groups"
                      aria-label="分類"
                      onChange={(e) => setOne(p.id, { group: e.target.value })}
                      className="w-28 rounded border px-2 py-1 text-base"
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      inputMode="numeric"
                      value={String(p.price)}
                      aria-label="価格"
                      onChange={(e) => {
                        const v = e.target.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
                        setOne(p.id, { price: Math.min(1_000_000, Number(v || 0)) });
                      }}
                      className="w-24 rounded border px-2 py-1 text-right text-base tabular-nums"
                    />
                    <span className="ml-1 text-xs">円</span>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={p.taxRate ?? DEFAULT_PRODUCT_TAX}
                      aria-label="税率"
                      onChange={(e) => setOne(p.id, { taxRate: Number(e.target.value) as TaxRate })}
                      className="rounded border px-1 py-1 text-base"
                    >
                      {TAX_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r === 8 ? "8%軽減" : "10%"}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input type="checkbox" checked={p.active} aria-label="販売中" onChange={(e) => setOne(p.id, { active: e.target.checked })} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <button onClick={() => move(p.id, -1)} className="rounded border px-2 py-0.5" aria-label="上へ">
                      ↑
                    </button>
                    <button onClick={() => move(p.id, 1)} className="ml-1 rounded border px-2 py-0.5" aria-label="下へ">
                      ↓
                    </button>
                  </td>
                  <td className="px-2 py-1">
                    <button
                      onClick={() => {
                        if (window.confirm(`「${p.name || "（名前なし）"}」を削除しますか？\n（過去の会計の記録はそのまま残ります。売らないだけなら「販売中」を外すのがおすすめです）`))
                          change(list.filter((x) => x.id !== p.id));
                      }}
                      className="rounded border px-2 py-0.5 text-red-700"
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">
        「販売中」を外すと会計画面に出なくなります。並び順は会計画面の表示順です。いちご狩りの予約の料金は「設定」のプランで決めます。
      </p>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-5xl">
          {errors.length > 0 && (
            <ul className="mb-2 list-disc pl-5 text-sm text-red-600">
              {errors.slice(0, 5).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={save} disabled={saving} className="rounded-lg bg-berry px-6 py-3 font-bold text-white disabled:opacity-50">
              {saving ? "保存中…" : "保存する"}
            </button>
            {message && <span className="text-sm text-green-700">{message}</span>}
            {dirty && !message && <span className="text-sm text-gray-500">まだ保存していない変更があります</span>}
            <span className="ml-auto text-sm text-gray-600">{list.length}件</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 去年の商品別の実績（Airレジ）から、まだ登録していない商品をまとめて追加する */
function ProductsFromRefs({ products, onAdd }: { products: Product[]; onAdd: (p: Product[]) => void }) {
  const { value: refs } = useItemRefs();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const ref = refs?.[0];
  if (!ref) return null;
  const have = new Set(products.map((p) => p.name.trim()));
  const candidates = ref.items
    .filter((i) => !PLAN_CATEGORY_NAMES.includes(i.category) && !have.has(i.name) && i.qty > 0)
    .sort((a, b) => b.amount - a.amount);

  if (!open)
    return (
      <button onClick={() => { setChecked(new Set(candidates.map((c) => c.name))); setOpen(true); }} className={smallButton}>
        去年の実績から商品を追加
      </button>
    );
  return (
    <div className="mt-3 rounded-xl border border-berry/40 bg-berry/5 p-3">
      <p className="text-sm font-semibold">
        去年の実績（{ref.from.replaceAll("-", "/")}〜{ref.to.replaceAll("-", "/")}）から追加
      </p>
      <p className="mt-1 text-xs text-gray-600">
        値段は「売上 ÷ 販売数」の目安です（割引の分、実際より少し安く出ることがあります）。追加したあと、上の一覧で直してください。いちご狩りの料金はプランで設定します。
      </p>
      {candidates.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">追加できる商品はありません（すべて登録済みです）</p>
      ) : (
        <ul className="mt-2 max-h-72 divide-y overflow-y-auto rounded-lg bg-white text-sm">
          {candidates.map((c) => (
            <li key={c.name}>
              <label className="flex items-center gap-2 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={checked.has(c.name)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(c.name);
                    else next.delete(c.name);
                    setChecked(next);
                  }}
                />
                <span className="flex-1">
                  {c.name}
                  <span className="ml-1 text-xs text-gray-500">{c.category || "いちご"}</span>
                </span>
                <span className="text-xs text-gray-500 tabular-nums">{c.qty.toLocaleString("ja-JP")}個</span>
                <span className="w-20 text-right tabular-nums">{suggestPrice(c).toLocaleString("ja-JP")}円</span>
                <span className="w-10 text-right text-xs">{suggestTax(c.name)}%</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <button
          disabled={checked.size === 0}
          onClick={() => {
            onAdd(
              candidates
                .filter((c) => checked.has(c.name))
                .map((c) => ({ id: newId(), name: c.name.slice(0, 30), group: c.category || "いちご", price: suggestPrice(c), active: true, taxRate: suggestTax(c.name) })),
            );
            setOpen(false);
          }}
          className="rounded-lg bg-berry px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
        >
          {checked.size}件を追加
        </button>
        <button onClick={() => setOpen(false)} className={smallButton}>
          やめる
        </button>
      </div>
    </div>
  );
}
