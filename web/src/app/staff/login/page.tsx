"use client";

import { FirebaseError } from "firebase/app";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";

function errorMessage(e: unknown): string {
  if (e instanceof FirebaseError) {
    if (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/user-not-found")
      return "メールアドレスかパスワードが違います。";
    if (e.code === "auth/too-many-requests") return "失敗が続いたため、しばらく時間をおいてからお試しください。";
    if (e.code === "auth/network-request-failed") return "通信できませんでした。電波の状態を確認してください。";
  }
  return "ログインできませんでした。";
}

export default function LoginPage() {
  const { user, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (user) router.replace("/staff/");
  }, [user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm flex-1 px-4 py-12">
      <h1 className="text-center text-2xl font-bold text-berry">🍓 スタッフログイン</h1>
      <form onSubmit={onSubmit} className="mt-8 space-y-4 rounded-2xl bg-white p-6 shadow-sm">
        <label className="block">
          <span className="text-sm text-gray-600">メールアドレス</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-base"
          />
        </label>
        <label className="block">
          <span className="text-sm text-gray-600">パスワード</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-base"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={sending}
          className="w-full rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50"
        >
          {sending ? "ログイン中…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}
