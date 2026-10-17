// ハウスの中の温度（Govee の温湿度計 H5179）。夜のあいだ（18時〜翌朝9時）20分ごとに Govee から今の温度を読み取り、
// houseTemp/{日付}（その夜が明けた日。収穫の日と同じ）に残す。振り返りで「その夜でいちばん低い温度」を見る。
// Govee の API キーは、管理者が画面から登録する（secrets/govee。画面からは誰も読めない。サーバーだけが使う）。
// Govee の公開 API（Govee Developer Platform）を使う。読めるのは今の値だけなので、こちらから定期的に読みにいく。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { assertAdmin, db } from "./common.js";

const API = "https://openapi.api.govee.com/router/api/v1";

/** Govee の温湿度計 */
export type GoveeDevice = { device: string; sku: string; name: string };
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

async function goveeFetch(path: string, apiKey: string, body?: Json): Promise<Json> {
  // テスト環境（エミュレーター）では Govee には取りに行かず、用意した答えを使う
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    if (apiKey === "bad-key") throw new HttpsError("invalid-argument", "Govee の API キーが正しくありません");
    const file = path.startsWith("/user/devices") ? "govee-devices.json" : "govee-state.json";
    return JSON.parse(readFileSync(join(__dirname, "../test-fixtures", file), "utf8")) as Json;
  }
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Govee-API-Key": apiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new HttpsError("invalid-argument", "Govee の API キーが正しくありません");
  if (res.status === 429) throw new HttpsError("resource-exhausted", "Govee の読み取りの回数が上限をこえました。少し時間をおいてください");
  if (!res.ok) throw new HttpsError("unavailable", `Govee につながりませんでした（${res.status}）`);
  return (await res.json()) as Json;
}

/** 温湿度計の一覧（温度が読めるものだけ） */
export function parseDevices(res: Json): GoveeDevice[] {
  return arr(res.data)
    .map(obj)
    .filter((d) => arr(d.capabilities).some((c) => obj(c).instance === "sensorTemperature"))
    .map((d) => ({ device: String(d.device ?? ""), sku: String(d.sku ?? ""), name: String(d.deviceName ?? d.sku ?? "") }))
    .filter((d) => d.device && d.sku);
}

/** Govee の温度は華氏（°F）で返ってくるので、摂氏（℃）にする（小数1けた） */
export const fToC = (f: number) => Math.round((((f - 32) * 5) / 9) * 10) / 10;

/** 今の温度（℃）。つながっていない・読めないときは null */
export function parseState(res: Json): number | null {
  const caps = arr(obj(res.payload).capabilities).map(obj);
  if (caps.some((c) => c.instance === "online" && obj(c.state).value === false)) return null;
  const v = obj(caps.find((c) => c.instance === "sensorTemperature")?.state).value;
  return typeof v === "number" && Number.isFinite(v) ? fToC(v) : null;
}

async function readTemp(apiKey: string, d: { device: string; sku: string }): Promise<number | null> {
  return parseState(await goveeFetch("/device/state", apiKey, { requestId: randomUUID(), payload: { sku: d.sku, device: d.device } }));
}

/** 日本時間の今。date＝その夜が明けた日（12時より前なら今日、あとなら明日）、time＝"HH:MM" */
export function nightSlot(nowMs: number): { date: string; time: string; inNight: boolean } {
  const jst = new Date(nowMs + 9 * 3600_000);
  const time = jst.toISOString().slice(11, 16);
  const day = jst.getUTCHours() >= 12 ? new Date(jst.getTime() + 86400_000) : jst;
  return { date: day.toISOString().slice(0, 10), time, inNight: time >= "18:00" || time <= "09:00" };
}

/** Govee の API キーを登録する（管理者）。キーが使えるか確かめて、温湿度計の一覧と今の温度を返す（キーそのものは返さない） */
export const saveGoveeKey = onCall({ timeoutSeconds: 60 }, async (req) => {
  await assertAdmin(req);
  const raw = req.data?.apiKey;
  const stored = (await db.doc("secrets/govee").get()).get("apiKey") as string | undefined;
  // キーを入れずに押したときは、登録してあるキーで確かめ直す
  const apiKey = typeof raw === "string" && raw.trim() ? raw.trim() : stored;
  if (!apiKey) throw new HttpsError("invalid-argument", "API キーを入れてください");
  if (apiKey.length > 200) throw new HttpsError("invalid-argument", "API キーが長すぎます");
  const devices = parseDevices(await goveeFetch("/user/devices", apiKey));
  await db.doc("secrets/govee").set({ apiKey, updatedAt: FieldValue.serverTimestamp() });
  await db.doc("config/govee").set({ devices, keySet: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const now: Record<string, number | null> = {};
  for (const d of devices) {
    try {
      now[d.device] = await readTemp(apiKey, d);
    } catch {
      now[d.device] = null;
    }
  }
  return { devices, now };
});

/** 1回分：ハウスを決めた温湿度計の今の温度を読んで残す */
export async function pollGoveeOnce(nowMs = Date.now(), force = false) {
  const slot = nightSlot(nowMs);
  if (!slot.inNight && !force) return { saved: 0 };
  const apiKey = (await db.doc("secrets/govee").get()).get("apiKey") as string | undefined;
  if (!apiKey) return { saved: 0 };
  const cfg = await db.doc("config/govee").get();
  const devices = (cfg.get("devices") as GoveeDevice[] | undefined) ?? [];
  const houseOf = (cfg.get("houseOf") as Record<string, string> | undefined) ?? {};
  const readings: Record<string, unknown> = {};
  for (const d of devices) {
    const house = houseOf[d.device];
    if (!house) continue;
    let temp: number | null = null;
    try {
      temp = await readTemp(apiKey, d);
    } catch {
      temp = null;
    }
    if (temp == null) continue; // 通信がうまくいかない温湿度計は、その回は飛ばす
    readings[house] = FieldValue.arrayUnion({ t: slot.time, temp });
  }
  // 夜の時間でなければ残さない（確認で読んだだけ）
  if (Object.keys(readings).length && slot.inNight)
    await db.doc(`houseTemp/${slot.date}`).set({ readings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { saved: Object.keys(readings).length, date: slot.date };
}

/** 夜のあいだ、20分ごとに読む（日本時間 18:00〜9:00） */
export const pollGovee = onSchedule({ schedule: "*/20 0-9,18-23 * * *", timeZone: "Asia/Tokyo", timeoutSeconds: 90 }, async () => {
  await pollGoveeOnce();
});

/** 今すぐ1回読む（管理者。つながっているかの確認用）。昼に読んだ分は残さない */
export const pollGoveeNow = onCall({ timeoutSeconds: 60 }, async (req) => {
  await assertAdmin(req);
  return await pollGoveeOnce(Date.now(), true);
});
