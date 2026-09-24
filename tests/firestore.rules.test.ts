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

const validSettings = {
  storeName: "テスト農園",
  storePhone: "",
  storeAddress: "",
  seasonStart: "06-15",
  seasonEnd: "10-15",
  openTime: "08:00",
  closeTime: "17:00",
  closedDates: [],
  bookingDaysAhead: 30,
  bookingCutoffDays: 1,
  timeSlots: [{ id: "a", time: "10:00", capacity: 30 }],
  priceCategories: [{ id: "adult", name: "大人" }],
  plans: [{ id: "p", name: "30分", minutes: 30, prices: { adult: 1500 }, public: true }],
  products: [{ id: "j", name: "いちごジャム", group: "お土産", price: 800, active: true }],
};

describe("設定 (settings/main)", () => {
  it("誰でも読める（予約ページで使うため）", async () => {
    await assertSucceeds(getDoc(doc(guest(), "settings/main")));
    await assertSucceeds(getDoc(doc(noRole(), "settings/main")));
  });
  it("ログインしていない人・権限のない人・スタッフは書けない", async () => {
    await assertFails(setDoc(doc(guest(), "settings/main"), validSettings));
    await assertFails(setDoc(doc(noRole(), "settings/main"), validSettings));
    await assertFails(setDoc(doc(staff(), "settings/main"), validSettings));
  });
  it("管理者は書ける", async () => {
    await assertSucceeds(setDoc(doc(admin(), "settings/main"), validSettings));
  });
  it("無効にされた管理者・名簿にない人は書けない", async () => {
    await assertFails(setDoc(doc(disabled(), "settings/main"), validSettings));
    await assertFails(setDoc(doc(unknown(), "settings/main"), validSettings));
  });
  it("決められた項目以外や、形の違うデータは保存できない", async () => {
    await assertFails(setDoc(doc(admin(), "settings/main"), { ...validSettings, customerPhone: "090" }));
    await assertFails(setDoc(doc(admin(), "settings/main"), { ...validSettings, timeSlots: "10:00" }));
  });
  it("settings/main 以外の場所には書けない", async () => {
    await assertFails(setDoc(doc(admin(), "settings/other"), validSettings));
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

describe("予約・連絡先・空き状況", () => {
  it("予約と連絡先はスタッフだけが読める", async () => {
    await assertSucceeds(getDoc(doc(staff(), "reservations/r1")));
    await assertSucceeds(getDoc(doc(staff(), "reservationContacts/r1")));
    for (const db of [guest(), noRole(), disabled(), unknown()]) {
      await assertFails(getDoc(doc(db, "reservations/r1")));
      await assertFails(getDoc(doc(db, "reservationContacts/r1")));
    }
  });
  it("予約と連絡先は、管理者でも画面から直接は書けない（サーバー経由のみ）", async () => {
    await assertFails(setDoc(doc(admin(), "reservations/r1"), { people: 1 }));
    await assertFails(setDoc(doc(admin(), "reservationContacts/r1"), { phone: "0" }));
  });
  it("空き状況は誰でも読めるが、誰も直接は書けない", async () => {
    await assertSucceeds(getDoc(doc(guest(), "availability/2026-07-01")));
    await assertFails(setDoc(doc(guest(), "availability/2026-07-01"), { slots: {} }));
    await assertFails(setDoc(doc(admin(), "availability/2026-07-01"), { slots: {} }));
  });
});

describe("ルールに書いていない場所", () => {
  it("管理者でも読み書きできない", async () => {
    await assertFails(getDoc(doc(admin(), "system/bootstrap")));
    await assertFails(setDoc(doc(admin(), "anything/x"), { a: 1 }));
  });
});
