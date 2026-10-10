"use client";

// 勤務管理表：従業員・日ごとの勤務・休みの希望
import { collection, deleteField, doc, documentId, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

/** 勤務の記号。off＝休み（出勤人数に数えない）、req＝従業員が希望として出せる */
export type ShiftCode = { code: string; off: boolean; req: boolean; color: string };
/** contact＝締め切りを過ぎた希望の変更を直接確認する相手（従業員の画面に出す）。まだ決めていなければ undefined */
export type ShiftConfig = { codes: ShiftCode[]; groups: string[]; cutoffDays: number; contact?: string };
export type ShiftMember = { id: string; name: string; group: string; floor: boolean; /** 収穫ができる */ harvest?: boolean; order: number; active: boolean; uid?: string; loginId?: string };
export type ShiftDay = { cells: Record<string, string>; note: string };
export type ShiftRequest = { id: string; memberId: string; uid: string; date: string; code: string; memo: string; status: "pending" | "approved" | "rejected" };

/** マスの色（記号ごと） */
export const CODE_COLORS: Record<string, string> = {
  none: "",
  pink: "bg-pink-100 text-pink-900",
  gray: "bg-gray-200 text-gray-700",
  yellow: "bg-amber-100 text-amber-900",
  blue: "bg-sky-100 text-sky-900",
  green: "bg-emerald-100 text-emerald-900",
};

/** はじめの設定（いただいたExcelの記号と同じ） */
export const DEFAULT_SHIFT_CONFIG: ShiftConfig = {
  codes: [
    { code: "〇", off: false, req: false, color: "none" },
    { code: "希休", off: true, req: true, color: "pink" },
    { code: "指休", off: true, req: false, color: "gray" },
    { code: "AM", off: false, req: true, color: "yellow" },
    { code: "PM", off: false, req: true, color: "yellow" },
    { code: "～12:00", off: false, req: true, color: "blue" },
    { code: "～13:00", off: false, req: true, color: "blue" },
    { code: "～14:00", off: false, req: true, color: "blue" },
    { code: "～15:00", off: false, req: true, color: "blue" },
    { code: "～16:00", off: false, req: true, color: "blue" },
  ],
  groups: ["男性", "売り場担当可", "女性"],
  cutoffDays: 14,
};

function useDoc<T>(path: string, parse: (d: Record<string, unknown> | undefined) => T): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, path),
        (s) => setV(parse(s.exists() ? s.data() : undefined)),
        () => setV(parse(undefined)),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return v;
}

export function useShiftConfig(): ShiftConfig | null {
  return useDoc("config/shift", (d) => {
    if (!d) return DEFAULT_SHIFT_CONFIG;
    const codes = Array.isArray(d.codes) ? (d.codes as ShiftCode[]).filter((c) => c && typeof c.code === "string") : DEFAULT_SHIFT_CONFIG.codes;
    const groups = Array.isArray(d.groups) ? (d.groups as string[]).filter((g) => typeof g === "string") : DEFAULT_SHIFT_CONFIG.groups;
    return {
      codes,
      groups: groups.length ? groups : DEFAULT_SHIFT_CONFIG.groups,
      cutoffDays: Number(d.cutoffDays ?? 14) || 14,
      contact: typeof d.contact === "string" ? d.contact : undefined,
    };
  });
}

export function useShiftMembers(): ShiftMember[] | null {
  const [v, setV] = useState<ShiftMember[] | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "shiftMembers"), orderBy("order")),
        (snap) => setV(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ShiftMember, "id">) }))),
        () => setV([]),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}

/** 期間内の日ごとの勤務（日付 → 勤務） */
export function useShiftDays(from: string, to: string): Record<string, ShiftDay> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; data: Record<string, ShiftDay> } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(query(collection(db, "shiftDays"), where(documentId(), ">=", from), where(documentId(), "<=", to)), (snap) =>
        setState({
          key,
          data: Object.fromEntries(snap.docs.map((d) => [d.id, { cells: (d.get("cells") as Record<string, string>) ?? {}, note: (d.get("note") as string) ?? "" }])),
        }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [from, to, key]);
  // 表示する日を増やしたときに表が消えないよう、読み込み中は前の内容を返す
  return state ? state.data : null;
}

/**
 * 勤務表に出す日数。表を右へ動かして端に近づくと、先の日を足していく（日数の上限なし）。
 * 先頭の日を変えたら、はじめの日数に戻す
 */
export function useGrowingSpan(from: string, initial = 42, step = 28): [number, () => void] {
  const [s, setS] = useState({ from, span: initial });
  const span = s.from === from ? s.span : initial;
  return [span, () => setS({ from, span: span + step })];
}

/** 期間内の、いちご狩りの予約人数（日付 → 人数）。予約ページの空き状況（時間枠ごとの人数）を足す */
export function useReservedPeople(from: string, to: string): Record<string, number> | null {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; data: Record<string, number> } | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        query(collection(db, "availability"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
        (snap) =>
          setState({
            key,
            data: Object.fromEntries(
              snap.docs.map((d) => [d.id, Object.values((d.get("slots") as Record<string, number>) ?? {}).reduce((n, x) => n + (Number(x) || 0), 0)]),
            ),
          }),
        () => setState({ key, data: {} }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [from, to, key]);
  return state ? state.data : null;
}

/** 休みの希望。uid を渡すとその人の分だけ（従業員用）、渡さなければ決まっていない希望すべて（管理者用） */
export function useShiftRequests(uid?: string): ShiftRequest[] | null {
  const [v, setV] = useState<ShiftRequest[] | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      const q = uid ? query(collection(db, "shiftRequests"), where("uid", "==", uid)) : query(collection(db, "shiftRequests"), where("status", "==", "pending"));
      unsub = onSnapshot(
        q,
        (snap) => setV(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ShiftRequest, "id">) })).sort((a, b) => a.date.localeCompare(b.date))),
        () => setV([]),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [uid]);
  return v;
}

/** マスに記号を入れる（"" なら消す） */
export async function setShiftCell(date: string, memberId: string, code: string) {
  const { db } = await getFirebase();
  const ref = doc(db, `shiftDays/${date}`);
  if (code) await setDoc(ref, { cells: { [memberId]: code }, updatedAt: serverTimestamp() }, { merge: true });
  else await setDoc(ref, { cells: { [memberId]: deleteField() }, updatedAt: serverTimestamp() }, { merge: true });
}

/** その日の何人かのマスを、まとめて書き換える（"" の人は空にする） */
export async function writeShiftCells(date: string, cells: Record<string, string>) {
  const { db } = await getFirebase();
  const next = Object.fromEntries(Object.entries(cells).map(([id, c]) => [id, c ? c : deleteField()]));
  await setDoc(doc(db, `shiftDays/${date}`), { cells: next, updatedAt: serverTimestamp() }, { merge: true });
}

/** その日の記号を、そのまま別の日にコピーする（その日に記号がない人は、コピー先も空にする） */
export async function copyShiftDay(to: string, memberIds: string[], cells: Record<string, string>) {
  const { db } = await getFirebase();
  const next = Object.fromEntries(memberIds.map((id) => [id, cells[id] ? cells[id] : deleteField()]));
  await setDoc(doc(db, `shiftDays/${to}`), { cells: next, updatedAt: serverTimestamp() }, { merge: true });
}

export async function setShiftNote(date: string, note: string) {
  const { db } = await getFirebase();
  await setDoc(doc(db, `shiftDays/${date}`), { note: note.trim().slice(0, 50), updatedAt: serverTimestamp() }, { merge: true });
}

/** 希望を承認する（表のマスにその記号を入れる）・却下する */
export async function decideRequest(r: ShiftRequest, approve: boolean, by: string) {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  if (approve) batch.set(doc(db, `shiftDays/${r.date}`), { cells: { [r.memberId]: r.code }, updatedAt: serverTimestamp() }, { merge: true });
  batch.update(doc(db, `shiftRequests/${r.id}`), { status: approve ? "approved" : "rejected", decidedAt: serverTimestamp(), decidedBy: by });
  await batch.commit();
}

export async function saveShiftConfig(c: ShiftConfig) {
  const { db } = await getFirebase();
  await setDoc(doc(db, "config/shift"), {
    codes: c.codes,
    groups: c.groups,
    cutoffDays: Math.round(c.cutoffDays),
    ...(c.contact !== undefined ? { contact: c.contact.trim().slice(0, 20) } : {}),
    updatedAt: serverTimestamp(),
  });
}

export async function saveMember(m: Omit<ShiftMember, "id" | "uid" | "loginId"> & { id?: string }) {
  const { db } = await getFirebase();
  const data = { name: m.name.trim().slice(0, 30), group: m.group, floor: m.floor, harvest: m.harvest === true, order: m.order, active: m.active, updatedAt: serverTimestamp() };
  if (m.id) await updateDoc(doc(db, `shiftMembers/${m.id}`), data);
  else await setDoc(doc(collection(db, "shiftMembers")), data);
}

/** まとまりの名前を変えたとき、そのまとまりの従業員もまとめて付け替える */
export async function renameMemberGroup(members: ShiftMember[], from: string, to: string) {
  const targets = members.filter((m) => m.group === from);
  if (targets.length === 0) return;
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  for (const m of targets) batch.update(doc(db, `shiftMembers/${m.id}`), { group: to, updatedAt: serverTimestamp() });
  await batch.commit();
}

/** 勤務表（全部の日）で使われている記号と、そのマスの数 */
export async function countShiftCodes(): Promise<Record<string, number>> {
  const { db } = await getFirebase();
  const snap = await getDocs(collection(db, "shiftDays"));
  const out: Record<string, number> = {};
  for (const d of snap.docs) for (const v of Object.values((d.get("cells") as Record<string, string>) ?? {})) if (v) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/**
 * 勤務表（全部の日）のマスの記号を置き換える（記号のリストで名前を変えたとき）。
 * map は 古い記号 → 新しい記号。置き換えたマスの数を返す
 */
export async function replaceShiftCodes(map: Record<string, string>): Promise<number> {
  const olds = Object.keys(map).filter((k) => map[k] && map[k] !== k);
  if (olds.length === 0) return 0;
  const { db } = await getFirebase();
  const snap = await getDocs(collection(db, "shiftDays"));
  let count = 0;
  let batch = writeBatch(db);
  let n = 0;
  for (const d of snap.docs) {
    const cells = (d.get("cells") as Record<string, string>) ?? {};
    const changed: Record<string, string> = {};
    for (const [m, v] of Object.entries(cells)) if (olds.includes(v)) changed[m] = map[v];
    if (Object.keys(changed).length === 0) continue;
    count += Object.keys(changed).length;
    batch.set(d.ref, { cells: changed, updatedAt: serverTimestamp() }, { merge: true });
    if (++n >= 400) {
      await batch.commit();
      batch = writeBatch(db);
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
  return count;
}

/** 出勤に数える記号か。記号のリストにあって「休みとして数える」でない記号だけ（リストにない古い記号などは数えない） */
export const isWorking = (cfg: ShiftConfig, code: string | undefined) => {
  const c = !!code && cfg.codes.find((x) => x.code === code);
  return !!c && !c.off;
};
export const codeColor = (cfg: ShiftConfig, code: string | undefined) => CODE_COLORS[cfg.codes.find((c) => c.code === code)?.color ?? "none"] ?? "";
