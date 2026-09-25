"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";

const LOGIN_PATH = "/staff/login/";

/** 権限のないアカウントの画面。管理者がまだいなければ、最初の管理者になれる */
function NoRole() {
  const { logout, refreshRole } = useAuth();
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function claim() {
    setError("");
    setSending(true);
    try {
      await callFunction("claimFirstAdmin", {});
      await refreshRole();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <p>このアカウントには、スタッフ画面を使う権限がありません。管理者に確認してください。</p>
      <div className="mt-6 rounded-xl border bg-white p-4 text-sm">
        <p className="text-gray-600">はじめて使うときだけ：まだ管理者が1人もいなければ、このアカウントを管理者にできます。</p>
        <button
          onClick={claim}
          disabled={sending}
          className="mt-3 rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-50"
        >
          {sending ? "登録中…" : "最初の管理者として登録する"}
        </button>
        {error && <p className="mt-2 text-red-600">{error}</p>}
      </div>
      <button onClick={logout} className="mt-6 rounded-lg border px-4 py-2">
        ログアウト
      </button>
    </main>
  );
}

/** スタッフ画面の共通部分。ログインしていなければログイン画面へ移動する */
function Guard({ children }: { children: ReactNode }) {
  const { loading, user, role, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === LOGIN_PATH || pathname === "/staff/login";

  useEffect(() => {
    if (!loading && !user && !isLoginPage) router.replace(LOGIN_PATH);
  }, [loading, user, isLoginPage, router]);

  if (isLoginPage) return <>{children}</>;
  if (loading || !user) return <p className="p-6 text-gray-500">読み込み中…</p>;

  if (!role) return <NoRole />;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between bg-berry px-4 py-3 text-white print:hidden">
        <Link href="/staff/" className="font-bold">
          🍓 スタッフ
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden sm:inline">
            {user.email}（{role === "admin" ? "管理者" : "スタッフ"}）
          </span>
          <button onClick={logout} className="rounded-md bg-white/20 px-3 py-1">
            ログアウト
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}

export function StaffShell({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <Guard>{children}</Guard>
    </AuthProvider>
  );
}
