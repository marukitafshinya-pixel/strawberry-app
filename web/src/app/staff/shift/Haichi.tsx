"use client";

// 作業配置表：その日の出勤者のリストから、名前を作業の枠へドラッグして割り振る。
// 名前は、マウスでも指でもドラッグできる（押してから動かす）。押すだけで選んで、枠を押して入れることもできる。
// 1人が複数の枠に入ってもよい。全員を割り振ったら「配置完了」で、リストを消して配置表だけを大きく出す。
import { useRef, useState } from "react";
import { addDays, formatJa, todayJST } from "@/lib/date";
import { errorText } from "@/lib/callFunction";
import { newSlotId, saveHaichiDay, saveHaichiTemplate, sectionArrows, sectionSide, useHaichiDay, useHaichiTemplate, type HaichiDay, type HaichiTemplate } from "@/lib/haichi";
import { isWorking, useShiftDays, type ShiftConfig, type ShiftMember } from "@/lib/shift";
import { ForecastStrip } from "./ForecastStrip";
import { sortMembers } from "./ShiftTable";

/** 配置表（見るだけの形と、割り振る形の両方で使う） */
export function HaichiBoard({
  template,
  day,
  names,
  big,
  cols,
  edit,
}: {
  template: HaichiTemplate;
  day: HaichiDay;
  names: Record<string, string>;
  /** 大きく出す（配置完了のあと・投影用） */
  big?: boolean;
  /** 段の数（決めると、画面の幅で変えない。投影用で使う） */
  cols?: 1 | 2 | 3;
  /** 割り振る形のとき：名前を押したとき・枠を押したとき・メモを変えたとき */
  edit?: {
    selected: { memberId: string; from: string | null } | null;
    onPickChip: (memberId: string, from: string, e: React.PointerEvent) => void;
    onSlotTap: (slotId: string) => void;
    onRemove: (slotId: string, memberId: string) => void;
    onMemo: (slotId: string, memo: string) => void;
    onArrow: (slotId: string, arrow: string) => void;
  };
}) {
  return (
    <div>
      {/* まとまりは左右2列に分けて、それぞれ上から並べる（どちらの列かは「枠を編集」で決める） */}
      <div className={`grid items-start gap-3 ${cols === 1 ? "" : cols || big ? "grid-cols-2" : "lg:grid-cols-2"}`}>
        {(["left", "right"] as const).map((side) => (
          <div key={side} className="space-y-3">
            {template.sections
              .filter((sec) => sectionSide(sec) === side)
              .map((sec) => (
                <section key={sec.id} className="overflow-hidden rounded-xl border-2 border-gray-500 bg-white">
                  <h3 className={`bg-slate-700 px-3 py-1 font-bold text-white ${big ? "text-2xl" : "text-base"}`}>{sec.name}</h3>
                  <table className="w-full border-collapse">
                    <tbody>
                      {sec.slots.map((slot) => {
                        const cell = day.cells[slot.id] ?? { members: [], memo: "" };
                        return (
                          <tr
                            key={slot.id}
                            data-drop={edit ? slot.id : undefined}
                            onClick={edit ? () => edit.onSlotTap(slot.id) : undefined}
                            className={`border-t border-gray-400 align-middle ${edit?.selected ? "cursor-copy hover:bg-amber-50" : ""}`}
                          >
                            <th
                              className={`whitespace-nowrap border-r border-gray-400 bg-gray-100 px-2 font-bold ${isHouseNo(slot.label) ? "text-center" : "text-left"} ${big ? "w-40 py-2 text-2xl" : "w-28 py-1.5 text-sm"}`}
                            >
                              {isHouseNo(slot.label) ? `No.${slot.label}` : slot.label}
                            </th>
                            {sectionArrows(sec) && (
                              <td className={`border-r border-gray-300 text-center ${big ? "w-14" : "w-12"}`}>
                                {edit ? (
                                  <ArrowSelect value={cell.arrow ?? ""} onChange={(v) => edit.onArrow(slot.id, v)} />
                                ) : (
                                  <span className={`font-bold text-red-600 ${big ? "text-4xl" : "text-2xl"}`}>{cell.arrow}</span>
                                )}
                              </td>
                            )}
                            <td className={`px-2 ${big ? "py-2" : "py-1"}`}>
                              <div className="flex min-h-[2rem] flex-wrap items-center gap-1.5">
                                {cell.members.map((id) => (
                                  <span
                                    key={id}
                                    onPointerDown={edit ? (e) => edit.onPickChip(id, slot.id, e) : undefined}
                                    onClick={(e) => e.stopPropagation()}
                                    className={`inline-flex touch-none select-none items-center gap-1 rounded-lg border border-sky-300 bg-sky-50 font-bold text-sky-950 ${
                                      big ? "px-3 py-1 text-2xl" : "px-2 py-0.5 text-base"
                                    } ${edit ? "cursor-grab" : ""} ${edit?.selected?.memberId === id && edit.selected.from === slot.id ? "ring-2 ring-amber-500" : ""}`}
                                  >
                                    {names[id] ?? "（削除された人）"}
                                    {edit && (
                                      <button
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          edit.onRemove(slot.id, id);
                                        }}
                                        className="ml-0.5 text-sm text-gray-400 hover:text-red-600"
                                        aria-label={`${names[id] ?? ""}を外す`}
                                      >
                                        ×
                                      </button>
                                    )}
                                  </span>
                                ))}
                                {edit ? (
                                  <MemoInput value={cell.memo} onSave={(v) => edit.onMemo(slot.id, v)} />
                                ) : (
                                  cell.memo && <span className={`text-gray-700 ${big ? "text-xl" : "text-sm"}`}>{cell.memo}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </section>
              ))}
          </div>
        ))}
      </div>
      {day.note && !edit && (
        <section className="rounded-xl border-2 border-amber-400 bg-amber-50 px-3 py-2">
          <span className={`font-bold ${big ? "text-2xl" : ""}`}>連絡：</span>
          <span className={big ? "text-2xl" : ""}>{day.note}</span>
        </section>
      )}
    </div>
  );
}

/** 枠の名前が数字だけ（ハウスの番号）なら、「No.1」のように出して真ん中にそろえる */
const isHouseNo = (label: string) => /^\d+$/.test(label.trim());

/** 次に向かうハウスの方向（収穫の枠に付ける矢印） */
export const ARROWS = ["", "→", "←", "↑", "↓", "↗", "↘", "↙", "↖"] as const;

/** 矢印を選ぶ（押すと一覧が出る） */
function ArrowSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      aria-label="次に向かう方向"
      title="次に向かうハウスの方向"
      className={`w-11 cursor-pointer appearance-none rounded border bg-white py-0.5 text-center text-2xl font-bold ${value ? "border-red-300 text-red-600" : "border-dashed border-gray-300 text-gray-300"}`}
    >
      {ARROWS.map((a) => (
        <option key={a} value={a}>
          {a || "・"}
        </option>
      ))}
    </select>
  );
}

/** 枠のメモ（押すと書ける。ほかの場所を押すと保存） */
function MemoInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? value}
      placeholder="メモ"
      maxLength={40}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="ml-auto w-28 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-gray-700 placeholder:text-gray-300 hover:border-gray-300 focus:border-gray-400 focus:bg-white focus:outline-none"
    />
  );
}

/** 作業配置表のタブ（管理者は割り振る、ほかの人は見るだけ） */
export function HaichiTab({ cfg, members, isAdmin }: { cfg: ShiftConfig; members: ShiftMember[]; isAdmin: boolean }) {
  const [date, setDate] = useState(todayJST());
  const template = useHaichiTemplate();
  const day = useHaichiDay(date);
  const shiftDays = useShiftDays(date, date);
  const [error, setError] = useState("");
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  /** 押して選んだ名前（そのあと枠を押すと入る）。from はどの枠から（リストなら null） */
  const [selected, setSelected] = useState<{
    memberId: string;
    from: string | null;
  } | null>(null);
  /** ドラッグ中の名前と、指の位置 */
  const [drag, setDrag] = useState<{
    memberId: string;
    from: string | null;
    x: number;
    y: number;
  } | null>(null);
  const start = useRef<{
    memberId: string;
    from: string | null;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  const active = sortMembers(
    members.filter((m) => m.active),
    cfg,
  );
  const names = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const cells = shiftDays?.[date]?.cells ?? {};
  const attendees = active.filter((m) => isWorking(cfg, cells[m.id]));
  const placedCount = new Map<string, number>();
  for (const c of Object.values(day?.cells ?? {})) for (const id of c.members) placedCount.set(id, (placedCount.get(id) ?? 0) + 1);
  const unplaced = attendees.filter((m) => !placedCount.has(m.id));
  const listMembers = showAll ? active : attendees;

  async function save(next: HaichiDay) {
    setError("");
    try {
      await saveHaichiDay(date, next);
    } catch (e) {
      setError(errorText(e));
    }
  }
  /** 名前を枠に入れる（from があれば、その枠からは外す＝移動） */
  function place(memberId: string, to: string | null, from: string | null) {
    if (!day || to === from) return;
    const next: HaichiDay = { ...day, cells: { ...day.cells } };
    if (from) {
      const c = next.cells[from] ?? { members: [], memo: "" };
      next.cells[from] = {
        ...c,
        members: c.members.filter((x) => x !== memberId),
      };
    }
    if (to) {
      const c = next.cells[to] ?? { members: [], memo: "" };
      if (!c.members.includes(memberId)) next.cells[to] = { ...c, members: [...c.members, memberId] };
    }
    void save(next);
  }

  // ドラッグ：押して少し動かしたらドラッグ、動かさずに離したら「選ぶ」
  function onPick(memberId: string, from: string | null, e: React.PointerEvent) {
    if (!isAdmin || day?.done) return;
    e.preventDefault();
    start.current = {
      memberId,
      from,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    const move = (ev: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      if (!s.moved && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < 6) return;
      s.moved = true;
      setDrag({
        memberId: s.memberId,
        from: s.from,
        x: ev.clientX,
        y: ev.clientY,
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const s = start.current;
      start.current = null;
      setDrag(null);
      if (!s) return;
      if (!s.moved) {
        setSelected((cur) => (cur && cur.memberId === s.memberId && cur.from === s.from ? null : { memberId: s.memberId, from: s.from }));
        return;
      }
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop]");
      if (!target) return;
      const to = target.dataset.drop === "list" ? null : target.dataset.drop!;
      place(s.memberId, to, s.from);
      setSelected(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  if (!template || !day || !shiftDays) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  const done = day.done;
  const canEdit = isAdmin && !done;
  const btn = "rounded-lg border bg-white px-3 py-1.5 text-sm";

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setDate(addDays(date, -1))} className={btn}>
          ‹ 前の日
        </button>
        <span className="text-lg font-bold">{formatJa(date)}</span>
        <button onClick={() => setDate(addDays(date, 1))} className={btn}>
          次の日 ›
        </button>
        {date !== todayJST() && (
          <button onClick={() => setDate(todayJST())} className={btn}>
            今日
          </button>
        )}
        <span className="text-sm text-gray-600">
          出勤 {attendees.length}人
          {canEdit && unplaced.length > 0 && <span className="ml-1 font-bold text-amber-700">（まだ配置していない人 {unplaced.length}人）</span>}
        </span>
        <button
          onClick={() => {
            const w = window.open(`/staff/shift/display/?from=${date}&view=haichi`, "ichigo-shift-display", "popup=yes,width=1280,height=800");
            if (w) w.focus();
            else window.alert("ウィンドウを開けませんでした。ブラウザでポップアップを許可してください。");
          }}
          className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-bold text-white"
        >
          📽 投影用の画面
        </button>
        <button onClick={() => setShowForecast(!showForecast)} className={`rounded-lg border px-3 py-1.5 text-sm font-bold ${showForecast ? "border-sky-700 bg-sky-700 text-white" : "border-sky-700 bg-white text-sky-800"}`}>
          🌤 天気予報{showForecast ? "を隠す" : ""}
        </button>
        {isAdmin && (
          <div className="ml-auto flex gap-2">
            {done ? (
              <button onClick={() => save({ ...day, done: false })} className={btn}>
                配置を直す
              </button>
            ) : (
              <>
                <button onClick={() => setEditingTemplate(!editingTemplate)} className={btn}>
                  {editingTemplate ? "枠の編集を閉じる" : "枠を編集"}
                </button>
                <button
                  onClick={() => save({ ...day, done: true })}
                  className={`rounded-lg px-4 py-1.5 text-sm font-bold text-white ${unplaced.length === 0 ? "bg-emerald-700" : "bg-slate-600"}`}
                >
                  配置完了（表だけ大きく出す）
                </button>
              </>
            )}
            <button onClick={() => window.print()} className="px-1 text-sm text-gray-600 underline">
              印刷
            </button>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {editingTemplate && canEdit && <TemplateEditor template={template} onClose={() => setEditingTemplate(false)} />}

      <div className={`mt-3 ${canEdit ? "grid gap-3 lg:grid-cols-[14rem_1fr]" : ""}`}>
        {canEdit && (
          <aside data-drop="list" className="h-max rounded-xl border-2 border-dashed border-gray-400 bg-white p-2 lg:sticky lg:top-2">
            <h3 className="font-bold">出勤者のリスト</h3>
            <p className="text-xs text-gray-500">名前を枠へドラッグ（または名前を押してから枠を押す）。枠の名前をここへ戻すと外れます。</p>
            <ul className="mt-2 flex flex-wrap gap-1.5 lg:flex-col">
              {listMembers.map((m) => {
                const n = placedCount.get(m.id) ?? 0;
                return (
                  <li
                    key={m.id}
                    onPointerDown={(e) => onPick(m.id, null, e)}
                    className={`flex cursor-grab touch-none select-none items-center justify-between gap-2 rounded-lg border px-2 py-1 font-bold ${
                      n === 0 ? "border-amber-400 bg-amber-50" : "border-gray-300 bg-gray-50 text-gray-500"
                    } ${selected?.memberId === m.id && selected.from === null ? "ring-2 ring-amber-500" : ""}`}
                  >
                    <span>
                      {m.name}
                      <span className="ml-1 text-xs font-normal text-gray-500">{cells[m.id] ?? ""}</span>
                    </span>
                    {n > 0 && <span className="text-xs font-normal">{n}か所</span>}
                  </li>
                );
              })}
              {listMembers.length === 0 && <li className="text-sm text-gray-500">この日の出勤者はいません（勤務表に記号が入っていません）。</li>}
            </ul>
            <label className="mt-2 flex items-center gap-1 text-xs text-gray-600">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              出勤でない人も出す
            </label>
            {selected && (
              <p className="mt-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
                「{names[selected.memberId]}
                」を選んでいます。入れる枠を押してください。
                <button onClick={() => setSelected(null)} className="ml-1 underline">
                  やめる
                </button>
              </p>
            )}
          </aside>
        )}
        <div>
          <HaichiBoard
            template={template}
            day={day}
            names={names}
            big={done}
            edit={
              canEdit
                ? {
                    selected,
                    onPickChip: (id, from, e) => onPick(id, from, e),
                    onSlotTap: (slotId) => {
                      if (!selected) return;
                      place(selected.memberId, slotId, selected.from);
                      setSelected(null);
                    },
                    onRemove: (slotId, id) => place(id, null, slotId),
                    onArrow: (slotId, arrow) => {
                      const c = day.cells[slotId] ?? { members: [], memo: "" };
                      void save({ ...day, cells: { ...day.cells, [slotId]: { ...c, arrow } } });
                    },
                    onMemo: (slotId, memo) => {
                      const c = day.cells[slotId] ?? { members: [], memo: "" };
                      void save({
                        ...day,
                        cells: { ...day.cells, [slotId]: { ...c, memo } },
                      });
                    },
                  }
                : undefined
            }
          />
          {canEdit && (
            <label className="mt-3 block text-sm">
              <span className="font-bold">連絡（配置表の下に出ます）</span>
              <NoteInput value={day.note} onSave={(note) => save({ ...day, note })} />
            </label>
          )}
          {/* 天気予報は、ボタンを押したときだけ出す（押したときに気象庁の予報を確かめる） */}
          {showForecast && <ForecastStrip big={done} />}
        </div>
      </div>
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border-2 border-amber-500 bg-amber-100 px-3 py-1 font-bold shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          {names[drag.memberId]}
        </div>
      )}
    </div>
  );
}

function NoteInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? value}
      maxLength={200}
      placeholder="例：本日 全閉め"
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="mt-1 w-full rounded-lg border px-3 py-2"
    />
  );
}

/** 枠の編集：まとまり（収穫・売り場など）と、その中の枠の名前・並び・追加・削除 */
function TemplateEditor({ template, onClose }: { template: HaichiTemplate; onClose: () => void }) {
  const [t, setT] = useState<HaichiTemplate>(() => JSON.parse(JSON.stringify(template)) as HaichiTemplate);
  const [msg, setMsg] = useState("");
  const setSec = (i: number, f: (s: HaichiTemplate["sections"][number]) => HaichiTemplate["sections"][number]) =>
    setT({ sections: t.sections.map((s, j) => (j === i ? f(s) : s)) });
  const moveSec = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= t.sections.length) return;
    const a = [...t.sections];
    [a[i], a[j]] = [a[j], a[i]];
    setT({ sections: a });
  };
  async function save() {
    setMsg("");
    try {
      await saveHaichiTemplate({
        sections: t.sections
          .map((s) => ({
            ...s,
            name: s.name.trim().slice(0, 30),
            slots: s.slots.map((x) => ({ ...x, label: x.label.trim().slice(0, 30) })).filter((x) => x.label),
          }))
          .filter((s) => s.name),
      });
      onClose();
    } catch (e) {
      setMsg(errorText(e));
    }
  }
  const small = "rounded border px-1.5 text-xs";
  return (
    <section className="mt-3 rounded-xl border-2 border-sky-300 bg-sky-50 p-3 text-sm">
      <h3 className="font-bold">枠の編集（すべての日に使う枠の並び）</h3>
      <p className="text-xs text-gray-600">まとまりの名前と、その中の枠の名前を書き換えられます。枠を消すと、その枠に入れた名前も表に出なくなります。</p>
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {t.sections.map((s, i) => (
          <div key={s.id} className="rounded-lg border bg-white p-2">
            <div className="flex items-center gap-1">
              <input
                value={s.name}
                onChange={(e) => setSec(i, (x) => ({ ...x, name: e.target.value }))}
                className="min-w-0 flex-1 rounded border px-2 py-1 font-bold"
                aria-label="まとまりの名前"
              />
              <button onClick={() => moveSec(i, -1)} className={small} aria-label="前へ">
                ←
              </button>
              <button onClick={() => moveSec(i, 1)} className={small} aria-label="後ろへ">
                →
              </button>
              <button
                onClick={() => window.confirm(`まとまり「${s.name}」を消しますか？`) && setT({ sections: t.sections.filter((_, j) => j !== i) })}
                className="px-1 text-xs text-red-700 underline"
              >
                消す
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                表の
                <select
                  value={sectionSide(s)}
                  onChange={(e) => setSec(i, (x) => ({ ...x, side: e.target.value as "left" | "right" }))}
                  className="rounded border px-1 py-0.5"
                >
                  <option value="left">左</option>
                  <option value="right">右</option>
                </select>
                の列
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={sectionArrows(s)} onChange={(e) => setSec(i, (x) => ({ ...x, arrows: e.target.checked }))} />
                次に向かう方向の矢印を付ける
              </label>
            </div>
            <ul className="mt-1 space-y-1">
              {s.slots.map((slot, k) => (
                <li key={slot.id} className="flex items-center gap-1">
                  <input
                    value={slot.label}
                    onChange={(e) =>
                      setSec(i, (x) => ({
                        ...x,
                        slots: x.slots.map((y, m) => (m === k ? { ...y, label: e.target.value } : y)),
                      }))
                    }
                    className="min-w-0 flex-1 rounded border px-2 py-0.5"
                    aria-label="枠の名前"
                  />
                  <button
                    onClick={() =>
                      k > 0 &&
                      setSec(i, (x) => {
                        const a = [...x.slots];
                        [a[k - 1], a[k]] = [a[k], a[k - 1]];
                        return { ...x, slots: a };
                      })
                    }
                    className={small}
                    aria-label="上へ"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() =>
                      k < s.slots.length - 1 &&
                      setSec(i, (x) => {
                        const a = [...x.slots];
                        [a[k + 1], a[k]] = [a[k], a[k + 1]];
                        return { ...x, slots: a };
                      })
                    }
                    className={small}
                    aria-label="下へ"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() =>
                      setSec(i, (x) => ({
                        ...x,
                        slots: x.slots.filter((_, m) => m !== k),
                      }))
                    }
                    className="px-1 text-xs text-red-700"
                    aria-label="枠を消す"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() =>
                setSec(i, (x) => ({
                  ...x,
                  slots: [...x.slots, { id: newSlotId(), label: "新しい枠" }],
                }))
              }
              className="mt-1 text-xs text-sky-700 underline"
            >
              ＋ 枠を足す
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() =>
            setT({
              sections: [
                ...t.sections,
                {
                  id: newSlotId(),
                  name: "新しいまとまり",
                  slots: [{ id: newSlotId(), label: "新しい枠" }],
                },
              ],
            })
          }
          className="rounded border bg-white px-3 py-1"
        >
          ＋ まとまりを足す
        </button>
        <button onClick={save} className="rounded-lg bg-berry px-4 py-1.5 font-bold text-white">
          保存する
        </button>
        <button onClick={onClose} className="px-2 underline">
          やめる
        </button>
        {msg && <span className="text-red-600">{msg}</span>}
      </div>
    </section>
  );
}
