"use client";

// レジの共通設定（どのiPadでも同じ）：領収書の「扱者」に選ぶ名前のリスト
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

export function useHandlers(): string[] | null {
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "config/register"),
        (s) => setList(((s.get("handlers") as string[] | undefined) ?? []).filter((x) => typeof x === "string")),
        () => setList([]),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return list;
}

export async function saveHandlers(list: string[]) {
  const { db } = await getFirebase();
  const clean = [...new Set(list.map((x) => x.trim().slice(0, 20)).filter(Boolean))].slice(0, 30);
  await setDoc(doc(db, "config/register"), { handlers: clean, updatedAt: serverTimestamp() });
}

/** この端末で最後に選んだ扱者（次の領収書でも同じ人を選んでおく） */
const LAST_KEY = "ichigo.lastHandler";
export function loadLastHandler(): string {
  try {
    return window.localStorage.getItem(LAST_KEY) ?? "";
  } catch {
    return "";
  }
}
export function saveLastHandler(name: string) {
  try {
    window.localStorage.setItem(LAST_KEY, name);
  } catch {
    // 保存できなくてもよい
  }
}
