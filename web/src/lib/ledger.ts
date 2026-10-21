"use client";

// 総勘定元帳（会計ソフトから印刷してスキャンしたもの）の読み込み：作業用フォルダの「経費の仕分け」で使う（管理者だけ）。
// 1ページずつAIで読み取り、科目ごとにまとめて、月度合計・総合計と合うかを確かめてから ledgers/{期間のはじめ}/accounts/{科目コード} に保存する
import { collection, doc, onSnapshot, serverTimestamp, writeBatch } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { filesToPages, type Page } from "./shikiri";

export type LedgerEntry = {
  /** 伝票No. */
  no: string;
  date: string;
  /** 相手科目（普通預金・組勘勘定・仮払金など） */
  counter: string;
  /** 補助（北洋銀行・JCBなど） */
  sub: string;
  /** 品名（摘要の上の段） */
  item: string;
  /** 取引先（摘要の下の段）。消費税の行は、同じ品名の行の取引先を入れる */
  partner: string;
  /** 消費税の行 */
  isTax: boolean;
  debit: number;
  credit: number;
  taxRate: string;
};
export type LedgerTotal = { debit: number; credit: number; count: number | null };
export type LedgerMonthTotal = LedgerTotal & { month: string };
/** AIが1ページから読み取ったもの */
export type LedgerPageResult = {
  accountCode: string;
  accountName: string;
  periodFrom: string;
  periodTo: string;
  entries: LedgerEntry[];
  monthTotals: LedgerMonthTotal[];
  grandTotal: LedgerTotal | null;
  notes: string;
};
/** 科目ごとにまとめたもの（保存する形） */
export type LedgerAccount = {
  code: string;
  name: string;
  periodFrom: string;
  periodTo: string;
  entries: LedgerEntry[];
  monthTotals: LedgerMonthTotal[];
  grandTotal: LedgerTotal | null;
  /** 読み取ったページ（画面の何ページ目か。確かめるときに画像を出す） */
  pages: number[];
  notes: string[];
};

// ---------- ファイル → ページの画像 ----------

/** TIFF（何ページでも）・PDF・写真を、ページごとの画像にする。元帳は縦長のまま使う */
export async function ledgerFilesToPages(files: File[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const f of files) {
    if (/\.tiff?$/i.test(f.name) || f.type === "image/tiff") {
      const UTIF = (await import("utif")).default;
      const buf = await f.arrayBuffer();
      let i = 0;
      for (const ifd of UTIF.decode(buf)) {
        UTIF.decodeImage(buf, ifd);
        // 小さい見本の画像（サムネイル）は使わない
        if (!ifd.width || !ifd.height || Math.max(ifd.width, ifd.height) < 500) continue;
        const rgba = UTIF.toRGBA8(ifd);
        const canvas = document.createElement("canvas");
        canvas.width = ifd.width;
        canvas.height = ifd.height;
        canvas.getContext("2d")!.putImageData(new ImageData(Uint8ClampedArray.from(rgba), ifd.width, ifd.height), 0, 0);
        pages.push({ name: `${f.name}（${++i}ページ）`, canvas: shrink(canvas), rotate: 0 });
      }
    } else {
      for (const p of await filesToPages([f])) pages.push({ ...p, rotate: 0 });
    }
  }
  return pages;
}

/** 送る画像の長い辺 */
const LONG_EDGE = 2576;
function shrink(c: HTMLCanvasElement): HTMLCanvasElement {
  const s = LONG_EDGE / Math.max(c.width, c.height);
  if (s >= 1) return c;
  const out = document.createElement("canvas");
  out.width = Math.round(c.width * s);
  out.height = Math.round(c.height * s);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0, out.width, out.height);
  return out;
}

/** 1ページを、AIに送るJPEGにする */
export function ledgerPageUpload(p: Page): { mediaType: "image/jpeg"; data: string } {
  const url = p.canvas.toDataURL("image/jpeg", 0.88);
  return { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

// ---------- 読み取った結果をまとめる・確かめる ----------

/** ページごとの結果を、科目ごとにまとめる（ページの順のまま） */
export function combineLedger(results: (LedgerPageResult | null)[]): LedgerAccount[] {
  const byCode = new Map<string, LedgerAccount>();
  results.forEach((r, i) => {
    if (!r) return;
    const code = r.accountCode.trim() || "不明";
    let a = byCode.get(code);
    if (!a) {
      a = { code, name: r.accountName, periodFrom: r.periodFrom, periodTo: r.periodTo, entries: [], monthTotals: [], grandTotal: null, pages: [], notes: [] };
      byCode.set(code, a);
    }
    a.pages.push(i);
    a.entries.push(...r.entries.map((e) => ({ ...e })));
    for (const m of r.monthTotals) if (!a.monthTotals.some((x) => x.month === m.month)) a.monthTotals.push(m);
    if (r.grandTotal) a.grandTotal = r.grandTotal;
    if (r.notes) a.notes.push(`${i + 1}ページ：${r.notes}`);
  });
  for (const a of byCode.values()) fillTaxPartners(a.entries);
  return [...byCode.values()].sort((x, y) => x.code.localeCompare(y.code));
}

/** 消費税の行に、すぐ上の同じ品名の行の取引先を入れる（仕入れ先ごとにまとめるため） */
export function fillTaxPartners(entries: LedgerEntry[]) {
  entries.forEach((e, i) => {
    if (!e.isTax || e.partner) return;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (!entries[j].isTax && entries[j].item === e.item) {
        e.partner = entries[j].partner;
        return;
      }
    }
  });
}

export type LedgerCheck = { label: string; read: number; expected: number; ok: boolean };
/** 月度合計・総合計と、明細を足した額をくらべる */
export function checkLedger(a: LedgerAccount): LedgerCheck[] {
  const out: LedgerCheck[] = [];
  const net = (e: LedgerEntry) => e.debit - e.credit;
  for (const m of [...a.monthTotals].sort((x, y) => x.month.localeCompare(y.month))) {
    const read = a.entries.filter((e) => e.date.slice(0, 7) === m.month).reduce((s, e) => s + net(e), 0);
    const expected = m.debit - m.credit;
    out.push({ label: `${Number(m.month.slice(5))}月度`, read, expected, ok: read === expected });
  }
  if (a.grandTotal) {
    const read = a.entries.reduce((s, e) => s + net(e), 0);
    const expected = a.grandTotal.debit - a.grandTotal.credit;
    out.push({ label: "総合計", read, expected, ok: read === expected });
  }
  return out;
}

// ---------- 保存・読み込み ----------

/** 科目ごとに保存する（同じ期間・同じ科目は入れ替える） */
export async function saveLedgerAccounts(accounts: LedgerAccount[]) {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  for (const a of accounts) {
    const period = a.periodFrom;
    batch.set(doc(db, "ledgers", period), { from: a.periodFrom, to: a.periodTo, updatedAt: serverTimestamp() }, { merge: true });
    batch.set(doc(db, "ledgers", period, "accounts", a.code), {
      code: a.code,
      name: a.name,
      entries: a.entries,
      monthTotals: a.monthTotals,
      grandTotal: a.grandTotal,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

export type SavedAccount = Omit<LedgerAccount, "pages" | "notes" | "periodFrom" | "periodTo">;
/** 保存してある期間の一覧（新しい順） */
export function useLedgerPeriods(): { from: string; to: string }[] | null {
  const [v, setV] = useState<{ from: string; to: string }[] | null>(null);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        collection(db, "ledgers"),
        (s) => setV(s.docs.map((d) => ({ from: d.id, to: String(d.get("to") ?? "") })).sort((a, b) => b.from.localeCompare(a.from))),
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

/** その期間の、保存してある科目 */
export function useLedgerAccounts(period: string | null): SavedAccount[] | null {
  const [v, setV] = useState<{ period: string; list: SavedAccount[] } | null>(null);
  useEffect(() => {
    if (!period) return;
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        collection(db, "ledgers", period, "accounts"),
        (s) => setV({ period, list: s.docs.map((d) => d.data() as SavedAccount).sort((a, b) => a.code.localeCompare(b.code)) }),
        () => setV({ period, list: [] }),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [period]);
  return period && v?.period === period ? v.list : null;
}
