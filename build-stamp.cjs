/* デプロイされた実物が、どのコミットから作られたのかを本番ページ上から
   確認できるようにする。

   これまでは「pushしたのに本番へ反映されているか」を、変更した文字列を
   curl+grepで探して確かめていた。エッジキャッシュが旧版を返して誤判定した
   こともあった（監査でも、キャッシュ由来で未デプロイと判断される事故が
   起きている）。metaにコミットSHAを載せておけば一度の取得で確定できる。

   Vercelのビルド時に VERCEL_GIT_COMMIT_SHA が渡るので、それを
   experience.html のプレースホルダへ埋める。ローカルやCI外では "local"
   のままで、ページの見た目には一切影響しない（metaタグのみ）。 */
const fs = require("fs");

const FILE = "experience.html";
const PLACEHOLDER = "__BUILD_SHA__";

const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
const stamp = sha ? sha.slice(0, 7) : "local";

let html = fs.readFileSync(FILE, "utf8");
if (!html.includes(PLACEHOLDER)) {
  /* 既に置換済み、またはプレースホルダを消してしまった場合。
     ビルドを失敗させるとデプロイ全体が止まるので、警告だけ出して通す */
  console.warn(`[build-stamp] ${PLACEHOLDER} が見つかりません。スタンプをスキップします。`);
  process.exit(0);
}
html = html.split(PLACEHOLDER).join(stamp);
fs.writeFileSync(FILE, html);
console.log(`[build-stamp] build-sha = ${stamp}`);
