"use client";

// 打刻タブレット：NFCタグ → 従業員の登録（timeclock/tags）・未登録のタグ（timeclock/unknown）・タブレットのログイン（timeclock/login）。
// 読むのは管理者だけ。書くのはサーバー（functions/src/timeclock.ts）
import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { callFunction } from "./callFunction";
import { getFirebase } from "./firebase";

export type TimeclockTag = { employeeId: string; card: string; name: string; at: number };
export type TimeclockLogin = { loginId?: string; active?: boolean };

/** 休憩時間を修正で選べる長さ（分）。サーバーの BREAK_CHOICES と同じ */
export const BREAK_CHOICES = [0, 15, 30, 45, 60];

function useTimeclockDoc<T>(id: string, pick: (d: Record<string, unknown> | undefined) => T): T | undefined {
  const [v, setV] = useState<T | undefined>(undefined);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "timeclock", id),
        (s) => setV(pick(s.data())),
        () => setV(pick(undefined)),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // pick は呼び出しごとに変わらない小さな関数なので、id だけで読み直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return v;
}

/** 登録したタグ（タグの番号 → 従業員）。読み込み中は undefined */
export const useTimeclockTags = () => useTimeclockDoc("tags", (d) => (d?.tags ?? {}) as Record<string, TimeclockTag>);
/** 未登録のタグ（タグの番号 → かざした時刻） */
export const useTimeclockUnknown = () => useTimeclockDoc("unknown", (d) => (d?.items ?? {}) as Record<string, number>);
/** 打刻タブレットのログイン */
export const useTimeclockLogin = () => useTimeclockDoc("login", (d) => (d ?? {}) as TimeclockLogin);

/** タグに従業員を割り当てる（null＝外す） */
export const setTimeclockTag = (serial: string, employeeId: string | null) => callFunction("timeclockSetTag", { serial, employeeId });
/** タブレットのログインを作る・パスワードを変える（loginId は、はじめて作るときだけ） */
export const saveTimeclockLogin = (password: string, loginId?: string) =>
  callFunction<unknown, { loginId: string }>("setTimeclockLogin", { password, loginId });
/** タブレットのログインを止める */
export const stopTimeclockLogin = () => callFunction("setTimeclockLogin", { stop: true });

export type PunchResult = { unknown?: boolean; name?: string; kind?: "in" | "out" | "dup"; min?: number };
/** かざした（at＝通信が切れていてあとから送るときの、かざした時刻） */
export const punch = (serial: string, at?: number) => callFunction<unknown, PunchResult>("timeclockPunch", { serial, ...(at ? { at } : {}) }, 20_000);
/** 休憩時間を修正（null＝いつもどおりに戻す） */
export const fixBreak = (serial: string, minutes: number | null) =>
  callFunction<unknown, { unknown?: boolean; name?: string; minutes: number | null }>("timeclockBreak", { serial, minutes }, 20_000);

/** タグの番号を短く見せる（例 04:a2:3b:…:9f → 04A2…9F） */
export const shortSerial = (s: string) => {
  const h = s.replace(/:/g, "").toUpperCase();
  return h.length > 8 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h;
};
