/* 部屋（下層ページ）の一覧ストリップ用の極小サムネイルを作る。
   使い方:  node make-strip-thumbs.mjs

   既存の assets/photos/<series>/thumb/ は 640〜768 x 960 で1枚41〜89KB。
   これは「1枚を大きく見る」ための解像度で、ストリップの40px幅に使うと
   SNAPS 32枚だけで 1.56MB を落とすことになる。表示サイズに見合う
   派生（高さ120px・webp）を別に持たせる。 */
import sharp from "sharp";
import fs from "fs";
import path from "path";

const ROOT = "assets/photos";
const H = 120;             /* ストリップの表示高さ(60px)の2倍。Retina想定 */
let n = 0, before = 0, after = 0;

for (const series of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, series, "thumb");
  if (!fs.existsSync(dir)) continue;
  const out = path.join(ROOT, series, "strip");
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (!/\.jpe?g$/i.test(f)) continue;
    const src = path.join(dir, f);
    const dst = path.join(out, f.replace(/\.jpe?g$/i, ".webp"));
    const buf = await sharp(src).resize({ height: H, withoutEnlargement: true })
      .webp({ quality: 72, effort: 6 }).toBuffer();
    fs.writeFileSync(dst, buf);
    before += fs.statSync(src).size;
    after += buf.length;
    n++;
  }
}
const mb = (b) => (b / 1024 / 1024).toFixed(2) + "MB";
console.log(`${n}枚  ${mb(before)} → ${mb(after)}  (1枚あたり ${(after / n / 1024).toFixed(1)}KB)`);
