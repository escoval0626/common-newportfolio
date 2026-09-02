/* クローラー向けの作品一覧（works.html）と画像サイトマップを、experience.js の
   AREAS から生成する。3D体験のコードには触れない。

   なぜ要るか：作品は WebGL のキャンバスに描かれるため、検索エンジンからは
   一枚も見えない。sr-only の一覧は <a href> とキャプションだけで <img> を
   持たない（.sr-only が全要素を 1x1px に畳むため loading="lazy" が効かず、
   ENTER前に98枚41.4MBを落としていた、という実測の経緯がある）。
   結果として、写真家のサイトが画像検索に一枚も出ていない。

   このページは「3Dからの逃げ道」ではなく「検索からの入口」として置く。
   UIからはリンクせず、sitemap と noscript にだけ載せる。着地した人が
   3D体験へ入れるよう、本編への導線はページ上部に大きく置く。 */
const fs = require("fs");

const SITE = "https://www.commonphotograph.com";
const src = fs.readFileSync("experience.js", "utf8").split("\r\n").join("\n");

/* --- COPY_EN（情景コピーの英訳） --- */
const copyEn = {};
{
  const m = src.match(/const COPY_EN = \{([\s\S]*?)\n\};/);
  if (m) for (const mm of m[1].matchAll(/(\w+): "([^"]*)"/g)) copyEn[mm[1]] = mm[2];
}

/* --- AREAS から、写真を持つ情景を順に取り出す --- */
const areas = [];
{
  const re = /name: "([A-Z]+)", num: "(\d+)", t: [0-9.]+,([\s\S]*?)\n  \},\n/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[3];
    const photos = [...body.matchAll(/\["(assets\/photos\/[^"]+\.jpg)", "([^"]*)"(?:, "([^"]*)")?\]/g)]
      .map((p) => ({ url: p[1], title: p[2], award: p[3] || null }));
    if (!photos.length) continue;
    const lm = body.match(/lines: \[([^\]]*)\]/);
    const lines = lm ? [...lm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [];
    areas.push({ name: m[1], num: m[2], lines, en: copyEn[m[1]] || "", photos });
  }
}
if (!areas.length) throw new Error("AREAS を読み取れなかった");

/* alt に使う日本語の説明文。無い写真は作品名で代替する。
   alt は「その写真が見えない人に何が写っているかを渡す文」で、題とは役割が違う。
   詩的な題（Figures That Would Not Stay など）は説明として機能しないため別に書く */
const ALT = (() => {
  try { return JSON.parse(fs.readFileSync("works-alt.json", "utf8")); } catch (e) { return {}; }
})();

const thumb = (u) => u.replace(/\/([^/]+)$/, "/thumb/$1");
const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

(async () => {
  /* サムネイルの実寸。書いておくと読み込み中のレイアウトシフトが出ない */
  const dims = {};
  try {
    const sharp = require("sharp");
    for (const a of areas) {
      for (const p of a.photos) {
        const f = thumb(p.url);
        if (!fs.existsSync(f)) continue;
        const md = await sharp(f).metadata();
        dims[f] = { w: md.width, h: md.height };
      }
    }
  } catch (e) { /* sharp が無い環境では省いて続行 */ }

  const total = areas.reduce((n, a) => n + a.photos.length, 0);

  const sections = areas.map((a) => {
    const figs = a.photos.map((p) => {
      const t = thumb(p.url), d = dims[t];
      const wh = d ? ' width="' + d.w + '" height="' + d.h + '"' : "";
      const cap = p.award ? esc(p.title) + "<em>" + esc(p.award) + "</em>" : esc(p.title);
      /* 説明文があればそれを alt にする。無ければ作品名で代替する */
      const alt = ALT[p.url] || p.title + " — " + a.name;
      return [
        "        <figure>",
        '          <a href="' + SITE + "/" + p.url + '"><img src="' + t + '" alt="' +
          esc(alt) + '"' + wh + ' loading="lazy" decoding="async" /></a>',
        "          <figcaption>" + cap + "</figcaption>",
        "        </figure>",
      ].join("\n");
    }).join("\n");
    return [
      '      <section class="series" id="' + a.name.toLowerCase() + '">',
      '        <h2><span class="series__num">' + a.num + '</span><span lang="en">' + a.name + "</span></h2>",
      '        <p class="series__line">' + esc(a.lines.join("")) + "</p>",
      '        <p class="series__line series__line--en" lang="en">' + esc(a.en) + "</p>",
      '        <div class="grid">',
      figs,
      "        </div>",
      "      </section>",
    ].join("\n");
  }).join("\n");

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "ImageGallery",
    "@id": SITE + "/works.html",
    name: "作品一覧 — Common / 北郷 将",
    inLanguage: "ja",
    url: SITE + "/works.html",
    isPartOf: { "@id": SITE + "/#website" },
    author: { "@id": SITE + "/#person" },
    numberOfItems: total,
    associatedMedia: areas.flatMap((a) => a.photos.map((p) => ({
      "@type": "ImageObject",
      contentUrl: SITE + "/" + p.url,
      thumbnailUrl: SITE + "/" + thumb(p.url),
      name: p.title,
      caption: p.award ? p.title + " — " + p.award : p.title,
      /* alt と同じ説明文。構造化データ側でも画像の中身が伝わるようにする */
      ...(ALT[p.url] ? { description: ALT[p.url] } : {}),
      genre: a.name,
      creator: { "@id": SITE + "/#person" },
      copyrightHolder: { "@id": SITE + "/#person" },
    }))),
  };

  const html = [
'<!DOCTYPE html>',
'<html lang="ja">',
'<head>',
'  <meta charset="UTF-8" />',
'  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
'  <title>作品一覧 — Common / 北郷 将</title>',
'  <meta name="description" content="写真家・北郷将の作品' + total + '点。植物、風景、建築、スナップ、抽象、展示。千葉県流山市を拠点に、オールドレンズで日常の光と余白を記録しています。 / All ' + total + ' works by photographer Sho Kitago." />',
'  <link rel="canonical" href="' + SITE + '/works.html" />',
'  <link rel="icon" type="image/svg+xml" href="assets/favicon.svg" />',
'  <meta property="og:type" content="website" />',
'  <meta property="og:url" content="' + SITE + '/works.html" />',
'  <meta property="og:title" content="作品一覧 — Common / 北郷 将" />',
'  <meta property="og:image" content="' + SITE + '/assets/photos/xp/landscape.jpg" />',
'  <link rel="preconnect" href="https://fonts.googleapis.com" />',
'  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
'  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&family=Josefin+Sans:wght@200;300;400&family=Zen+Old+Mincho:wght@400;500&display=swap" rel="stylesheet" />',
'  <script type="application/ld+json">',
JSON.stringify(jsonld, null, 2),
'  </script>',
'  <style>',
'    :root {',
'      --bg: #f7f6f2; --ink: #1c1c1c; --ink-mid: #55534e; --ink-dim: #6f6b63; --line: #e0dedb;',
'      --font-latin: "Josefin Sans", sans-serif;',
'      --font-jp: "Zen Old Mincho", serif;',
'      --font-display: "Cormorant Garamond", serif;',
'    }',
'    * { box-sizing: border-box; }',
'    body {',
'      margin: 0; background: var(--bg); color: var(--ink);',
'      font-family: var(--font-jp); line-height: 1.9;',
'      -webkit-font-smoothing: antialiased;',
'    }',
'    .wrap { max-width: 1180px; margin: 0 auto; padding: clamp(40px, 7vw, 88px) clamp(20px, 5vw, 56px) 96px; }',
'    .brand { font-family: var(--font-latin); font-size: 13px; letter-spacing: 0.2em; margin: 0 0 40px; }',
'    /* Cormorant Garamond に日本語グリフは無い。和文見出しに当てると',
'       システム書体の合成斜体になるので、ここは本文と同じ明朝で組む */',
'    h1 { font-family: var(--font-jp); font-weight: 500; letter-spacing: 0.06em;',
'      font-size: clamp(38px, 7vw, 68px); line-height: 1.1; margin: 0 0 18px; }',
'    .lede { max-width: 62ch; color: var(--ink-mid); font-size: 15px; margin: 0 0 10px; }',
'    .lede--en { font-family: var(--font-latin); font-size: 13px; letter-spacing: 0.06em; color: var(--ink-dim); }',
'    .enter {',
'      display: inline-flex; align-items: baseline; gap: 10px; margin: 34px 0 0;',
'      font-family: var(--font-latin); font-size: 14px; letter-spacing: 0.16em;',
'      color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--ink); padding-bottom: 4px;',
'    }',
'    .enter:hover, .enter:focus-visible { color: var(--ink-dim); border-color: var(--ink-dim); }',
'    .enter__note { display: block; font-family: var(--font-jp); font-size: 13px;',
'      letter-spacing: 0; color: var(--ink-dim); margin-top: 12px; max-width: 46ch; line-height: 1.8; }',
'    .rule { border: 0; border-top: 1px solid var(--line); margin: 56px 0 0; }',
'    .series { margin-top: 64px; }',
'    .series h2 { display: flex; align-items: baseline; gap: 14px; margin: 0 0 10px;',
'      font-family: var(--font-latin); font-weight: 300; font-size: clamp(24px, 3.4vw, 34px); letter-spacing: 0.12em; }',
'    .series__num { font-size: 12px; letter-spacing: 0.2em; color: var(--ink-dim); }',
'    .series__line { margin: 0; color: var(--ink-mid); font-size: 15px; }',
'    .series__line--en { font-family: var(--font-latin); font-size: 12px; letter-spacing: 0.1em;',
'      color: var(--ink-dim); margin-bottom: 26px; }',
'    .grid { display: grid; gap: clamp(18px, 2.4vw, 30px);',
'      grid-template-columns: repeat(auto-fill, minmax(216px, 1fr)); }',
'    figure { margin: 0; }',
'    figure img { display: block; width: 100%; height: auto; background: #eeedea; }',
'    figcaption { font-family: var(--font-latin); font-size: 11.5px; letter-spacing: 0.08em;',
'      color: var(--ink-mid); margin-top: 9px; line-height: 1.6; }',
'    figcaption em { display: block; font-family: var(--font-jp); font-style: normal;',
'      font-size: 11px; letter-spacing: 0; color: var(--ink-dim); margin-top: 3px; }',
'    footer { margin-top: 84px; padding-top: 30px; border-top: 1px solid var(--line);',
'      font-size: 13px; color: var(--ink-mid); }',
'    footer a { color: var(--ink); }',
'    a:focus-visible, .enter:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }',
'  </style>',
'</head>',
'<body>',
'  <div class="wrap">',
'    <p class="brand" lang="en">COMMON<sup>©</sup></p>',
'    <h1>作品一覧</h1>',
'    <p class="lede">写真家・北郷 将の作品' + total + '点。千葉県流山市を拠点に、オールドレンズを通して、日常の中でふと立ち止まりたくなるような光や余白、ざらついた静けさを記録しています。</p>',
'    <p class="lede lede--en" lang="en">All ' + total + ' works by Sho Kitago, photographer based in Nagareyama, Chiba.</p>',
'',
'    <a class="enter" href="' + SITE + '/"><span lang="en">ENTER THE EXPERIENCE</span><span>→</span></a>',
'    <span class="enter__note">このページは検索から来た方のための一覧です。作品は本編の3D空間で、一粒の綿毛を追いながら見ていただけます。</span>',
'',
'    <hr class="rule" />',
'',
sections,
'',
'    <footer>',
'      <p>撮影のご依頼、それから、ものをつくる相談も。<br />',
'      <a href="mailto:escoval0626@gmail.com">escoval0626@gmail.com</a></p>',
'      <p><a href="https://www.instagram.com/common_ordinarydays/" rel="noopener noreferrer" lang="en">Instagram</a>',
'      ・<a href="https://note.com/common0626" rel="noopener noreferrer" lang="en">note</a>',
'      ・<a href="' + SITE + '/">Common</a></p>',
'    </footer>',
'  </div>',
'</body>',
'</html>',
''].join("\n");

  fs.writeFileSync("works.html", html);

  /* ---------- sitemap.xml（画像サイトマップ付き） ---------- */
  const today = new Date().toISOString().slice(0, 10);
  const imgs = areas.flatMap((a) => a.photos)
    .map((p) => "      <image:image><image:loc>" + SITE + "/" + p.url + "</image:loc></image:image>")
    .join("\n");
  const sitemap = [
'<?xml version="1.0" encoding="UTF-8"?>',
'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
'        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
'  <url>',
'    <loc>' + SITE + '/</loc>',
'    <lastmod>' + today + '</lastmod>',
'  </url>',
'  <url>',
'    <loc>' + SITE + '/works.html</loc>',
'    <lastmod>' + today + '</lastmod>',
imgs,
'  </url>',
'</urlset>',
''].join("\n");
  fs.writeFileSync("sitemap.xml", sitemap);

  console.log("works.html   : " + areas.length + " シリーズ / " + total + " 点  (" +
    (fs.statSync("works.html").size / 1024).toFixed(1) + " KB)");
  console.log("sitemap.xml  : 2 URL / " + total + " 画像  (" +
    (fs.statSync("sitemap.xml").size / 1024).toFixed(1) + " KB)");
  console.log("実寸を書けた : " + Object.keys(dims).length + " / " + total);
})();
