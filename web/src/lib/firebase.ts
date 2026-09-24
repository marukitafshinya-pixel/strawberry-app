import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";

export type FirebaseServices = { app: FirebaseApp; auth: Auth; db: Firestore };

const useEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === "true";

/**
 * Firebaseの接続設定を取得する。
 * - Firebase Hosting 上では、Hosting が用意する /__/firebase/init.json から読む（コードに値を書かない）
 * - パソコン上では .env.local の値を使う
 */
async function loadConfig(): Promise<FirebaseOptions> {
  if (!useEmulator) {
    try {
      const res = await fetch("/__/firebase/init.json");
      if (res.ok) return (await res.json()) as FirebaseOptions;
    } catch {
      // Hosting 以外で動いているときは下の設定を使う
    }
  }
  return {
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "emulator-api-key",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

let servicesPromise: Promise<FirebaseServices> | null = null;

/** Firebase を1回だけ初期化して、ログイン機能とデータベースを返す */
export function getFirebase(): Promise<FirebaseServices> {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const app = getApps()[0] ?? initializeApp(await loadConfig());
      const auth = getAuth(app);
      const db = getFirestore(app);
      if (useEmulator) {
        connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
        connectFirestoreEmulator(db, "127.0.0.1", 8080);
      }
      return { app, auth, db };
    })();
  }
  return servicesPromise;
}
