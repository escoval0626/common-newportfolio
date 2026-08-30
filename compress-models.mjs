/* 3Dモデルを圧縮して assets/models/min/*.glb を作る。
   使い方:  node compress-models.mjs

   元アセット（assets/models/real/）はテクスチャ付きの汎用GLTFで、
   このサイトの使い方にはまったく合っていなかった。

   1. UVが要らない
      placeScan() は MeshSurfaceSampler で表面から点を拾い、位置と法線しか
      使わない（sampler.sample(_sp, _sn)）。material も texture も参照しない。
      それでも TEXCOORD_0 が全頂点ぶん入っていて、deadtree だけで421KBあった。

   2. 三角形が100倍多い
      deadtree は 101,802三角形あるが、そこから実際に撒く粒子は
      TRANSIT_OBJECTS の設定（高さ×150）で510〜975点。しかも霧の中の
      シルエットとして見える。ratio 0.25 まで落としても、なお36倍の
      オーバーサンプリングが残る。simplify の誤差上限は 0.001（バウンディング
      ボックスの0.1%）に締めてあり、この範囲内で目標比率に到達している。
      三角形が減ると MeshSurfaceSampler の構築（面積の累積分布を作る処理、
      三角形数に比例する。deadtree 1体で実測131msかかっていた）も同じだけ速くなる。

   3. 圧縮していない
      float32の生データが .bin にそのまま並んでいた。quantize + meshopt で
      1/5以下になる。

   出力を .glb にしたのは、テクスチャ参照をビルド時に落としたことで、
   experience.js 側が実行時にJSONを書き換えてtextureを剥がす必要が
   なくなったため。1ファイル1リクエストで読める。

   元アセットは再実行できるよう残してあるが、配信には不要なので
   .vercelignore で除外している。 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, weld, prune, simplify, reorder, quantize } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import fs from "fs";
import path from "path";

/* ★ 品質を変えたくなったらここ。ratio を上げるほど元の形に近づく */
const SIMPLIFY_RATIO = 0.25;
const SIMPLIFY_ERROR = 0.001;

const SRC_DIR = "assets/models/real";
const OUT_DIR = "assets/models/min";

/* experience.js の MODELS / MODELS_DEFERRED と対応する。
   花3件は現状どこからも配置されていないが、使うときに圧縮済みで
   あるほうがいいので一緒に処理する */
const MODELS = {
  deadtree:   "dead_tree_trunk/dead_tree_trunk_1k.gltf",
  fern:       "fern_02/fern_02_1k.gltf",
  gazania:    "flower_gazania/flower_gazania_1k.gltf",
  heliophila: "flower_heliophila/flower_heliophila_1k.gltf",
  ursinia:    "flower_ursinia/flower_ursinia_1k.gltf",
};

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

function countTriangles(doc) {
  let t = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      t += (prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount()) / 3;
  return Math.round(t);
}

/* 元アセットは .gltf + .bin + textures/ の3点セットなので、
   ディレクトリごと合計しないと削減量を見誤る */
function sourceBytes(rel) {
  const dir = path.join(SRC_DIR, path.dirname(rel));
  let sum = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) continue;   /* textures/ は元から配信していない */
    sum += fs.statSync(p).size;
  }
  return sum;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let before = 0;
let after = 0;
console.log(`\nsimplify ratio=${SIMPLIFY_RATIO} / 誤差上限=${SIMPLIFY_ERROR}\n`);
console.log("モデル        三角形            サイズ");
console.log("─".repeat(52));

for (const [key, rel] of Object.entries(MODELS)) {
  const doc = await io.read(path.join(SRC_DIR, rel));

  /* UVは使っていないので落とす。これをやらないと simplify も quantize も
     要らないデータを丁寧に圧縮してしまう */
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      for (const semantic of prim.listSemantics())
        if (semantic.startsWith("TEXCOORD")) prim.setAttribute(semantic, null);

  /* material を消すと、参照が切れた texture / image を prune が回収する。
     placeScan は独自のパレットで色を塗るので material は一切見ていない */
  for (const material of doc.getRoot().listMaterials()) material.dispose();

  const triBefore = countTriangles(doc);
  await doc.transform(
    dedup(),
    weld(),                                                   /* simplifyの前に頂点を溶接しないと形が崩れる */
    prune(),
    simplify({ simplifier: MeshoptSimplifier, ratio: SIMPLIFY_RATIO, error: SIMPLIFY_ERROR }),
    reorder({ encoder: MeshoptEncoder }),                     /* 頂点順を並べ替えると meshopt がよく縮む */
    quantize()
  );
  doc.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });

  const glb = await io.writeBinary(doc);
  fs.writeFileSync(path.join(OUT_DIR, `${key}.glb`), glb);

  const src = sourceBytes(rel);
  before += src;
  after += glb.byteLength;
  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  console.log(
    `${key.padEnd(12)} ${String(triBefore).padStart(6)} → ${String(countTriangles(doc)).padStart(5)}   ` +
    `${kb(src).padStart(7)} → ${kb(glb.byteLength).padStart(6)}  (${(100 - (glb.byteLength / src) * 100).toFixed(0)}%減)`
  );
}

console.log("─".repeat(52));
console.log(
  `合計         ${((before / 1024 / 1024).toFixed(2) + "MB").padStart(22)} → ` +
  `${(after / 1024 / 1024).toFixed(2)}MB  (${(100 - (after / before) * 100).toFixed(0)}%減)\n`
);
console.log("次に確認すること:");
console.log("  1. experience.js の MODELS が assets/models/min/*.glb を指していること");
console.log("  2. GLTFLoader に setMeshoptDecoder(MeshoptDecoder) が渡っていること");
console.log("     （渡さないと EXT_meshopt_compression は必須拡張なので読み込みが失敗する）");
console.log("  3. ブラウザで木立のシルエットが痩せていないこと\n");
