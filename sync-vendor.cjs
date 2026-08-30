/* vendor/ のライブラリを更新するスクリプト。
   使い方:  node sync-vendor.cjs

   Three.js と GSAP は vendor/ に実体を置いて自前配信している（CDNを
   単一障害点にしないため。経緯は vendor/README.md 参照）。
   その差し替えを手作業でやるとコピー漏れやバージョン取り違えが起きるので、
   バージョン指定・コピー・依存チェックまでここで完結させる。

   package.json をあえて作っていないのは、Vercel が Node.js プロジェクトと
   判定してビルド挙動が変わるのを避けるため。バージョンはこのファイルの
   定数が唯一の情報源になる。 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/* ★ 更新するときはこの2つを書き換えてから実行する */
const THREE_VERSION = "0.160.0";
const GSAP_VERSION = "3.13.0";

/* 実際に import しているものだけを置く。examples/jsm を丸ごと入れると
   数MBになるため。addon が内部で使うものも含める（BufferGeometryUtils は
   GLTFLoader の依存） */
const FILES = [
  ["node_modules/three/build/three.module.js", "vendor/three/three.module.js"],
  ["node_modules/three/examples/jsm/loaders/GLTFLoader.js", "vendor/three/addons/loaders/GLTFLoader.js"],
  ["node_modules/three/examples/jsm/math/MeshSurfaceSampler.js", "vendor/three/addons/math/MeshSurfaceSampler.js"],
  ["node_modules/three/examples/jsm/lines/LineSegments2.js", "vendor/three/addons/lines/LineSegments2.js"],
  ["node_modules/three/examples/jsm/lines/LineSegmentsGeometry.js", "vendor/three/addons/lines/LineSegmentsGeometry.js"],
  ["node_modules/three/examples/jsm/lines/LineMaterial.js", "vendor/three/addons/lines/LineMaterial.js"],
  ["node_modules/three/examples/jsm/utils/BufferGeometryUtils.js", "vendor/three/addons/utils/BufferGeometryUtils.js"],
  ["node_modules/three/examples/jsm/libs/meshopt_decoder.module.js", "vendor/three/addons/libs/meshopt_decoder.module.js"],
  ["node_modules/gsap/index.js", "vendor/gsap/index.js"],
  ["node_modules/gsap/gsap-core.js", "vendor/gsap/gsap-core.js"],
  ["node_modules/gsap/CSSPlugin.js", "vendor/gsap/CSSPlugin.js"],
];

/* addon が import してよい相手。ここに無いものが現れたら、その依存も
   vendor/ へ入れないと import エラーで起動しなくなる（バージョンを上げた
   ときに依存が増えることがあるので、毎回照合する） */
const ALLOWED_IMPORTS = [
  "three",
  "../utils/BufferGeometryUtils.js",
  "../lines/LineMaterial.js",
  "../lines/LineSegmentsGeometry.js",
  "./gsap-core.js",
  "./CSSPlugin.js",
];

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

console.log(`\n[1/4] three@${THREE_VERSION} と gsap@${GSAP_VERSION} を取得`);
run(`npm install --no-save --silent three@${THREE_VERSION} gsap@${GSAP_VERSION}`);

console.log("\n[2/4] 必要なファイルを vendor/ へ配置");
let copied = 0;
for (const [src, dst] of FILES) {
  if (!fs.existsSync(src)) {
    console.error(`  × 見つかりません: ${src}`);
    console.error("    バージョンを上げてファイル構成が変わった可能性があります。");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const kb = (fs.statSync(dst).size / 1024).toFixed(0);
  console.log(`  ${String(kb).padStart(5)}KB  ${dst}`);
  copied++;
}
console.log(`  → ${copied}ファイル`);

console.log("\n[3/4] 依存が増えていないか照合");
const unexpected = [];
for (const [, dst] of FILES) {
  const body = fs.readFileSync(dst, "utf8");
  /* コメント中の例示URLを拾わないよう、import/export 文の from だけを見る */
  const re = /^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(body))) {
    if (!ALLOWED_IMPORTS.includes(m[1])) unexpected.push(`${dst} → ${m[1]}`);
  }
}
if (unexpected.length) {
  console.error("  × 想定外の依存が見つかりました:");
  unexpected.forEach((u) => console.error(`    ${u}`));
  console.error("\n    このファイルも vendor/ へ追加し、FILES と ALLOWED_IMPORTS を更新してください。");
  console.error("    足りないまま公開すると import エラーでサイトが起動しません。");
  process.exit(1);
}
console.log("  → 想定内の依存のみ");

console.log("\n[4/4] バージョン表記と更新履歴を vendor/README.md へ反映");
const readmePath = "vendor/README.md";
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, "utf8");
  const rev = (fs.readFileSync("vendor/three/three.module.js", "utf8").match(/REVISION\s*=\s*'([^']+)'/) || [])[1];

  /* 現在のバージョン表 */
  readme = readme.replace(
    /\| Three\.js \| \*\*[^*]+\*\*[^|]*\|/,
    `| Three.js | **r${rev}** (\`three@${THREE_VERSION}\`) |`
  );
  readme = readme.replace(/\| GSAP \| \*\*[^*]+\*\* \|/, `| GSAP | **${GSAP_VERSION}** |`);

  /* 更新履歴。「いつ何から何へ上げたか」は手で書くと必ず忘れるので、
     バージョンが変わったときだけ行を足す（同バージョンの再実行では
     履歴を汚さない） */
  const histHeader = "| 日付 | Three.js | GSAP |\n|---|---|---|\n";
  if (readme.includes(histHeader)) {
    const line = `| ${new Date().toISOString().slice(0, 10)} | r${rev} (${THREE_VERSION}) | ${GSAP_VERSION} |\n`;
    const already = readme.includes(`| r${rev} (${THREE_VERSION}) | ${GSAP_VERSION} |`);
    if (already) {
      console.log("  → バージョン変更なし。履歴は追記しません");
    } else {
      readme = readme.replace(histHeader, histHeader + line);
      console.log(`  → 履歴に追記: Three.js r${rev} / GSAP ${GSAP_VERSION}`);
    }
  }
  fs.writeFileSync(readmePath, readme);
  console.log(`  → 現在: Three.js r${rev} / GSAP ${GSAP_VERSION}`);
}

console.log("\n完了。次に確認すること:");
console.log("  1. node server.cjs でローカル起動し、コンソールにエラーが出ないこと");
console.log("  2. Three.js のメジャー更新時は点群シェーダーの表示崩れがないこと");
console.log("     （このプロジェクトは ShaderMaterial を自作しているため影響を受けやすい）\n");
