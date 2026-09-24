"use client";

import { onIdTokenChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getFirebase } from "./firebase";

/** 権限：admin=管理者、staff=スタッフ、null=権限なし */
export type Role = "admin" | "staff" | null;

type AuthState = {
  loading: boolean;
  user: User | null;
  role: Role;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** サーバー側で権限が変わったあとに、最新の権限を読み直す */
  refreshRole: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role>(null);

  useEffect(() => {
    let unsubscribe = () => {};
    getFirebase().then(({ auth }) => {
      unsubscribe = onIdTokenChanged(auth, async (u) => {
        if (u) {
          // 権限はサーバー側でログイン情報に付けた印（カスタムクレーム）から読む
          const token = await u.getIdTokenResult();
          const r = token.claims.role;
          setRole(r === "admin" || r === "staff" ? r : null);
        } else {
          setRole(null);
        }
        setUser(u);
        setLoading(false);
      });
    });
    return () => unsubscribe();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { auth } = await getFirebase();
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const logout = useCallback(async () => {
    const { auth } = await getFirebase();
    await signOut(auth);
  }, []);

  const refreshRole = useCallback(async () => {
    const { auth } = await getFirebase();
    await auth.currentUser?.getIdToken(true);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, user, role, login, logout, refreshRole }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth は AuthProvider の中で使ってください");
  return ctx;
}
