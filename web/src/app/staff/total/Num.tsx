"use client";

import { useState } from "react";

/** 金額の入力欄（3けたごとにカンマ。全角数字・マイナス記号も読める） */
export function Num({
  value,
  onChange,
  label,
  placeholder,
  className = "w-[5.2rem] rounded border px-1 py-1 text-right",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  placeholder?: string;
  /** 入力欄の見た目（幅など） */
  className?: string;
}) {
  // 3けたごとにカンマを入れて見せる
  const fmt = (v: number | null) => (v === null ? "" : v.toLocaleString("ja-JP"));
  const [text, setText] = useState(fmt(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(fmt(value));
  }
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        let t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[−ー－▲]/g, "-");
        t = t.replace(/[^0-9-]/g, "").replace(/(?!^)-/g, "");
        if (t === "" || t === "-") {
          setText(t);
          return onChange(null);
        }
        const n = Math.max(-999_999_999, Math.min(999_999_999, Number(t)));
        setText(fmt(n));
        setPrev(n);
        onChange(n);
      }}
      className={className}
    />
  );
}
