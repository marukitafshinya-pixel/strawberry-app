// 仕切書（出荷先から届く支払明細書）の写真・PDFを、AI（Claude）で読み取る。
// AIの鍵（APIキー）は Firestore の secrets/anthropic に置く。
// secrets はセキュリティルールでだれも読み書きできないので、サーバー（この処理）からしか使えない。
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertAdmin, assertStaff, db } from "./common.js";

const KEY_DOC = "secrets/anthropic";
const MODEL = "claude-opus-5-5";
// エミュレーター（手元での動作確認）でだけ使う鍵。AIを呼ばずに、見本の読み取り結果を返す
const TEST_KEY = "sk-ant-test-fixture-0000000000000000";
const isEmulatorTest = (k: string) => process.env.FUNCTIONS_EMULATOR === "true" && k === TEST_KEY;

async function loadKey(): Promise<string | null> {
  const snap = await db.doc(KEY_DOC).get();
  const k = snap.get("apiKey");
  return typeof k === "string" && k ? k : null;
}

/** AIの鍵が登録されているか（鍵そのものは返さない。末尾4文字だけ） */
export const aiKeyStatus = onCall(async (req) => {
  await assertStaff(req);
  const k = await loadKey();
  return { set: !!k, last4: k ? k.slice(-4) : "" };
});

/** AIの鍵を登録する（管理者だけ）。空にすると消す */
export const setAiKey = onCall(async (req) => {
  const uid = await assertAdmin(req);
  const raw = (req.data as { apiKey?: unknown })?.apiKey;
  if (typeof raw !== "string") throw new HttpsError("invalid-argument", "鍵を入力してください");
  const apiKey = raw.trim();
  if (apiKey === "") {
    await db.doc(KEY_DOC).delete();
    return { set: false, last4: "" };
  }
  if (!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(apiKey)) throw new HttpsError("invalid-argument", "鍵の形が正しくありません（sk-ant- ではじまる文字です）");
  // 使える鍵か、ためしに1回呼んで確かめる
  if (!isEmulatorTest(apiKey)) try {
    await new Anthropic({ apiKey }).models.retrieve(MODEL);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpsError("invalid-argument", "この鍵は使えませんでした。もう一度コピーしなおしてください");
    if (e instanceof Anthropic.PermissionDeniedError) throw new HttpsError("invalid-argument", "この鍵には使う権限がありません");
    throw new HttpsError("unavailable", "AIの確認ができませんでした。時間をおいてもう一度お試しください");
  }
  await db.doc(KEY_DOC).set({ apiKey, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  return { set: true, last4: apiKey.slice(-4) };
});

// 読み取った結果の形（AIにこの形で返してもらう）
const NUM_OR_NULL = { anyOf: [{ type: "integer" }, { type: "null" }] };
const SCHEMA = {
  type: "object",
  properties: {
    sheets: {
      type: "array",
      description: "仕切書1枚（1か月分）ごと。PDFに複数か月分あればそれぞれ",
      items: {
        type: "object",
        properties: {
          year: { type: "integer", description: "西暦の年（例：2026）" },
          month: { type: "integer", description: "何月分か（1〜12）" },
          blocks: {
            type: "array",
            description: "品種・規格のまとまり（例：なつみずき 秀品、夏瑞 秀品）",
            items: {
              type: "object",
              properties: {
                variety: { type: "string", description: "品種（例：なつみずき、夏瑞）" },
                rank: { type: "string", description: "規格（例：秀品、A品）" },
                rows: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      size: { type: "string", description: "サイズの欄の文字そのまま（例：8入りR、16入り、プレミアム、ロイヤル）" },
                      entries: {
                        type: "array",
                        description: "数量が0でない日だけ",
                        items: {
                          type: "object",
                          properties: {
                            day: { type: "integer" },
                            qty: { type: "integer", description: "数量" },
                            price: { type: "integer", description: "単価（円）" },
                          },
                          required: ["day", "qty", "price"],
                          additionalProperties: false,
                        },
                      },
                      qtyTotal: { ...NUM_OR_NULL, description: "右端の「数量計」に印刷された数字" },
                    },
                    required: ["size", "entries", "qtyTotal"],
                    additionalProperties: false,
                  },
                },
                amountTotal: { ...NUM_OR_NULL, description: "このまとまりの「品種合計額」に印刷された数字" },
              },
              required: ["variety", "rank", "rows", "amountTotal"],
              additionalProperties: false,
            },
          },
          subtotal: { ...NUM_OR_NULL, description: "「8%軽対象合計額」（税抜の合計）" },
          tax: { ...NUM_OR_NULL, description: "「消費税」" },
          total: { ...NUM_OR_NULL, description: "「税込金額」" },
          fee: { ...NUM_OR_NULL, description: "「送金料」" },
          paid: { ...NUM_OR_NULL, description: "「送金額」" },
        },
        required: ["year", "month", "blocks", "subtotal", "tax", "total", "fee", "paid"],
        additionalProperties: false,
      },
    },
    notes: { type: "string", description: "読みにくかったところ・自信がないところ（なければ空）" },
  },
  required: ["sheets", "notes"],
  additionalProperties: false,
} as const;

const PROMPT = `これは、いちごの出荷先から届いた「仕切書（支払明細書）」をスキャンしたものです。紙が横向きに写っていることがあります。
表の数字を、1つずつ正確に読み取ってください。

表の見方：
- 横に1日〜31日の列、縦にサイズ（8入りR、16入り、20入り…、プレミアム、ロイヤルなど）の行があります。
- サイズごとに「数量」と「単価」の2行があります。同じ日の列の、上が数量、下が単価です。
- 右端の「数量計」、まとまりごとの「品種合計額」、下の「8%軽対象合計額」「消費税」「税込金額」「送金料」「送金額」も読んでください。

読み取りの決まり：
- 数量が0の日は entries に入れないでください。
- 日付は列の見出し（何日）で決めてください。列を1つずらさないよう、特に注意してください。
- 読み取ったら、サイズごとに数量の合計が「数量計」と合うか、数量×単価の合計が「品種合計額」と合うかを確かめ、合わなければ読みなおしてください。
- それでも読めない・自信がないところは notes に書いてください。推測で埋めないでください。`;

type Upload = { mediaType: string; data: string };
const MAX_FILES = 6;
const MAX_TOTAL = 9_000_000; // base64 の合計（呼び出しの大きさの上限 10MB に収める）

/** 仕切書を読み取る（スタッフ） */
export const readShikiri = onCall({ timeoutSeconds: 540, memory: "512MiB" }, async (req) => {
  await assertStaff(req);
  const files = (req.data as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) throw new HttpsError("invalid-argument", "仕切書のファイルを選んでください");
  if (files.length > MAX_FILES) throw new HttpsError("invalid-argument", `一度に読めるのは${MAX_FILES}ページまでです`);
  let size = 0;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of files as Upload[]) {
    if (typeof f?.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.data)) throw new HttpsError("invalid-argument", "ファイルが読めません");
    size += f.data.length;
    if (f.mediaType === "image/jpeg" || f.mediaType === "image/png") {
      content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
    } else if (f.mediaType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    } else throw new HttpsError("invalid-argument", "写真（JPEG・PNG）かPDFを選んでください");
  }
  if (size > MAX_TOTAL) throw new HttpsError("invalid-argument", "ファイルが大きすぎます");
  content.push({ type: "text", text: PROMPT });

  const apiKey = await loadKey();
  if (!apiKey) throw new HttpsError("failed-precondition", "AIの鍵が登録されていません。管理者が「AIの鍵」を登録してください");
  if (isEmulatorTest(apiKey)) return { result: JSON.parse(readFileSync(join(__dirname, "../test-fixtures/shikiri-2026-08.json"), "utf8")) as unknown, usage: { input: 0, output: 0 } };
  const client = new Anthropic({ apiKey });

  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpsError("failed-precondition", "AIの鍵が使えなくなっています。管理者が登録しなおしてください");
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "AIが混み合っています。少し待ってからもう一度お試しください");
    if (e instanceof Anthropic.BadRequestError) {
      console.error("readShikiri bad request", e.message);
      if (/credit|billing/i.test(e.message)) throw new HttpsError("failed-precondition", "AIの利用料金の残高が足りません。Anthropicの画面で残高を追加してください");
      throw new HttpsError("invalid-argument", "このファイルはAIで読めませんでした（大きすぎる・壊れているなど）");
    }
    console.error("readShikiri error", e);
    throw new HttpsError("unavailable", "AIとの通信に失敗しました。時間をおいてもう一度お試しください");
  }
  if (message.stop_reason === "refusal") throw new HttpsError("failed-precondition", "AIがこのファイルを読み取れませんでした");
  if (message.stop_reason === "max_tokens") throw new HttpsError("failed-precondition", "読み取る量が多すぎました。1か月分ずつに分けてください");
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    return { result: JSON.parse(text) as unknown, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
  } catch {
    console.error("readShikiri parse", text.slice(0, 500));
    throw new HttpsError("internal", "読み取った結果の形が正しくありませんでした。もう一度お試しください");
  }
});
