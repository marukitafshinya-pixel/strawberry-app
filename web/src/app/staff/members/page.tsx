"use client";

import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";

type StaffRole = "admin" | "staff";
type Member = { uid: string; email: string; displayName: string; role: StaffRole; active: boolean };

const ROLE_LABEL: Record<StaffRole, string> = { admin: "管理者", staff: "スタッフ" };

const input = "mt-1 w-full rounded-lg border px-3 py-2 text-base";
const button = "rounded-lg px-4 py-2 font-bold disabled:opacity-50";

export default function MembersPage() {
  const { role, user } = useAuth();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (role !== "admin") return;
    let unsubscribe = () => {};
    getFirebase().then(({ db }) => {
      // 名簿の変更は即時に画面へ反映される
      unsubscribe = onSnapshot(
        query(collection(db, "staff"), orderBy("createdAt")),
        (snap) => setMembers(snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<Member, "uid">) }))),
        (e) => setLoadError(errorText(e)),
      );
    });
    return () => unsubscribe();
  }, [role]);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">スタッフ管理</h1>

      <AddMemberForm />

      <h2 className="mt-8 font-bold">登録済みのスタッフ</h2>
      {loadError && <p className="mt-2 text-red-600">{loadError}</p>}
      {!members && !loadError && <p className="mt-2 text-gray-500">読み込み中…</p>}
      <ul className="mt-2 space-y-2">
        {members?.map((m) => (
          <MemberRow key={m.uid} member={m} isMe={m.uid === user?.uid} />
        ))}
      </ul>
    </>
  );
}

function AddMemberForm() {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newRole, setNewRole] = useState<StaffRole>("staff");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSending(true);
    try {
      await callFunction("createStaff", { displayName, email, password, role: newRole });
      setMessage(`${displayName} さんを追加しました。メールアドレスとパスワードを本人に伝えてください。`);
      setDisplayName("");
      setEmail("");
      setPassword("");
      setNewRole("staff");
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-4">
      {message && <p className="mb-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      {!open ? (
        <button onClick={() => setOpen(true)} className={`${button} bg-berry text-white`}>
          ＋ スタッフを追加
        </button>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3 rounded-2xl bg-white p-4 shadow-sm sm:max-w-md">
          <label className="block">
            <span className="text-sm text-gray-600">名前</span>
            <input required maxLength={30} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={input} />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">メールアドレス（ログインに使います）</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">最初のパスワード（8文字以上）</span>
            <input
              type="text"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
          </label>
          <RoleSelect value={newRole} onChange={setNewRole} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={sending} className={`${button} bg-berry text-white`}>
              {sending ? "追加中…" : "追加する"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={`${button} border font-normal`}>
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function RoleSelect({ value, onChange }: { value: StaffRole; onChange: (r: StaffRole) => void }) {
  return (
    <fieldset>
      <legend className="text-sm text-gray-600">権限</legend>
      <div className="mt-1 flex gap-4">
        {(["staff", "admin"] as const).map((r) => (
          <label key={r} className="flex items-center gap-1">
            <input type="radio" checked={value === r} onChange={() => onChange(r)} />
            {ROLE_LABEL[r]}
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-gray-500">管理者は、設定の変更とスタッフの追加ができます。</p>
    </fieldset>
  );
}

function MemberRow({ member, isMe }: { member: Member; isMe: boolean }) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(member.displayName);
  const [role, setRole] = useState<StaffRole>(member.role);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function update(patch: Record<string, unknown>) {
    setError("");
    setSending(true);
    try {
      await callFunction("updateStaff", { uid: member.uid, ...patch });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (displayName !== member.displayName) patch.displayName = displayName;
    if (role !== member.role) patch.role = role;
    if (password) patch.password = password;
    if (Object.keys(patch).length === 0 || (await update(patch))) {
      setPassword("");
      setEditing(false);
    }
  }

  async function toggleActive() {
    const next = !member.active;
    const msg = next
      ? `${member.displayName} さんを再び使えるようにしますか？`
      : `${member.displayName} さんを無効にしますか？\nログインできなくなります（記録は残ります）。`;
    if (window.confirm(msg)) await update({ active: next });
  }

  return (
    <li className={`rounded-xl border bg-white p-4 ${member.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-semibold">{member.displayName}</span>
          {isMe && <span className="ml-1 text-xs text-gray-500">（自分）</span>}
          <span
            className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
              member.role === "admin" ? "bg-berry/10 text-berry-dark" : "bg-gray-100 text-gray-700"
            }`}
          >
            {ROLE_LABEL[member.role]}
          </span>
          {!member.active && <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs">無効</span>}
          <div className="text-sm text-gray-500 break-all">{member.email}</div>
        </div>
        {!editing && (
          <div className="flex gap-2">
            <button onClick={() => setEditing(true)} className={`${button} border font-normal`}>
              編集
            </button>
            {!isMe && (
              <button onClick={toggleActive} disabled={sending} className={`${button} border font-normal`}>
                {member.active ? "無効にする" : "有効にする"}
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={onSave} className="mt-3 space-y-3 sm:max-w-md">
          <label className="block">
            <span className="text-sm text-gray-600">名前</span>
            <input required maxLength={30} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={input} />
          </label>
          {!isMe && <RoleSelect value={role} onChange={setRole} />}
          <label className="block">
            <span className="text-sm text-gray-600">新しいパスワード（変えるときだけ入力・8文字以上）</span>
            <input
              type="text"
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={sending} className={`${button} bg-berry text-white`}>
              {sending ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDisplayName(member.displayName);
                setRole(member.role);
                setPassword("");
                setError("");
              }}
              className={`${button} border font-normal`}
            >
              やめる
            </button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </li>
  );
}
