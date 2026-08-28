/* 情景画像から「点描の粒子データ」を生成するワーカー。

   experience.js の addSceneDust は、12枚のアートワーク（各2600粒子）と
   1枚のパネル（10000粒子）ぶんの画像サンプリングをメインスレッドで
   同期実行していた。内訳は canvas の getImageData、最大 count*8 回の
   棄却サンプリングループ、Float32Array 6本の確保と slice。
   実測でローディング中に合計 10,233ms・最長 1,747ms のブロックが発生し、
   ENTER直後の操作感を損ねていた。

   WebGLコンテキストはメインスレッドにあるため BufferGeometry の生成
   そのものは移せないが、処理時間の大半を占める「画像 → 粒子データ配列」
   はここで計算できる。結果の Float32Array は Transferable として
   ゼロコピーで返すので、受け渡しのコストもかからない。

   fetch → createImageBitmap → OffscreenCanvas まで全てこのワーカー内で
   完結させ、画像のデコードもメインスレッドから外している。 */

/* 13枚ぶんの依頼はほぼ同時に届く。それをawaitで並行に走らせると、
   createImageBitmap と OffscreenCanvas のデコード／GPUリソース確保が
   一斉に競合し、かえってブラウザ全体が重くなる（実測で単一9,070msの
   ブロックを観測）。ここでキューに積んで必ず1枚ずつ処理する。 */
const queue = [];
let running = false;

self.onmessage = (e) => {
  queue.push(e.data);
  pump();
};

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { id, imageUrl, lineUrl, aspect, count } = queue.shift();
    try {
      const r = await buildDust(imageUrl, lineUrl, aspect, count);
      /* 6本の配列はいずれもここでしか参照しないので、コピーではなく
         所有権ごとメインスレッドへ渡す */
      self.postMessage({ id, ok: true, ...r }, [
        r.pos.buffer, r.scat.buffer, r.col.buffer,
        r.seed.buffer, r.sizes.buffer, r.delay.buffer,
      ]);
    } catch (err) {
      /* 失敗はメインスレッド側で従来の同期処理へフォールバックさせる */
      self.postMessage({ id, ok: false, error: String(err && err.message || err) });
    }
  }
  running = false;
}

/* 指定サイズへ縮小して描き、生のRGBAを取り出す */
async function readPixels(url, w, h) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h).data;
}

/* experience.js の同期版と同一のアルゴリズム。見た目を変えないため、
   サンプル解像度・棄却条件・乱数の使い方まで揃えてある */
async function buildDust(imageUrl, lineUrl, aspect, count) {
  const sx = 340, sy = Math.max(1, Math.round(340 * aspect)); /* 細かくサンプル */
  const data = await readPixels(imageUrl, sx, sy);

  /* 線画から「輪郭マップ」を作る：輪郭に近い粒子ほど早く着地させるため */
  let edgeMap = null, emW = 0, emH = 0;
  if (lineUrl) {
    try {
      emW = 170; emH = Math.max(1, Math.round(170 * aspect));
      const ld = await readPixels(lineUrl, emW, emH);
      edgeMap = new Float32Array(emW * emH);
      for (let k = 0; k < emW * emH; k++) edgeMap[k] = ld[k * 4 + 3] / 255; /* 線の濃さ */
    } catch {
      edgeMap = null; /* 輪郭マップは無くても成立する（遅延が一律になるだけ） */
    }
  }

  const pos = new Float32Array(count * 3);
  const scat = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const sizes = new Float32Array(count);
  const delay = new Float32Array(count); /* 0=輪郭で先着, 1=面で後着 */
  let idx = 0, tries = 0;
  while (idx < count && tries < count * 8) {
    tries++;
    const u = Math.random(), v = Math.random();
    const px = Math.min(sx - 1, (u * sx) | 0);
    const py = Math.min(sy - 1, (v * sy) | 0);
    const i = (py * sx + px) * 4;
    const alpha = data[i + 3] / 255;
    if (alpha < 0.08 || Math.random() > alpha * 0.85 + 0.15) continue;
    pos[idx * 3] = u - 0.5;                 /* 水彩画上の定位置 X */
    pos[idx * 3 + 1] = (0.5 - v) * aspect;  /* 同 Y */
    pos[idx * 3 + 2] = (Math.random() - 0.5) * 0.04;
    scat[idx * 3] = (Math.random() - 0.5) * 1.4;
    scat[idx * 3 + 1] = (Math.random() - 0.5) * 1.0;
    scat[idx * 3 + 2] = (Math.random() - 0.5) * 1.4;
    col[idx * 3] = data[i] / 255;
    col[idx * 3 + 1] = data[i + 1] / 255;
    col[idx * 3 + 2] = data[i + 2] / 255;
    seed[idx] = Math.random() * 100;
    sizes[idx] = 0.45 + Math.random() * 0.55;
    /* 輪郭の濃さ → 遅延。線上=0(先着) / 面=0.35〜1(後着) */
    let edge = 0;
    if (edgeMap) {
      const ex = Math.min(emW - 1, (u * emW) | 0);
      const ey = Math.min(emH - 1, (v * emH) | 0);
      edge = edgeMap[ey * emW + ex];
    }
    delay[idx] = (1.0 - Math.min(1, edge * 1.8)) * (0.5 + Math.random() * 0.5);
    idx++;
  }

  /* 実際に採れた分だけに詰めて返す（slice は新しいバッファを作るので、
     そのまま Transferable にできる） */
  return {
    idx,
    pos: pos.slice(0, idx * 3),
    scat: scat.slice(0, idx * 3),
    col: col.slice(0, idx * 3),
    seed: seed.slice(0, idx),
    sizes: sizes.slice(0, idx),
    delay: delay.slice(0, idx),
  };
}
