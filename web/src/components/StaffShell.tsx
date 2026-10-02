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

/**
 * 新しい版が出ていたらお知らせする。
 * ホーム画面のアプリは閉じても裏で残っていることが多く、古い版のまま使い続けてしまうため。
 * 画面に戻ってきたときと、5分ごとに確かめる。
 */
function useNewVersion(): boolean {
  const [outdated, setOutdated] = useState(false);
  useEffect(() => {
    const current = process.env.NEXT_PUBLIC_BUILD_ID;
    if (!current || process.env.NODE_ENV !== "production") return;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/version.txt?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const latest = (await res.text()).trim();
        if (latest && latest !== current) setOutdated(true);
      } catch {
        // 電波が悪いときは次の機会に
      }
    };
    check();
    const timer = setInterval(check, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return outdated;
}

const WORKER_PATH = "/staff/shift/me/";

/** スタッフ画面の共通部分。ログインしていなければログイン画面へ移動する */
function Guard({ children }: { children: ReactNode }) {
  const { loading, user, role, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === LOGIN_PATH || pathname === "/staff/login";
  const outdated = useNewVersion();

  useEffect(() => {
    if (!loading && !user && !isLoginPage) router.replace(LOGIN_PATH);
  }, [loading, user, isLoginPage, router]);
  const workerAway = role === "worker" && !isLoginPage && !pathname?.startsWith(WORKER_PATH);
  useEffect(() => {
    if (workerAway) router.replace(WORKER_PATH);
  }, [workerAway, router]);

  if (isLoginPage) return <>{children}</>;
  if (loading || !user) return <p className="p-6 text-gray-500">読み込み中…</p>;

  if (!role) return <NoRole />;
  // 従業員は、意向勤務管理表（自分の画面）だけ
  if (role === "worker" && !pathname?.startsWith(WORKER_PATH)) return <p className="p-6 text-gray-500">読み込み中…</p>;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between bg-berry px-4 py-3 text-white print:hidden">
        <Link href={role === "worker" ? WORKER_PATH : "/staff/"} className="font-bold">
          🍓 スタッフ
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden sm:inline">
            {role === "worker" ? user.displayName ?? "" : user.email}（{role === "admin" ? "管理者" : role === "worker" ? "従業員" : "スタッフ"}）
          </span>
          <button onClick={logout} className="rounded-md bg-white/20 px-3 py-1">
            ログアウト
          </button>
        </div>
      </header>
      {outdated && (
        <div className="flex flex-wrap items-center justify-center gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-900 print:hidden">
          <span>アプリの新しい版があります。</span>
          <button onClick={() => window.location.reload()} className="rounded-lg bg-amber-600 px-4 py-1.5 font-bold text-white">
            更新する
          </button>
          <span className="text-xs">（会計の途中なら、会計が終わってから押してください）</span>
        </div>
      )}
      {/* 会計はレジとして使うので、画面の幅いっぱいに広げる */}
      <main className={`mx-auto w-full flex-1 px-4 py-6 print:max-w-none print:p-0 ${pathname?.startsWith("/staff/checkout") ? "max-w-screen-2xl py-3" : "max-w-5xl"}`}>{children}</main>
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
