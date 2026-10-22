"use client";

// 役割ごとに見せる画面（設定 →「役割ごとの見せる画面」。config/rolePerms）。
// 管理者はいつもすべての画面を使える。スタッフ・経理は、ここで見せると決めた画面だけ（決めていなければ、はじめの見せ方）。
// メニュー・画面に入れるか・データの読み書き（firestore.rules の permsOf）・サーバーの処理（functions の assertCan）で同じ名前を使う
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { getFirebase } from "./firebase";

export type PermRole = "staff" | "accounting";

/** 見せる・見せないを選べる画面（メニューの順）。path＝その画面のアドレスのはじめ */
export const FEATURES = [
  { key: "reservations", label: "予約管理", paths: ["/staff/reservations"] },
  { key: "checkout", label: "会計（レジ）", paths: ["/staff/checkout", "/staff/receipt"] },
  { key: "receivables", label: "売掛管理", paths: ["/staff/receivables"] },
  { key: "customers", label: "顧客リスト", paths: ["/staff/customers"] },
  { key: "dashboard", label: "ダッシュボード", paths: ["/staff/dashboard", "/staff/sales", "/staff/report"] },
  { key: "reservationReport", label: "予約の集計", paths: ["/staff/report/reservations"] },
  { key: "shift", label: "勤務管理表", paths: ["/staff/shift"] },
  { key: "harvest", label: "収穫管理", paths: ["/staff/harvest"] },
  { key: "tempWatch", label: "温度の見張り", paths: ["/staff/harvest/watch"] },
  { key: "shipping", label: "出荷実績", paths: ["/staff/shipping"] },
  { key: "store", label: "店舗実績", paths: ["/staff/store", "/staff/report/items"] },
  { key: "total", label: "トータル実績", paths: ["/staff/total"] },
  { key: "goals", label: "目標と実績", paths: ["/staff/goals"] },
  { key: "weather", label: "気象データ", paths: ["/staff/weather"] },
  { key: "cashbook", label: "現金出納帳（見るだけ）", paths: ["/staff/cashbook"] },
  { key: "payrollView", label: "給与（見るだけ・口座などは出さない）", paths: ["/staff/cashbook/payroll"] },
  { key: "ledger", label: "帳簿（経理）", paths: ["/staff/ledger"] },
] as const;
export type Feature = (typeof FEATURES)[number]["key"];

/** 管理者だけに決めている画面（選べない） */
export const ADMIN_ONLY = ["給与（入力）", "作業用フォルダ", "商品設定", "設定・スタッフ管理・バックアップ", "収穫の実績・振り返り", "過去の売上の取り込み"];
/** 管理者だけの画面のアドレス */
const ADMIN_PATHS = [
  "/staff/payroll",
  "/staff/work",
  "/staff/products",
  "/staff/settings",
  "/staff/members",
  "/staff/backup",
  "/staff/import",
  "/staff/harvest/report",
  "/staff/harvest/past",
  "/staff/shipping/settings",
];

/** 決めていないときの、はじめの見せ方（サーバーの DEFAULT_PERMS・ルールの permsOf と同じ） */
export const DEFAULT_PERMS: Record<PermRole, Feature[]> = {
  staff: ["reservations", "checkout", "receivables", "customers", "dashboard", "reservationReport", "shift", "harvest", "shipping", "store", "weather"],
  accounting: ["cashbook", "payrollView", "ledger"],
};

export type RolePerms = Record<PermRole, Feature[]>;

/** 役割ごとに見せる画面（保存したもの。なければはじめの見せ方）。読み込み中は undefined */
export function useRolePerms(enabled = true): RolePerms | undefined {
  const [v, setV] = useState<RolePerms | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "config/rolePerms"),
        (s) =>
          setV({
            staff: s.exists() && Array.isArray(s.get("staff")) ? (s.get("staff") as Feature[]) : DEFAULT_PERMS.staff,
            accounting: s.exists() && Array.isArray(s.get("accounting")) ? (s.get("accounting") as Feature[]) : DEFAULT_PERMS.accounting,
          }),
        () => setV(DEFAULT_PERMS),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [enabled]);
  return v;
}

export async function saveRolePerms(p: RolePerms) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/rolePerms"), { staff: p.staff, accounting: p.accounting, updatedAt: serverTimestamp() });
}

/**
 * ログインしている人が使える画面。can(f)＝その画面を使えるか（管理者はいつも true、従業員は false）。
 * ready＝読み込みが終わったか
 */
export function usePerms(): { ready: boolean; can: (f: Feature) => boolean } {
  const { role } = useAuth();
  const member = role === "staff" || role === "accounting";
  const perms = useRolePerms(member);
  if (role === "admin") return { ready: true, can: () => true };
  if (!member) return { ready: role !== null, can: () => false };
  return { ready: perms !== undefined, can: (f) => !!perms?.[role].includes(f) };
}

/** アドレスに当たる画面（いちばん長く合うもの）。管理者だけの画面は "admin"、どれでもなければ null（メニューなど） */
export function featureOfPath(pathname: string): Feature | "admin" | null {
  const p = pathname.replace(/\/$/, "");
  const hit = (base: string) => p === base || p.startsWith(`${base}/`);
  let best: { f: Feature | "admin"; len: number } | null = null;
  for (const f of FEATURES) for (const base of f.paths) if (hit(base) && (!best || base.length > best.len)) best = { f: f.key, len: base.length };
  for (const base of ADMIN_PATHS) if (hit(base) && (!best || base.length > best.len)) best = { f: "admin", len: base.length };
  return best?.f ?? null;
}
