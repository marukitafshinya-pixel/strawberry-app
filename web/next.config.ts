import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 静的書き出し：ビルドすると out/ にHTML等のファイルができ、Firebase Hosting に置くだけで動く
  output: "export",
  // /staff → /staff/index.html のように出力（Firebase Hosting と相性がよい）
  trailingSlash: true,
};

export default nextConfig;
