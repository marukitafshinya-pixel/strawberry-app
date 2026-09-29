"use client";

// 仕切書（出荷先から届く支払明細書）をAIで読み取り、出荷実績（概算）を正確な数字に直す
import { doc, serverTimestamp, writeBatch } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";
import {
  applyChanges,
  checkSheet,
  diffSheet,
  filesToPages,
  guessGrade,
  monthDays,
  pagesToUploads,
  type Page,
  type ShikiriResult,
  type ShikiriRow,
  type ShikiriSheet,
} from "@/lib/shikiri";
import { parseOcrPage, type OcrPage } from "@/lib/shikiriOcr";
import { useShipments, type Grade } from "@/lib/shipping";
import { todayJST } from "@/lib/date";

const num = (n: number) => n.toLocaleString("ja-JP");
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export function ShikiriImport({ grades, onDone }: { grades: Grade[]; onDone: () => void }) {
  const { role } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<{ set: boolean; last4: string } | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [result, setResult] = useState<ShikiriResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);

  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => {
    if (!aiOpen || key) return;
    callFunction<object, { set: boolean; last4: string }>("aiKeyStatus", {})
      .then(setKey)
      .catch((e) => setError(errorText(e)));
  }, [aiOpen, key]);
  // 読み取り中は、かかっている時間を出す（1〜3分かかるので）
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [started]);

  async function pick(files: File[]) {
    setError("");
    setResult(null);
    setBusy("ファイルを開いています…");
    try {
      setPages(await filesToPages(files));
    } catch (e) {
      console.error("仕切書を開けませんでした", e);
      setError(e instanceof Error && /[ぁ-ん]/.test(e.message) ? e.message : "ファイルを開けませんでした。PDFか写真を選んでください");
    } finally {
      setBusy("");
    }
  }

  /** Google の文字読み取りで読み、表を組み立てる */
  async function readOcr() {
    setError("");
    setBusy("文字を読み取っています…");
    setStarted(Date.now());
    setNow(Date.now());
    try {
      const files = pagesToUploads(pages);
      const res = await callFunction<{ files: typeof files }, { pages: OcrPage[] }>("readShikiriOcr", { files }, 150_000);
      const year = Number(todayJST().slice(0, 4));
      const sheets: ShikiriSheet[] = [];
      const notes: string[] = [];
      res.pages.forEach((pg, i) => {
        const r = parseOcrPage(pg, year);
        if (r.sheet) sheets.push(r.sheet);
        notes.push(...r.notes.map((n) => (res.pages.length > 1 ? `${i + 1}ページ目：${n}` : n)));
      });
      if (!sheets.length) throw new Error(notes.join(" ") || "仕切書の表が見つかりませんでした");
      setResult({ sheets, notes: notes.join("\n") });
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : errorText(e));
    } finally {
      setBusy("");
      setStarted(0);
    }
  }

  async function read() {
    setError("");
    setBusy("AIが読み取っています…");
    setStarted(Date.now());
    setNow(Date.now());
    try {
      const files = pagesToUploads(pages);
      const res = await callFunction<{ files: typeof files }, { result: ShikiriResult }>("readShikiri", { files }, 560_000);
      if (!res.result?.sheets?.length) throw new Error("仕切書の表が見つかりませんでした");
      setResult(res.result);
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : errorText(e));
    } finally {
      setBusy("");
      setStarted(0);
    }
  }

  function close() {
    setOpen(false);
    setPages([]);
    setResult(null);
    setError("");
  }

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="mt-3 rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-bold text-emerald-800">
        仕切書で正確な数字に直す（読み取り）
      </button>
    );

  return (
    <section className="mt-3 rounded-2xl border border-emerald-700/40 bg-white p-4 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">仕切書で正確な数字に直す</h2>
        <button onClick={close} className="text-gray-500 underline">
          閉じる
        </button>
      </div>
      <p className="mt-1 text-gray-600">
        出荷先から届いた仕切書（支払明細書）のPDFか写真を選ぶと、表の数字を読み取ります。読み取った数字はすぐには保存しません。仕切書の合計と照らし合わせ、今の数字（概算）と並べて確かめてから直します。
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (fs.length) pick(fs);
        }}
      />
      {!result && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button disabled={!!busy} onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-4 py-2 disabled:opacity-50">
            {pages.length ? "ファイルを選びなおす" : "仕切書のファイルを選ぶ（PDF・写真）"}
          </button>
          {pages.length > 0 && (
            <button disabled={!!busy} onClick={readOcr} className="rounded-lg bg-emerald-700 px-5 py-2 font-bold text-white disabled:opacity-50">
              読み取る
            </button>
          )}
        </div>
      )}
      {busy && (
        <p className="mt-2 text-gray-600">
          {busy}
          {started > 0 && `（${Math.max(0, Math.floor((now - started) / 1000))}秒）`}
        </p>
      )}
      {error && <p className="mt-2 text-red-600">{error}</p>}

      {!result && pages.length > 0 && (
        <>
          <p className="mt-3 text-gray-600">表の文字がまっすぐ読める向きになっているか確かめてください。違っていたら「回す」を押してください。</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {pages.map((p, i) => (
              <figure key={i} className="w-48">
                <Thumb page={p} />
                <figcaption className="mt-1 flex items-center justify-between gap-1 text-xs text-gray-600">
                  <span className="truncate">{p.name}</span>
                  <span className="flex shrink-0 gap-1">
                    <button
                      onClick={() => setPages(pages.map((x, j) => (j === i ? { ...x, rotate: (((x.rotate + 90) % 360) as Page["rotate"]) } : x)))}
                      className="rounded border px-2 py-0.5"
                    >
                      回す
                    </button>
                    <button onClick={() => setPages(pages.filter((_, j) => j !== i))} className="rounded border px-2 py-0.5">
                      外す
                    </button>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
          <details className="mt-4 text-gray-600" open={aiOpen} onToggle={(e) => setAiOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer">うまく読めないとき：AIで読み取る（Anthropic の鍵が必要）</summary>
            {key && <KeyBox status={key} admin={role === "admin"} onChange={setKey} />}
            <button disabled={!!busy || !key?.set} onClick={read} className="mt-2 rounded-lg border border-emerald-700 bg-white px-4 py-2 font-bold text-emerald-800 disabled:opacity-50">
              AIで読み取る（1〜3分）
            </button>
          </details>
        </>
      )}

      {result && (
        <>
          {result.notes && <p className="mt-3 whitespace-pre-line rounded-lg bg-amber-50 p-3 text-amber-900">読み取りのメモ：{result.notes}</p>}
          {result.sheets.map((s, i) => (
            <SheetPanel key={i} sheet={s} grades={grades} onDone={onDone} />
          ))}
          <button onClick={() => { setResult(null); setPages([]); }} className="mt-3 rounded-lg border bg-white px-4 py-2">
            別の仕切書を読み取る
          </button>
        </>
      )}
    </section>
  );
}

/** ページの小さい見本（向きを直した形で） */
function Thumb({ page }: { page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const side = page.rotate === 90 || page.rotate === 270;
    const w = side ? page.canvas.height : page.canvas.width;
    const h = side ? page.canvas.width : page.canvas.height;
    const s = 384 / Math.max(w, h);
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((page.rotate * Math.PI) / 180);
    ctx.drawImage(page.canvas, (-page.canvas.width * s) / 2, (-page.canvas.height * s) / 2, page.canvas.width * s, page.canvas.height * s);
  }, [page]);
  return <canvas ref={ref} className="w-full rounded border bg-gray-50" />;
}

/** AIの鍵（APIキー）の登録。鍵はサーバーにだけ保存し、画面には末尾4文字しか出さない */
function KeyBox({ status, admin, onChange }: { status: { set: boolean; last4: string }; admin: boolean; onChange: (s: { set: boolean; last4: string }) => void }) {
  const [edit, setEdit] = useState(!status.set);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!admin) return <p className="mt-3 rounded-lg bg-amber-50 p-3 text-amber-800">AIの鍵がまだ登録されていません。管理者に登録してもらってください。</p>;
  if (!edit)
    return (
      <p className="mt-3 text-gray-600">
        AIの鍵：登録済み（末尾 {status.last4}）
        <button onClick={() => setEdit(true)} className="ml-2 underline">
          変更
        </button>
      </p>
    );
  async function save() {
    setBusy(true);
    setError("");
    try {
      const s = await callFunction<{ apiKey: string }, { set: boolean; last4: string }>("setAiKey", { apiKey: value }, 60_000);
      onChange(s);
      setValue("");
      setEdit(!s.set);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 rounded-lg bg-gray-50 p-3">
      <p className="font-bold">AIの鍵（Anthropic の APIキー）を登録</p>
      <p className="mt-1 text-xs text-gray-600">「sk-ant-」ではじまる文字をはり付けてください。鍵はサーバーにだけ保存され、画面やほかの人には見えません。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-ant-…"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-base"
        />
        <button disabled={busy || !value.trim()} onClick={save} className="rounded-lg bg-emerald-700 px-4 py-2 font-bold text-white disabled:opacity-50">
          {busy ? "確かめています…" : "登録する"}
        </button>
        {status.set && (
          <button onClick={() => setEdit(false)} className="rounded-lg border bg-white px-3 py-2">
            やめる
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-red-600">{error}</p>}
    </div>
  );
}

/** 仕切書1か月分：読み取った数字の確かめ → 規格の当てはめ → 今の数字との違い → 直す */
function SheetPanel({ sheet: initial, grades, onDone }: { sheet: ShikiriSheet; grades: Grade[]; onDone: () => void }) {
  // 読み違いを画面で直せるように、読み取り結果を手元に持つ
  const [sheet, setSheet] = useState(initial);
  const [editing, setEditing] = useState("");
  const ym = `${sheet.year}-${String(sheet.month).padStart(2, "0")}`;
  const current = useShipments(`${ym}-01`, `${ym}-${String(monthDays(sheet.year, sheet.month)).padStart(2, "0")}`);
  const checks = useMemo(() => checkSheet(sheet), [sheet]);
  // 仕切書の行（「まとまり番号-行番号」）→ アプリの規格
  const [byKey, setByKey] = useState(() => {
    const m = new Map<string, string>();
    initial.blocks.forEach((b, bi) => b.rows.forEach((r, ri) => m.set(`${bi}-${ri}`, guessGrade(b, r, grades))));
    return m;
  });
  const mapping = useMemo(() => {
    const m = new Map<ShikiriRow, string>();
    sheet.blocks.forEach((b, bi) => b.rows.forEach((r, ri) => m.set(r, byKey.get(`${bi}-${ri}`) ?? "")));
    return m;
  }, [sheet, byKey]);
  const setRow = (bi: number, ri: number, row: ShikiriRow) =>
    setSheet({ ...sheet, blocks: sheet.blocks.map((b, i) => (i === bi ? { ...b, rows: b.rows.map((r, j) => (j === ri ? row : r)) } : b)) });
  const [clearMissing, setClearMissing] = useState(true);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const gradeName = (id: string) => {
    const g = grades.find((x) => x.id === id);
    return g ? `${g.group} ${g.name}` : "（なし）";
  };
  const changes = useMemo(() => (current ? diffSheet(sheet, mapping, current, clearMissing) : null), [sheet, mapping, current, clearMissing]);
  const allOk = [...checks.rows.values(), ...checks.blocks.values(), ...checks.sheet].every((c) => c.ok);
  const unmapped = [...mapping.values()].filter((v) => !v).length;
  const used = new Set([...mapping.values()].filter(Boolean));
  // 当てはめた規格の、月の合計（今 → 仕切書）
  const sums = useMemo(() => {
    if (!current || !changes) return null;
    const after = applyChanges(changes, current);
    const tally = (days: Record<string, Record<string, { qty?: number; price?: number }>>) => {
      let qty = 0;
      let amount = 0;
      for (const [d, items] of Object.entries(days)) {
        if (!d.startsWith(ym)) continue;
        for (const [id, it] of Object.entries(items)) {
          if (!used.has(id)) continue;
          qty += it.qty ?? 0;
          amount += (it.qty ?? 0) * (it.price ?? 0);
        }
      }
      return { qty, amount };
    };
    return { before: tally(current), after: tally({ ...current, ...after }) };
    // used は mapping から作るので mapping が変われば変わる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, changes, ym, mapping]);

  async function save() {
    if (!changes || !current) return;
    setBusy(true);
    setError("");
    try {
      const next = applyChanges(changes, current);
      const { db } = await getFirebase();
      const dates = Object.keys(next);
      for (let i = 0; i < dates.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of dates.slice(i, i + 400)) {
          if (Object.keys(next[d]).length === 0) batch.delete(doc(db, `shipments/${d}`));
          else batch.set(doc(db, `shipments/${d}`), { items: next[d], updatedAt: serverTimestamp() });
        }
        await batch.commit();
      }
      setMessage(`${sheet.year}年${sheet.month}月分を、仕切書の数字に直しました（${changes.length}か所・${dates.length}日分）`);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const Mark = ({ ok }: { ok: boolean }) => <span className={ok ? "text-green-700" : "font-bold text-red-600"}>{ok ? "✓ 合っています" : "✗ 合いません"}</span>;

  return (
    <div className="mt-4 rounded-xl border p-3">
      <h3 className="text-base font-bold">
        {sheet.year}年{sheet.month}月分
      </h3>

      <h4 className="mt-2 font-bold">① 読み取った数字の確かめ（仕切書に印刷された合計と比べます）</h4>
      <ul className="mt-1 space-y-0.5">
        {checks.sheet.map((c) => (
          <li key={c.label}>
            {c.label}：読み取り {num(c.read)}円／仕切書 {c.printed === null ? "（読めず）" : `${num(c.printed)}円`} <Mark ok={c.ok} />
          </li>
        ))}
        {sheet.blocks.map((b, i) => {
          const c = checks.blocks.get(b)!;
          return (
            <li key={i}>
              {c.label}：読み取り {num(c.read)}円／仕切書 {c.printed === null ? "（読めず）" : `${num(c.printed)}円`} <Mark ok={c.ok} />
            </li>
          );
        })}
        {sheet.total !== null && <li className="text-gray-600">税込金額 {num(sheet.total)}円・送金額 {sheet.paid === null ? "－" : `${num(sheet.paid)}円`}</li>}
      </ul>

      <h4 className="mt-3 font-bold">② 仕切書の行を、アプリの規格に当てはめる</h4>
      <div className="overflow-x-auto">
        <table className="mt-1 min-w-[32rem] text-sm tabular-nums">
          <thead>
            <tr className="border-b text-xs text-gray-500">
              <th className="py-1 pr-3 text-left">仕切書の行</th>
              <th className="py-1 pr-3 text-left">アプリの規格</th>
              <th className="py-1 pr-3 text-right">数量計（読み取り／仕切書）</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sheet.blocks.flatMap((b, bi) =>
              b.rows.map((r, ri) => {
                const c = checks.rows.get(r)!;
                const k = `${bi}-${ri}`;
                return (
                  <tr key={k} className={`border-b last:border-0 ${editing === k ? "bg-emerald-50" : ""}`}>
                    <td className="py-1 pr-3">
                      {b.variety} {b.rank} {r.size}
                    </td>
                    <td className="py-1 pr-3">
                      <select
                        value={mapping.get(r) ?? ""}
                        onChange={(e) => setByKey(new Map(byKey).set(k, e.target.value))}
                        className={`rounded border px-2 py-1 text-base ${mapping.get(r) ? "" : "border-amber-500 bg-amber-50"}`}
                      >
                        <option value="">取り込まない</option>
                        {grades.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.group} {g.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`py-1 pr-3 text-right ${c.ok ? "" : "font-bold text-red-600"}`}>
                      {num(c.read)}／{c.printed === null ? "－" : num(c.printed)}
                    </td>
                    <td className="py-1">
                      <button onClick={() => setEditing(editing === k ? "" : k)} className={`rounded border px-2 py-0.5 text-xs ${c.ok ? "" : "border-red-500 font-bold text-red-700"}`}>
                        {editing === k ? "閉じる" : c.ok ? "数字を見る" : "数字を直す"}
                      </button>
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
      {editing &&
        (() => {
          const [bi, ri] = editing.split("-").map(Number);
          const b = sheet.blocks[bi];
          const r = b?.rows[ri];
          return (
            r && (
              <div className="mt-2">
                <p className="font-bold">
                  {b.variety} {b.rank} {r.size} の数字
                </p>
                <RowEditor row={r} year={sheet.year} month={sheet.month} onChange={(row) => setRow(bi, ri, row)} />
              </div>
            )
          );
        })()}
      {unmapped > 0 && <p className="mt-1 text-amber-800">当てはまる規格がない行は取り込みません（{unmapped}行）。必要なら規格を選んでください。</p>}

      <h4 className="mt-3 font-bold">③ 今の数字（概算）との違い</h4>
      <label className="mt-1 flex items-center gap-2">
        <input type="checkbox" checked={clearMissing} onChange={(e) => setClearMissing(e.target.checked)} />
        仕切書で0の日は、アプリの数量も消す（当てはめた規格だけ）
      </label>
      {!changes || !sums ? (
        <p className="mt-1 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <p className="mt-1">
            当てはめた規格の{sheet.month}月の合計：数量 {num(sums.before.qty)} → <b>{num(sums.after.qty)}</b>、金額 {num(sums.before.amount)}円 → <b>{num(sums.after.amount)}円</b>
          </p>
          {changes.length === 0 ? (
            <p className="mt-1 text-green-700">アプリの数字は、すでに仕切書と同じです。</p>
          ) : (
            <div className="mt-1 max-h-80 overflow-auto rounded border">
              <table className="w-full text-sm tabular-nums">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b text-xs text-gray-500">
                    <th className="px-2 py-1 text-left">日</th>
                    <th className="px-2 py-1 text-left">規格</th>
                    <th className="px-2 py-1 text-right">今（数量×単価）</th>
                    <th className="px-2 py-1 text-right">仕切書</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-2 py-1">{md(c.date)}</td>
                      <td className="px-2 py-1">{gradeName(c.gradeId)}</td>
                      <td className="px-2 py-1 text-right text-gray-600">{c.before.qty ? `${num(c.before.qty)}×${c.before.price ? num(c.before.price) : "－"}` : "－"}</td>
                      <td className="px-2 py-1 text-right font-semibold text-emerald-800">{c.after.qty ? `${num(c.after.qty)}×${c.after.price ? num(c.after.price) : "－"}` : "消す"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {message ? (
        <p className="mt-3 font-bold text-green-700">{message}</p>
      ) : (
        changes &&
        changes.length > 0 && (
          <div className="mt-3">
            {!allOk && (
              <>
                <p className="text-red-600">読み取った数字の合計が、仕切書の合計と合わないところがあります。「数字を直す」で仕切書と見比べて、読み違いを直してください。</p>
                <label className="mt-1 flex items-center gap-2">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  合わないところがあっても直す
                </label>
              </>
            )}
            <button disabled={busy || (!allOk && !force)} onClick={save} className="mt-2 rounded-lg bg-emerald-700 px-5 py-2 font-bold text-white disabled:opacity-50">
              {busy ? "保存しています…" : `この数字に直す（${changes.length}か所）`}
            </button>
          </div>
        )
      )}
      {error && <p className="mt-2 text-red-600">{error}</p>}
    </div>
  );
}

/** 仕切書1行分の数字を、紙と見比べて直す（数量・単価・数量計） */
function RowEditor({ row, year, month, onChange }: { row: ShikiriRow; year: number; month: number; onChange: (r: ShikiriRow) => void }) {
  const days = Array.from({ length: monthDays(year, month) }, (_, i) => i + 1);
  const get = (d: number) => row.entries.find((e) => e.day === d);
  const set = (d: number, f: "qty" | "price", v: string) => {
    const n = v === "" ? 0 : Math.max(0, Math.round(Number(v)));
    if (!Number.isFinite(n)) return;
    const cur = get(d) ?? { day: d, qty: 0, price: 0 };
    const next = { ...cur, [f]: n };
    const entries = row.entries.filter((e) => e.day !== d);
    if (next.qty > 0 || next.price > 0) entries.push(next);
    onChange({ ...row, entries: entries.sort((a, b) => a.day - b.day) });
  };
  const cell = "w-14 rounded border px-1 py-0.5 text-right text-sm tabular-nums";
  return (
    <div className="rounded-lg bg-gray-50 p-2">
      <p className="text-xs text-gray-600">仕切書と見比べて、違うところを直してください。0の日は空のままで大丈夫です。</p>
      <div className="mt-1 overflow-x-auto">
        <table className="text-xs">
          <tbody>
            <tr>
              <th className="pr-2 text-left font-normal text-gray-500">日</th>
              {days.map((d) => (
                <th key={d} className="px-0.5 font-normal text-gray-500">
                  {d}
                </th>
              ))}
            </tr>
            {(["qty", "price"] as const).map((f) => (
              <tr key={f}>
                <th className="whitespace-nowrap pr-2 text-left font-normal">{f === "qty" ? "数量" : "単価"}</th>
                {days.map((d) => (
                  <td key={d} className="px-0.5">
                    <input inputMode="numeric" value={get(d)?.[f] || ""} onChange={(e) => set(d, f, e.target.value)} className={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm">
        仕切書の数量計
        <input
          inputMode="numeric"
          value={row.qtyTotal ?? ""}
          onChange={(e) => onChange({ ...row, qtyTotal: e.target.value === "" ? null : Math.max(0, Math.round(Number(e.target.value)) || 0) })}
          className={cell}
        />
      </label>
    </div>
  );
}
