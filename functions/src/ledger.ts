// 総勘定元帳（会計ソフトから印刷してスキャンしたもの）の1ページを、AI（Claude）で読み取る（管理者だけ）。
// 経費を仕入れ先ごとにまとめ、来年度の予算の参考にするための作業に使う。
// 読み取った結果は画面に返すだけ（保存は画面で確かめてから、管理者が ledgers/ に入れる）。画像は保存しない
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertAdmin } from "./common.js";
import { isEmulatorTest, loadKey, MODEL } from "./shikiri.js";

const INT = { type: "integer" };
const INT_OR_NULL = { anyOf: [{ type: "integer" }, { type: "null" }] };
const STR = { type: "string" };
const TOTAL = {
  type: "object",
  properties: { debit: INT, credit: INT, count: INT_OR_NULL },
  required: ["debit", "credit", "count"],
  additionalProperties: false,
};
const SCHEMA = {
  type: "object",
  properties: {
    accountCode: STR,
    accountName: STR,
    periodFrom: STR,
    periodTo: STR,
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          no: STR,
          date: STR,
          counter: STR,
          sub: STR,
          item: STR,
          partner: STR,
          isTax: { type: "boolean" },
          debit: INT,
          credit: INT,
          taxRate: STR,
        },
        required: ["no", "date", "counter", "sub", "item", "partner", "isTax", "debit", "credit", "taxRate"],
        additionalProperties: false,
      },
    },
    monthTotals: {
      type: "array",
      items: {
        type: "object",
        properties: { month: STR, debit: INT, credit: INT, count: INT_OR_NULL },
        required: ["month", "debit", "credit", "count"],
        additionalProperties: false,
      },
    },
    grandTotal: { anyOf: [TOTAL, { type: "null" }] },
    notes: STR,
  },
  required: ["accountCode", "accountName", "periodFrom", "periodTo", "entries", "monthTotals", "grandTotal", "notes"],
  additionalProperties: false,
};

const PROMPT = `これは会社の会計ソフトで印刷した「総勘定元帳」の1ページをスキャンした画像です。表を読み取って、決められた形（JSON）で返してください。

各項目：
- accountCode / accountName：見出しのかっこの中の科目（例「815:諸材料 費」→ accountCode "815"、accountName "諸材料費"。名前の空白は詰める）
- periodFrom / periodTo：見出しの下の期間（例「2026年2月1日〜2027年1月31日」→ "2026-02-01" と "2027-01-31"）
- entries：明細の行（1つの伝票No.で上下2段になっている1件を1つにする）
  - no：伝票No.
  - date：日付を "YYYY-MM-DD" で。「〃」は上の行と同じ日付。年は期間から決める（期間が2月〜翌1月なら、2〜12月は始まりの年、1月は次の年）
  - counter：相手科目（例「普通預金」「組勘勘定」「仮払金」。空白は詰める）
  - sub：補助（例「北洋銀行」「JCB」。先頭の「/」は取る。なければ ""）
  - item：摘要の上の段（品名。例「直管パイプ他」）
  - partner：摘要の下の段（取引先。例「タキロンシーアイアグリ(株)」）。下の段が「消費税」のときは "" にして isTax を true にする。下の段がなければ ""
  - isTax：摘要の下の段が「消費税」の行なら true、ほかは false
  - debit：借方金額（円。なければ 0）、credit：貸方金額（円。なければ 0）
  - taxRate：残高の欄の（ ）の中の税率（例 "10%"、"8%"。なければ ""）
  - 半角カナは全角カナに直してください（例「ﾀｷﾛﾝｼｰｱｲｱｸﾞﾘ(株)」→「タキロンシーアイアグリ(株)」）
- monthTotals：「◯月度合計」の行（month は "YYYY-MM"、debit・credit はその行の金額、count は下の「◯件」）
- grandTotal：「総合計」の行があれば、その金額と件数。なければ null
- 「繰越残高」「頁合計」の行は entries に入れないでください
- notes：読めない・自信がないところがあれば書く（なければ ""）。推測で埋めないでください

読み取りの決まり：読み取ったあと、月ごとに entries の借方の合計が「◯月度合計」と合うか確かめ、合わなければ読みなおしてください（その月の明細が前のページから続いているときは合わなくてもかまいません）。`;

const MAX_SIZE = 9_000_000;

/** 総勘定元帳の1ページを読み取る（管理者） */
export const readLedgerPage = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (req) => {
  await assertAdmin(req);
  const f = (req.data as { file?: { mediaType?: unknown; data?: unknown } })?.file;
  if (typeof f?.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data)) throw new HttpsError("invalid-argument", "ファイルが読めません");
  if (f.data.length > MAX_SIZE) throw new HttpsError("invalid-argument", "ファイルが大きすぎます");
  let block: Anthropic.Beta.BetaContentBlockParam;
  if (f.mediaType === "image/jpeg" || f.mediaType === "image/png") block = { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } };
  else throw new HttpsError("invalid-argument", "画像（JPEG・PNG）を送ってください");

  const apiKey = await loadKey();
  if (!apiKey) throw new HttpsError("failed-precondition", "AIの鍵が登録されていません。設定から「AIの鍵」を登録してください");
  // 手元での動作確認（エミュレーター）では、架空の見本を返す
  if (isEmulatorTest(apiKey)) {
    const pages = JSON.parse(readFileSync(join(__dirname, "../test-fixtures/ledger-sample.json"), "utf8")) as unknown[];
    const n = Number((req.data as { page?: unknown })?.page ?? 0);
    return { result: pages[Math.abs(n) % pages.length], usage: { input: 0, output: 0 } };
  }

  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = new Anthropic({ apiKey }).beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpsError("failed-precondition", "AIの鍵が使えなくなっています。登録しなおしてください");
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "AIが混み合っています。少し待ってからもう一度お試しください");
    if (e instanceof Anthropic.BadRequestError) {
      console.error("readLedgerPage bad request", e.message);
      if (/credit|billing/i.test(e.message))
        throw new HttpsError("failed-precondition", "AIの利用料金の残高が足りません。Anthropicの画面で残高を追加してください");
      throw new HttpsError("invalid-argument", "このページはAIで読めませんでした");
    }
    console.error("readLedgerPage error", e);
    throw new HttpsError("unavailable", "AIとの通信に失敗しました。時間をおいてもう一度お試しください");
  }
  if (message.stop_reason === "refusal") throw new HttpsError("failed-precondition", "AIがこのページを読み取れませんでした");
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    return { result: JSON.parse(text) as unknown, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
  } catch {
    console.error("readLedgerPage parse", text.slice(0, 300));
    throw new HttpsError("internal", "読み取った結果の形が正しくありませんでした。もう一度お試しください");
  }
});
