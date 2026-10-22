"use client";

// データのバックアップ：Firestore の全データを1つのファイル（JSON）にして、パソコンに保存する（管理者だけ）。
// - 「今すぐダウンロード」：その場でファイルを保存する
// - 自動保存：パソコンの保存先フォルダを一度選んでおくと、バックアップの画面を開いている間、毎晩決めた時刻に自動で保存する
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { getFirebase } from "./firebase";

/** まるごと保存するデータの入れ物（コレクション） */
export const BACKUP_COLLECTIONS = [
  "staff",
  "workers",
  "reservations",
  "reservationContacts",
  "availability",
  "dailyCapacity",
  "sales",
  "receivables",
  "importedSales",
  "otherSales",
  "customers",
  "cashCounts",
  "cashbook",
  "journal",
  "autoJournal",
  "bank",
  "tbImport",
  "itemReferences",
  "storeDaily",
  "shipments",
  "weather",
  "cafeCalls",
  "employees",
  "payrolls",
  "goals",
  "timecards",
  "shiftMembers",
  "shiftDays",
  "shiftRequests",
  "haichi",
  "harvest",
  "houseUse",
] as const;
/** 1つずつ保存する設定（config などは、まとめて読めないので名前で読む） */
export const BACKUP_DOCS = [
  "settings/main",
  "config/invoice",
  "config/invoiceSeal",
  "config/harvest",
  "config/menu",
  "config/cashbookItems",
  "config/accounts",
  "config/register",
  "config/timecard",
  "config/haichi",
  "config/shift",
  "shipping/config",
] as const;

export type BackupFile = {
  app: "ichigo-backup";
  version: 1;
  exportedAt: string;
  collections: Record<string, Record<string, unknown>>;
  docs: Record<string, unknown>;
  counts: Record<string, number>;
};

/** 日時（Firestore の Timestamp）は {"__time": "2026-10-11T12:00:00.000Z"} の形にする（あとで元に戻せるように） */
function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(plain);
  const o = v as Record<string, unknown> & { toDate?: () => Date };
  if (typeof o.toDate === "function" && "seconds" in o && "nanoseconds" in o) return { __time: o.toDate().toISOString() };
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
}

/** 全データを読む。onProgress で、いまどのデータを読んでいるかを知らせる */
export async function exportAll(onProgress?: (label: string) => void): Promise<BackupFile> {
  const { db } = await getFirebase();
  const out: BackupFile = { app: "ichigo-backup", version: 1, exportedAt: new Date().toISOString(), collections: {}, docs: {}, counts: {} };
  for (const name of BACKUP_COLLECTIONS) {
    onProgress?.(name);
    const snap = await getDocs(collection(db, name)).catch((e) => {
      throw new Error(`「${name}」を読めませんでした（${e instanceof Error ? e.message : e}）`);
    });
    out.collections[name] = Object.fromEntries(snap.docs.map((d) => [d.id, plain(d.data())]));
    out.counts[name] = snap.size;
  }
  for (const path of BACKUP_DOCS) {
    onProgress?.(path);
    const s = await getDoc(doc(db, path));
    if (s.exists()) out.docs[path] = plain(s.data());
  }
  return out;
}

/** 日本時間の日付（ファイル名に使う） */
export function ymdJST(d = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
}
export const backupFileName = (ymd: string) => `ichigo-backup-${ymd}.json`;
const FILE_RE = /^ichigo-backup-(\d{4}-\d{2}-\d{2})\.json$/;

export function downloadBackup(data: BackupFile) {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFileName(ymdJST());
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- パソコンの保存先フォルダ（Chrome・Edge の機能。選んだフォルダを、このブラウザが覚えておく） ----

type PermState = "granted" | "denied" | "prompt";
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: "readwrite" }) => Promise<PermState>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<PermState>;
  values?: () => AsyncIterable<FileSystemHandle>;
};

export const canPickFolder = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, ng) => {
    const r = indexedDB.open("ichigo-backup", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
}
async function kvGet<T>(key: string): Promise<T | undefined> {
  const d = await idb();
  return new Promise((ok, ng) => {
    const r = d.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => ok(r.result as T | undefined);
    r.onerror = () => ng(r.error);
  });
}
async function kvSet(key: string, v: unknown): Promise<void> {
  const d = await idb();
  return new Promise((ok, ng) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").put(v, key);
    t.oncomplete = () => ok();
    t.onerror = () => ng(t.error);
  });
}

export async function pickFolder(): Promise<DirHandle> {
  const h = (await (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker({
    id: "ichigo-backup",
    mode: "readwrite",
  })) as DirHandle;
  await kvSet("dir", h);
  return h;
}
export async function savedFolder(): Promise<DirHandle | undefined> {
  try {
    return await kvGet<DirHandle>("dir");
  } catch {
    return undefined;
  }
}
/** 保存先に書いてよいか（ブラウザを開き直すと、もう一度「許可」がいることがある） */
export async function folderPermission(h: DirHandle, ask: boolean): Promise<PermState> {
  if (!h.queryPermission) return "granted";
  const p = await h.queryPermission({ mode: "readwrite" });
  if (p === "granted" || !ask || !h.requestPermission) return p;
  return h.requestPermission({ mode: "readwrite" });
}

/** フォルダにその日のファイルを書き、keepDays 日より古いバックアップのファイルを消す */
export async function writeToFolder(h: DirHandle, data: BackupFile, keepDays: number): Promise<{ name: string; bytes: number; removed: number }> {
  const ymd = ymdJST();
  const text = JSON.stringify(data);
  const f = await h.getFileHandle(backupFileName(ymd), { create: true });
  const w = await f.createWritable();
  await w.write(text);
  await w.close();
  let removed = 0;
  if (h.values) {
    const limit = new Date(Date.now() - keepDays * 86400_000);
    const oldest = ymdJST(limit);
    for await (const e of h.values()) {
      const m = e.kind === "file" ? FILE_RE.exec(e.name) : null;
      if (m && m[1] < oldest) {
        await h.removeEntry(e.name);
        removed++;
      }
    }
  }
  return { name: backupFileName(ymd), bytes: new Blob([text]).size, removed };
}
