# COMMON. photograph（experience）

- 本番: https://www.commonphotograph.com （Vercel。`/` → `experience.html`。main への push で本番）
- フレームワーク無しの静的サイト。本体は `experience.html` / `experience.js` / `assets/` / `vendor/`（three.js 等はローカル同梱、`sync-vendor.cjs`）。
- 起動: `node server.cjs`（port 4173、依存ゼロ）。npm install 不要。
- Vercel の build は `node build-stamp.cjs && node build-works.cjs`。works 一覧は `works.html` / `works-alt.json` から生成される。
- **CSP が厳しい**（vercel.json）。`script-src 'self'` ＋ inline script は sha256 固定。inline `<script>` を書き換えたら CSP のハッシュも更新する。外部 CDN は読み込めない。
- WebGL の元ネタ実測値は Codex 側の reference にある（ローカルPC）。クラウドからは見えないので、シェーダの数値は推測で変えない。分からなければ確認事項に書く。

## リモート運用（iPhone／クラウドセッションからの指示）

このリポジトリは Claude Code のクラウドセッション（claude.ai/code・iPhone アプリ）から、車中の**音声入力**で指示されることがある。ローカルPCのメモリやツールは使えない前提で、以下を守る。

### 指示の受け方
- 音声入力なので誤変換・言い切り・主語抜けが混ざる。着手時に「こう解釈した」を一行で書いてから進める。
- 「もう少し広く／小さく／ゆっくり」は常識的な一段で試す（余白 8〜16px、サイズ 0.9〜1.1倍、モーション 100〜200ms）。数値を報告に書く。
- 「大きすぎる／強すぎる／多すぎる」は**程度**の不満。機能・セクション・演出を消さない。数値だけ直す。
- 「A を B に合わせて」は、直前に挙がった1点だけ揃える。A の全部を B にしない。
- サイトの種類・ペルソナ・題材・文言の意味を変える判断は本人のもの。勝手に決めない。仮置きなら仮置きと明記し、選択肢を添える。
- 連絡先・価格・実績・固有名詞などの事実は捏造しない。無ければ空のまま。

### 進め方
- 必ずブランチを切り PR を作る。main / master へ直接 push しない。
- 1指示 = 1PR。小さく速く。
- `npm ci` → 変更 → `npm run build`（あれば lint / `tsc --noEmit`）が通ってから PR。落ちたら落ちたと書く。通ったふりをしない。
- PR に Vercel のプレビュー URL が付く。報告に必ず貼る（iPhone で見て判断する）。
- `.env`・API キー・トークンは読まない・作らない・貼らない。
- 有料サービス・有料プラン・課金は提案しない。

### 報告の型
**ステータス / やったこと / TODO / 確認事項** の4見出し＋箇条書き。1項目1行。経緯・差分・長い引用は貼らない。
