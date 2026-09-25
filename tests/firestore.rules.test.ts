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

describe("この日だけの定員 (dailyCapacity)", () => {
  it("誰でも読める", async () => {
    await assertSucceeds(getDoc(doc(guest(), "dailyCapacity/2026-07-01")));
  });
  it("管理者だけが書ける", async () => {
    await assertSucceeds(setDoc(doc(admin(), "dailyCapacity/2026-07-01"), { slots: { a: 10 } }));
    await assertFails(setDoc(doc(staff(), "dailyCapacity/2026-07-01"), { slots: { a: 10 } }));
    await assertFails(setDoc(doc(guest(), "dailyCapacity/2026-07-01"), { slots: { a: 10 } }));
  });
  it("形の違うデータや日付でない場所には書けない", async () => {
    await assertSucceeds(setDoc(doc(admin(), "dailyCapacity/2026-07-02"), { stopped: { a: true } }));
    await assertFails(setDoc(doc(staff(), "dailyCapacity/2026-07-02"), { stopped: { a: true } }));
    await assertFails(setDoc(doc(admin(), "dailyCapacity/2026-07-01"), { stopped: true }));
    await assertFails(setDoc(doc(admin(), "dailyCapacity/2026-07-01"), { slots: 10 }));
    await assertFails(setDoc(doc(admin(), "dailyCapacity/2026-07-01"), { slots: {}, extra: 1 }));
    await assertFails(setDoc(doc(admin(), "dailyCapacity/abc"), { slots: {} }));
  });
});

describe("会計・売掛・過去売上", () => {
  it("会計・売掛はスタッフだけが読め、誰も直接は書けない", async () => {
    await assertSucceeds(getDoc(doc(staff(), "sales/s1")));
    await assertSucceeds(getDoc(doc(staff(), "receivables/r1")));
    for (const db of [guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "sales/s1")));
      await assertFails(getDoc(doc(db, "receivables/r1")));
    }
    await assertFails(setDoc(doc(admin(), "sales/s1"), { total: 1 }));
    await assertFails(setDoc(doc(admin(), "receivables/r1"), { amount: 1 }));
  });
  it("過去売上の取り込みは管理者だけ", async () => {
    await assertSucceeds(setDoc(doc(admin(), "importedSales/2025-07-01"), { amount: 12000, source: "airregi" }));
    await assertFails(setDoc(doc(staff(), "importedSales/2025-07-01"), { amount: 12000, source: "airregi" }));
    await assertFails(setDoc(doc(admin(), "importedSales/2025-07-01"), { amount: "12000", source: "airregi" }));
    await assertSucceeds(getDoc(doc(staff(), "importedSales/2025-07-01")));
    await assertFails(getDoc(doc(guest(), "importedSales/2025-07-01")));
  });
  it("去年の商品別の実績は管理者だけが取り込み、スタッフは見るだけ", async () => {
    const data = { from: "2025-06-01", to: "2025-11-30", items: [{ name: "いちごジャム", category: "直売", amount: 104550, qty: 141 }] };
    await assertSucceeds(setDoc(doc(admin(), "itemReferences/2025-06-01_2025-11-30"), data));
    await assertFails(setDoc(doc(admin(), "itemReferences/abc"), data));
    await assertFails(setDoc(doc(admin(), "itemReferences/2025-06-01_2025-11-30"), { ...data, extra: 1 }));
    await assertFails(setDoc(doc(staff(), "itemReferences/2025-06-01_2025-11-30"), data));
    await assertSucceeds(getDoc(doc(staff(), "itemReferences/2025-06-01_2025-11-30")));
    await assertFails(getDoc(doc(guest(), "itemReferences/2025-06-01_2025-11-30")));
  });
});

describe("給与（管理者のみ）", () => {
  it("従業員と給与は管理者だけが読み書きできる", async () => {
    await assertSucceeds(setDoc(doc(admin(), "employees/e1"), { name: "山田", accountNumber: "1234567" }));
    await assertSucceeds(getDoc(doc(admin(), "employees/e1")));
    await assertSucceeds(setDoc(doc(admin(), "payrolls/2026-07"), { paymentDate: "2026-08-15", rows: {}, employer: {} }));
    for (const db of [staff(), guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "employees/e1")));
      await assertFails(getDoc(doc(db, "payrolls/2026-07")));
      await assertFails(setDoc(doc(db, "payrolls/2026-07"), { paymentDate: "2026-08-15", rows: {}, employer: {} }));
    }
  });
  it("月の形や項目が違うものは保存できない", async () => {
    await assertFails(setDoc(doc(admin(), "payrolls/2026-7"), { paymentDate: "", rows: {}, employer: {} }));
    await assertFails(setDoc(doc(admin(), "payrolls/2026-07"), { rows: {}, employer: {}, secret: 1 }));
  });
});

describe("出荷実績", () => {
  it("スタッフは出荷を入力でき、規格の設定は読むだけ", async () => {
    await assertSucceeds(setDoc(doc(staff(), "shipments/2026-07-01"), { items: { g1: { qty: 10, price: 500 } } }));
    await assertSucceeds(getDoc(doc(staff(), "shipping/config")));
    await assertFails(setDoc(doc(staff(), "shipping/config"), { destination: "x", grades: [] }));
    await assertSucceeds(setDoc(doc(admin(), "shipping/config"), { destination: "JA", grades: [] }));
  });
  it("ログインしていない人は出荷を読めない・書けない", async () => {
    await assertFails(getDoc(doc(guest(), "shipments/2026-07-01")));
    await assertFails(setDoc(doc(guest(), "shipments/2026-07-01"), { items: {} }));
    await assertFails(setDoc(doc(staff(), "shipments/abc"), { items: {} }));
  });
});

describe("連続送信の記録 (rateLimits)", () => {
  it("誰も読み書きできない", async () => {
    for (const db of [guest(), staff(), admin()]) {
      await assertFails(getDoc(doc(db, "rateLimits/ip_x")));
      await assertFails(setDoc(doc(db, "rateLimits/ip_x"), { count: 0 }));
    }
  });
});

describe("ルールに書いていない場所", () => {
  it("管理者でも読み書きできない", async () => {
    await assertFails(getDoc(doc(admin(), "system/bootstrap")));
    await assertFails(setDoc(doc(admin(), "anything/x"), { a: 1 }));
  });
});
