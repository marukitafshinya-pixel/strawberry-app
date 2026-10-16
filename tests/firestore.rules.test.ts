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
    await assertSucceeds(setDoc(doc(admin(), "config/invoice"), { bankInfo: "x", note: "", issuerName: "株式会社テスト" }));
    await assertFails(setDoc(doc(admin(), "config/invoice"), { bankInfo: "x", note: "", issuerName: 1 }));
    await assertSucceeds(getDoc(doc(staff(), "config/invoice")));
    await assertFails(getDoc(doc(guest(), "config/invoice")));
    const png = "data:image/png;base64,iVBORw0KGgo=";
    await assertSucceeds(setDoc(doc(admin(), "config/invoiceSeal"), { image: png }));
    await assertFails(setDoc(doc(staff(), "config/invoiceSeal"), { image: png }));
    await assertFails(setDoc(doc(admin(), "config/invoiceSeal"), { image: "javascript:alert(1)" }));
    await assertFails(setDoc(doc(admin(), "config/invoiceSeal"), { image: png, other: 1 }));
    await assertSucceeds(getDoc(doc(staff(), "config/invoiceSeal")));
    await assertFails(getDoc(doc(guest(), "config/invoiceSeal")));
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

describe("目標と実績（管理者のみ）", () => {
  it("管理者だけが読み書きでき、形が違うものは保存できない", async () => {
    await assertSucceeds(setDoc(doc(admin(), "goals/2026"), { targets: { "10": { store: 1000000, labor: 500000 } }, hobe: { "10": 30000 } }));
    await assertSucceeds(getDoc(doc(admin(), "goals/2026")));
    for (const db of [staff(), guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "goals/2026")));
      await assertFails(setDoc(doc(db, "goals/2026"), { targets: {}, hobe: {} }));
    }
    await assertFails(setDoc(doc(admin(), "goals/26"), { targets: {}, hobe: {} }));
    await assertFails(setDoc(doc(admin(), "goals/2026"), { targets: {}, hobe: {}, secret: 1 }));
  });
});

describe("タイムカード（管理者のみ）", () => {
  it("打刻と計算のルールは管理者だけが読み書きできる", async () => {
    const tc = { cards: { "001": { "01": { i: 338, o: 1024 }, "02": { i: 339, o: null, e: { i: 339, o: 1020 } } } }, fileName: "ER201001.csv" };
    await assertSucceeds(setDoc(doc(admin(), "timecards/2026-09"), tc));
    await assertSucceeds(getDoc(doc(admin(), "timecards/2026-09")));
    await assertSucceeds(setDoc(doc(admin(), "config/timecard"), { cards: { "001": "e1" }, startTimes: [{ from: "2026-09-01", time: 360 }], roundIn: 15, inDir: "down", roundOut: 15, outDir: "up", breaks: [{ start: 720, end: 780 }], overtimeOver: 480, closeDay: 31, rulesVersion: 2 }));
    for (const db of [staff(), guest(), noRole(), disabled(), env.authenticatedContext("w1", { role: "worker" }).firestore()]) {
      await assertFails(getDoc(doc(db, "timecards/2026-09")));
      await assertFails(setDoc(doc(db, "timecards/2026-09"), tc));
      await assertFails(getDoc(doc(db, "config/timecard")));
      await assertFails(setDoc(doc(db, "config/timecard"), { roundIn: 1 }));
    }
  });
  it("月の形や項目が違うものは保存できない", async () => {
    await assertFails(setDoc(doc(admin(), "timecards/2026-9"), { cards: {} }));
    await assertFails(setDoc(doc(admin(), "timecards/2026-09"), { cards: {}, secret: 1 }));
    await assertFails(setDoc(doc(admin(), "config/timecard"), { roundIn: 0 }));
    await assertFails(setDoc(doc(admin(), "config/timecard"), { closeDay: 40 }));
    await assertFails(setDoc(doc(admin(), "config/timecard"), { inDir: "abc" }));
    await assertFails(setDoc(doc(admin(), "config/timecard"), { overtimeOver: 0 }));
  });
});

describe("気象データ", () => {
  it("スタッフは見るだけ（書き込みはサーバー側）", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "weather/2025-07"), { station: "美瑛", days: { "01": { tAvg: 19 } } });
    });
    await assertSucceeds(getDoc(doc(staff(), "weather/2025-07")));
    await assertFails(setDoc(doc(admin(), "weather/2025-07"), { days: {} }));
    await assertFails(getDoc(doc(guest(), "weather/2025-07")));
  });
});

describe("カフェの呼出番号 (cafeCalls)", () => {
  it("スタッフは1番から1つずつ進めるだけ", async () => {
    await assertSucceeds(setDoc(doc(staff(), "cafeCalls/2026-10-09"), { last: 1 }));
    await assertSucceeds(getDoc(doc(staff(), "cafeCalls/2026-10-09")));
    await assertSucceeds(setDoc(doc(staff(), "cafeCalls/2026-10-09"), { last: 2 }));
    await assertFails(setDoc(doc(staff(), "cafeCalls/2026-10-09"), { last: 2 }));
    await assertFails(setDoc(doc(staff(), "cafeCalls/2026-10-09"), { last: 5 }));
    await assertFails(setDoc(doc(staff(), "cafeCalls/2026-10-09"), { last: 1 }));
    await assertFails(setDoc(doc(staff(), "cafeCalls/2026-10-10"), { last: 3 }));
    await assertFails(setDoc(doc(staff(), "cafeCalls/2026-10-11"), { last: 1, x: 1 }));
    await assertFails(setDoc(doc(staff(), "cafeCalls/abc"), { last: 1 }));
    for (const db of [guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "cafeCalls/2026-10-09")));
      await assertFails(setDoc(doc(db, "cafeCalls/2026-10-12"), { last: 1 }));
    }
  });
});

describe("作業配置表 (config/haichi・haichi)", () => {
  it("管理者だけが書け、スタッフは見るだけ", async () => {
    await assertSucceeds(setDoc(doc(admin(), "config/haichi"), { sections: [{ id: "a", name: "収穫", slots: [{ id: "h1", label: "1" }] }] }));
    await assertSucceeds(getDoc(doc(staff(), "config/haichi")));
    await assertFails(setDoc(doc(staff(), "config/haichi"), { sections: [] }));
    await assertFails(setDoc(doc(admin(), "config/haichi"), { sections: [], x: 1 }));
    await assertSucceeds(setDoc(doc(admin(), "haichi/2026-10-12"), { cells: { h1: { members: ["m1"], memo: "赤玉" } }, note: "", done: false }));
    await assertSucceeds(getDoc(doc(staff(), "haichi/2026-10-12")));
    await assertFails(setDoc(doc(staff(), "haichi/2026-10-12"), { cells: {}, note: "", done: false }));
    await assertFails(setDoc(doc(admin(), "haichi/2026-10-12"), { cells: {}, note: "", done: "x" }));
    await assertFails(setDoc(doc(admin(), "haichi/abc"), { cells: {}, note: "", done: false }));
    for (const db of [guest(), noRole(), disabled()]) await assertFails(getDoc(doc(db, "haichi/2026-10-12")));
  });
});

describe("天気予報 (forecast)", () => {
  it("スタッフ・従業員は見るだけ（書き込みはサーバー側）", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "forecast/biei"), { slots: [] });
    });
    await assertSucceeds(getDoc(doc(staff(), "forecast/biei")));
    await assertFails(setDoc(doc(admin(), "forecast/biei"), { slots: [] }));
    await assertFails(getDoc(doc(guest(), "forecast/biei")));
  });
});

describe("トータル実績（ほかの売上）", () => {
  it("管理者だけが読み書きできる", async () => {
    await assertSucceeds(setDoc(doc(admin(), "otherSales/2026"), { months: { "08": { onion: 120000, soba: 0, contract: 50000 } } }));
    await assertSucceeds(getDoc(doc(admin(), "otherSales/2026")));
    await assertSucceeds(setDoc(doc(admin(), "otherSales/2026"), { months: {}, forecast: { "11": { ship: 500000, direct: 80000 } } }));
    await assertFails(setDoc(doc(admin(), "otherSales/2026"), { months: {}, forecast: "x" }));
    for (const db of [staff(), guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "otherSales/2026")));
      await assertFails(setDoc(doc(db, "otherSales/2026"), { months: {} }));
    }
    await assertFails(setDoc(doc(admin(), "otherSales/26"), { months: {} }));
    await assertFails(setDoc(doc(admin(), "otherSales/2026"), { months: {}, x: 1 }));
  });
});

describe("現金出納帳", () => {
  it("管理者だけが読み書きできる", async () => {
    await assertSucceeds(setDoc(doc(admin(), "cashbook/2026-08"), { entries: [{ date: "2026-08-03", item: "ごみ処理代", income: null, expense: 800, memo: "" }], opening: 660 }));
    await assertSucceeds(getDoc(doc(admin(), "cashbook/2026-08")));
    for (const db of [staff(), guest(), noRole(), disabled()]) {
      await assertFails(getDoc(doc(db, "cashbook/2026-08")));
      await assertFails(setDoc(doc(db, "cashbook/2026-08"), { entries: [] }));
    }
  });
  it("項目の候補は管理者だけが読み書きできる", async () => {
    await assertSucceeds(setDoc(doc(admin(), "config/cashbookItems"), { items: ["ごみ処理代", "切手代"] }));
    await assertFails(getDoc(doc(staff(), "config/cashbookItems")));
    await assertFails(setDoc(doc(staff(), "config/cashbookItems"), { items: [] }));
    await assertFails(setDoc(doc(admin(), "config/cashbookItems"), { items: "x" }));
  });
  it("月の形や項目が違うものは保存できない", async () => {
    await assertFails(setDoc(doc(admin(), "cashbook/2026-8"), { entries: [] }));
    await assertFails(setDoc(doc(admin(), "cashbook/2026-08"), { entries: [], secret: 1 }));
    await assertFails(setDoc(doc(admin(), "cashbook/2026-08"), { entries: [], opening: "660" }));
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
    await assertSucceeds(setDoc(doc(admin(), "config/shift"), { codes: [], groups: [], cutoffDays: 14, contact: "平山" }));
    await assertFails(setDoc(doc(admin(), "config/shift"), { codes: [], groups: [], cutoffDays: 14, contact: 5 }));
    await assertFails(setDoc(doc(admin(), "config/shift"), { codes: [], groups: [], cutoffDays: 14, contact: "x".repeat(21) }));
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
    await assertSucceeds(setDoc(doc(admin(), "shiftMembers/m1"), { name: "田中", group: "男性", floor: true, harvest: true, order: 0, active: true, uid: "w1", loginId: "tanaka" }));
    await assertSucceeds(setDoc(doc(admin(), "shiftRequests/m1_2026-10-20"), { memberId: "m1", uid: "w1", date: "2026-10-20", code: "希望休", memo: "", status: "approved" }));
    await assertFails(setDoc(doc(admin(), "shiftRequests/m1_2026-10-20"), { memberId: "m1", uid: "w1", date: "2026-10-21", code: "希望休", memo: "", status: "approved" }));
  });
});

describe("顧客だけの商品の値段 (customers.products)", () => {
  it("管理者は保存でき、スタッフは保存できない", async () => {
    await assertSucceeds(setDoc(doc(admin(), "customers/c1"), { name: "テスト商事", prices: { adult: 1500 }, products: { j: 700 }, active: true }));
    await assertFails(setDoc(doc(staff(), "customers/c1"), { name: "テスト商事", products: { j: 1 }, active: true }));
    await assertFails(setDoc(doc(admin(), "customers/c1"), { name: "テスト商事", products: "安く", active: true }));
  });
});

describe("収穫管理 (harvest・houseUse・config/harvest)", () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = { "17": { members: ["m1"], start: 360, end: 430, cases: 5.3 } };

  it("スタッフは最近の日の収穫を読み書きでき、古い日は読めない。管理者はどの日も読める", async () => {
    await assertSucceeds(setDoc(doc(staff(), `harvest/${today}`), { houses: rows }));
    await assertSucceeds(getDoc(doc(staff(), `harvest/${today}`)));
    await assertFails(setDoc(doc(staff(), "harvest/2020-01-01"), { houses: rows }));
    await assertSucceeds(setDoc(doc(admin(), "harvest/2020-01-01"), { houses: rows }));
    await assertFails(getDoc(doc(staff(), "harvest/2020-01-01")));
    await assertSucceeds(getDoc(doc(admin(), "harvest/2020-01-01")));
    await assertFails(setDoc(doc(admin(), "harvest/2020-01-01"), { houses: rows, memo: "x" }));
    await assertSucceeds(setDoc(doc(staff(), `harvest/${today}`), { houses: rows, endTime: 585 }));
    await assertFails(setDoc(doc(staff(), `harvest/${today}`), { houses: rows, endTime: "9:45" }));
    await assertFails(setDoc(doc(admin(), "harvest/abc"), { houses: rows }));
    await assertFails(getDoc(doc(guest(), `harvest/${today}`)));
    await assertFails(setDoc(doc(disabled(), `harvest/${today}`), { houses: rows }));
  });

  it("ハウスの使い方はスタッフが読み書きでき、まとまりは管理者だけが変えられる", async () => {
    await assertSucceeds(setDoc(doc(staff(), "houseUse/2026-10-15"), { houses: { "21": "picking" } }));
    await assertSucceeds(getDoc(doc(staff(), "houseUse/2026-10-15")));
    await assertFails(setDoc(doc(staff(), "houseUse/2026-10-15"), { houses: "全部" }));
    await assertFails(getDoc(doc(guest(), "houseUse/2026-10-15")));
    await assertSucceeds(getDoc(doc(staff(), "config/harvest")));
    await assertFails(setDoc(doc(staff(), "config/harvest"), { groups: [] }));
    await assertSucceeds(setDoc(doc(admin(), "config/harvest"), { groups: [{ name: "1・6・8", houses: ["1", "6", "8"] }] }));
    await assertSucceeds(setDoc(doc(admin(), "config/harvest"), { groups: [], startTime: 360 }));
    await assertFails(setDoc(doc(admin(), "config/harvest"), { groups: [], startTime: "6:00" }));
    await assertFails(setDoc(doc(staff(), "config/harvest"), { startTime: 330 }));
  });
});

describe("収穫管理：集荷係の従業員", () => {
  const worker = () => env.authenticatedContext("w1", { role: "worker" }).firestore();
  const houses = { "17": { members: ["m3"], cases: 2 } };
  const seed = () =>
    env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "workers/w1"), { memberId: "m1", loginId: "tanaka", active: true });
      await setDoc(doc(db, "haichi/2026-10-15"), { cells: { pickup: { members: ["m1"], memo: "" } }, note: "", done: false });
      await setDoc(doc(db, "haichi/2026-10-16"), { cells: { pickup: { members: ["m2"], memo: "" } }, note: "", done: false });
    });

  it("集荷係の日だけ、収穫とハウスの使い方を読み書きできる", async () => {
    await seed();
    await assertSucceeds(setDoc(doc(worker(), "harvest/2026-10-15"), { houses }));
    await assertSucceeds(getDoc(doc(worker(), "harvest/2026-10-15")));
    await assertSucceeds(setDoc(doc(worker(), "houseUse/2026-10-15"), { houses: { "21": "picking" } }));
    await assertSucceeds(getDoc(doc(worker(), "config/harvest")));
    // 集荷係でない日・配置表がない日はできない
    await assertFails(setDoc(doc(worker(), "harvest/2026-10-16"), { houses }));
    await assertFails(getDoc(doc(worker(), "harvest/2026-10-16")));
    await assertFails(setDoc(doc(worker(), "harvest/2026-10-17"), { houses }));
    await assertFails(setDoc(doc(worker(), "houseUse/2026-10-16"), { houses: {} }));
    // 実績（期間の記録）や給与などは見られない
    await assertFails(getDoc(doc(worker(), "payrolls/2026-10")));
  });
});

describe("収穫管理：毎日使える従業員（社員など）", () => {
  const today = new Date().toISOString().slice(0, 10);
  const worker = (uid: string) => env.authenticatedContext(uid, { role: "worker" }).firestore();
  it("「毎日使える」にした人だけ、集荷係でない日も最近の日を読み書きできる", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "workers/w5"), { memberId: "m5", loginId: "asano", active: true });
      await setDoc(doc(db, "shiftMembers/m5"), { name: "浅野", group: "社員", floor: false, harvestEntry: true, order: 0, active: true, uid: "w5" });
      await setDoc(doc(db, "workers/w6"), { memberId: "m6", loginId: "suzuki", active: true });
      await setDoc(doc(db, "shiftMembers/m6"), { name: "鈴木", group: "パート", floor: false, order: 1, active: true, uid: "w6" });
    });
    const houses = { "17": { members: ["m5"], cases: 1 } };
    await assertSucceeds(setDoc(doc(worker("w5"), `harvest/${today}`), { houses }));
    await assertSucceeds(getDoc(doc(worker("w5"), `harvest/${today}`)));
    await assertSucceeds(setDoc(doc(worker("w5"), `houseUse/${today}`), { houses: {} }));
    await assertFails(getDoc(doc(worker("w5"), "harvest/2020-01-01")));
    await assertFails(setDoc(doc(worker("w6"), `harvest/${today}`), { houses }));
    // 管理者でなければ「毎日使える」は付けられない
    await assertFails(setDoc(doc(worker("w6"), "shiftMembers/m6"), { name: "鈴木", group: "パート", floor: false, harvestEntry: true, order: 1, active: true, uid: "w6" }));
  });
});

describe("収穫終了の予測（forecast・株数・速さ）", () => {
  const today = new Date().toISOString().slice(0, 10);
  it("朝の予測と株数を保存でき、速さはサーバーだけが書ける", async () => {
    await assertSucceeds(setDoc(doc(staff(), `harvest/${today}`), { forecast: 565 }));
    await assertFails(setDoc(doc(staff(), `harvest/${today}`), { forecast: "9:25" }));
    await assertSucceeds(setDoc(doc(staff(), `harvest/${today}`), { forecast: 565, forecastHouses: { "17": { start: 360, end: 410 } } }));
    await assertSucceeds(setDoc(doc(staff(), `harvest/${today}`), { break: { start: 540, minutes: 15 } }));
    await assertFails(setDoc(doc(staff(), `harvest/${today}`), { break: { start: 540, minutes: 15, memo: "x" } }));
    await assertSucceeds(setDoc(doc(admin(), "config/harvest"), { plants: { "21": 3448 } }));
    await assertFails(setDoc(doc(staff(), "config/harvest"), { plants: { "21": 1 } }));
    await assertSucceeds(getDoc(doc(staff(), "stats/harvestSpeed")));
    await assertFails(setDoc(doc(admin(), "stats/harvestSpeed"), { speeds: {} }));
    await assertFails(getDoc(doc(guest(), "stats/harvestSpeed")));
  });
});

describe("経理担当（現金出納帳を見るだけ）", () => {
  const acc = () => env.authenticatedContext("a1", { role: "accounting" }).firestore();
  const accOff = () => env.authenticatedContext("a2", { role: "accounting" }).firestore();
  it("現金出納帳は読めるが書けない。ほかは読めない", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "staff/a1"), { role: "accounting", active: true });
      await setDoc(doc(db, "staff/a2"), { role: "accounting", active: false });
      await setDoc(doc(db, "cashbook/2026-10"), { entries: [] });
    });
    await assertSucceeds(getDoc(doc(acc(), "cashbook/2026-10")));
    await assertFails(setDoc(doc(acc(), "cashbook/2026-10"), { entries: [] }));
    await assertFails(getDoc(doc(accOff(), "cashbook/2026-10")));
    for (const p of ["payrolls/2026-10", "employees/e1", "reservations/r1", "sales/s1", "harvest/2026-10-15", "staff/u1"]) await assertFails(getDoc(doc(acc(), p)));
  });
});
