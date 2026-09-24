"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";

const LOGIN_PATH = "/staff/login/";

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

  if (!role) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p>このアカウントには、スタッフ画面を使う権限がありません。管理者に確認してください。</p>
        <button onClick={logout} className="mt-4 rounded-lg border px-4 py-2">
          ログアウト
        </button>
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between bg-berry px-4 py-3 text-white">
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
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
