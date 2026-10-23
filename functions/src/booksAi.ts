// 帳簿（経理）：総勘定元帳のスキャン・写真と、レシート・請求書を、AI（Claude）で読み取る（帳簿を使える人）。
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
    notes: STR,
  },
  required: ["date", "partner", "items", "byRate", "total", "notes"],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `これはお店で受け取ったレシートか、届いた請求書・納品書の画像です。経費の帳簿につけるために読み取って、決められた形（JSON）で返してください。

各項目：
- date：日付を "YYYY-MM-DD" で（請求書は請求日・取引日。読めなければ ""）
- partner：お店・会社の名前（例「コメリ」「ファームランド美瑛」。支店名はなくてよい。半角カナは全角カナに直す）
- items：買ったものを短く（例「ナット他」「結束バンド・鎌」。いちばん高いもの1つに「他」をつけるくらいの長さ。30文字まで）
- byRate：税率ごとの税込の金額。軽減税率（8%）の品と10%の品があれば分ける。税のかからないもの（切手・収入印紙など）は "0%"。値引きは引いたあとの金額
- total：支払った合計（税込）
- notes：読めない・自信がないところがあれば書く（なければ ""）。推測で埋めないでください

byRate の合計が total と合うか確かめ、合わなければ読みなおしてください。1枚の画像に2枚以上のレシートが写っているときは、いちばん大きく写っている1枚だけを読み、notes にそう書いてください。`;

/** エミュレーターの見本（レシート） */
const RECEIPT_SAMPLE = { date: "2026-10-12", partner: "コメリ", items: "結束バンド他", byRate: [{ rate: "10%", amount: 3278 }], total: 3278, notes: "" };

const MAX_SIZE = 9_000_000;

/** 1枚（1ページ）を読み取る。kind：ledger＝総勘定元帳、receipt＝レシート・請求書 */
export const readBooksPage = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (req) => {
  await assertCan(req, ["ledger"]);
  const kind = (req.data as { kind?: unknown })?.kind;
  if (kind !== "ledger" && kind !== "receipt") throw new HttpsError("invalid-argument", "読み取るものの種類が正しくありません");
  const f = (req.data as { file?: { mediaType?: unknown; data?: unknown } })?.file;
  if (typeof f?.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data)) throw new HttpsError("invalid-argument", "ファイルが読めません");
  if (f.data.length > MAX_SIZE) throw new HttpsError("invalid-argument", "ファイルが大きすぎます");
  if (f.mediaType !== "image/jpeg" && f.mediaType !== "image/png") throw new HttpsError("invalid-argument", "画像（JPEG・PNG）を送ってください");
  const block: Anthropic.Beta.BetaContentBlockParam = { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } };

  const apiKey = await loadKey();
  if (!apiKey) throw new HttpsError("failed-precondition", "AIの鍵が登録されていません。管理者に「AIの鍵」の登録を頼んでください");
  if (isEmulatorTest(apiKey)) {
    if (kind === "receipt") return { result: RECEIPT_SAMPLE, usage: { input: 0, output: 0 } };
    throw new HttpsError("unavailable", "手元での確かめでは、元帳のスキャンは読めません");
  }

  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = new Anthropic({ apiKey }).beta.messages.stream({
      model: MODEL,
      max_tokens: kind === "ledger" ? 32000 : 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: kind === "ledger" ? LEDGER_SCHEMA : RECEIPT_SCHEMA } },
      messages: [{ role: "user", content: [block, { type: "text", text: kind === "ledger" ? LEDGER_PROMPT : RECEIPT_PROMPT }] }],
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
