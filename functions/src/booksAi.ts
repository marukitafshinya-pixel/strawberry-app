// 帳簿（経理）：総勘定元帳のスキャン・写真と、レシート・請求書と、預金通帳を、AI（Claude）で読み取る（帳簿を使える人）。
// 読み取った結果は画面に返すだけ（画面で確かめてから、仕訳帳に未仕分けで入れる）。画像は保存しない。
// 総勘定元帳の読み方は、作業用フォルダの「経費の仕分け」（ledger.ts）と同じ
import Anthropic from "@anthropic-ai/sdk";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertCan } from "./common.js";
import { PROMPT as LEDGER_PROMPT, SCHEMA as LEDGER_SCHEMA } from "./ledger.js";
import { isEmulatorTest, loadKey, MODEL } from "./shikiri.js";

const INT = { type: "integer" };
const STR = { type: "string" };
const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    date: STR,
    partner: STR,
    items: STR,
    byRate: {
      type: "array",
      items: {
        type: "object",
        properties: { rate: { type: "string", enum: ["10%", "8%", "0%"] }, amount: INT },
        required: ["rate", "amount"],
        additionalProperties: false,
      },
    },
    total: INT,
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { date: STR, item: STR, rate: { type: "string", enum: ["10%", "8%", "0%"] }, amount: INT },
        required: ["date", "item", "rate", "amount"],
        additionalProperties: false,
      },
    },
    linesExcludeTax: { type: "boolean" },
    notes: STR,
  },
  required: ["date", "partner", "items", "byRate", "total", "lines", "linesExcludeTax", "notes"],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `これはお店で受け取ったレシートか、届いた請求書・納品書の画像です。経費の帳簿につけるために読み取って、決められた形（JSON）で返してください。

各項目：
- date：日付を "YYYY-MM-DD" で（請求書は請求日・取引日。読めなければ ""）
- partner：お店・会社の名前（例「コメリ」「ファームランド美瑛」。支店名はなくてよい。半角カナは全角カナに直す）
- items：買ったものを短く（例「ナット他」「結束バンド・鎌」。いちばん高いもの1つに「他」をつけるくらいの長さ。30文字まで）
- byRate：税率ごとの税込の金額。軽減税率（8%）の品と10%の品があれば分ける。税のかからないもの（切手・収入印紙など）は "0%"。値引きは引いたあとの金額
- total：支払った合計（税込）。請求書は「今回の買い上げ（税込）」の合計で、前回の請求額・入金・繰越は入れない
- lines：明細の1行ずつ（品物・作業ごと）。上から順に、書いてあるとおり全部。まとめずに1行ずつ別にする（同じ品名が2回あれば2行。items のようにまとめない）。レシートも1品ずつ
  - date：その行の日付 "YYYY-MM-DD"（行に日付がなければ ""）
  - item：品名（例「ミツバチ/ぶんぶん2000」。数量・単位はいらない。40文字まで）
  - rate：その行の税率（書いていなければ、食品・飲み物は "8%"、ほかは "10%"）
  - amount：その行の金額（数量×単価のあと。書いてあるとおりの数字。値引き・返品の行はマイナス）
  - 入れない行：入金・振込・前回請求額・繰越・「伝票計」「小計」「合計」・消費税の行・送り先や挨拶の行
- linesExcludeTax：lines の金額が税抜きなら true（「金額は税抜金額です」「外税」など）、税込みなら false
- notes：読めない・自信がないところがあれば書く（なければ ""）。推測で埋めないでください

年が2けた（例「26年」）のときは西暦の下2けた（2026年）。令和・平成で書いてあれば西暦に直してください。
byRate の合計が total と合うか、lines の合計（税抜きなら税をたしたもの）が total とおおよそ合うかを確かめ、合わなければ読みなおしてください。1枚の画像に2枚以上のレシートが写っているときは、いちばん大きく写っている1枚だけを読み、notes にそう書いてください。`;

const BANK_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { date: STR, desc: STR, deposit: INT, withdrawal: INT, balance: { anyOf: [INT, { type: "null" }] } },
        required: ["date", "desc", "deposit", "withdrawal", "balance"],
        additionalProperties: false,
      },
    },
    notes: STR,
  },
  required: ["rows", "notes"],
  additionalProperties: false,
};

const BANK_PROMPT = `これは預金通帳（またはネットバンキングの入出金明細）の1ページの画像です。帳簿につけるために、入出金の行を上から順に全部読み取って、決められた形（JSON）で返してください。

rows の各項目（1行の取引ごと）：
- date：取引の日付 "YYYY-MM-DD"。通帳の日付は和暦（例「8-10-05」「08.10.05」＝令和8年＝2026年）か西暦の下2けた（例「26-10-05」＝2026年）で書かれていることが多いので、西暦に直す。今は2026年（令和8年）ごろなので、それに近い年になるはず
- desc：摘要（取引の内容。例「振込 ホーブ」「カード」「電気料」）。カタカナは全角に直す。読めなければ ""
- deposit：お預り金額（入金）。なければ 0
- withdrawal：お支払金額（出金・引出）。なければ 0
- balance：その行の差引残高。書いていなければ null

入れない行：繰越（「繰越」「くりこし」だけで金額の出入りがない行）・合計の行・見出し・空の行。
前の行の残高 ＋ 入金 − 出金 ＝ その行の残高 になるか確かめ、合わなければ読みなおしてください。
notes：読めない・自信がないところがあれば書く（なければ ""）。推測で埋めないでください。`;

/** エミュレーターの見本（通帳） */
const BANK_SAMPLE = {
  rows: [
    { date: "2026-10-01", desc: "振込 ホーブ", deposit: 120000, withdrawal: 0, balance: 1120000 },
    { date: "2026-10-05", desc: "電気料", deposit: 0, withdrawal: 15400, balance: 1104600 },
  ],
  notes: "",
};

/** エミュレーターの見本（レシート） */
const RECEIPT_SAMPLE = {
  date: "2026-10-12",
  partner: "コメリ",
  items: "結束バンド他",
  byRate: [{ rate: "10%", amount: 3278 }],
  total: 3278,
  lines: [
    { date: "", item: "結束バンド", rate: "10%", amount: 1980 },
    { date: "", item: "鎌", rate: "10%", amount: 1298 },
  ],
  linesExcludeTax: false,
  notes: "",
};

const MAX_SIZE = 9_000_000;

/** 1枚（1ページ）を読み取る。kind：ledger＝総勘定元帳、receipt＝レシート・請求書、bank＝預金通帳 */
export const readBooksPage = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (req) => {
  await assertCan(req, ["ledger"]);
  const kind = (req.data as { kind?: unknown })?.kind;
  if (kind !== "ledger" && kind !== "receipt" && kind !== "bank") throw new HttpsError("invalid-argument", "読み取るものの種類が正しくありません");
  const f = (req.data as { file?: { mediaType?: unknown; data?: unknown } })?.file;
  if (typeof f?.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data)) throw new HttpsError("invalid-argument", "ファイルが読めません");
  if (f.data.length > MAX_SIZE) throw new HttpsError("invalid-argument", "ファイルが大きすぎます");
  if (f.mediaType !== "image/jpeg" && f.mediaType !== "image/png") throw new HttpsError("invalid-argument", "画像（JPEG・PNG）を送ってください");
  const block: Anthropic.Beta.BetaContentBlockParam = { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } };

  const apiKey = await loadKey();
  if (!apiKey) throw new HttpsError("failed-precondition", "AIの鍵が登録されていません。管理者に「AIの鍵」の登録を頼んでください");
  if (isEmulatorTest(apiKey)) {
    if (kind === "receipt") return { result: RECEIPT_SAMPLE, usage: { input: 0, output: 0 } };
    if (kind === "bank") return { result: BANK_SAMPLE, usage: { input: 0, output: 0 } };
    throw new HttpsError("unavailable", "手元での確かめでは、元帳のスキャンは読めません");
  }

  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = new Anthropic({ apiKey }).beta.messages.stream({
      model: MODEL,
      max_tokens: kind === "receipt" ? 16000 : 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: { ledger: LEDGER_SCHEMA, receipt: RECEIPT_SCHEMA, bank: BANK_SCHEMA }[kind] } },
      messages: [{ role: "user", content: [block, { type: "text", text: { ledger: LEDGER_PROMPT, receipt: RECEIPT_PROMPT, bank: BANK_PROMPT }[kind] }] }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpsError("failed-precondition", "AIの鍵が使えなくなっています。管理者に登録しなおしを頼んでください");
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "AIが混み合っています。少し待ってからもう一度お試しください");
    if (e instanceof Anthropic.BadRequestError) {
      console.error("readBooksPage bad request", e.message);
      if (/credit|billing/i.test(e.message)) throw new HttpsError("failed-precondition", "AIの利用料金の残高が足りません。Anthropicの画面で残高を追加してください");
      throw new HttpsError("invalid-argument", "この画像はAIで読めませんでした");
    }
    console.error("readBooksPage error", e);
    throw new HttpsError("unavailable", "AIとの通信に失敗しました。時間をおいてもう一度お試しください");
  }
  if (message.stop_reason === "refusal") throw new HttpsError("failed-precondition", "AIがこの画像を読み取れませんでした");
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    return { result: JSON.parse(text) as unknown, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
  } catch {
    console.error("readBooksPage parse", text.slice(0, 300));
    throw new HttpsError("internal", "読み取った結果の形が正しくありませんでした。もう一度お試しください");
  }
});
