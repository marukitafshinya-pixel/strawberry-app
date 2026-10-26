import { cpSync, writeFileSync } from "node:fs";
import type { NextConfig } from "next";

// 版の番号（ビルドした時刻）。画面に埋め込み、同じものを public/version.txt にも書く。
// 開いている画面が古いまま残っていないかを、version.txt と比べて確かめるため
const BUILD_ID = String(Date.now());
try {
  writeFileSync("public/version.txt", BUILD_ID);
} catch {
  // 書けなくてもビルドは続ける（新しい版のお知らせが出ないだけ）
}

// PDFを読むときに使う、日本語の文字の表（CMap）と標準のフォント。フォントの入っていない日本語のPDF
// （ネットバンキングの明細など）も、文字を読めて画像にもできるように、public/pdfjs/ に置く
for (const dir of ["cmaps", "standard_fonts"]) cpSync(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, { recursive: true });

const nextConfig: NextConfig = {
  // 静的書き出し：ビルドすると out/ にHTML等のファイルができ、Firebase Hosting に置くだけで動く
  output: "export",
  // /staff → /staff/index.html のように出力（Firebase Hosting と相性がよい）
  trailingSlash: true,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
};

export default nextConfig;
