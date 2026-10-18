// ハウスの中の温度（Govee の温湿度計 H5179）。1日じゅう20分ごとに Govee から今の温度を読み取り、
// houseTemp/{日付} に残す。1つの日付には「前の日の9時すぎ〜その日の9時」の24時間分が入る（その日の収穫の前の24時間）。
// 振り返りで、その24時間の最低・平均・最高の温度を見る。
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

/** 日本時間の今。date＝どの日の分か（9時までなら今日、9時すぎなら明日）、time＝"HH:MM" */
export function daySlot(nowMs: number): { date: string; time: string } {
  const jst = new Date(nowMs + 9 * 3600_000);
  const time = jst.toISOString().slice(11, 16);
  const day = time > "09:00" ? new Date(jst.getTime() + 86400_000) : jst;
  return { date: day.toISOString().slice(0, 10), time };
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
export async function pollGoveeOnce(nowMs = Date.now()) {
  const slot = daySlot(nowMs);
  const apiKey = (await db.doc("secrets/govee").get()).get("apiKey") as string | undefined;
  if (!apiKey) return { saved: 0 };
  const cfg = await db.doc("config/govee").get();
  const devices = (cfg.get("devices") as GoveeDevice[] | undefined) ?? [];
  const houseOf = (cfg.get("houseOf") as Record<string, string> | undefined) ?? {};
  const readings: Record<string, unknown> = {};
  const temps: Record<string, number> = {};
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
    temps[house] = temp;
  }
  if (Object.keys(readings).length) await db.doc(`houseTemp/${slot.date}`).set({ readings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const alertTemp = typeof cfg.get("alertTemp") === "number" ? (cfg.get("alertTemp") as number) : DEFAULT_ALERT_TEMP;
  await updateAlert(nowMs, temps, [...new Set(Object.values(houseOf).filter(Boolean))], alertTemp);
  return { saved: Object.keys(readings).length, date: slot.date };
}

// ---------- 温度の見張り（警報） ----------
// alerts/temp に「いま出ている警報」を入れる。見張り担当の携帯（見張り画面）がこれを見て、①→②→③の順に鳴らす。
// だれかが「止める」を押すと ackBy・ackAt が入り、全員の音が止まる。新しい警報が出たら、止めた印を消して①から鳴らし直す

/** 知らせる温度（画面で変えていなければ） */
const DEFAULT_ALERT_TEMP = 4;
/** 温度計がこれより長く読めないと警報（分） */
const STALE_MIN = 60;

export type AlertItem = { house: string; kind: "low" | "stale"; temp?: number; since: number };

/** 読んだ結果から、警報の中身を決める（lastOk＝ハウスごとに最後に読めた時刻） */
export function alertItems(
  nowMs: number,
  temps: Record<string, number>,
  houses: string[],
  lastOk: Record<string, number>,
  alertTemp: number,
  prev: AlertItem[],
) {
  const items: AlertItem[] = [];
  const sinceOf = (key: string) => prev.find((x) => `${x.kind}-${x.house}` === key)?.since ?? nowMs;
  for (const h of houses) {
    if (temps[h] != null) {
      if (temps[h] < alertTemp) items.push({ house: h, kind: "low", temp: temps[h], since: sinceOf(`low-${h}`) });
      continue;
    }
    // 一度も読めていない温度計（つながっていない）は見張らない。1日以上読めていないものも、もう知らせない
    const age = lastOk[h] != null ? (nowMs - lastOk[h]) / 60_000 : null;
    if (age != null && age > STALE_MIN && age < 24 * 60) items.push({ house: h, kind: "stale", since: sinceOf(`stale-${h}`) });
  }
  return items;
}

async function updateAlert(nowMs: number, temps: Record<string, number>, houses: string[], alertTemp: number) {
  const ref = db.doc("alerts/temp");
  const prev = (await ref.get()).data() ?? {};
  const lastOk: Record<string, number> = { ...(prev.lastOk ?? {}) };
  const latest: Record<string, { temp: number; at: number }> = { ...(prev.latest ?? {}) };
  for (const [h, t] of Object.entries(temps)) {
    lastOk[h] = nowMs;
    latest[h] = { temp: t, at: nowMs };
  }
  // 温度計の割り当てを外したハウスは消す
  for (const h of Object.keys(latest)) if (!houses.includes(h)) delete latest[h];
  const prevItems = (prev.items ?? []) as AlertItem[];
  const items = alertItems(nowMs, temps, houses, lastOk, alertTemp, prevItems);
  const prevKeys = new Set(prevItems.map((x) => `${x.kind}-${x.house}`));
  const fresh = items.some((x) => !prevKeys.has(`${x.kind}-${x.house}`));
  const reset = items.length === 0 || fresh;
  await ref.set({
    items,
    startedAt: items.length === 0 ? null : fresh || !prev.startedAt ? nowMs : prev.startedAt,
    ackBy: reset ? null : (prev.ackBy ?? null),
    ackAt: reset ? null : (prev.ackAt ?? null),
    lastOk,
    latest,
    alertTemp,
    checkedAt: nowMs,
  });
}

/** 1日じゅう、20分ごとに読む */
export const pollGovee = onSchedule({ schedule: "*/20 * * * *", timeZone: "Asia/Tokyo", timeoutSeconds: 90 }, async () => {
  await pollGoveeOnce();
});

/** 今すぐ1回読んで残す（管理者。つながっているかの確認用） */
export const pollGoveeNow = onCall({ timeoutSeconds: 60 }, async (req) => {
  await assertAdmin(req);
  return await pollGoveeOnce(Date.now());
});
