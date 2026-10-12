"use client";

// 請求書・納品書に押す印鑑（角印）。
// 紙に押した印鑑の写真・スキャンから、紙の白いところを透明にして朱色だけを残し、小さな画像（PNG）にして保存する。
// 画像はアプリのデータ（config/invoiceSeal）に入れ、スタッフ以外は見られない（プログラムには入れない）。
import { deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

const SEAL_DOC = "config/invoiceSeal";
/** 保存する画像の大きさ（いちばん長い辺のピクセル数） */
const SIZE = 360;

/** 印鑑の画像（なければ ""、読み込み中は null） */
export function useSeal(): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, SEAL_DOC),
        (s) => setValue((s.get("image") as string) ?? ""),
        () => setValue(""),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return value;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((ok, ng) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      ok(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      ng(new Error("画像を開けませんでした（写真やスキャンの画像を選んでください）"));
    };
    img.src = url;
  });
}

/** 写真から、紙の部分を透明にして朱肉の色だけを残し、印鑑のまわりで切り抜いた PNG（data URL）にする */
export async function sealFromPhoto(file: File): Promise<string> {
  const img = await loadImage(file);
  const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  const px = d.data;
  // 朱色の濃さ：赤が強く、緑・青が弱いほど濃い。紙（白〜灰色）は 0 になる
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const ink = Math.max(0, Math.min(1, (r - (g + b) / 2 - 20) / 60));
    px[i] = 205;
    px[i + 1] = 35;
    px[i + 2] = 35;
    px[i + 3] = Math.round(ink * 255);
    if (ink > 0.5) {
      const p = i / 4;
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("赤い印影が見つかりませんでした。白い紙に押した印鑑を、明るいところで撮ってください");
  ctx.putImageData(d, 0, 0);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const k = Math.min(1, SIZE / Math.max(cw, ch));
  const out = document.createElement("canvas");
  out.width = Math.round(cw * k);
  out.height = Math.round(ch * k);
  out.getContext("2d")!.drawImage(c, x0, y0, cw, ch, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

export async function saveSeal(image: string) {
  const { db } = await getFirebase();
  await setDoc(doc(db, SEAL_DOC), { image, updatedAt: serverTimestamp() });
}
export async function removeSeal() {
  const { db } = await getFirebase();
  await deleteDoc(doc(db, SEAL_DOC));
}
