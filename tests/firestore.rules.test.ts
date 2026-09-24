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
});

afterAll(async () => {
  await env?.cleanup();
});

const guest = () => env.unauthenticatedContext().firestore();
const noRole = () => env.authenticatedContext("u0").firestore();
const staff = () => env.authenticatedContext("u1", { role: "staff" }).firestore();
const admin = () => env.authenticatedContext("u2", { role: "admin" }).firestore();

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
});

describe("ルールに書いていない場所", () => {
  it("管理者でも読み書きできない", async () => {
    await assertFails(getDoc(doc(admin(), "anything/x")));
    await assertFails(setDoc(doc(admin(), "anything/x"), { a: 1 }));
  });
});
