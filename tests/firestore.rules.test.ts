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
  it("顧客リストはスタッフが見るだけ、管理者が登録。外の人は読めない", async () => {
    const c = { name: "〇〇旅行", phone: "0120-000-000", prices: { adult: 2500, child: 1800 }, active: true };
    await assertSucceeds(setDoc(doc(admin(), "customers/c1"), c));
    await assertFails(setDoc(doc(admin(), "customers/c2"), { ...c, name: "" }));
    await assertFails(setDoc(doc(admin(), "customers/c2"), { ...c, secret: 1 }));
    await assertFails(setDoc(doc(staff(), "customers/c2"), c));
    await assertSucceeds(getDoc(doc(staff(), "customers/c1")));
    for (const db of [guest(), noRole(), disabled()]) await assertFails(getDoc(doc(db, "customers/c1")));
  });
  it("レジ精算はスタッフが記録でき、外の人は読めない", async () => {
    const d = { float: 30000, counts: { "10000": 3 }, cashSales: 0, counted: 30000, diff: 0, memo: "", updatedBy: "u1" };
    await assertSucceeds(setDoc(doc(staff(), "cashCounts/2026-09-27"), d));
    await assertFails(setDoc(doc(staff(), "cashCounts/2026-09-27"), { ...d, updatedBy: "someone" }));
    await assertFails(setDoc(doc(staff(), "cashCounts/abc"), d));
    await assertFails(setDoc(doc(staff(), "cashCounts/2026-09-27"), { ...d, extra: 1 }));
    await assertFails(getDoc(doc(guest(), "cashCounts/2026-09-27")));
    await assertFails(setDoc(doc(disabled(), "cashCounts/2026-09-28"), { ...d, updatedBy: "u3" }));
  });
  it("請求書の振込先はスタッフが見るだけ、管理者が変更。外の人は読めない", async () => {
    await assertSucceeds(setDoc(doc(admin(), "config/invoice"), { bankInfo: "○○銀行 本店 普通 1234567", note: "" }));
    await assertFails(setDoc(doc(staff(), "config/invoice"), { bankInfo: "x", note: "" }));
    await assertFails(setDoc(doc(admin(), "config/invoice"), { bankInfo: "x", other: 1 }));
    await assertSucceeds(getDoc(doc(staff(), "config/invoice")));
    await assertFails(getDoc(doc(guest(), "config/invoice")));
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
    await assertSucceeds(setDoc(doc(admin(), "payrolls/2026-08"), { paymentDate: "", rows: {}, employer: {}, memo: "", payerAccount: "117779", author: "hirayama" }));
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

describe("レジの共通設定（扱者のリスト）", () => {
  it("スタッフは読み書きでき、スタッフ以外はできない", async () => {
    await assertSucceeds(setDoc(doc(staff(), "config/register"), { handlers: ["山田", "佐藤"] }));
    await assertSucceeds(getDoc(doc(staff(), "config/register")));
    await assertFails(setDoc(doc(staff(), "config/register"), { handlers: ["山田"], other: 1 }));
    await assertFails(setDoc(doc(staff(), "config/register"), { handlers: "山田" }));
    for (const db of [guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "config/register")));
      await assertFails(setDoc(doc(db, "config/register"), { handlers: ["x"] }));
    }
  });
});

describe("店舗実績", () => {
  it("スタッフは読み書きでき、決めた項目以外は保存できない", async () => {
    await assertSucceeds(setDoc(doc(staff(), "storeDaily/2026-06-02"), { direct: 17600, directCustomers: 27, total: 79500 }));
    await assertSucceeds(getDoc(doc(staff(), "storeDaily/2026-06-02")));
    await assertFails(setDoc(doc(staff(), "storeDaily/2026-06-02"), { direct: 1, secret: 1 }));
    await assertFails(setDoc(doc(staff(), "storeDaily/2026-6-2"), { direct: 1 }));
    for (const db of [guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "storeDaily/2026-06-02")));
      await assertFails(setDoc(doc(db, "storeDaily/2026-06-02"), { direct: 1 }));
    }
  });
});

describe("AIの鍵 (secrets)", () => {
  it("管理者もスタッフも読み書きできない（サーバーだけが使う）", async () => {
    for (const db of [admin(), staff(), guest()]) {
      await assertFails(getDoc(doc(db, "secrets/anthropic")));
      await assertFails(setDoc(doc(db, "secrets/anthropic"), { apiKey: "sk-ant-x" }));
    }
  });
});

describe("メニューのタイルの配置 (config/menu)", () => {
  it("スタッフは読めて、変えられるのは管理者だけ", async () => {
    await assertSucceeds(setDoc(doc(admin(), "config/menu"), { slots: { reservations: 0, checkout: 4 }, cols: 3 }));
    await assertSucceeds(getDoc(doc(staff(), "config/menu")));
    await assertFails(setDoc(doc(staff(), "config/menu"), { slots: {}, cols: 3 }));
    await assertFails(setDoc(doc(admin(), "config/menu"), { slots: {}, cols: 9 }));
    await assertFails(setDoc(doc(admin(), "config/menu"), { slots: {}, cols: 3, other: 1 }));
    await assertFails(getDoc(doc(guest(), "config/menu")));
  });
});

describe("意向勤務管理表（従業員 worker）", () => {
  const worker = () => env.authenticatedContext("w1", { role: "worker" }).firestore();
  const workerOff = () => env.authenticatedContext("w2", { role: "worker" }).firestore();
  const seed = () =>
    env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "workers/w1"), { memberId: "m1", loginId: "tanaka", active: true });
      await setDoc(doc(db, "workers/w2"), { memberId: "m2", loginId: "sato", active: false });
      await setDoc(doc(db, "shiftMembers/m1"), { name: "田中", group: "男性", floor: false, order: 0, active: true, uid: "w1", loginId: "tanaka" });
      await setDoc(doc(db, "shiftDays/2026-10-10"), { cells: { m1: "〇" }, note: "" });
      await setDoc(doc(db, "shiftRequests/m1_2026-10-20"), { memberId: "m1", uid: "w1", date: "2026-10-20", code: "希望休", memo: "", status: "pending" });
      await setDoc(doc(db, "shiftRequests/m9_2026-10-20"), { memberId: "m9", uid: "w9", date: "2026-10-20", code: "AM", memo: "", status: "pending" });
      await setDoc(doc(db, "reservations/r1"), { customerName: "お客様" });
      await setDoc(doc(db, "sales/s1"), { total: 100 });
    });

  it("従業員は勤務の表と自分の希望だけ読め、書き込みはできない", async () => {
    await seed();
    await assertSucceeds(getDoc(doc(worker(), "shiftDays/2026-10-10")));
    await assertSucceeds(getDoc(doc(worker(), "shiftMembers/m1")));
    await assertSucceeds(getDoc(doc(worker(), "config/shift")));
    await assertSucceeds(getDoc(doc(worker(), "shiftRequests/m1_2026-10-20")));
    await assertFails(getDoc(doc(worker(), "shiftRequests/m9_2026-10-20")));
    await assertFails(setDoc(doc(worker(), "shiftDays/2026-10-10"), { cells: { m1: "希望休" } }));
    await assertFails(setDoc(doc(worker(), "shiftRequests/m1_2026-10-21"), { memberId: "m1", uid: "w1", date: "2026-10-21", code: "希望休", status: "approved" }));
    // 予約・会計・スタッフ名簿・給与は読めない
    for (const p of ["reservations/r1", "sales/s1", "staff/u1", "employees/e1", "payrolls/2026-10", "settings/main"]) {
      if (p === "settings/main") continue; // 設定は誰でも読める
      await assertFails(getDoc(doc(worker(), p)));
    }
  });

  it("使えなくした従業員は何も読めない", async () => {
    await seed();
    await assertFails(getDoc(doc(workerOff(), "shiftDays/2026-10-10")));
  });

  it("管理者は表を書け、スタッフは見るだけ。ログインの付け替えは管理者でもできない", async () => {
    await seed();
    await assertSucceeds(setDoc(doc(admin(), "shiftDays/2026-10-11"), { cells: { m1: "AM" }, note: "宵宮" }));
    await assertSucceeds(getDoc(doc(staff(), "shiftDays/2026-10-11")));
    await assertFails(setDoc(doc(staff(), "shiftDays/2026-10-11"), { cells: { m1: "〇" } }));
    await assertFails(setDoc(doc(admin(), "shiftMembers/m1"), { name: "田中", group: "男性", floor: true, order: 0, active: true, uid: "w9", loginId: "tanaka" }));
    await assertSucceeds(setDoc(doc(admin(), "shiftMembers/m1"), { name: "田中", group: "男性", floor: true, order: 0, active: true, uid: "w1", loginId: "tanaka" }));
    await assertSucceeds(setDoc(doc(admin(), "shiftRequests/m1_2026-10-20"), { memberId: "m1", uid: "w1", date: "2026-10-20", code: "希望休", memo: "", status: "approved" }));
    await assertFails(setDoc(doc(admin(), "shiftRequests/m1_2026-10-20"), { memberId: "m1", uid: "w1", date: "2026-10-21", code: "希望休", memo: "", status: "approved" }));
  });
});
