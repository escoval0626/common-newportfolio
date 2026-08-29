# vendor/ — 自前配信しているライブラリ

## なぜ置いてあるか

以前は Three.js と GSAP を jsDelivr から読んでいた。体験の本体がこの2つに
依存しているため、CDN が落ちる・遮断されるだけでサイトが起動せず、
`LOADING 0%` のまま止まる単一障害点になっていた。

ここに実体を置くことで、外部の状況に関係なく動く。あわせて CSP から
外部スクリプトの許可を外し、`script-src` / `connect-src` とも `'self'` のみに
厳格化してある（`vercel.json` / `server.cjs`）。

CDN 時代もバージョンは固定していたので、**勝手に更新されて壊れることは
以前も今も無い**。違いは「CDNが死んだときに巻き込まれるかどうか」だけ。

## 現在のバージョン

| ライブラリ | バージョン | 置き場所 |
|---|---|---|
| Three.js | **r160** (`three@0.160.0`) | `vendor/three/` |
| GSAP | **3.13.0** | `vendor/gsap/` |

Three.js のリビジョンは `vendor/three/three.module.js` 内の
`REVISION = '160'` で確認できる。

## 置いてあるファイルと、その理由

`examples/jsm` を丸ごと置くと数MBになるので、実際に import しているものだけ
に絞ってある。

**Three.js**

- `three.module.js` — 本体
- `addons/loaders/GLTFLoader.js` — 3Dモデル読み込み
- `addons/math/MeshSurfaceSampler.js` — メッシュ表面の点群サンプリング
- `addons/lines/LineSegments2.js` / `LineSegmentsGeometry.js` / `LineMaterial.js` — 線画表現
- `addons/utils/BufferGeometryUtils.js` — GLTFLoader が内部で依存

**GSAP**

- `index.js` — エントリ（`gsap-core.js` と `CSSPlugin.js` を束ねる）
- `gsap-core.js` — 本体
- `CSSPlugin.js` — DOM要素の opacity / transform を扱うため必須

## 更新手順

バージョンを上げたくなったときだけ実行する。普段は触らなくてよい。

### スクリプトで一括更新（推奨）

リポジトリ直下の `sync-vendor.cjs` が、取得・配置・依存チェック・
このREADMEのバージョン表更新までまとめて行う。



依存が増えていた場合はその場で検出して停止するので、コピー漏れのまま
公開してしまう事故が起きない。

### 手作業でやる場合

```bash
# 1. 新しいバージョンを取得（--no-save で package.json を作らない）
npm install --no-save three@<新バージョン> gsap@<新バージョン>

# 2. 必要なファイルだけ差し替える
cp node_modules/three/build/three.module.js vendor/three/three.module.js
cp node_modules/three/examples/jsm/loaders/GLTFLoader.js vendor/three/addons/loaders/
cp node_modules/three/examples/jsm/math/MeshSurfaceSampler.js vendor/three/addons/math/
cp node_modules/three/examples/jsm/lines/LineSegments2.js \
   node_modules/three/examples/jsm/lines/LineSegmentsGeometry.js \
   node_modules/three/examples/jsm/lines/LineMaterial.js vendor/three/addons/lines/
cp node_modules/three/examples/jsm/utils/BufferGeometryUtils.js vendor/three/addons/utils/
cp node_modules/gsap/index.js node_modules/gsap/gsap-core.js node_modules/gsap/CSSPlugin.js vendor/gsap/

# 3. このREADMEのバージョン表を更新する
```

### 更新後に必ず確認すること

1. **addon の依存が増えていないか**（メジャー更新時は特に）

   ```bash
   grep -o "from '[^']*'" vendor/three/addons/**/*.js | sort -u
   ```

   `three` と `../utils/BufferGeometryUtils.js`、`../lines/*` 以外が出てきたら、
   そのファイルも `vendor/` へ追加する。足りないと import エラーで起動しない。

2. **ブラウザのコンソールにエラーが出ないか**（`node server.cjs` で確認）

3. **Three.js のメジャー更新では破壊的変更に注意**
   r160 → r16x でも `BufferGeometry` や `ShaderMaterial` の API が変わることがある。
   このプロジェクトは点群シェーダーを自作しているため影響を受けやすい。

## 更新履歴

sync-vendor.cjs が実行のたびに追記する。手で書き足す必要はない。

| 日付 | Three.js | GSAP |
|---|---|---|
| 2026-08-29 | r160 (0.160.0) | 3.13.0 | ← 自前配信へ切り替え（初期導入）

## importmap との対応

`experience.html` の importmap がここを指している。パスを変えるときは両方直す。

```json
{
  "three": "./vendor/three/three.module.js",
  "three/addons/": "./vendor/three/addons/",
  "gsap": "./vendor/gsap/index.js"
}
```
