// セキュリティルールのテスト（練習用Firebase＝エミュレーターで実行）
import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, beforeEach, describe, it } from "vitest";

let env: RulesTestEnvironment;

beforeEach(async () => {
  env ??= await initializeTestEnvironment({
    projectId: "demo-ichigo",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  await env.clearFirestore();
  // スタッフ名簿の準備（u3 は無効にされたスタッフ）
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "staff/u1"), { role: "staff", active: true });
    await setDoc(doc(db, "staff/u2"), { role: "admin", active: true });
    await setDoc(doc(db, "staff/u3"), { role: "staff", active: false });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

const guest = () => env.unauthenticatedContext().firestore();
const noRole = () => env.authenticatedContext("u0").firestore();
const staff = () => env.authenticatedContext("u1", { role: "staff" }).firestore();
const admin = () => env.authenticatedContext("u2", { role: "admin" }).firestore();
const disabled = () => env.authenticatedContext("u3", { role: "staff" }).firestore();
// 名簿にないのに印だけ持っている人
const unknown = () => env.authenticatedContext("u9", { role: "admin" }).firestore();

describe("設定 (settings)", () => {
  it("ログインしていない人は読めない", async () => {
    await assertFails(getDoc(doc(guest(), "settings/main")));
  });
  it("権限のないアカウントは読めない", async () => {
    await assertFails(getDoc(doc(noRole(), "settings/main")));
  });
  it("スタッフは読めるが書けない", async () => {
    await assertSucceeds(getDoc(doc(staff(), "settings/main")));
    await assertFails(setDoc(doc(staff(), "settings/main"), { a: 1 }));
  });
  it("管理者は書ける", async () => {
    await assertSucceeds(setDoc(doc(admin(), "settings/main"), { a: 1 }));
  });
  it("無効にされたスタッフ・名簿にない人は読めない", async () => {
    await assertFails(getDoc(doc(disabled(), "settings/main")));
    await assertFails(getDoc(doc(unknown(), "settings/main")));
  });
});

describe("スタッフ名簿 (staff)", () => {
  it("スタッフは読める", async () => {
    await assertSucceeds(getDoc(doc(staff(), "staff/u2")));
  });
  it("ログインしていない人・権限のない人は読めない", async () => {
    await assertFails(getDoc(doc(guest(), "staff/u1")));
    await assertFails(getDoc(doc(noRole(), "staff/u1")));
  });
  it("管理者でも画面から直接は書き換えられない（サーバー経由のみ）", async () => {
    await assertFails(setDoc(doc(admin(), "staff/u1"), { role: "admin", active: true }));
    await assertFails(setDoc(doc(staff(), "staff/u1"), { role: "admin", active: true }));
  });
});

describe("ルールに書いていない場所", () => {
  it("管理者でも読み書きできない", async () => {
    await assertFails(getDoc(doc(admin(), "system/bootstrap")));
    await assertFails(setDoc(doc(admin(), "anything/x"), { a: 1 }));
  });
});
