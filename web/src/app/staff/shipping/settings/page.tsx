"use client";

import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";
import { newId } from "@/lib/settings";
import { unitWeight, useShippingConfig, type Grade, type ShippingConfig } from "@/lib/shipping";

export default function ShippingSettingsPage() {
  const { role } = useAuth();
  const { value, exists } = useShippingConfig();
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!value) return <p className="text-gray-500">読み込み中…</p>;
  return <Editor initial={value} exists={exists} />;
}

function Editor({ initial, exists }: { initial: ShippingConfig; exists: boolean }) {
  const [c, setC] = useState(initial);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const setGrade = (i: number, patch: Partial<Grade>) => {
    setC({ ...c, grades: c.grades.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
    setMessage("");
  };
  const move = (i: number, d: number) => {
    const grades = [...c.grades];
    [grades[i], grades[i + d]] = [grades[i + d], grades[i]];
    setC({ ...c, grades });
  };

  async function save() {
    setError("");
    for (const g of c.grades) {
      if (!g.name.trim()) return setError("規格の名前が空です");
      if (!(g.count >= 1) || !(g.avgG > 0)) return setError(`「${g.group}${g.name}」の粒数と平均の重さを入れてください`);
    }
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await setDoc(doc(db, "shipping/config"), {
        destination: c.destination.trim(),
        grades: c.grades.map((g) => ({ ...g, group: g.group.trim(), name: g.name.trim(), gRange: g.gRange.trim() })),
        updatedAt: serverTimestamp(),
      });
      setMessage("保存しました");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const input = "rounded border px-2 py-1 text-base";
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/shipping/" className="text-gray-500 underline">
          ← 出荷実績
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">規格・出荷先の設定</h1>
      {!exists && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">いただいた出荷実績の表の規格を、最初から入れてあります。確かめて「保存する」を押してください。</p>}

      <label className="mt-4 block text-sm sm:max-w-md">
        <span className="text-gray-600">出荷先</span>
        <input value={c.destination} maxLength={40} placeholder="例：JAびえい" onChange={(e) => setC({ ...c, destination: e.target.value })} className={`mt-1 w-full ${input}`} />
      </label>

      <div className="mt-4 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr>
              <th className="px-2 py-2">区分</th>
              <th className="px-2 py-2">規格の名前</th>
              <th className="px-2 py-2">粒数</th>
              <th className="px-2 py-2">1粒の重さ（g）</th>
              <th className="px-2 py-2">平均（g）</th>
              <th className="px-2 py-2">出荷単位の重さ</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {c.grades.map((g, i) => (
              <tr key={g.id} className="border-t">
                <td className="px-2 py-1">
                  <input value={g.group} maxLength={10} list="grade-groups" onChange={(e) => setGrade(i, { group: e.target.value })} className={`w-20 ${input}`} aria-label="区分" />
                </td>
                <td className="px-2 py-1">
                  <input value={g.name} maxLength={20} onChange={(e) => setGrade(i, { name: e.target.value })} className={`w-28 ${input}`} aria-label="規格の名前" />
                </td>
                <td className="px-2 py-1">
                  <input
                    inputMode="numeric"
                    value={g.count || ""}
                    onChange={(e) => setGrade(i, { count: Number(e.target.value.replace(/[^0-9]/g, "")) })}
                    className={`w-16 text-right ${input}`}
                    aria-label="粒数"
                  />
                </td>
                <td className="px-2 py-1">
                  <input value={g.gRange} maxLength={10} placeholder="16-22" onChange={(e) => setGrade(i, { gRange: e.target.value })} className={`w-20 ${input}`} aria-label="1粒の重さの範囲" />
                </td>
                <td className="px-2 py-1">
                  <input
                    inputMode="decimal"
                    value={g.avgG || ""}
                    onChange={(e) => setGrade(i, { avgG: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
                    className={`w-16 text-right ${input}`}
                    aria-label="平均の重さ"
                  />
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{unitWeight(g)}g</td>
                <td className="whitespace-nowrap px-2 py-1">
                  <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded border px-2 py-1 disabled:opacity-30" aria-label="上へ">
                    ↑
                  </button>
                  <button disabled={i === c.grades.length - 1} onClick={() => move(i, 1)} className="ml-1 rounded border px-2 py-1 disabled:opacity-30" aria-label="下へ">
                    ↓
                  </button>
                  <button
                    onClick={() =>
                      window.confirm(`「${g.group}${g.name}」を削除しますか？\nこの規格で入れた出荷の数字は、表に出なくなります。`) &&
                      setC({ ...c, grades: c.grades.filter((_, j) => j !== i) })
                    }
                    className="ml-1 rounded border px-2 py-1 text-red-700"
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="grade-groups">
          {[...new Set(c.grades.map((g) => g.group))].map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </div>
      <button
        onClick={() => setC({ ...c, grades: [...c.grades, { id: newId(), group: c.grades.at(-1)?.group ?? "", name: "", count: 1, gRange: "", avgG: 0 }] })}
        className="mt-2 rounded-lg border bg-white px-3 py-2 text-sm"
      >
        ＋ 規格を追加
      </button>
      <p className="mt-2 text-xs text-gray-500">出荷単位の重さ ＝ 粒数 × 平均の重さ。粒で売るもの（プレミアムなど）は粒数を1にします。</p>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-berry px-6 py-3 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "保存する"}
        </button>
        {message && <span className="text-sm text-green-700">{message}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </>
  );
}
