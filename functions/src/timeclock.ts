// 打刻タブレット：入口に置いたAndroidタブレットに、従業員が自分のNFCタグをかざして出勤・退勤する。
// 打刻はタイムカード（timecards/{YYYY-MM}）に、MAXのタイムレコーダーと同じ形で入れる（s＝"tab" の印付き。同じ日はタブレットを優先）。
// タブレットは打刻専用のログイン（role = timeclock）で、データは読めない。打刻・休憩の修正はここ（サーバー）で行う。
// タグ → 従業員の登録・タブレットのログインは管理者が行う。
import { getAuth } from "firebase-admin/auth";
import { FieldPath, FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { assertAdmin, db, requirePassword, requireString } from "./common.js";
import { isEmulatorTest, loadKey, MODEL } from "./shikiri.js";
import { WORKER_EMAIL_DOMAIN } from "./shift.js";
import { nextPunch } from "./timeclockDay.js";

/** タグ → 従業員（給与の従業員）とタイムカードのカード番号。yomi＝名前の読み方（ひらがな。打刻のあいさつの声に使う）、yomiGuess＝AIの予測のまま */
type Tag = { employeeId: string; card: string; name: string; at: number; yomi?: string; yomiGuess?: boolean };
const TAGS = "timeclock/tags";
/** まだ登録していないタグ（かざした時刻）。管理者が従業員を割り当てる */
const UNKNOWN = "timeclock/unknown";
const LOGIN = "timeclock/login";
/** 休憩の修正で選べる長さ（分） */
const BREAK_CHOICES = [0, 15, 30, 45, 60];

function requireSerial(v: unknown): string {
  const s = requireString(v, "タグ", 64).toLowerCase();
  if (!/^[0-9a-f:]{4,64}$/.test(s)) throw new HttpsError("invalid-argument", "タグの番号が正しくありません");
  return s;
}

/** 打刻タブレット（または管理者）か */
async function assertTimeclock(req: CallableRequest) {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください");
  if (req.auth?.token.role === "admin") return assertAdmin(req);
  if (req.auth?.token.role !== "timeclock") throw new HttpsError("permission-denied", "打刻タブレットだけが使えます");
  const login = await db.doc(LOGIN).get();
  if (login.get("uid") !== uid || login.get("active") !== true)
    throw new HttpsError("permission-denied", "このタブレットの打刻は止められています。管理者に確認してください");
  return uid;
}

/** 日本時間の日付（YYYY-MM-DD）と、0時からの分 */
function jst(ms: number) {
  const d = new Date(ms + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * かざした時刻：ふつうはサーバーの時刻。通信が切れていてあとから送った分だけ、タブレットで記録した時刻（24時間以内）を使う
 */
function punchTime(v: unknown): number {
  const now = Date.now();
  if (v == null) return now;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpsError("invalid-argument", "時刻が正しくありません");
  if (v > now + 60_000 || v < now - 24 * 3600_000) throw new HttpsError("invalid-argument", "時刻が正しくありません");
  return Math.min(v, now);
}

async function tagOf(serial: string): Promise<Tag | null> {
  const tags = ((await db.doc(TAGS).get()).get("tags") ?? {}) as Record<string, Tag>;
  return tags[serial] ?? null;
}

/** 未登録のタグを残す（新しい20枚まで） */
async function rememberUnknown(serial: string, at: number) {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(UNKNOWN);
    const items = { ...(((await tx.get(ref)).get("items") ?? {}) as Record<string, number>), [serial]: at };
    const keep = Object.fromEntries(
      Object.entries(items)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
    );
    tx.set(ref, { items: keep, updatedAt: FieldValue.serverTimestamp() });
  });
}

type Day = { i: number | null; o: number | null; s?: string; e?: { i: number | null; o: number | null }; bk?: number; x?: string };

/** その日の分だけを書き直す（消した欄も消えるように、日ごと置き換える） */
function writeDay(tx: Transaction, ref: DocumentReference, exists: boolean, card: string, dd: string, day: Day) {
  if (exists) tx.update(ref, new FieldPath("cards", card, dd), day, "updatedAt", FieldValue.serverTimestamp());
  else tx.set(ref, { cards: { [card]: { [dd]: day } }, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * かざした：その日の最初が出勤、そのあとは退勤（最後にかざした時刻）。
 * MAXの打刻がある日も、タブレットでかざしたら、タブレットの打刻に置き換える（直した時刻・休憩はそのまま）
 */
export const timeclockPunch = onCall(async (req) => {
  await assertTimeclock(req);
  const serial = requireSerial(req.data?.serial);
  const at = punchTime(req.data?.at);
  const tag = await tagOf(serial);
  if (!tag) {
    await rememberUnknown(serial, at);
    return { unknown: true };
  }
  const { date, min } = jst(at);
  const ref = db.doc(`timecards/${date.slice(0, 7)}`);
  const dd = date.slice(8);
  const kind = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const day = (snap.get("cards") as Record<string, Record<string, Day>> | undefined)?.[tag.card]?.[dd];
    // 手で直した日（e）にかざしても集計表に出るように、直した時刻にもタブレットの時刻を入れる（timeclockDay.ts）
    const r = nextPunch(day as Parameters<typeof nextPunch>[0], min);
    if (r.kind === "dup" || !r.next) return "dup" as const;
    writeDay(tx, ref, snap.exists, tag.card, dd, r.next as Day);
    return r.kind;
  });
  return { name: tag.name, yomi: tag.yomi ?? null, kind, min, date };
});

/** 休憩時間を修正：その人のその日の休憩（分）。null＝いつもどおり（自動）に戻す */
export const timeclockBreak = onCall(async (req) => {
  await assertTimeclock(req);
  const serial = requireSerial(req.data?.serial);
  const minutes = req.data?.minutes;
  if (minutes !== null && !BREAK_CHOICES.includes(minutes)) throw new HttpsError("invalid-argument", "休憩の長さを選んでください");
  const tag = await tagOf(serial);
  if (!tag) {
    await rememberUnknown(serial, Date.now());
    return { unknown: true };
  }
  const { date } = jst(Date.now());
  const ref = db.doc(`timecards/${date.slice(0, 7)}`);
  const dd = date.slice(8);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const day = (snap.get("cards") as Record<string, Record<string, Day>> | undefined)?.[tag.card]?.[dd];
    const next: Day = { ...(day ?? { i: null, o: null }) };
    if (minutes === null) delete next.bk;
    else next.bk = minutes;
    writeDay(tx, ref, snap.exists, tag.card, dd, next);
  });
  return { name: tag.name, minutes, date };
});

/**
 * タグに従業員を割り当てる・外す（管理者）。
 * カード番号は、その人のMAXのカード番号（タイムカードのひも付け）を使う。なければ社員番号、それもなければ T＋社員のID
 */
export const timeclockSetTag = onCall(async (req) => {
  await assertAdmin(req);
  const serial = requireSerial(req.data?.serial);
  // まちがえてかざした未登録のタグを、一覧から消す（登録はしない）
  if (req.data?.forget === true) {
    await db.doc(UNKNOWN).set({ items: { [serial]: FieldValue.delete() } }, { merge: true });
    return { ok: true };
  }
  const employeeId = req.data?.employeeId;
  if (employeeId === null) {
    await db.doc(TAGS).set({ tags: { [serial]: FieldValue.delete() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true };
  }
  const id = requireString(employeeId, "従業員", 64);
  const emp = await db.doc(`employees/${id}`).get();
  if (!emp.exists) throw new HttpsError("not-found", "従業員が見つかりません");
  const cfgRef = db.doc("config/timecard");
  const cards = ((await cfgRef.get()).get("cards") ?? {}) as Record<string, string>;
  const code = String(emp.get("code") ?? "").trim();
  let card = Object.keys(cards).find((c) => cards[c] === id);
  if (!card) {
    // 社員番号が同じカード（ひも付けがないときに使う決まり）がほかの人に使われていなければ、社員番号
    card = /^\d+$/.test(code) && !cards[code] ? code : `T${id.slice(0, 20)}`;
    await cfgRef.set({ cards: { [card]: id }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  const tag: Tag = { employeeId: id, card, name: String(emp.get("name") ?? "").slice(0, 30), at: Date.now() };
  // 前にほかの人で使っていたタグなら、その人の読み方は消す（あとで予測し直す）
  await db
    .doc(TAGS)
    .set(
      { tags: { [serial]: { ...tag, yomi: FieldValue.delete(), yomiGuess: FieldValue.delete() } }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  await db.doc(UNKNOWN).set({ items: { [serial]: FieldValue.delete() } }, { merge: true });
  return { card };
});

/** 打刻タブレットのログインを作る・パスワードを変える・止める（管理者）。ログインIDは従業員と同じ形 */
export const setTimeclockLogin = onCall(async (req) => {
  await assertAdmin(req);
  const ref = db.doc(LOGIN);
  const cur = await ref.get();
  const uid = cur.get("uid") as string | undefined;
  if (req.data?.stop === true) {
    if (uid) {
      await getAuth().updateUser(uid, { disabled: true });
      await getAuth().revokeRefreshTokens(uid);
    }
    await ref.set({ active: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true };
  }
  const password = requirePassword(req.data?.password);
  if (uid) {
    await getAuth().updateUser(uid, { password, disabled: false });
    await getAuth().revokeRefreshTokens(uid);
    await ref.set({ active: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { loginId: cur.get("loginId") };
  }
  const loginId = requireString(req.data?.loginId, "ログインID", 30, 3).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(loginId)) throw new HttpsError("invalid-argument", "ログインIDは、半角の英字・数字（3〜30文字）にしてください");
  let newUid: string;
  try {
    newUid = (await getAuth().createUser({ email: `${loginId}@${WORKER_EMAIL_DOMAIN}`, password, displayName: "打刻タブレット" })).uid;
  } catch (e) {
    if ((e as { code?: string }).code === "auth/email-already-exists") throw new HttpsError("already-exists", "このログインIDはすでに使われています");
    throw e;
  }
  await getAuth().setCustomUserClaims(newUid, { role: "timeclock" });
  await ref.set({ uid: newUid, loginId, active: true, updatedAt: FieldValue.serverTimestamp() });
  return { loginId };
});

// ---------- 名前の読み方（打刻のあいさつの声で「〇〇さん」と読む） ----------

/** 読み方をそろえる：カタカナはひらがなに、空白は1つに。ひらがな・長音・空白だけ（30文字まで）。だめなら null */
export function normYomi(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const h = v
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s\u3000・]+/g, " ")
    .trim();
  return /^[\u3041-\u3096\u30fc ]{1,30}$/.test(h) ? h : null;
}

/** 読み方を直す（管理者）。null＝消す（漢字のまま読み上げる） */
export const timeclockSetYomi = onCall(async (req) => {
  await assertAdmin(req);
  const serial = requireSerial(req.data?.serial);
  const raw = req.data?.yomi;
  const yomi = raw === null || raw === "" ? null : normYomi(raw);
  if (raw !== null && raw !== "" && !yomi) throw new HttpsError("invalid-argument", "読み方は、ひらがな（またはカタカナ）で入れてください");
  const tags = ((await db.doc(TAGS).get()).get("tags") ?? {}) as Record<string, Tag>;
  if (!tags[serial]) throw new HttpsError("not-found", "このタグは登録されていません");
  await db
    .doc(TAGS)
    .set(
      { tags: { [serial]: { yomi: yomi ?? FieldValue.delete(), yomiGuess: FieldValue.delete() } }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  return { yomi };
});

const YOMI_SCHEMA = {
  type: "object",
  properties: {
    readings: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, yomi: { type: "string" } }, required: ["id", "yomi"], additionalProperties: false },
    },
  },
  required: ["readings"],
  additionalProperties: false,
};

/** 読み方がまだないタグの名前の読み方を、AIで予測して入れる（管理者）。入れた数を返す */
export const timeclockGuessYomi = onCall(async (req) => {
  await assertAdmin(req);
  const tags = ((await db.doc(TAGS).get()).get("tags") ?? {}) as Record<string, Tag>;
  const todo = Object.entries(tags).filter(([, t]) => !t.yomi && t.name);
  if (todo.length === 0) return { count: 0 };
  const apiKey = await loadKey();
  if (!apiKey) throw new HttpsError("failed-precondition", "AIの鍵が登録されていないので、読み方を予測できません（手で入れてください）");
  let readings: { id: string; yomi: string }[];
  if (isEmulatorTest(apiKey)) readings = todo.map(([serial]) => ({ id: serial, yomi: "てすと" }));
  else {
    const list = todo.map(([serial, t]) => `${serial}\t${t.name}`).join("\n");
    try {
      const stream = new Anthropic({ apiKey }).beta.messages.stream({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: YOMI_SCHEMA } },
        messages: [
          {
            role: "user",
            content:
              "次の日本人の氏名の、いちばんありそうな読み方を、ひらがなで答えてください。姓と名の間は空白1つ。名前がカタカナや英字なら、その読みをひらがなで。" +
              "id はそのまま返してください。\n（id と氏名をタブ区切りで1行に1人）\n" +
              list,
          },
        ],
      });
      const m = await stream.finalMessage();
      const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      readings = (JSON.parse(text) as { readings: { id: string; yomi: string }[] }).readings ?? [];
    } catch (e) {
      console.error("timeclockGuessYomi", e);
      throw new HttpsError("unavailable", "読み方の予測ができませんでした。時間をおいてもう一度お試しください（手で入れることもできます）");
    }
  }
  const upd: Record<string, { yomi: string; yomiGuess: true }> = {};
  for (const r of readings) {
    const y = normYomi(r.yomi);
    if (!y || !tags[r.id] || tags[r.id].yomi) continue;
    upd[r.id] = { yomi: y, yomiGuess: true };
  }
  const count = Object.keys(upd).length;
  if (count > 0) await db.doc(TAGS).set({ tags: upd, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { count };
});
