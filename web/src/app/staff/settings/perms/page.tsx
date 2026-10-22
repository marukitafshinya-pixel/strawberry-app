"use client";

// 役割ごとの見せる画面（管理者だけ）：スタッフ・経理に、どの画面を見せるかを選ぶ。
// 見せない画面は、メニューに出さず、開いても使えず、データも読めない（データの読み書きの決まりとサーバーの処理も同じ設定を見る）
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { ADMIN_ONLY, DEFAULT_PERMS, FEATURES, saveRolePerms, useRolePerms, type Feature, type PermRole, type RolePerms } from "@/lib/perms";

const ROLES: { key: PermRole; label: string }[] = [
  { key: "staff", label: "スタッフ" },
  { key: "accounting", label: "経理" },
];

export default function PermsPage() {
  const { role } = useAuth();
  const saved = useRolePerms(role === "admin");
  const [draft, setDraft] = useState<RolePerms | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!saved) return <p className="text-gray-500">読み込み中…</p>;
  const cur = draft ?? saved;
  const dirty = draft != null && ROLES.some((r) => [...draft[r.key]].sort().join() !== [...saved[r.key]].sort().join());

  function toggle(r: PermRole, f: Feature) {
    setMsg("");
    const list = cur[r].includes(f) ? cur[r].filter((x) => x !== f) : [...cur[r], f];
    setDraft({ ...cur, [r]: FEATURES.map((x) => x.key).filter((k) => list.includes(k)) });
  }
  async function save() {
    setSaving(true);
    setMsg("");
    try {
      await saveRolePerms(cur);
      setDraft(null);
      setMsg("保存しました。スタッフ・経理の画面にも、すぐに反映されます。");
    } catch (e) {
      setMsg(`保存できませんでした：${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl pb-24">
      <p className="text-sm">
        <Link href="/staff/settings/" className="text-gray-500 underline">
          ← 設定
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">🔐 役割ごとの見せる画面</h1>
      <p className="mt-1 text-sm text-gray-600">
        スタッフと経理に、どの画面を見せるかを選びます。見せない画面はメニューに出ず、開いても使えず、その画面のデータも読めなくなります。管理者はいつもすべての画面を使えます。
      </p>
      <div className="mt-3 overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2">画面</th>
              {ROLES.map((r) => (
                <th key={r.key} className="px-3 py-2 text-center">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.key} className="border-t">
                <td className="px-3 py-2">{f.label}</td>
                {ROLES.map((r) => (
                  <td key={r.key} className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={cur[r.key].includes(f.key)}
                      onChange={() => toggle(r.key, f.key)}
                      className="h-5 w-5"
                      aria-label={`${r.label}に${f.label}を見せる`}
                    />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t bg-gray-50 text-gray-500">
              <td className="px-3 py-2" colSpan={3}>
                管理者だけ（選べません）：{ADMIN_ONLY.join("・")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="mt-2 list-disc pl-5 text-xs text-gray-500">
        <li>今まで管理者だけだった画面（温度の見張り・トータル実績・目標と実績・帳簿）を見せると、その画面は管理者と同じように使えます。</li>
        <li>現金出納帳は、管理者のほかは見るだけ（印刷・エクセルに書き出しはできます）です。給与（見るだけ）には、口座・時給・タイムカードは出ません。</li>
        <li>予約・会計などで、もともと管理者だけができる操作（予約の削除・顧客の登録・設定の変更など）は、見せても管理者だけのままです。</li>
      </ul>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
          <button onClick={save} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-3 font-bold text-white disabled:opacity-40">
            {saving ? "保存中…" : "保存する"}
          </button>
          <button
            onClick={() => {
              setDraft(DEFAULT_PERMS);
              setMsg("");
            }}
            className="rounded-lg border bg-white px-4 py-2 text-sm"
          >
            はじめの見せ方に戻す
          </button>
          {dirty && !msg && <span className="text-sm text-gray-500">まだ保存していない変更があります</span>}
          {msg && <span className="text-sm text-green-700">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
