import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "./firebase";

/** サーバー側の処理（Cloud Functions）を呼び出す */
export async function callFunction<Req, Res = unknown>(name: string, data: Req): Promise<Res> {
  const { functions } = await getFirebase();
  const res = await httpsCallable<Req, Res>(functions, name)(data);
  return res.data;
}

/** エラーを画面に出す日本語の文にする */
export function errorText(e: unknown): string {
  if (e instanceof FirebaseError) {
    // サーバー側で日本語の説明を付けているものはそのまま出す
    if (e.code.startsWith("functions/") && e.code !== "functions/internal" && /[ぁ-んァ-ン一-龥]/.test(e.message)) {
      return cleanMessage(e.message);
    }
    if (e.code === "functions/unavailable" || e.code === "auth/network-request-failed") {
      return "通信できませんでした。電波の状態を確認してください。";
    }
    if (e.code === "permission-denied" || e.code === "firestore/permission-denied") {
      return "この操作をする権限がありません。";
    }
  }
  return "エラーが起きました。時間をおいてもう一度お試しください。";
}

/** サーバーからの説明文の末尾に付く番号（例：" [429]"）を取り除く */
export function cleanMessage(message: string): string {
  return message.replace(/\s*\[\d+\]$/, "");
}
