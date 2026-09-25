// ロボット対策（Firebase App Check ＋ reCAPTCHA Enterprise）
// 予約ページからの送信が、本物のブラウザからのものかをGoogleに確かめてもらう。
import { getFirebase } from "./firebase";

/**
 * reCAPTCHA の「サイトキー」（プロジェクトごと）。
 * これは秘密の値ではなく、予約ページの中で誰でも見られる前提の公開用の値。
 * 登録したドメイン（ichigo-test-d0fa2.web.app など）以外では使えない。
 */
const SITE_KEYS: Record<string, string> = {
  "ichigo-test-d0fa2": "6LdHls0tAAAAAJSSMlh4X5gW1v7Z-0kucgPainBT",
};

let ready: Promise<void> | null = null;

/** 予約ページで1回だけ App Check を有効にする（失敗しても予約ページ自体は使えるようにする） */
export function ensureAppCheck(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      if (process.env.NEXT_PUBLIC_USE_EMULATOR === "true") return;
      const { app } = await getFirebase();
      const key = SITE_KEYS[app.options.projectId ?? ""];
      if (!key) return;
      const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import("firebase/app-check");
      initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(key), isTokenAutoRefreshEnabled: true });
    })().catch(() => {});
  }
  return ready;
}
