// Airレジの「商品一覧」CSV（商品のダウンロード）を読み取る
import type { TaxRate } from "./settings";

export type AirregiProduct = {
  airregiId: string;
  categoryId: string;
  name: string;
  price: number;
  taxRate: TaxRate;
  active: boolean;
};

/** 見出しの行を探して読み取る（1行目は "v1400" のような版の番号） */
export function parseAirregiProducts(rows: string[][]): { items: AirregiProduct[]; error?: string } {
  const h = rows.findIndex((r) => r.some((c) => c.includes("商品名")));
  if (h < 0) return { items: [], error: "「商品名」の列が見つかりません。Airレジの商品一覧のCSVを選んでください" };
  const header = rows[h];
  const col = (test: (c: string) => boolean) => header.findIndex(test);
  const idCol = col((c) => c.startsWith("商品ID"));
  const catCol = col((c) => c.startsWith("カテゴリーID"));
  const nameCol = col((c) => c.includes("商品名") && !c.includes("（"));
  const taxCol = col((c) => c.startsWith("適用税率"));
  // 「価格設定」「価格2」とまちがえないように、「【必須】価格」を先に探す
  const requiredPrice = col((c) => c.startsWith("【必須】価格"));
  const priceCol = requiredPrice >= 0 ? requiredPrice : col((c) => /^価格(\s|$|※|（)/.test(c));
  const showCol = col((c) => c.startsWith("表示/非表示"));
  const delCol = col((c) => c.startsWith("削除設定"));
  if (nameCol < 0 || priceCol < 0) return { items: [], error: "「商品名」と「価格」の列が見つかりません" };

  const items: AirregiProduct[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(h + 1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    let name = get(nameCol).replace(/[\s　]+$/g, "").replace(/^[\s　]+/g, "");
    if (!name) continue;
    if (get(delCol)) continue; // 削除の印がある行は飛ばす
    const price = Number(get(priceCol).replace(/[^0-9]/g, "")) || 0;
    // 同じ名前が2つあるときは、値段を付けて見分ける
    if (seen.has(name)) name = `${name}（${price}円）`;
    seen.add(name);
    items.push({
      airregiId: get(idCol),
      categoryId: get(catCol),
      name: name.slice(0, 50),
      price: Math.min(price, 1_000_000),
      taxRate: get(taxCol) === "軽減税率" ? 8 : 10,
      active: get(showCol) !== "非表示",
    });
  }
  if (items.length === 0) return { items: [], error: "取り込める商品がありません" };
  return { items: items.slice(0, 300) };
}
