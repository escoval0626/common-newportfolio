/* ============================================================
   EXPERIENCE — 綿毛の旅
   物語：一輪のタンポポ（マクロ）→ ENTERで綿毛がひとつ離脱（ABOUT）
         → 綿毛がカメラを先導して世界を巡る
         PLANTS（タンポポの群生）→ LANDSCAPE → ARCHITECTURE
         → SNAPS → CONTACT（種がまた降りて、芽吹く）
   すべて粒子（点描）で描画。視点連動のシルエット強調つき。
   ※ MODELS のGLBは差し替え可能（Blender製 water.glb 等が
      完成したらパスを足すだけで同じ点描言語に変換される）
   Credits: Poly Haven のフォトスキャンモデル（CC0）
============================================================ */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import gsap from "gsap";

const canvas = document.getElementById("xpCanvas");

/* ?perf=1 のときだけ、重い処理の所要時間を window.__perf に溜める。
   「どこがメインスレッドを止めているのか」を推測ではなく実測するための
   計測フック。本番では条件が偽なので関数呼び出し1回ぶんしか掛からない */
/* ?perf=1 を付けるだけで本番URLでも window.__perf が公開できてしまっていた。
   計測フックはローカル開発時だけ有効にする */
const PERF = /[?&]perf=1\b/.test(location.search) &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
if (PERF) window.__perf = [];
function perf(name, fn) {
  if (!PERF) return fn();
  const t0 = performance.now();
  const r = fn();
  window.__perf.push({ name, ms: +(performance.now() - t0).toFixed(1) });
  return r;
}

/* WebGL自体が使えない環境（古いブラウザ・一部の組み込みWebView・GPU拒否リスト）
   ではWebGLRenderingContextのコンストラクタが例外を投げる。この体験は
   WebGL前提で全編組んであり縮退動作を用意できないため、非対応時は
   #webglFallback（作品6点＋プロフィール＋連絡先の静的な代替表示）に切り替える。
   以前はここから index.html へ逃がす想定だったが、その旧TOPは公開対象から
   外してある（.gitignore済み・本番には存在しない）ので、逃がし先を持たず
   このページ内で完結させる */
function isWebGLAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (e) {
    return false;
  }
}
function showWebglFallback() {
  trackEvent("static_fallback_shown");
  const fb = document.getElementById("webglFallback");
  if (fb) {
    fb.classList.add("is-active");
    /* aria-hidden="true" のままだと支援技術からはこのメッセージ自体が
       「存在しない」ものとして扱われ、何が起きたのか伝わらない */
    fb.setAttribute("aria-hidden", "false");
    const link = document.getElementById("webglFallbackLink");
    if (link) link.focus();
  }
  const loader = document.getElementById("loader");
  if (loader) loader.style.display = "none";
}
if (!isWebGLAvailable()) {
  showWebglFallback();
  throw new Error("WebGL is not available in this browser.");
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    /* 粒子にはMSAAはほぼ効かないが、下層ページの写真は板の縁が出るので必要。
       粒子を大幅に削って余裕ができたぶん、ここに回す。
       ただしタッチ端末（非力なモバイルGPU）ではMSAAのコスト自体が
       カルーセルの横送りのもたつきとして体感されており、板の縁は
       シェーダー側でも自前にアンチエイリアシングしている（fwidthベース）
       ため、タッチ端末ではMSAAを切って浮いた分をフレームレートに回す */
    /* IS_TOUCH の定義はこのファイルの後方（renderer初期化より後）にあるため、
       ここでは同じ判定式をそのまま書く（TDZで参照できない） */
    antialias: !(matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints || 0) > 0),
    powerPreference: "high-performance",
  });
} catch (e) {
  showWebglFallback();
  throw e;
}

/* 綿毛（旅の主役）だけを、霧のヴェールより手前に描くための専用レンダラー。
   ENTER前はこのシーンだけに綿毛を置いてレンダリングし、ENTER後は
   本編のsceneへ戻す（下記 fluff = makeFluff() 付近、およびenterBtnの
   クリックハンドラ参照）。失敗しても本編体験には影響させない
   （綿毛が霧の奥のままになるだけで、機能的な破綻はない） */
let loaderFluffRenderer = null;
const loaderFluffScene = new THREE.Scene();
try {
  const loaderFluffCanvas = document.getElementById("loaderFluffCanvas");
  if (loaderFluffCanvas) {
    loaderFluffRenderer = new THREE.WebGLRenderer({
      canvas: loaderFluffCanvas, alpha: true, antialias: true,
    });
    loaderFluffRenderer.setClearColor(0x000000, 0);
  }
} catch (e) { loaderFluffRenderer = null; }

/* GPUドライバのクラッシュ・タブのバックグラウンド長時間放置・端末のメモリ逼迫等で
   コンテキストが失われると、以降renderer.render()は何も描かず沈黙する
   （エラーは出ない）。契機を捉えてループを止め、無音の黒画面のまま
   固まって見える最悪の状態を避ける */
let contextLost = false;
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  contextLost = true;
  showWebglFallback();
}, false);

const BG = new THREE.Color("#eeedea");

/* 半透明の粒子は重なるほど同じ画素を何度も塗り直すので、
   コストは「窓の面積」にほぼ比例する。小さなプレビューでは軽いのに
   全画面のブラウザで急に重くなるのはこれが理由。面積そのものに上限を設ける。 */
const PIXEL_BUDGET = 3.6e6;
let qualityScale = 1;
const dustMats = []; /* 点の大きさは実解像度に追従させる必要がある */
/* 拡大表示の間だけ立てる。activeRoom は宣言がずっと後ろなので、
   fitPixelRatio から直接参照すると初期化前アクセスになりうる */
let zoomFullRes = false;
function fitPixelRatio() {
  if (zoomFullRes) {
    /* 拡大表示は板1枚とテクスチャだけで、旅の最中のような半透明粒子の
       塗り重ねが無い（実測: 拡大 draw 34 / pts 1259 に対し 旅 draw 181）。
       上の 1.25 上限は粒子のための制限で、ここでは払う必要が無い。
       写真家のポートフォリオで作品を見せる主画面が、素の <img> より
       線形解像度で約6割にしかならないのは本末転倒なので、ここだけ上げる */
    return Math.min(window.devicePixelRatio || 1, 2);
  }
  const base = Math.min(window.devicePixelRatio || 1, 1.25);
  const area = innerWidth * innerHeight * base * base;
  const k = area > PIXEL_BUDGET ? Math.sqrt(PIXEL_BUDGET / area) : 1;
  return THREE.MathUtils.clamp(base * k * qualityScale, 0.7, base);
}
function applyPixelRatio() {
  const pr = fitPixelRatio();
  renderer.setPixelRatio(pr);
  pointsUniforms.uPr.value = pr;
  for (const m of dustMats) m.uniforms.uPr.value = pr;
}
renderer.setClearColor(BG, 1);

const scene = new THREE.Scene();
/* 線は scene.fog で減衰させる（粒子側の uFogDensity と同期させる） */
scene.fog = new THREE.FogExp2(BG, 0.4);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);

/* ============================================================
   実線（ペン画のインク線）— 粒子と役割分担する
   輪郭・骨格は線が担い、粒子は内側の階調と空気を担う
============================================================ */
const lineMats = [];
function makeLineMat(color, width, opacity) {
  const m = new LineMaterial({
    color: new THREE.Color(color),
    linewidth: width,          /* px（画面空間） */
    transparent: true,
    opacity,
    fog: true,
    depthWrite: false,
  });
  m.resolution.set(innerWidth, innerHeight);
  lineMats.push(m);
  return m;
}
const INK_STEM  = makeLineMat("#4a5740", 1.5, 0.85);  /* 茎 */
const INK_FIL   = makeLineMat("#6f6a5c", 1.0, 0.5);   /* 綿毛の軸 */
const INK_STRUCT= makeLineMat("#3d3833", 1.4, 0.8);   /* 建築・桟橋の骨格 */
const INK_WIRE  = makeLineMat("#4a463e", 1.0, 0.55);  /* 柵のワイヤー */
const INK_SCAN  = makeLineMat("#4a443d", 1.1, 0.5);   /* スキャン面のハッチング */
const INK_GRASS = makeLineMat("#6f7a55", 1.0, 0.45);  /* 草の毛描き */
const INK_HAIR  = makeLineMat("#8a857a", 0.8, 0.42);  /* 冠毛（パラシュートの毛） */

/* 位置配列 → 太さのある線分群 */
function buildLines(positions, mat) {
  if (!positions.length) return null;
  const g = new LineSegmentsGeometry();
  g.setPositions(positions);
  const l = new LineSegments2(g, mat);
  l.computeLineDistances();
  l.frustumCulled = false;
  scene.add(l);
  return l;
}
/* 手描きの震え：線の端点をわずかに散らす */
function jit(v, amt) { return v + (Math.random() - 0.5) * amt; }

/* アーティスティックな線：直線ではなく、弓なりの曲線ストロークを刻む
   （2次ベジェを数分割してLineSegmentsに落とす） */
function strokeCurve(out, ax, ay, az, bx, by, bz, bow = 0.05, segs = 3) {
  const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
  const dxl = bx - ax, dyl = by - ay, dzl = bz - az;
  let px = Math.random() - 0.5, py = Math.random() - 0.5, pz = Math.random() - 0.5;
  const L2 = dxl * dxl + dyl * dyl + dzl * dzl || 1;
  const dot = (px * dxl + py * dyl + pz * dzl) / L2;
  px -= dot * dxl; py -= dot * dyl; pz -= dot * dzl;
  const pl = Math.hypot(px, py, pz) || 1;
  const cxm = mx + (px / pl) * bow, cym = my + (py / pl) * bow, czm = mz + (pz / pl) * bow;
  let prx = ax, pry = ay, prz = az;
  for (let s = 1; s <= segs; s++) {
    const t = s / segs, it = 1 - t;
    const qx = it * it * ax + 2 * it * t * cxm + t * t * bx;
    const qy = it * it * ay + 2 * it * t * cym + t * t * by;
    const qz = it * it * az + 2 * it * t * czm + t * t * bz;
    out.push(prx, pry, prz, qx, qy, qz);
    prx = qx; pry = qy; prz = qz;
  }
}

/* 形状のエッジ（角度しきい値超え）をインク線として取り出す */
const _ev = new THREE.Vector3();
function pushEdges(out, geom, transform, threshold = 25, jitter = 0.006) {
  const eg = new THREE.EdgesGeometry(geom, threshold);
  const pos = eg.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _ev.fromBufferAttribute(pos, i);
    if (transform) _ev.applyMatrix4(transform);
    out.push(jit(_ev.x, jitter), jit(_ev.y, jitter), jit(_ev.z, jitter));
  }
  eg.dispose();
}

/* ============================================================
   点描マテリアル（共有）— 霧・またたき・シルエット強調
============================================================ */
const pointsUniforms = {
  uTime: { value: 0 },
  uFogDensity: { value: 0.4 },
  uBg: { value: BG },
  uPr: { value: 1 }, /* 実解像度は applyPixelRatio が入れる */
};

const pointsMat = new THREE.ShaderMaterial({
  uniforms: pointsUniforms,
  vertexShader: /* glsl */ `
    attribute float aSeed;
    attribute float aSize;
    attribute vec3 aColor;
    attribute vec3 aNormal;
    uniform float uTime, uFogDensity, uPr;
    varying vec3 vColor;
    varying float vFog;
    varying float vTw;
    varying float vFres;
    varying float vNear;
    varying float vInk;
    varying vec2 vRot;
    varying float vElong;
    void main() {
      vec3 p = position;
      p.x += sin(uTime * 0.5 + aSeed) * 0.022;
      p.y += sin(uTime * 0.42 + aSeed * 1.7) * 0.022;
      p.z += cos(uTime * 0.47 + aSeed * 2.3) * 0.022;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      float dist = max(0.6, -mv.z);
      float fres = 0.0;
      if (dot(aNormal, aNormal) > 0.1) {
        vec3 wN = normalize(mat3(modelMatrix) * aNormal);
        vec3 wP = (modelMatrix * vec4(p, 1.0)).xyz;
        vec3 V = normalize(cameraPosition - wP);
        fres = pow(1.0 - abs(dot(wN, V)), 2.2);
      }
      vFres = fres;
      /* 近すぎる粒子は巨大な染みになって"ゴミ"に見えるので、大きさに上限を設け、
         至近距離では静かに退場させる（視界を横切る大きな黒点をなくす） */
      gl_PointSize = min(aSize * uPr * (17.0 / dist) * (1.0 + fres * 0.85), uPr * 3.6);
      vNear = smoothstep(0.9, 2.6, dist);
      /* 墨の濃さの個体差。均一だと"点の集合"に見えるので、大半を淡く散らす */
      vInk = 0.28 + 0.72 * pow(fract(aSeed * 0.37), 1.8);
      { float a0 = fract(aSeed * 0.61) * 6.2831; vRot = vec2(cos(a0), sin(a0)); vElong = 1.0 + 0.95 * fract(aSeed * 0.61 * 7.3); }
      vFog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
      vTw = 0.85 + 0.15 * sin(uTime * 0.8 + aSeed * 3.0);
      vColor = aColor;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uBg;
    varying vec3 vColor;
    varying float vFog;
    varying float vTw;
    varying float vFres;
    varying float vNear;
    varying float vInk;
    varying vec2 vRot;
    varying float vElong;
    /* 完全な真円が均一に並ぶと「コンピューターが打った点」に見える。
       粒ごとに向き・伸び・縁の凹凸を変え、紙の目に沿った鉛筆の粒状に寄せる。 */
    /* 回転と伸びは頂点側で用意した値を使い、縁の凹凸は三角関数を使わずに出す。
       sin(3θ)/sin(5θ) は正規化した向き n から多項式で得られるので、
       atan も sin も呼ばずに済む（塗る画素が多いほどこの差が効く）。 */
    float grainDist(vec2 pc, vec2 rot, float elong) {
      vec2 q = vec2(pc.x * rot.x - pc.y * rot.y, pc.x * rot.y + pc.y * rot.x);
      q.y *= elong;
      float len = length(q) + 1e-5;
      float s = q.y / len;
      float s2 = s * s;
      float s3 = 3.0 * s - 4.0 * s * s2;                 /* = sin(3θ) */
      float s5 = s * (5.0 - 20.0 * s2 + 16.0 * s2 * s2); /* = sin(5θ) */
      float wob = 1.0 + 0.20 * s3 + 0.13 * s5;
      return len * 2.0 / wob;
    }
    void main() {
      float d = grainDist(gl_PointCoord - 0.5, vRot, vElong);
      if (d > 1.0) discard;
      /* 硬い縁のベタ円＝"黒点"に見える。中心から滑らかに薄れる滲みにする（紙に落ちた墨） */
      float a = exp(-d * d * 2.9);
      vec3 c = mix(vColor, vColor * 0.45, vFres * 0.9);
      /* 常に紙の色をいくらか含ませ、真っ黒な粒を作らない */
      c = mix(c, uBg, 0.20 + vFog * 0.80);
      a *= (1.0 - vFog * 0.88) * vTw * (1.0 + vFres * 0.4) * vNear * vInk * 0.82;
      a = min(1.0, a);
      if (a < 0.015) discard;
      gl_FragColor = vec4(c, a);
    }
  `,
  transparent: true,
  depthWrite: false,
});

/* ============================================================
   粒子生成ヘルパー
============================================================ */
const _sp = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _tmpCol = new THREE.Color();

function makeAttrArrays(cap) {
  return {
    pos: new Float32Array(cap * 3),
    col: new Float32Array(cap * 3),
    nor: new Float32Array(cap * 3),
    seed: new Float32Array(cap),
    sizes: new Float32Array(cap),
    idx: 0,
  };
}
function pushParticle(a, x, y, z, palette, sizeMin = 0.55, sizeMax = 1.4, dim = 1, nx = 0, ny = 0, nz = 0) {
  const i = a.idx;
  a.pos[i * 3] = x; a.pos[i * 3 + 1] = y; a.pos[i * 3 + 2] = z;
  _tmpCol.set(palette[(Math.random() * palette.length) | 0]);
  const v = (0.86 + Math.random() * 0.26) * dim;
  a.col[i * 3] = _tmpCol.r * v + BG.r * (1 - dim) * 0.6;
  a.col[i * 3 + 1] = _tmpCol.g * v + BG.g * (1 - dim) * 0.6;
  a.col[i * 3 + 2] = _tmpCol.b * v + BG.b * (1 - dim) * 0.6;
  a.nor[i * 3] = nx; a.nor[i * 3 + 1] = ny; a.nor[i * 3 + 2] = nz;
  a.seed[i] = Math.random() * 100;
  a.sizes[i] = sizeMin + Math.random() * (sizeMax - sizeMin);
  a.idx++;
}
function buildPointsGeo(a) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(a.pos.slice(0, a.idx * 3), 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(a.col.slice(0, a.idx * 3), 3));
  geo.setAttribute("aNormal", new THREE.BufferAttribute(a.nor.slice(0, a.idx * 3), 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(a.seed.slice(0, a.idx), 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(a.sizes.slice(0, a.idx), 1));
  return geo;
}
function buildPoints(a) {
  const points = new THREE.Points(buildPointsGeo(a), pointsMat);
  /* 頂点シェーダーで風に揺らす分だけ境界球を膨らませ、画面外は描かないようにする。
     旅の道中の木立は常に十数本あるが、視界に入るのは毎フレーム数本だけ。 */
  points.geometry.computeBoundingSphere();
  if (points.geometry.boundingSphere) points.geometry.boundingSphere.radius += 0.2;
  points.frustumCulled = true;
  scene.add(points);
  return points;
}

/* 情景粒子マテリアル：aScatter=散らばった居場所、position=水彩画上の定位置。
   uAssemble 0→1 で「浮遊する粒子」→「結合した水彩画」へモーフする。
   uPanelFade で写真へ譲るときに退く。 */
function makeDustMat() {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({}, pointsUniforms, {
      uPanelFade: { value: 1 }, uAssemble: { value: 0 }, uColorIn: { value: 0 },
    }),
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aSize;
      attribute vec3 aColor;
      attribute vec3 aScatter;
      attribute float aDelay;
      uniform float uTime, uFogDensity, uPr, uAssemble;
      varying vec3 vColor;
      varying float vFog;
      varying float vTw;
      varying float vNear;
      varying float vInk;
      varying vec2 vRot;
      varying float vElong;
      varying float vSettle;  /* この粒子の着地度 0→1 */
      /* 到着後にわずかに行き過ぎて震えて止まる（easeOutBack + 減衰） */
      float easeBack(float t) {
        float s = 1.5;
        t -= 1.0;
        return t * t * ((s + 1.0) * t + s) + 1.0;
      }
      void main() {
        vec3 target = position;                 /* 水彩画上の定位置 */
        vec3 scattered = target + aScatter;     /* 散らばった居場所 */
        scattered.x += sin(uTime * 0.35 + aSeed) * 0.16;
        scattered.y += sin(uTime * 0.30 + aSeed * 1.7) * 0.16;
        scattered.z += cos(uTime * 0.32 + aSeed * 2.3) * 0.16;
        /* 輪郭先行の非同期結合：aDelay が小さい粒子（＝線上）ほど先に着地。
           uAssemble を [aDelay*0.6, aDelay*0.6+0.4] の窓で 0→1 に写像 */
        float lo = aDelay * 0.6;
        float s = clamp((uAssemble - lo) / 0.4, 0.0, 1.0);
        vSettle = s;
        float e = easeBack(s);
        /* 螺旋で巻き込むように着地（最短直線にしない） */
        vec3 p = mix(scattered, target, e);
        float swirl = (1.0 - s) * s * 0.5;
        p.x += cos(aSeed * 6.2831 + s * 6.0) * swirl * 0.3;
        p.z += sin(aSeed * 6.2831 + s * 6.0) * swirl * 0.3;
        /* 着地後のごく僅かな呼吸 */
        p.x += sin(uTime * 0.5 + aSeed) * 0.008 * s;
        p.y += sin(uTime * 0.42 + aSeed * 1.7) * 0.008 * s;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(0.6, -mv.z);
        /* 至近距離の巨大化を抑え、近すぎる粒子は退場させる（黒い染み対策） */
        /* aSize は 0.45〜1.0。17.0/dist だと旅の常用距離（15〜25）で
           0.4〜1.0px にしかならず、点が1画素より小さいので何個撒いても
           画面に乗らなかった（実測: 粒子が触れる画素は全体の1.06%、
           平均寄与 0.045/255。色斑の122分の1）。実寸で見える大きさにする */
        gl_PointSize = min(aSize * uPr * (55.0 / dist), uPr * 9.0);
        vNear = smoothstep(0.9, 2.6, dist);
        vInk = 0.28 + 0.72 * pow(fract(aSeed * 0.37), 1.8);
        { float a0 = fract(aSeed * 0.61) * 6.2831; vRot = vec2(cos(a0), sin(a0)); vElong = 1.0 + 0.95 * fract(aSeed * 0.61 * 7.3); }
        vFog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        vTw = 0.85 + 0.15 * sin(uTime * 0.8 + aSeed * 3.0);
        vColor = aColor;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uBg;
      uniform float uPanelFade, uColorIn;
      varying vec3 vColor;
      varying float vFog;
      varying float vTw;
      varying float vNear;
      varying float vInk;
      varying vec2 vRot;
      varying float vElong;
      varying float vSettle;
      /* 粒ごとに向き・伸び・縁の凹凸を変え、真円の均一な並びを崩す。
         毎ピクセルの三角関数は避け、多項式で sin(3θ)/sin(5θ) を得る */
      float grainDist(vec2 pc, vec2 rot, float elong) {
        vec2 q = vec2(pc.x * rot.x - pc.y * rot.y, pc.x * rot.y + pc.y * rot.x);
        q.y *= elong;
        float len = length(q) + 1e-5;
        float s = q.y / len;
        float s2 = s * s;
        float s3 = 3.0 * s - 4.0 * s * s2;
        float s5 = s * (5.0 - 20.0 * s2 + 16.0 * s2 * s2);
        float wob = 1.0 + 0.20 * s3 + 0.13 * s5;
        return len * 2.0 / wob;
      }
      void main() {
        float d = grainDist(gl_PointCoord - 0.5, vRot, vElong);
        if (d > 1.0) discard;
        /* 硬い縁のベタ円ではなく、紙に落ちた墨の滲みに */
        float a = exp(-d * d * 2.9);
        /* 色の後追い：着地直後は墨単色、遅れて水彩の色が滲み出す（kasui流） */
        float ink = 0.30;
        vec3 sumi = vec3(ink, ink, ink * 0.96);
        /* 写真へ組み替わるほど、墨ではなく写真そのものの色になる */
        float colored = smoothstep(0.0, 1.0, vSettle) * uColorIn;
        vec3 base = mix(sumi, vColor, colored);
        /* 常に紙の色をいくらか含ませ、真っ黒な粒を作らない（写真側では紙を抜く） */
        vec3 c = mix(base, uBg, 0.18 + vFog * 0.82);
        a *= (1.0 - vFog * 0.88) * vTw * uPanelFade * vNear * vInk * 0.85;
        if (a < 0.015) discard;
        gl_FragColor = vec4(c, a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/* ============================================================
   ワイルドな水彩ウォッシュ
   線画の上（実際は背面レイヤー）に、輪郭を無視した色斑を落とす。
   にじみのテクスチャをCanvasで生成し、スプライトとして配置。
   中心をわざとズラし、サイズも輪郭からはみ出す大きさにする。
============================================================ */
const washTextures = [];
(function makeWashTextures() {
  for (let v = 0; v < 4; v++) {
    const s = 256;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d");
    ctx.translate(s / 2, s / 2);
    /* ぎざぎざの輪郭を持つ低アルファの斑を数層、中心をずらして重ねる */
    for (let layer = 0; layer < 4; layer++) {
      const rBase = s * (0.16 + layer * 0.05);
      ctx.beginPath();
      const N = 20;
      let firstR = 0;
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * Math.PI * 2;
        let r = i === N ? firstR : rBase * (0.55 + Math.random() * 0.9);
        if (i === 0) firstR = r;
        const px = Math.cos(ang) * r;
        const py = Math.sin(ang) * r * (0.7 + Math.random() * 0.3);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = 0.14 + Math.random() * 0.12;
      ctx.fill();
      ctx.translate((Math.random() - 0.5) * s * 0.14, (Math.random() - 0.5) * s * 0.14);
    }
    /* 飛沫 */
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = s * (0.28 + Math.random() * 0.2);
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * d, Math.sin(ang) * d, 1.5 + Math.random() * 4.5, 0, Math.PI * 2);
      ctx.globalAlpha = 0.18 + Math.random() * 0.2;
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    washTextures.push(tex);
  }
})();

/* 全体の彩度・濃度をここで一括調整（上げるほどワイルドに色が乗る） */
const WASH_BOOST = 1.85;

function addWash(x, y, z, size, color, opacity = 0.34, aspect = 0.75) {
  opacity = Math.min(0.95, opacity * WASH_BOOST);
  const m = new THREE.SpriteMaterial({
    map: washTextures[(Math.random() * washTextures.length) | 0],
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    fog: true,
    rotation: Math.random() * Math.PI * 2,
  });
  const sp = new THREE.Sprite(m);
  /* ワイルドさ：中心をずらして輪郭を無視させる。
     Zだけ size に比例しない固定値(±0.25)だったので、色斑が同じ奥行きに
     並んだ薄い一枚板になっていた。XYも含めて size 基準に揃え、奥行きへも
     散らす。斑の個数は増やしていない —— addWash は SpriteMaterial を
     1個ずつ作るので、個数がそのままドローコールになる（実測112斑=112マテリアル）。
     散らばりを広げるのは位置を変えるだけで、描画コストは変わらない */
  sp.position.set(
    x + (Math.random() - 0.5) * size * 1.05,
    y + (Math.random() - 0.5) * size * 0.55,
    z + (Math.random() - 0.5) * size * 0.7
  );
  sp.scale.set(size * (0.85 + Math.random() * 0.5), size * aspect * (0.8 + Math.random() * 0.4), 1);
  sp.renderOrder = -1; /* インクの線・粒より先に描く＝色の上に線が乗る */
  scene.add(sp);
  return sp;
}

/* MeshSurfaceSampler.build() は三角形ごとの面積の累積分布を作る処理で、
   モデルが複雑なほど重い（deadtree 1体で実測131ms）。TRANSIT_OBJECTS は
   同じGLTFを deadtree 13体・fern 5体ぶん並べており、clone してもジオメトリ
   自体は共有されるため、配置のたびに作り直すのは丸ごと無駄だった。
   サンプラーは sample() で内部状態を持たない（毎回ランダムな点を返す）ので、
   ジオメトリ単位で安全に使い回せる。ここが「最長1.7秒のブロック」の実体 */
const surfaceSamplerCache = new WeakMap();
function getSurfaceSampler(mesh) {
  let s = surfaceSamplerCache.get(mesh.geometry);
  if (!s) {
    s = new MeshSurfaceSampler(mesh).build();
    surfaceSamplerCache.set(mesh.geometry, s);
  }
  return s;
}

function sampleGeometryInto(a, geom, count, palette, transform, sizeMin = 0.5, sizeMax = 1.2, dim = 1) {
  const mesh = new THREE.Mesh(geom);
  const sampler = getSurfaceSampler(mesh);
  for (let k = 0; k < count; k++) {
    sampler.sample(_sp, _sn);
    if (transform) {
      _sp.applyMatrix4(transform);
      _sn.transformDirection(transform);
    }
    pushParticle(a, _sp.x, _sp.y, _sp.z, palette, sizeMin, sizeMax, dim, _sn.x, _sn.y, _sn.z);
  }
}
const _q = new THREE.Quaternion();
const _s3 = new THREE.Vector3();
function trs(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) {
  _q.setFromEuler(new THREE.Euler(0, ry, 0));
  _s3.set(sx, sy, sz);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, _s3);
}

/* ============================================================
   情景パネル（線画 ＋ 水彩のミックス）
   北郷さん制作の「線画」と「水彩」を1情景ぶん重ねて空間に立てる。
   - 水彩(背面) は常時うっすら＝色の気配
   - 線画(前面) はカメラが寄るほど濃く結像する（点描DOFと同じ距離連動）
   - 白背景は透過済みなので霧にそのまま溶ける
   - パネルの足元に点描を散らして3D空間と地続きにする
============================================================ */
const texLoader = new THREE.TextureLoader();
const panels = [];
let panelPending = 0;
let sceneReady = false;

/* 情景のコラージュ絵12枚は合計11.8MBあり、初期ダウンロードの過半を
   占めていた（実測18.7MBのうち）。透過付きのwebpで、品質を落としても
   4%しか縮まない一方、解像度を800px幅に落とすと50%減る。
   モバイルは画面幅375〜430pxで、3D空間に映る大きさも画面幅どまりなので
   800pxあれば高DPIでも足りる。デスクトップは原寸のままにして画質を
   落とさない（assets/scenes/m/ に軽量版を置いてある） */
const USE_LIGHT_SCENES = matchMedia("(max-width: 767px)").matches;
function sceneUrl(url) {
  return USE_LIGHT_SCENES ? url.replace("assets/scenes/", "assets/scenes/m/") : url;
}

function loadSceneTex(url) {
  panelPending++;
  const t = texLoader.load(sceneUrl(url), () => { panelPending--; }, undefined, () => { panelPending--; });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 情景パネルを配置。line/wash/photo は白透過済みPNG
   photo（元写真）を下地に、wash（水彩）を重ねると "写真と水彩の中間" になる */
/* 縁を羽化して矩形の枠を消す。skyCut を上げると上部（空）を強めに抜く */
function featherMaterial(mat, skyCut = 0.0) {
  /* uDissolve / uLineFade は既定 0 ＝ 何も起きない。
     写真ページへの遷移でだけ、絵を「描かれる前」へ巻き戻すのに使う。 */
  const u = {
    uSkyCut: { value: skyCut },
    uDissolve: { value: 0 },
    uLineFade: { value: 0 },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = `
      uniform float uSkyCut;
      uniform float uDissolve;
      uniform float uLineFade;
      float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
` + shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
       {
         /* 左右・下端をなだらかにフェード（矩形の縁を消す） */
         float fx = smoothstep(0.0, 0.14, vMapUv.x) * smoothstep(1.0, 0.86, vMapUv.x);
         float fyb = smoothstep(0.0, 0.10, vMapUv.y);
         /* 上端は空をより広く抜く（枠の上辺を消す） */
         float fyt = smoothstep(1.0, 1.0 - 0.10 - uSkyCut, vMapUv.y);
         diffuseColor.a *= fx * fyb * fyt;

         float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         /* ① 鉛筆の線（暗い成分）が先に消える＝「線を引いて、彩色した」制作順の逆再生 */
         if (uLineFade > 0.0) {
           float keep = smoothstep(uLineFade * 0.62 - 0.10, uLineFade * 0.62 + 0.30, lum);
           diffuseColor.a *= mix(1.0, keep, uLineFade);
         }
         /* ② 残った色面が、明るい方から順に分解して光に還る */
         if (uDissolve > 0.0) {
           float n = vnoise(vMapUv * 7.0) * 0.62 + vnoise(vMapUv * 21.0) * 0.38;
           n = n * 0.72 + lum * 0.28;
           diffuseColor.a *= 1.0 - smoothstep(n - 0.14, n + 0.05, uDissolve);
         }
       }`
    );
  };
  mat.needsUpdate = true;
  return mat;
}

/* 点描の生成は dust-worker.js（別スレッド）へ逃がしている。
   画像サンプリングは処理量が大きく、メインスレッドで同期実行すると
   実測で合計10,233ms・最長1,747msのブロックを生んでいた。
   ワーカーが使えない環境（OffscreenCanvas非対応のSafari 16.4未満など）
   では、従来どおりメインスレッドで組む buildDustSync に落ちる。 */
let dustWorker = null;
let dustWorkerUnavailable = false;
let dustReqSeq = 0;
const dustReqs = new Map();

function getDustWorker() {
  if (dustWorkerUnavailable) return null;
  if (dustWorker) return dustWorker;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    dustWorkerUnavailable = true;
    return null;
  }
  try {
    dustWorker = new Worker("dust-worker.js");
    dustWorker.onmessage = (e) => {
      const req = dustReqs.get(e.data.id);
      if (!req) return;
      dustReqs.delete(e.data.id);
      req(e.data);
    };
    /* ワーカー自体が読み込めない／落ちた場合は、以降を同期処理に切り替え、
       返答待ちだったぶんもその場で組み直す（絵が欠けたままにしない） */
    dustWorker.onerror = () => {
      dustWorkerUnavailable = true;
      dustWorker = null;
      const pending = [...dustReqs.values()];
      dustReqs.clear();
      pending.forEach((req) => req({ ok: false, error: "worker error" }));
    };
  } catch (err) {
    dustWorkerUnavailable = true;
    return null;
  }
  return dustWorker;
}

/* 受け取った粒子データからThree.jsのオブジェクトを組む。
   WebGLコンテキストはメインスレッドにあるので、ここだけは移せない */
function applyDust(rec, group, d) { perf("applyDust", () => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(d.pos, 3));
  geo.setAttribute("aScatter", new THREE.BufferAttribute(d.scat, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(d.col, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(d.seed, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(d.sizes, 1));
  geo.setAttribute("aDelay", new THREE.BufferAttribute(d.delay, 1));
  const mat = makeDustMat();
  mat.uniforms.uPr.value = renderer.getPixelRatio();
  dustMats.push(mat);
  const pts = new THREE.Points(geo, mat);
  /* 散らばった居場所（aScatter）＋風の分を境界球に足してから、画面外は描かない */
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += 1.0;
  pts.frustumCulled = true;
  rec.dustPts = pts;
  group.add(pts);
  rec.dustMat = mat;
  rec.dustGeo = geo;
}); }

/* 従来のメインスレッド版。ワーカーが使えない環境向けのフォールバックで、
   アルゴリズムは dust-worker.js 側と完全に同じ（見た目を変えないため） */
/* ワーカーが使えないとき、粒子の枚数をそのまま同期処理に流すと、
   1枚ぶんの生成がまるごとメインスレッドを占有する（この処理は以前
   最長1.7秒ブロックしていて、ワーカーへ逃がした経緯がある）。
   密度を 2600 → 6500 に上げたぶん、フォールバック側は据え置きにする。
   粒がやや疎になるが、数秒フリーズするよりはずっといい */
const SYNC_DUST_CAP = 2600;

function buildDustSync(rec, group, imageUrl, aspect, count, lineUrl, done) {
  count = Math.min(count, SYNC_DUST_CAP);
  let edgeMap = null, emW = 0, emH = 0;
  /* 線画から「輪郭マップ」を作る：輪郭に近い粒子ほど早く着地させるため */
  function buildEdgeMap(cb) {
    if (!lineUrl) { cb(); return; }
    const li = new Image();
    li.onload = () => {
      emW = 170; emH = Math.max(1, Math.round(170 * aspect));
      const lc = document.createElement("canvas");
      lc.width = emW; lc.height = emH;
      const lx = lc.getContext("2d");
      lx.drawImage(li, 0, 0, emW, emH);
      const ld = lx.getImageData(0, 0, emW, emH).data;
      edgeMap = new Float32Array(emW * emH);
      for (let k = 0; k < emW * emH; k++) edgeMap[k] = ld[k * 4 + 3] / 255; /* 線の濃さ */
      cb();
    };
    li.onerror = () => cb();
    li.src = lineUrl;
  }

  const img = new Image();
  img.onload = () => buildEdgeMap(() => {
    const sx = 340, sy = Math.max(1, Math.round(340 * aspect)); /* 細かくサンプル */
    const c = document.createElement("canvas");
    c.width = sx; c.height = sy;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, sx, sy);
    const data = ctx.getImageData(0, 0, sx, sy).data;

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
    applyDust(rec, group, {
      pos: pos.slice(0, idx * 3),
      scat: scat.slice(0, idx * 3),
      col: col.slice(0, idx * 3),
      seed: seed.slice(0, idx),
      sizes: sizes.slice(0, idx),
      delay: delay.slice(0, idx),
    });
    done();
  });
  img.onerror = () => done();
  img.src = imageUrl;
}

/* 情景画像をピクセルサンプリングして、パネルと同じ面に点描を敷く。
   ローカル座標（plane は 1 × aspect）で配置し、group のスケールに乗る。 */
function addSceneDust(rec, group, imageUrl, aspect, count, lineUrl) {
  /* 粒子生成では 340x227 まで縮めてサンプリングするだけなので、
     モバイルでは軽量版（800px幅）で十分。テクスチャ側と同じURLに
     揃えることで、ブラウザのキャッシュも共有できる */
  imageUrl = sceneUrl(imageUrl);
  if (lineUrl) lineUrl = sceneUrl(lineUrl);
  panelPending++;
  let settled = false;
  const done = () => { if (!settled) { settled = true; panelPending--; } };

  const w = getDustWorker();
  if (!w) { buildDustSync(rec, group, imageUrl, aspect, count, lineUrl, done); return; }

  const id = ++dustReqSeq;
  dustReqs.set(id, (msg) => {
    if (msg && msg.ok) { applyDust(rec, group, msg); done(); return; }
    /* ワーカー側で失敗（画像取得エラー等）したぶんは同期処理で組み直す */
    buildDustSync(rec, group, imageUrl, aspect, count, lineUrl, done);
  });
  try {
    w.postMessage({ id, imageUrl, lineUrl: lineUrl || null, aspect, count });
  } catch (err) {
    dustReqs.delete(id);
    buildDustSync(rec, group, imageUrl, aspect, count, lineUrl, done);
  }
}

function addPanel(lineUrl, washUrl, x, y, z, worldWidth, faceTo, opts = {}) {
  const aspect = opts.aspect || 0.666; /* h/w（元画像はおおむね3:2） */
  const geo = new THREE.PlaneGeometry(1, aspect);
  const g = new THREE.Group();

  /* 元写真（最背面・下地）— 空をしっかり抜いて矩形感を消す */
  let photoMat = null;
  if (opts.photoUrl) {
    photoMat = new THREE.MeshBasicMaterial({
      map: loadSceneTex(opts.photoUrl), transparent: true, opacity: 0.0,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    featherMaterial(photoMat, opts.skyCut ?? 0.32);
    g.add(new THREE.Mesh(geo, photoMat));
  }
  /* 水彩（中間・写真の上ににじむ） */
  const washMat = new THREE.MeshBasicMaterial({
    map: loadSceneTex(washUrl), transparent: true, opacity: 0.0, depthWrite: false,
    side: THREE.DoubleSide, fog: true, blending: THREE.NormalBlending,
  });
  featherMaterial(washMat, 0.12);
  const wash = new THREE.Mesh(geo, washMat);
  wash.position.z = 0.01;
  /* 線画（最前面・寄りで結像） */
  const lineMat = new THREE.MeshBasicMaterial({
    map: loadSceneTex(lineUrl), transparent: true, opacity: 0.0, depthWrite: false,
    side: THREE.DoubleSide, fog: true,
  });
  featherMaterial(lineMat, 0.12);
  const line = new THREE.Mesh(geo, lineMat);
  line.position.z = 0.02;
  line.position.x = 0.015;     /* ズラして“はみ出す水彩”の効果 */
  line.position.y = 0.01;

  g.add(wash); g.add(line);
  g.scale.set(worldWidth, worldWidth, 1);
  g.position.set(x, y, z);
  if (faceTo) g.rotation.y = Math.atan2(faceTo.x - x, faceTo.z - z);
  scene.add(g);

  const rec = {
    group: g, washMat, lineMat, photoMat, dustMat: null,
    /* タンポポと同じ「線画＋まばらな粒子」の家族に揃える。
       線画を主役にし、粒子は結合の気配、水彩は淡い色、写真は最後にそっと */
    baseWash: opts.washMax ?? 0.3,
    baseLine: opts.lineMax ?? 0.72,  /* 線画を主役（タンポポのインク線と同格） */
    basePhoto: opts.photoMax ?? 0.4, /* 写真は淡い余韻 */
    near: opts.near ?? 5.5,
    far: opts.far ?? 22,
  };
  panels.push(rec);

  /* 情景の粒子（タンポポと同じ粒子言語）。線画が形を担うので粒子はまばらで良い＝軽い */
  addSceneDust(rec, g, opts.dustUrl || washUrl, aspect, opts.dustCount ?? 10000, lineUrl);

  /* 足元の点描（絵から粒がこぼれて地面へ散る） */
  if (opts.scatter !== false) {
    const a = makeAttrArrays(1400);
    const pal = opts.scatterPalette || P_MOOR;
    const halfW = worldWidth * 0.5;
    const botY = y - worldWidth * aspect * 0.5;
    for (let i = 0; i < 1400; i++) {
      const sx = (Math.random() - 0.5) * worldWidth * 1.1;
      const sy = Math.pow(Math.random(), 2) * worldWidth * aspect * 0.5;
      pushParticle(a,
        x + Math.cos(g.rotation.y) * sx,
        botY + sy,
        z - Math.sin(g.rotation.y) * sx + (Math.random() - 0.5) * 0.4,
        pal, 0.4, 0.95);
    }
    buildPoints(a);
  }
  return g;
}

const _pv = new THREE.Vector3();
function updatePanels() {
  for (const p of panels) {
    _pv.copy(p.group.position).applyMatrix4(camera.matrixWorldInverse);
    const d = -_pv.z;
    /* 遠→近：水彩は早めに立ち上がり、線画は寄って結像 */
    const sm = (k) => k * k * (3 - 2 * k);
    /* ① 結合：遠→近で 0→1（散らばった粒子が非同期に集まる）。
       輪郭先行の窓を全粒子分カバーするため 0→1.4 まで伸ばす */
    const asmRaw = THREE.MathUtils.clamp((p.far - d) / (p.far - p.near), 0, 1);
    const assemble = asmRaw * 1.4;
    /* ② 色の後追い：位置が結合してから少し遅れて水彩色が乗る */
    const colorIn = sm(THREE.MathUtils.clamp((asmRaw - 0.45) / 0.4, 0, 1));
    /* ③ 写真化：最後だけ。ただし上限は 0.7（写真を勝たせすぎない＝AD指示） */
    const photoIn = sm(THREE.MathUtils.clamp((p.near + 3.0 - d) / 3.0, 0, 1));

    if (p.dustMat) {
      p.dustMat.uniforms.uAssemble.value = assemble;
      p.dustMat.uniforms.uColorIn.value = colorIn;
      /* 結合したら濃く、写真が出ても粒子は完全には退かない（記憶を残す） */
      p.dustMat.uniforms.uPanelFade.value = (0.5 + 0.5 * Math.min(1, assemble)) * (1.0 - photoIn * 0.55);
    }
    /* 水彩・線画は結合中の下地／輪郭。写真は 0.7 上限でそっと現れる */
    p.washMat.opacity = p.baseWash * Math.min(1, assemble) * (1.0 - photoIn * 0.4);
    p.lineMat.opacity = p.baseLine * Math.min(1, assemble);
    if (p.photoMat) p.photoMat.opacity = p.basePhoto * photoIn;
  }
}

/* ============================================================
   完成画アートワーク（紙地を抜いた透過PNGを忠実表示）
   四角い枠は無く、繊細な鉛筆線＋淡彩がそのまま霧の世界に浮かぶ。
   遠い＝画像から採った粒子が散らばり、寄る＝画像が忠実に結像。
============================================================ */
const artworks = [];
/* そのカットの引き具合（area.framing）を、絵の結像距離にも反映する。
   faceTo は build() から渡される area.viewPos そのものなので、参照で引き当てる。 */
function framingOf(faceTo) {
  if (!faceTo || typeof AREAS === "undefined") return 1;
  const area = AREAS.find((a) => a.viewPos === faceTo);
  return area && area.framing ? area.framing : 1;
}
function addArtwork(url, x, y, z, worldWidth, faceTo, opts = {}) {
  const aspect = opts.aspect || 0.66;
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    map: loadSceneTex(url), transparent: true, opacity: 0, depthWrite: false,
    side: THREE.DoubleSide, fog: true,
  });
  featherMaterial(mat, 0.02); /* 念のため残った矩形縁を羽化 */
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(1, aspect), mat));
  g.scale.set(worldWidth, worldWidth, 1);
  g.position.set(x, y, z);
  if (faceTo) g.rotation.y = Math.atan2(faceTo.x - x, faceTo.z - z);
  scene.add(g);

  const dist = framingOf(faceTo);
  const rec = {
    group: g, mat, dustMat: null,
    /* どの情景に属する絵か（写真ページへの遷移で「クリックされた層」を特定する） */
    area: (typeof AREAS !== "undefined" && AREAS.find((a) => a.viewPos === faceTo)) || null,
    aspect, baseScale: worldWidth,
    maxOp: opts.maxOp ?? 0.96,
    /* カメラを引いた分だけ結像距離も後退させ、引きでも絵がしっかり見えるようにする */
    near: (opts.near ?? 5.5) * dist,
    far: (opts.far ?? 26) * dist,
  };
  artworks.push(rec);
  /* 画像そのものを点描化して「散らばり→結合」の粒子演出。
     以前は2600に絞ってあった（半透明の点は重なるほど塗り直しになるので、
     枚数がそのまま塗り面積の負荷になる、という理由）。
     ただし実測すると1フレーム4.2ms（1440x810・draw147・points30,210）で、
     60fpsの予算16.7msに対して4倍の余裕があった。絞りすぎで、
     結合前の「散らばり」が薄くなっていたので上げる */
  if (opts.dust !== false) addSceneDust(rec, g, url, aspect, opts.dustCount ?? 6500, url);
  return g;
}

const _pa = new THREE.Vector3();
function updateArtworks() {
  /* 遷移中とギャラリー表示中は、そのタイムラインが濃度を持つので触らない
     （ここで戻すと、還ったはずの絵が写真の上に再結像してしまう） */
  if (typeof transitionActive !== "undefined" && (transitionActive || galleryOpen)) return;
  const sm = (k) => k * k * (3 - 2 * k);
  for (const a of artworks) {
    _pa.copy(a.group.position).applyMatrix4(camera.matrixWorldInverse);
    const d = -_pa.z;
    const kRaw = THREE.MathUtils.clamp((a.far - d) / (a.far - a.near), 0, 1);
    const k = sm(kRaw);            /* near→1：画像が忠実に結像 */
    a.mat.opacity = a.maxOp * k;
    if (a.dustMat) {
      a.dustMat.uniforms.uAssemble.value = kRaw * 1.4;
      a.dustMat.uniforms.uColorIn.value = sm(THREE.MathUtils.clamp((kRaw - 0.4) / 0.4, 0, 1));
      /* 粒子は「集まって形をなす」時にだけ見せる。
         散らばった状態で単体が空中に浮くと、粒子ではなく"ゴミ"に見えるため、
         結合が進むまでは出さない（遠距離＝ほぼ0）。寄って結像したら退く。 */
      /* 指数2.6は「結合が進むまで出さない」ための強い抑制で、
         散らばった状態がほぼ0になっていた。浮遊している粒が見えないのは
         これが効きすぎていたため。1.25まで緩め、遠くでも気配が残るようにする */
      const gather = Math.min(1, kRaw * 1.4);
      const fade = Math.pow(gather, 1.25) * (1.0 - k * 0.7);
      a.dustMat.uniforms.uPanelFade.value = fade;
      /* 透明でも discard までは塗り面積を消費するので、消えている間は描画ごと止める */
      if (a.dustPts) a.dustPts.visible = fade > 0.004;
    }
  }
}

/* ============================================================
   パレット
============================================================ */
const PALETTES = {
  deadtree:   ["#5d564c", "#4a443d", "#6f675c", "#3d3833", "#7d7266"],
  fern:       ["#5d6b4a", "#4a5740", "#6f7d58", "#83926a"],
  gazania:    ["#b3958a", "#9c7d74", "#8a6f66", "#5d6b4a"],
  heliophila: ["#9c8a99", "#837182", "#b3a8b8", "#5d6b4a"],
  ursinia:    ["#b39a6e", "#9c8257", "#c9ae82", "#5d6b4a"],
};
const P_WOOD  = ["#5d564c", "#4a443d", "#6f6357", "#38332e"];
const P_SEA   = ["#a8b3b8", "#93a1a8", "#b9c2c6", "#7d8b93"];
const P_LAMP  = ["#d8b87e", "#e6cf9a", "#c9a45f"];
const P_MOOR  = ["#a8a68b", "#b9b79c", "#8b8a6e", "#c4c2a8", "#8b9678"];
const P_WALL  = ["#6f6759", "#5d564c", "#847b6d", "#8d7358", "#4a453d"];
const P_WIRE  = ["#4a463e", "#5d594f"];
const P_STEM  = ["#7d8a5f", "#93a173", "#66754a"];
const P_FIL   = ["#a8a396", "#b9b4a6", "#93907f"];   /* 綿毛の軸 */
const P_TUFT  = ["#c4bfb0", "#d3cec0", "#a8a396"];   /* 綿毛の先端 */
const P_CORE  = ["#8a7a5f", "#6f6248", "#9c8a6a"];   /* 花托・種 */

/* ============================================================
   GLBスキャン読み込み（Blender製アセット完成時はここに追加）
============================================================ */
const loaderGLTF = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
/* assets/models/min/*.glb は compress-models.mjs が作る圧縮済みアセット。
   EXT_meshopt_compression を必須拡張として持つので、上の setMeshoptDecoder を
   外すと読み込みごと失敗する。非圧縮の原本は assets/models/real/ に残してある */

/* 実際に3D空間へ配置しているのは TRANSIT_OBJECTS（情景と情景のあいだに
   立つ木立）だけで、そこで使うキーは deadtree と fern の2つ。
   花の3件（gazania / heliophila / ursinia）は placeScan から一度も
   参照されないまま、Promise.all で毎回ダウンロードされ、READYの判定
   （loadedCount）にも数えられていた。実測で合計4.0MBの純粋な無駄。
   パレット（PALETTES / WASH_BY_KEY）に名前だけ残してあるのは将来の
   配置に備えたもので、アセット原本も消していない。使うときは
   MODELS_DEFERRED から MODELS へ移すか、到達時のオンデマンド読み込みにする */
const MODELS = {
  deadtree:   "assets/models/min/deadtree.glb",
  fern:       "assets/models/min/fern.glb",
};
/* 現状どこからも配置されていない。初期ロードには含めない */
const MODELS_DEFERRED = {
  gazania:    "assets/models/min/gazania.glb",
  heliophila: "assets/models/min/heliophila.glb",
  ursinia:    "assets/models/min/ursinia.glb",
};
const loaded = {};
let loadedCount = 0;
const totalCount = Object.keys(MODELS).length;

function loadModel(key, url) {
  return new Promise((resolve) => {
    /* 以前はここで .gltf を fetch してJSONを書き換え、texture参照を剥がしてから
       parse() に渡していた。placeScan() は geometry を MeshSurfaceSampler で
       サンプリングするだけで material も texture も見ないのに、GLTFLoader が
       法線・拡散色・ラフネスの画像（1モデル3枚）まで自動で取りに行き、
       5モデル合計7.7MiB・15リクエストが完全に無駄になっていたため。
       いまは compress-models.mjs がビルド時に material ごと落としているので、
       素直に load() で読める */
    loaderGLTF.load(
      url,
      (gltf) => { loaded[key] = gltf.scene; loadedCount++; resolve(); },
      undefined,
      () => { trackEvent("asset_load_error", { type: "model_load", key }); loadedCount++; resolve(); }
    );
  });
}

const GROUND_Y = -1.5;

/* スキャン系オブジェクト用のウォッシュ配色 */
const WASH_BY_KEY = {
  deadtree:   ["#a08a72", "#8ba3ad", "#b3a86e"],
  fern:       ["#7d8a5f", "#9aab7c", "#5d6b4a"],
  gazania:    ["#c98d7a", "#b3958a", "#9aab7c"],
  heliophila: ["#9c8a99", "#8ba3ad", "#9aab7c"],
  ursinia:    ["#c9a45f", "#b3a86e", "#9aab7c"],
};

/* GLBを正規化して粒子化（mirror=水鏡、palette=色上書き） */
/* スキャン原本はどれも横倒しで保存されている（長辺はすべてX軸）:
     deadtree   3.05 x 0.29 x 0.28   fern       1.97 x 0.43 x 1.72
     gazania    1.48 x 0.17 x 0.70   heliophila 2.75 x 0.40 x 1.41
     ursinia    2.19 x 0.17 x 0.34
   placeScan は scale = height / size.y で高さを揃えるので、横倒しのままだと
   短辺(deadtree で0.29)を基準に14.5倍へ拡大され、シーン内で
   39.5 x 4.1 x 26.4 まで広がる。

   これを「木立が経路を横切る帯になっている不具合」と読んで、一度
   Z軸90度で起こした（5e13381）。だが起こすと 0.4 x 4.2 x 0.4 の細い柱に
   なり、枝の無い幹1本では点が縦に並んだ棒にしか見えなかった（0802750で削除）。

   実際には、横倒しのまま広がった状態こそが目的の絵だった。
   高さ4.1はカメラの目線(y=1.5)を含み、630粒が広い体積に散らばるので、
   木ではなく「3D空間を漂う粒子」として効いていた。視差もそこで生まれる。
   起こさない。 */

function placeScan(key, x, z, height, count, rotY = 0, opts = {}) {
  const pal = opts.palette || PALETTES[key] || P_TUFT;
  const src = loaded[key];
  if (!src) return null;
  /* 粒の大きさの倍率。点サイズのシェーダ（gl_PointSize）は綿毛と共用で、
     綿毛は近距離なので上限 uPr*5.2 に張り付いている。そちらを変えずに
     道中の粒だけ大きくしたいので、生成時の aSize を倍率で持ち上げる。
     道中の常用距離（15〜30）では 17.0/dist が 0.57〜1.13 にしかならず、
     素の 0.55〜1.4 だと 0.3〜1.6px でほぼ画面に乗らない */
  const grain = opts.grain ?? 1;
  const model = src.clone(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = height / Math.max(0.0001, size.y);
  model.scale.setScalar(scale);
  box.setFromObject(model);
  const center = new THREE.Vector3();
  box.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);

  const meshes = [];
  model.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const triCounts = meshes.map((m) =>
    m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3
  );
  const totalTri = triCounts.reduce((s, b) => s + b, 0) || 1;

  const mirror = !!opts.mirror;
  const a = makeAttrArrays(count * (mirror ? 2 : 1));
  meshes.forEach((m, i) => {
    const n = Math.max(1, Math.round((count * triCounts[i]) / totalTri));
    const sampler = getSurfaceSampler(m);
    for (let k = 0; k < n && a.idx < count; k++) {
      sampler.sample(_sp, _sn);
      _sp.applyMatrix4(m.matrixWorld);
      _sn.transformDirection(m.matrixWorld);
      pushParticle(a, _sp.x, _sp.y, _sp.z, pal, 0.55 * grain, 1.4 * grain, 1, _sn.x, _sn.y, _sn.z);
    }
  });
  if (mirror) {
    const upto = a.idx;
    for (let i = 0; i < upto; i += 2) {
      pushParticle(a,
        a.pos[i * 3] + (Math.random() - 0.5) * 0.06,
        -a.pos[i * 3 + 1] - 0.04,
        a.pos[i * 3 + 2] + (Math.random() - 0.5) * 0.06,
        pal, 0.4, 0.9, 0.55);
    }
  }
  /* ハッチング：表面の接線方向（縦寄り）に短いインクのストロークを引く
     — ペン画の毛描きと同じで、形の流れが線として立ち上がる */
  const strokeN = opts.strokes ?? Math.round(count / 14);
  if (strokeN > 0 && meshes.length) {
    const linePts = [];
    const up = new THREE.Vector3(0, 1, 0);
    const tan = new THREE.Vector3();
    const per = Math.ceil(strokeN / meshes.length);
    meshes.forEach((m) => {
      const sampler = getSurfaceSampler(m);
      for (let k = 0; k < per; k++) {
        sampler.sample(_sp, _sn);
        _sp.applyMatrix4(m.matrixWorld);
        _sn.transformDirection(m.matrixWorld);
        /* 接平面上で最も上向きの方向＝幹や葉の流れ */
        tan.copy(up).addScaledVector(_sn, -up.dot(_sn));
        if (tan.lengthSq() < 0.05) tan.set(Math.random() - 0.5, 0.2, Math.random() - 0.5);
        tan.normalize();
        const len = height * (0.03 + Math.random() * 0.06);
        strokeCurve(linePts,
          jit(_sp.x - tan.x * len, 0.008), jit(_sp.y - tan.y * len, 0.008), jit(_sp.z - tan.z * len, 0.008),
          jit(_sp.x + tan.x * len, 0.008), jit(_sp.y + tan.y * len, 0.008), jit(_sp.z + tan.z * len, 0.008),
          len * 0.35, 3);
      }
    });
    const lines = buildLines(linePts, INK_SCAN);
    if (lines) {
      lines.position.set(x, GROUND_Y, z);
      lines.rotation.y = rotY;
    }
  }
  /* このオブジェクト自身にワイルドな色斑を乗せる（全スキャン共通） */
  if (opts.wash !== false) {
    const pal = WASH_BY_KEY[key] || ["#9aab7c", "#a08a72"];
    const nWash = Math.max(3, Math.round(height * 1.2));
    for (let w = 0; w < nWash; w++) {
      addWash(x, GROUND_Y + height * (0.25 + Math.random() * 0.55), z,
        height * (0.7 + Math.random() * 0.6),
        pal[(Math.random() * pal.length) | 0],
        0.16 + Math.random() * 0.08);
    }
  }
  const points = buildPoints(a);
  points.position.set(x, GROUND_Y, z);
  points.rotation.y = rotY;
  return points;
}

function addPickProxy(x, z, w, h, d) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  m.position.set(x, GROUND_Y + h / 2, z);
  scene.add(m);
  return m;
}

/* ============================================================
   タンポポ（プロシージャル・写実比率）
   細い茎 → 花托 → 放射する種毛の軸 → 先端の冠毛
============================================================ */
/* タンポポ（実物の解剖構造）
   茎 → 花托 → 柄(beak)が放射 → 柄の先端でパラシュート状の冠毛が開く
   球のアウトラインは「無数のパラシュートの縁」が自然に形成する */
const _du = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _dd = new THREE.Vector3();
function makeDandelion(x, z, stalkH, headR, filN, group = null) {
  const a = makeAttrArrays(filN * 10 + 60);
  const stemPts = [];
  const beakPts = [];
  const hairPts = [];

  /* group時はローカル原点(0,0,0・base y=0)で組み、世界位置は group に持たせる
     （絶対座標を焼き込まず、基点から成長スケールできるようにする） */
  const worldX = x, worldZ = z;
  const by0 = group ? 0 : GROUND_Y;
  if (group) { x = 0; z = 0; }

  /* 茎：ゆるいS字 */
  const bend = (Math.random() - 0.5) * 0.35;
  const SEG = 10;
  for (let k = 0; k < SEG; k++) {
    const t0 = k / SEG, t1 = (k + 1) / SEG;
    stemPts.push(
      jit(x + bend * t0 * t0, 0.004), by0 + t0 * stalkH, jit(z + bend * 0.3 * Math.sin(t0 * 2.4), 0.004),
      jit(x + bend * t1 * t1, 0.004), by0 + t1 * stalkH, jit(z + bend * 0.3 * Math.sin(t1 * 2.4), 0.004)
    );
  }
  const cx = x + bend, cy = by0 + stalkH, cz = z + bend * 0.3 * Math.sin(2.4);

  /* 花托：小さな球 */
  for (let k = 0; k < 36; k++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    const r = headR * 0.08 * Math.cbrt(Math.random());
    pushParticle(a,
      cx + Math.sin(ph) * Math.cos(th) * r,
      cy + Math.cos(ph) * r,
      cz + Math.sin(ph) * Math.sin(th) * r,
      P_CORE, 0.5, 0.9);
  }

  for (let f = 0; f < filN; f++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    _dd.set(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
    /* 柄（beak）：中心から放射する細い曲線 */
    const r0 = headR * 0.1;
    const r1 = headR * 0.66 * (0.95 + Math.random() * 0.1);
    strokeCurve(beakPts,
      cx + _dd.x * r0, cy + _dd.y * r0, cz + _dd.z * r0,
      cx + _dd.x * r1, cy + _dd.y * r1, cz + _dd.z * r1,
      headR * 0.035, 3);
    /* 柄と直交する基底（冠毛の傘を張るため） */
    _du.set(-_dd.z, 0, _dd.x);
    if (_du.lengthSq() < 0.01) _du.set(1, 0, 0);
    _du.normalize();
    _dv.crossVectors(_dd, _du);
    /* パラシュート：先端から放射状に開く冠毛（外向き＋わずかに前傾） */
    const bx2 = cx + _dd.x * r1, by2 = cy + _dd.y * r1, bz2 = cz + _dd.z * r1;
    const hairs = 7 + ((Math.random() * 3) | 0);
    for (let h = 0; h < hairs; h++) {
      const ang = (h / hairs) * Math.PI * 2 + Math.random() * 0.5;
      const tilt = 0.42 + Math.random() * 0.22; /* 前傾角：傘の開き */
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const hx = (_du.x * ca + _dv.x * sa) * ct + _dd.x * st;
      const hy = (_du.y * ca + _dv.y * sa) * ct + _dd.y * st;
      const hz = (_du.z * ca + _dv.z * sa) * ct + _dd.z * st;
      const hl = headR * (0.24 + Math.random() * 0.07);
      strokeCurve(hairPts, bx2, by2, bz2,
        bx2 + hx * hl, by2 + hy * hl, bz2 + hz * hl,
        headR * 0.02, 2);
      /* 毛先のごく小さな綿 */
      if (h % 2 === 0) {
        pushParticle(a,
          bx2 + hx * hl, by2 + hy * hl, bz2 + hz * hl,
          P_TUFT, 0.25, 0.45, 1, _dd.x, _dd.y, _dd.z);
      }
    }
  }
  const l1 = buildLines(stemPts, INK_STEM);
  const l2 = buildLines(beakPts, INK_FIL);
  const l3 = buildLines(hairPts, INK_HAIR);
  /* ワイルドな水彩：綿球に淡い青灰とセージ、茎の根元に緑を走らせる */
  const w1 = addWash(cx, cy, cz, headR * 3.4, "#8ba3ad", 0.22);
  const w2 = addWash(cx, cy - headR * 0.3, cz, headR * 2.6, "#9aab7c", 0.2);
  const w3 = addWash(x, by0 + stalkH * 0.25, z, stalkH * 0.9, "#7d8a5f", 0.2, 1.1);
  const pts = buildPoints(a);
  /* group が渡されたら全パーツをそこへ集約（ローカル原点で組んであるので
     そのまま reparent。group.position を株元に置き、scaleで基点から成長） */
  if (group) {
    group.position.set(worldX, GROUND_Y, worldZ);
    for (const o of [l1, l2, l3, pts, w1, w2, w3]) {
      if (o) group.add(o); /* scene から reparent（座標は既にローカル） */
    }
  }
  return pts;
}

/* ============================================================
   手続き木（タンポポと同じ描画言語：手描きインク枝＋点描）
   GLB・PNGは使わず、strokeCurve の再帰分岐で樹形を描く。
   水面の下に線をミラーして水鏡の映り込みを作る。
============================================================ */
const INK_REFL = makeLineMat("#9c968a", 0.9, 0.28); /* 水鏡の映り込み（淡い） */
function makeInkTree(x, z, h, opts = {}) {
  const waterY = opts.waterY ?? GROUND_Y;
  const trunk = [], twig = [], tips = [];
  function branch(bx, by, bz, dx, dy, dz, len, depth) {
    const jx = len * 0.06;
    const ex = bx + dx * len, ey = by + dy * len, ez = bz + dz * len;
    const arr = depth < 2 ? trunk : twig;
    strokeCurve(arr, bx, by, bz, jit(ex, jx), jit(ey, jx), jit(ez, jx), len * 0.13, depth < 2 ? 3 : 2);
    if (depth >= 4 || len < 0.16) { tips.push([ex, ey, ez]); return; }
    const nb = depth === 0 ? 3 : (Math.random() < 0.45 ? 3 : 2);
    const spread = 0.5 + depth * 0.2;
    for (let i = 0; i < nb; i++) {
      let ndx = dx + (Math.random() - 0.5) * spread;
      let ndy = dy + (Math.random() - 0.5) * spread * 0.4 + 0.1; /* 上向きバイアス */
      let ndz = dz + (Math.random() - 0.5) * spread;
      const l = Math.hypot(ndx, ndy, ndz) || 1;
      branch(ex, ey, ez, ndx / l, ndy / l, ndz / l, len * (0.62 + Math.random() * 0.16), depth + 1);
    }
  }
  branch(x, GROUND_Y, z, (Math.random() - 0.5) * 0.12, 1, (Math.random() - 0.5) * 0.12, h * 0.4, 0);

  /* 梢の綿（霧・葉の気配）＝淡い単色の点描 */
  const FOL = ["#b0aca2", "#9c988e", "#c4c0b6", "#8a857a"];
  const a = makeAttrArrays(tips.length * 6 + 40);
  for (const [tx, ty, tz] of tips) {
    for (let k = 0; k < 6; k++) {
      pushParticle(a, tx + (Math.random() - 0.5) * 0.3, ty + (Math.random() - 0.5) * 0.3, tz + (Math.random() - 0.5) * 0.3, FOL, 0.3, 0.7);
    }
  }
  buildPoints(a);

  /* 水鏡：線を waterY で上下反転＋横に微ゆらぎ、淡いインクで */
  const reflect = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += 3) out.push(jit(arr[i], 0.03), 2 * waterY - arr[i + 1], arr[i + 2]);
    return out;
  };
  buildLines(trunk, INK_STEM);
  buildLines(twig, INK_HAIR);
  buildLines(reflect(trunk).concat(reflect(twig)), INK_REFL);
  const ra = makeAttrArrays(tips.length * 3 + 20);
  for (const [tx, ty, tz] of tips) {
    for (let k = 0; k < 3; k++) {
      pushParticle(ra, tx + (Math.random() - 0.5) * 0.3, 2 * waterY - ty + (Math.random() - 0.5) * 0.25, tz + (Math.random() - 0.5) * 0.3, FOL, 0.25, 0.55, 0.5);
    }
  }
  buildPoints(ra);
}

/* ============================================================
   画像 → 手描きインク（写真の情景を、タンポポと同じインク線で引き直す）
   線画PNGを「線の在り処」のガイドにだけ使い、実描画は strokeCurve。
   Sobelで線の向きを求め、そのタンジェント方向に短いインクを敷く。
   → 内容は写真に忠実、トーンはタンポポと同一。
============================================================ */
const INK_IMG = makeLineMat("#7d766c", 0.7, 0.42);       /* 極細・淡色の鉛筆線 */
const INK_IMG_REFL = makeLineMat("#a8a196", 0.7, 0.2);  /* 水鏡（さらに淡く） */
function makeInkFromImage(lineUrl, x, y, z, worldWidth, faceTo, opts = {}) {
  panelPending++;
  const img = new Image();
  img.onload = () => {
    const sw = 300, sh = Math.max(1, Math.round(300 * (img.height / img.width)));
    const aspect = sh / sw;
    const c = document.createElement("canvas");
    c.width = sw; c.height = sh;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh).data;
    const A = (px, py) => {
      if (px < 0 || py < 0 || px >= sw || py >= sh) return 0;
      return d[(py * sw + px) * 4 + 3] / 255;
    };
    const linePts = [];
    const dust = makeAttrArrays(3000);
    const strokeTarget = opts.strokes ?? 7000;
    const dpx = 1 / sw;                 /* ローカル1px */
    const slen = 2.4 * dpx;             /* ストローク長 */
    let tries = 0;
    while (linePts.length < strokeTarget * 12 && tries < strokeTarget * 8) {
      tries++;
      const px = (Math.random() * sw) | 0, py = (Math.random() * sh) | 0;
      const a0 = A(px, py);
      if (a0 < 0.25) continue;
      /* Sobel 勾配 → 線のタンジェント（勾配に直交） */
      const gx = (A(px + 1, py - 1) + 2 * A(px + 1, py) + A(px + 1, py + 1))
               - (A(px - 1, py - 1) + 2 * A(px - 1, py) + A(px - 1, py + 1));
      const gy = (A(px - 1, py + 1) + 2 * A(px, py + 1) + A(px + 1, py + 1))
               - (A(px - 1, py - 1) + 2 * A(px, py - 1) + A(px + 1, py - 1));
      let tx = -gy, ty = gx;
      const tl = Math.hypot(tx, ty);
      if (tl < 0.15) { tx = Math.random() - 0.5; ty = Math.random() - 0.5; }
      else { tx /= tl; ty /= tl; }
      /* ローカル平面座標（-0.5..0.5, ±aspect/2）。y は画像上下反転 */
      const u = px / sw, v = py / sh;
      const lx = u - 0.5, ly = (0.5 - v) * aspect;
      const zz = (Math.random() - 0.5) * 0.01;
      strokeCurve(linePts,
        lx - tx * slen, ly + ty * slen, zz,
        lx + tx * slen, ly - ty * slen, zz,
        slen * 0.5, 2);
      /* 濃い線上にたまに淡い点描（面の気配） */
      if (dust.idx < 3000 && Math.random() < 0.18) {
        pushParticle(dust, lx + (Math.random() - 0.5) * 0.01, ly + (Math.random() - 0.5) * 0.01, zz,
          ["#b0aca2", "#9c988e", "#8a857a"], 0.3, 0.6);
      }
    }
    const rotY = faceTo ? Math.atan2(faceTo.x - x, faceTo.z - z) : 0;
    const g = new THREE.Group();
    g.scale.set(worldWidth, worldWidth, worldWidth);
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    const lines = buildLines(linePts, INK_IMG);
    if (lines) { lines.position.set(0, 0, 0); g.add(lines); }
    g.add(buildPoints(dust));

    /* 水鏡：waterY を基準に上下反転した淡い複製（ローカルで反転） */
    if (opts.waterY !== undefined) {
      const localWater = (opts.waterY - y) / worldWidth; /* group内ローカルの水面 */
      const refl = [];
      for (let i = 0; i < linePts.length; i += 3) {
        refl.push(jit(linePts[i], 0.006), 2 * localWater - linePts[i + 1], linePts[i + 2]);
      }
      const rl = buildLines(refl, INK_IMG_REFL);
      if (rl) { rl.position.set(0, 0, 0); g.add(rl); }
    }
    scene.add(g);
    panelPending--;
  };
  img.onerror = () => { panelPending--; };
  img.src = lineUrl;
}

/* 綿毛（ガイド）：種ひとつ＋放射する冠毛。毎フレーム経路の先を浮遊 */
/* 綿毛（単体の種）＝ 種 → 細長い柄(beak) → 頂点で水平に開く傘（冠毛） */
function makeFluff() {
  const g = new THREE.Group();
  const a = makeAttrArrays(160);
  const beak = [];
  const hairs = [];
  /* 種：下端の細長い塊 */
  for (let k = 0; k < 14; k++) {
    pushParticle(a,
      (Math.random() - 0.5) * 0.012,
      -0.27 - Math.random() * 0.05,
      (Math.random() - 0.5) * 0.012,
      P_CORE, 0.55, 0.9);
  }
  /* 柄：種から頂点までの一本の細い線 */
  strokeCurve(beak, 0, -0.27, 0, 0, 0, 0, 0.014, 3);
  /* 傘：頂点から放射する冠毛（水平よりわずかに上向き） */
  const N = 16;
  for (let h = 0; h < N; h++) {
    const ang = (h / N) * Math.PI * 2 + Math.random() * 0.3;
    const tilt = 0.12 + Math.random() * 0.22; /* 水平からの持ち上がり */
    const dx = Math.cos(ang) * Math.cos(tilt);
    const dy = Math.sin(tilt);
    const dz = Math.sin(ang) * Math.cos(tilt);
    const hl = 0.16 + Math.random() * 0.03;
    strokeCurve(hairs, 0, 0, 0, dx * hl, dy * hl, dz * hl, 0.012, 2);
    pushParticle(a, dx * hl, dy * hl, dz * hl, P_TUFT, 0.3, 0.5, 1, dx, dy, dz);
  }
  g.add(buildLines(beak, INK_FIL));
  g.add(buildLines(hairs, INK_HAIR));
  g.add(buildPoints(a));
  /* 綿毛にも淡い青灰の色斑を（グループの子として一緒に浮遊させる） */
  const wm = new THREE.SpriteMaterial({
    map: washTextures[0], color: new THREE.Color("#8ba3ad"),
    transparent: true, opacity: 0.3, depthWrite: false, fog: true,
  });
  const wsp = new THREE.Sprite(wm);
  wsp.scale.set(0.5, 0.42, 1);
  wsp.renderOrder = -1;
  g.add(wsp);
  /* 見え隠れ用にマテリアルを保持（元の濃度を覚えておく） */
  const mats = [];
  g.traverse((o) => {
    if (!o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (m.userData.baseOp === undefined) m.userData.baseOp = m.opacity ?? 1;
      m.transparent = true;
      mats.push(m);
    }
  });
  g.userData.mats = mats;
  scene.add(g);
  return g;
}

/* ---------- 背景ループ動画（読み込めた時だけ表示） ---------- */
(function initBgVideo() {
  const v = document.getElementById("bgVideo");
  if (!v) return;
  /* CSSでdisplay:noneの間（experience.html参照）は使っていない。
     ここで早期returnしないと、pointerdownのresumeがv.play()を呼び、
     preload="none"を指定していても最初のクリックで7.4MBが読み込まれてしまう */
  if (getComputedStyle(v).display === "none") return;
  /* 軽量な動画はこのスクリプトより先に読み込み終わることがある */
  if (v.readyState >= 2) v.setAttribute("data-ok", "1");
  v.addEventListener("loadeddata", () => v.setAttribute("data-ok", "1"));
  v.addEventListener("error", () => v.removeAttribute("data-ok"), true);
  /* タブ復帰・初回操作時に自動再生が止まっていたら再開する */
  const resume = () => { if (v.paused) v.play().catch(() => {}); };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pointerdown", resume, { once: true });
})();

/* ---------- 水彩紙テクスチャ ---------- */
function makeCanvas(size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d")];
}
(function makePaper() {
  const s = 512;
  const [c, ctx] = makeCanvas(s);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const ang = Math.random() * Math.PI, l = 2 + Math.random() * 7;
    ctx.strokeStyle = "#c9c6bf";
    ctx.globalAlpha = 0.05 + Math.random() * 0.08;
    ctx.lineWidth = 0.6 + Math.random() * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * l, y + Math.sin(ang) * l);
    ctx.stroke();
  }
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const r = 1 + Math.random() * 3.2;
    ctx.fillStyle = Math.random() < 0.5 ? "#d8d5ce" : "#f4f2ec";
    ctx.globalAlpha = 0.05 + Math.random() * 0.09;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const el = document.getElementById("paperFx");
  if (el) el.style.backgroundImage = `url(${c.toDataURL("image/png")})`;
})();

/* ============================================================
   カメラ経路
============================================================ */
/* 各情景の viewPos を順に通す長い経路（導線を伸ばして間をとる）
   ABOUT→PLANTS→LANDSCAPES→ARCHITECTURES→SNAPS→ABSTRACTS→EXHIBITIONS→CONTACT */
/* モバイルは画角を広げてある（FOV最大84°、PC比で約2倍）ため、
   同じカメラ距離でも被写体が遠く小さく見えてしまう。旅の起点（TOP画面、
   綿毛の接写がこのサイトの導入の要）だけは、モバイルでカメラを寄せて
   画角差を打ち消し、狙った"寄り"の見え方を保つ */
const MOBILE_LAYOUT = innerWidth <= 767;
/* 操作ヒントの文言分岐用。画面幅ではなく実際の入力方式で判定する
   （タッチ対応の広い画面もあるため）。pointer:coarseだけだと、
   タッチ対応ノートPC等のhybrid端末（主入力はマウスでもタッチも使える）を
   取りこぼすことがあるため、maxTouchPointsも合わせて見る */
const IS_TOUCH = matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints || 0) > 0;
/* ?debug=1 / ?trailer=1 は開発中の内部確認用。本番ドメインでも
   誰でもURLに付けるだけで発火してしまうと、window.__xp経由で
   内部stateが覗けたり、trailerモードが900フレームぶんの
   レンダリング＋POSTを閲覧者のブラウザに走らせてしまう。
   ローカル開発時（localhost / 127.0.0.1）だけ許可する */
const DEV_TOOLS_ALLOWED = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/* 計測の受け口。今はまだ計測サービスを何も導入していない（無料/課金なしの
   縛りがあるため軽率に外部サービスへ登録できない）ので、この関数の中身だけ
   差し替えれば呼び出し側は変更不要になるよう、イベント名＋最小限のデータ
   という素直な形に統一しておく。window.dataLayer（GA4/GTM互換）が存在すれば
   そこにも積む。PII（メールアドレス本文や氏名等）は載せない */
function trackEvent(name, data) {
  if (window.dataLayer) window.dataLayer.push({ event: name, ...data });
  if (DEV_TOOLS_ALLOWED) console.debug("[track]", name, data || "");
}

const curve = new THREE.CatmullRomCurve3(
  [
    new THREE.Vector3(0, 1.6, MOBILE_LAYOUT ? 5.6 : 8), // 起点（冒頭のうしろ）
    new THREE.Vector3(0.5, 1.6, -11),   // ABOUT
    new THREE.Vector3(-2.4, 1.4, -25),  // PLANTS
    new THREE.Vector3(2.6, 1.7, -42),   // LANDSCAPES
    new THREE.Vector3(-2.6, 1.7, -59),  // ARCHITECTURES
    new THREE.Vector3(1.6, 1.5, -75),   // SNAPS
    new THREE.Vector3(-2.2, 1.6, -91),  // ABSTRACTS
    new THREE.Vector3(2.3, 1.5, -107),  // EXHIBITIONS
    new THREE.Vector3(0.3, 1.4, -125),  // CONTACT
  ],
  false, "catmullrom", 0.5
);

/* ============================================================
   世界のベース（散らばって浮遊する粒子の野原だけ。柵・草は無し）
============================================================ */
function buildWorldBase() {
  /* 空中に浮かせると"埃"に見える。地面に貼り付く霞として低く・小さく・少なく敷く */
  const N = 2100;
  const a = makeAttrArrays(N);
  for (let i = 0; i < N; i++) {
    const x = (Math.random() - 0.5) * 30;
    const z = 8 - Math.random() * 138;
    const y = GROUND_Y + Math.pow(Math.random(), 3.0) * 0.45;
    pushParticle(a, x, y, z, P_MOOR, 0.22, 0.5);
  }
  buildPoints(a);
}

/* 情景と情景の"あいだ"に立つオブジェクト（霧の中の枯れ木・シダ）。
   速度は絶対値では知覚できず、手前と奥が違う速さで流れることでしか感じられない。
   3D空間に置くので視差は物理的に正しく発生し、実装済みの緩急が初めて"見える"ようになる。
   手前層＝経路に近く大きい（速く流れる）／奥層＝遠く高い（ゆっくり流れる）の2層構成。 */
const TRANSIT_OBJECTS = [
  /* [key, x, z, height]  ― 手前層（経路の左右3〜8）*/
  ["deadtree", -5.5,  -5,  4.2], ["fern",      4.8,  -9,  1.1],
  ["deadtree",  5.5, -20,  3.6], ["deadtree", -7.5, -25,  4.8],
  ["fern",     -6.5, -36,  1.3], ["deadtree",  7.5, -41,  4.0],
  ["deadtree",  8.0, -52,  3.4], ["deadtree", -8.5, -58,  5.0],
  ["fern",     -7.0, -69,  1.2], ["deadtree",  6.5, -75,  3.8],
  ["deadtree", -6.0, -85,  4.4], ["fern",      5.0, -90,  1.0],
  /* EXHIBITIONS(x=7.5, z=-112)の単体コラージュの視界に重ならないよう、
     この区間だけ木々を絵の反対側(x負)へ寄せる（正面に重なると点描が絵の上のノイズに見える）*/
  ["deadtree", -7.5, -99,  4.0], ["fern",     -6.5, -104, 1.3],
  ["deadtree", -8.0, -115, 4.8], ["deadtree", -6.5, -120, 3.6],
  ["fern",     -9.5, -124, 1.1],
  /* 奥層（遠く高い＝ゆっくり流れて奥行きを作る）*/
  ["deadtree", -13.0, -16, 6.0], ["deadtree", -14.0, -46, 6.5],
  ["deadtree",  13.0, -72, 6.0], ["deadtree", -13.5, -108, 6.2],
];
/* 20個のTRANSIT_OBJECTS全てを1フレームで処理すると、placeScan内部の
   MeshSurfaceSampler構築（三角形面積の累積分布を作る、モデルの複雑さに
   比例して重い処理）が同期的に積み重なり、5モデルの読み込み完了直後に
   メインスレッドが数百ms単位でブロックされてカクついていた。
   1フレームあたり数個ずつに分割し、rAFを挟んで処理を逃がす */
function buildTransitObjects(onDone) {
  let i = 0;
  const BATCH = 3;
  function step() {
    const end = Math.min(TRANSIT_OBJECTS.length, i + BATCH);
    for (; i < end; i++) {
      const [key, x, z, h] = TRANSIT_OBJECTS[i];
      /* ハッチング線は入れない（strokes: 0）。
         遠景で線を引くと、木の形にならず"短い線の断片"が空中に散らばって見える。
         霧に沈むシルエットは、密度を上げた点描だけのほうが静かで美しい。 */
      /* 霧に沈むシルエットなので、粒の密度は見た目にほとんど効かない。
         常に十数本が視界の前後にいる＝ここが総量に一番効く */
      /* 空中に漂う量。元は 高さ×150・粒の大きさ等倍。
         「あと少し欲しい」ぶん、数と粒の大きさを両方上げてある */
      perf("placeScan:" + key, () => placeScan(key, x, z, h, Math.round(h * 320), Math.random() * Math.PI * 2, { strokes: 0, grain: 1.12 }));
    }
    if (i < TRANSIT_OBJECTS.length) requestAnimationFrame(step);
    else if (onDone) onDone();
  }
  step();
}

/* ============================================================
   ヒーロー：一輪のタンポポ（マクロの主役）
============================================================ */
const HERO_HEAD = new THREE.Vector3(0.7, GROUND_Y + 2.9, 3.2);
function buildHero() {
  makeDandelion(0.7, 3.2, 2.9, 0.5, 220);
  makeDandelion(1.6, 2.4, 1.9, 0.3, 130);
  makeDandelion(-0.4, 2.2, 1.5, 0.24, 110);
}


/* ============================================================
   エリア定義（綿毛の旅の順路）
   PLANTS → LANDSCAPES → ARCHITECTURES → SNAPS → ABSTRACTS → EXHIBITIONS → CONTACT
============================================================ */
const AREAS = [
  {
    /* ABOUT：冒頭のあと・PLANTSの前。自己紹介の固定カット（岩場の完成画＋バイオ） */
    name: "ABOUT", num: "", t: 0.150, isAbout: true,
    center: new THREE.Vector3(4.0, 1.2, -15),
    viewPos: new THREE.Vector3(1.0, 1.65, -9.8), /* ほんの少し引き */
    hotspot: "",
    lines: [],
    build() {
      /* ここだけ日英のバイオ全文が絵の全面に重なる。他の情景は詩の
         1〜2行なので絵を濃く出せるが、ABOUTは 0.92 のままだと
         英文（11.8px）が岩場のドローイングに埋もれて読めなかった。
         ハローを足すより地を引くほうが確実。サイト内の maxOp は
         0.6〜1.0 の幅があり、0.75 はその中間 */
      addArtwork("assets/scenes/about_art.webp",
        4.0, GROUND_Y + 2.7, -15, 8.6, this.viewPos, { aspect: 0.668, maxOp: 0.75, near: 8, far: 30 });
      this.object = addPickProxy(4.0, -15, 7.2, 5.0, 3.0);
    },
  },
  {
    name: "PLANTS", num: "01", t: 0.267,
    center: new THREE.Vector3(-6.5, 0.9, -30),
    viewPos: new THREE.Vector3(-1.6, 1.6, -24.2), /* ほんの少しアップ（前回の引きすぎを戻す） */
    hotspot: "View the series",
    lines: ["最も静かな被写体、", "最も雄弁な生命。"],
    /* 北郷さんの実写。題は1枚ずつ実物を見て付けている（年号は入れない） */
    photos: [
      ["assets/photos/plants/plants-01.jpg", "White Yarrow, Meadow"],
      ["assets/photos/plants/plants-02.jpg", "Seedheads, Wide Plateau"],
      ["assets/photos/plants/plants-03.jpg", "Dew on Blades"],
      ["assets/photos/plants/plants-04.jpg", "Gentian Bud"],
      ["assets/photos/plants/plants-05.jpg", "Tulips, Dark Ground"],
      ["assets/photos/plants/plants-06.jpg", "Wild Daisies Adrift"],
      ["assets/photos/plants/plants-07.jpg", "Clematis Seed Head"],
      ["assets/photos/plants/plants-08.jpg", "Silver Grass Against the Sun"],
      ["assets/photos/plants/plants-09.jpg", "Dried Umbels, Sunset"],
      ["assets/photos/plants/plants-10.jpg", "Cosmos, Water Drops"],
      ["assets/photos/plants/plants-11.jpg", "Poppies, One Holding Still"],
      ["assets/photos/plants/plants-12.jpg", "Cosmos in Haze"],
      ["assets/photos/plants/plants-13.jpg", "Camellia, Scattered Light"],
      ["assets/photos/plants/plants-14.jpg", "Silver Grass in Fog"],
      ["assets/photos/plants/plants-15.jpg", "Dandelion, One Seed Leaving"],
      ["assets/photos/plants/plants-16.jpg", "Rain on Branches"],
      ["assets/photos/plants/plants-17.jpg", "Dried Flower, Indoors"],
    ],
    /* タンポポの群生 */
    /* コラージュ確定：A案「群れの奥行き」
       ポピー畑(横)を奥の壁に、コスモス(縦)を左手前の層、タンポポ(縦)を主役に。 */
    build() {
      const z = -30, y = GROUND_Y;
      addArtwork("assets/scenes/p4_art.webp",            /* ポピー畑：奥の壁 */
        -7.4, y + 3.4, z - 2.4, 9.0, this.viewPos, { aspect: 0.668, maxOp: 0.62, near: 8, far: 32 });
      addArtwork("assets/scenes/p5_art.webp",            /* コスモス：左手前の層 */
        -9.4, y + 2.9, z + 1.4, 4.4, this.viewPos, { aspect: 1.5, maxOp: 0.78, near: 7, far: 28 });
      addArtwork("assets/scenes/p1_art.webp",            /* タンポポ：主役 */
        -5.4, y + 3.0, z + 0.4, 5.0, this.viewPos, { aspect: 1.499, maxOp: 0.95, near: 6.5, far: 28 });
      this.object = addPickProxy(-6.5, -30, 6.4, 6.6, 3.2);
    },
  },
  {
    name: "LANDSCAPES", num: "02", t: 0.384,
    center: new THREE.Vector3(7.5, 1.4, -47),
    viewPos: new THREE.Vector3(2.6, 1.7, -42),
    gesture: { dy: -0.55, lookDy: -0.35 }, /* 水面すれすれを滑って近づく */
    hotspot: "View the series",
    lines: ["誰もいない場所にだけ、", "風景は現れる。"],
    /* 北郷さんの実写。題は1枚ずつ実物を見て付けている */
    photos: [
      ["assets/photos/landscapes/landscapes-01.jpg", "Autumn Pond, Morning Mist"],
      ["assets/photos/landscapes/landscapes-02.jpg", "Green Forest in Fog"],
      ["assets/photos/landscapes/landscapes-03.jpg", "Flooded Grove"],
      ["assets/photos/landscapes/landscapes-04.jpg", "Lone Tree, Storm Clouds"],
      ["assets/photos/landscapes/landscapes-05.jpg", "Ridge in Cloud"],
      ["assets/photos/landscapes/landscapes-06.jpg", "Canopy from Above"],
      ["assets/photos/landscapes/landscapes-07.jpg", "Fog Between Trunks"],
      ["assets/photos/landscapes/landscapes-08.jpg", "Building on Still Water"],
      ["assets/photos/landscapes/landscapes-09.jpg", "Avenue, Empty Bench"],
      ["assets/photos/landscapes/landscapes-10.jpg", "Cedar Slope, Yellow Bloom"],
      ["assets/photos/landscapes/landscapes-11.jpg", "Maple, Dark Trunk"],
      ["assets/photos/landscapes/landscapes-12.jpg", "Pasture, Distant Towers"],
      ["assets/photos/landscapes/landscapes-13.jpg", "Boat on the Lake"],
      ["assets/photos/landscapes/landscapes-14.jpg", "Island of Trees, Mirror"],
      ["assets/photos/landscapes/landscapes-15.jpg", "Grass in Low Cloud"],
      ["assets/photos/landscapes/landscapes-16.jpg", "Two Figures, Reflection"],
      ["assets/photos/landscapes/landscapes-17.jpg", "Rocks in the Fog"],
    ],
    /* コラージュ確定：沼地と桟橋。地に足のついた静けさ。 */
    build() {
      addArtwork("assets/scenes/land2_art.webp",
        8.8, GROUND_Y + 3.2, -50.0, 9.2, this.viewPos, { aspect: 0.723, maxOp: 0.8 });
      addArtwork("assets/scenes/land1_art.webp",
        6.6, GROUND_Y + 2.7, -46.5, 8.2, this.viewPos, { aspect: 0.668 });
      this.object = addPickProxy(7.5, -47, 7.4, 5.4, 3.2);
    },
  },
  {
    name: "ARCHITECTURES", num: "03", t: 0.502,
    center: new THREE.Vector3(-7.5, 1.4, -64),
    viewPos: new THREE.Vector3(-2.6, 1.7, -59),
    gesture: { dy: 0.6, lookDy: 0.6 }, /* 見上げるように上昇して近づく */
    hotspot: "View the series",
    lines: ["直線の中に、", "人の祈りを探す。"],
    /* 北郷さんの実写。題は1枚ずつ実物を見て付けている */
    photos: [
      ["assets/photos/architectures/architectures-01.jpg", "Café Window, Green Beyond"],
      ["assets/photos/architectures/architectures-02.jpg", "Hilltop, Yellow Field"],
      ["assets/photos/architectures/architectures-03.jpg", "Dark Eaves, Brick Beyond"],
      ["assets/photos/architectures/architectures-04.jpg", "Stepped Terrace, Crowd"],
      ["assets/photos/architectures/architectures-05.jpg", "Beams in Shadow"],
      ["assets/photos/architectures/architectures-06.jpg", "Ivy Wall in Fog"],
      ["assets/photos/architectures/architectures-07.jpg", "Handrails, Down to B1"],
      ["assets/photos/architectures/architectures-08.jpg", "Ribs of Steel and Glass"],
      ["assets/photos/architectures/architectures-09.jpg", "Abandoned House, Backlit"],
      ["assets/photos/architectures/architectures-10.jpg", "Shadow on Concrete"],
      ["assets/photos/architectures/architectures-11.jpg", "A Slit of Light on Concrete"],
      ["assets/photos/architectures/architectures-12.jpg", "Hollow in the Hillside"],
      ["assets/photos/architectures/architectures-13.jpg", "Onsen Street, Rain"],
      ["assets/photos/architectures/architectures-14.jpg", "Arches, Repeating"],
      ["assets/photos/architectures/architectures-15.jpg", "Factory, Idle Fan"],
      ["assets/photos/architectures/architectures-16.jpg", "Benches Facing the Water"],
      ["assets/photos/architectures/architectures-17.jpg", "Courtyard by Night"],
      ["assets/photos/architectures/architectures-18.jpg", "Concrete Basin, Wide Sky"],
      ["assets/photos/architectures/architectures-19.jpg", "White Facade in Fog"],
      ["assets/photos/architectures/architectures-20.jpg", "Lattice Window"],
      ["assets/photos/architectures/architectures-21.jpg", "Corridor, Hanging Lamps"],
      ["assets/photos/architectures/architectures-22.jpg", "A Tower in a Circle of Glass"],
    ],
    /* コラージュ：建築の完成画2枚を層にして重ねる（一旦保留・位置のみ） */
    build() {
      addArtwork("assets/scenes/arch2_art.webp",
        -9.2, GROUND_Y + 3.2, -66.5, 9.2, this.viewPos, { aspect: 0.665, maxOp: 0.8 });
      addArtwork("assets/scenes/arch1_art.webp",
        -6.6, GROUND_Y + 2.7, -63.2, 8.2, this.viewPos, { aspect: 0.665 });
      this.object = addPickProxy(-7.5, -64, 7.4, 5.4, 3.2);
    },
  },
  {
    name: "SNAPS", num: "04", t: 0.619,
    center: new THREE.Vector3(5.5, 1.0, -80),
    viewPos: new THREE.Vector3(1.6, 1.6, -75),
    gesture: { dy: -0.15, lookDy: 0.25 }, /* 水平線へ向かって真っ直ぐ吸い込まれる */
    hotspot: "View the series",
    lines: ["通りすがりに見たものが、", "いちばん長く残る。"],
    /* 北郷さんの実写。題は1枚ずつ実物を見て付けている。
       2026-09、32点から16点へ絞った。残したのは「無人の場所と、そこを
       通り過ぎる人」の一群 — 誰もいないブランコ、誰もいない会衆席、
       ランプの下に残されたグラス、スクリーンに落ちた人影、長時間露光で
       溶けた通行人。32点のままだと街・記録・人物が混ざり、この主題が
       「たまたま撮れた霧の写真」に見えてしまっていた。 */
    photos: [
      ["assets/photos/snaps/snaps-02.jpg", "Empty Swings"],
      ["assets/photos/snaps/snaps-03.jpg", "Wind Chime, Glass"],
      ["assets/photos/snaps/snaps-04.jpg", "Wires in Fog"],
      ["assets/photos/snaps/snaps-05.jpg", "Pier at Dusk"],
      ["assets/photos/snaps/snaps-11.jpg", "Empty Pews"],
      ["assets/photos/snaps/snaps-14.jpg", "Gull on Still Water"],
      ["assets/photos/snaps/snaps-19.jpg", "Glass Under Lamplight"],
      ["assets/photos/snaps/snaps-21.jpg", "Stems, Studded with Light"],
      ["assets/photos/snaps/snaps-22.jpg", "Leaves on Glass"],
      ["assets/photos/snaps/snaps-24.jpg", "Shadow on the Screen"],
      ["assets/photos/snaps/snaps-25.jpg", "Afternoon, Three Generations"],
      ["assets/photos/snaps/snaps-26.jpg", "Poles into Fog"],
      ["assets/photos/snaps/snaps-28.jpg", "Figures That Would Not Stay"],
      ["assets/photos/snaps/snaps-29.jpg", "Crossing, Old Street"],
      ["assets/photos/snaps/snaps-30.jpg", "Waiting by the Window"],
      ["assets/photos/snaps/snaps-32.jpg", "Calf in the Fog"],
    ],
    /* 外した16点。ファイルは assets/photos/snaps/ に残してあるので、
       上の配列に行を戻すだけで復帰できる。
       01 Gull Over Surf
       06 Hand on a Shoulder
       07 Horse, Overcast Field
       08 One Plane, Many Clouds
       09 Departure Lounge
       10 Apples on the Branch
       12 Mixing Desk
       13 Two Benches, One Walk
       15 Child in Overalls
       16 Posters, After Dark
       17 Blue Bench, Leaf Shadow
       18 One Chair
       20 Through the Window
       23 Web in the Mist
       27 The Museum Is Not Enough
       31 Grass and Standing Water
    */
    /* コラージュ確定：B案「無人の情景」（桟橋は使わない）
       霧の電柱道(縦)を主役に、誰もいないブランコ(縦)を右奥に添える静かな構成。 */
    build() {
      const z = -80, y = GROUND_Y;
      addArtwork("assets/scenes/s5_art.webp",            /* 霧の電柱道：主役 */
        5.2, y + 3.2, z, 6.0, this.viewPos, { aspect: 1.5, maxOp: 0.95, near: 6.5, far: 28 });
      addArtwork("assets/scenes/s4_art.webp",            /* 無人のブランコ：右奥に添える */
        9.0, y + 3.0, z - 2.6, 4.6, this.viewPos, { aspect: 1.5, maxOp: 0.6, near: 8, far: 30 });
      this.object = addPickProxy(5.5, -80, 7.4, 5.4, 4.2);
    },
  },
  {
    /* ABSTRACTS：具象を離れ、線とにじみだけが残る情景 */
    name: "ABSTRACTS", num: "05", t: 0.736,
    center: new THREE.Vector3(-7.0, 1.2, -96),
    viewPos: new THREE.Vector3(-2.2, 1.6, -91),
    gesture: { dy: 0.15, lookDy: -0.2 }, /* 輪郭が溶けるように、かすかに揺らぎながら漂う */
    hotspot: "View the series",
    lines: ["輪郭がほどけていく先に、", "本当の形がある。"],
    /* 北郷さんの実写。題は1枚ずつ実物を見て付けている */
    photos: [
      ["assets/photos/abstracts/abstracts-01.jpg", "Undergrowth Coming Undone"],
      ["assets/photos/abstracts/abstracts-02.jpg", "Green, Running Sideways"],
      ["assets/photos/abstracts/abstracts-03.jpg", "Rapids Over Stones"],
      ["assets/photos/abstracts/abstracts-04.jpg", "Young Fir in Fog"],
      ["assets/photos/abstracts/abstracts-05.jpg", "Bud, Glowing Green"],
      ["assets/photos/abstracts/abstracts-06.jpg", "Pansies, Layered"],
      ["assets/photos/abstracts/abstracts-07.jpg", "Amber Curtain"],
      ["assets/photos/abstracts/abstracts-08.jpg", "A Grove, Half Erased"],
    ],
    /* コラージュ：柳と電柱の情景（DSC_8627、横長1535x1025→aspect 0.668）を単体で */
    build() {
      addArtwork("assets/scenes/abst4_art.webp",
        -7.0, GROUND_Y + 2.7, -96, 8.4, this.viewPos, { aspect: 0.668, maxOp: 0.92, near: 7, far: 30 });
      this.object = addPickProxy(-7.0, -96, 7.4, 5.4, 3.2);
      /* 絵の周りに水彩の色斑をアクセントとして添える（絵より手前＝カメラ側に置き、隠れないようにする） */
      addWash(-11.2, GROUND_Y + 4.8, -92.5, 5.2, "#a08a72", 0.18);
      addWash(-2.4, GROUND_Y + 1.4, -91.8, 4.4, "#8ba3ad", 0.16, 0.9);
      addWash(-6.5, GROUND_Y + 5.6, -92.2, 3.8, "#b3a86e", 0.15, 1.1);
    },
  },
  {
    /* EXHIBITIONS：展示・発表の情景 */
    name: "EXHIBITIONS", num: "06", t: 0.853,
    center: new THREE.Vector3(7.5, 1.3, -112),
    viewPos: new THREE.Vector3(2.3, 1.6, -107),
    gesture: { dy: 0.3, lookDy: 0.15 }, /* 展示室に足を踏み入れ、静かに全体を見渡す */
    /* ここだけ中身が「作品群」ではなく「公に出した2点の記録」で、
       他の5シリーズ（8〜32点）と分類の軸が違う。ラベルまで
       "View the series" だと、シリーズを期待して開いて2枚で終わる。
       枚数を先に言って、記録として受け取ってもらう */
    hotspot: "Two works, shown",
    hotspotAria: "出展・受賞した2点を見る",
    lines: ["見せることは、", "選び、手放すこと。"],
    /* 北郷さんの実写。題は1枚ずつ実物を見て付けている。
       3枠目（受賞歴）は、その作品が実際に選ばれた展示・コンテスト。
       以前は詩コピー画面（addCopyBoxのxp-contact-extra）にまとめて
       出していたが、モバイルではその画面自体が詩＋英訳＋展示歴2件で
       縦に長くなりすぎ、下のホットスポットと文字が重なっていた。
       作品ごとの受賞歴として、該当写真を開いた時（zoomCapText）に
       出す形へ移す方が情報としても自然で、詩コピー画面もシンプルになる */
    photos: [
      ["assets/photos/exhibitions/exhibitions-01.jpg", "Wrapped", "epSITE ONLINE PHOTO CONTEST 2023 入賞"],
      ["assets/photos/exhibitions/exhibitions-02.jpg", "Tiny World", "BOKEHPHOTOFAN GROUP EXHIBITION 2024 出展"],
    ],
    /* コラージュ：水辺の情景（DSC_2786、縦長1024x1535→aspect 1.499）を単体で、大きく静かに見せる。
       粒子の"組み上がり"演出（dust）は近づいても常時うっすら残る仕様のため、
       繊細な鉛筆線の一枚絵ではノイズになって元素材の質感を損なう→無効化して素材そのままを見せる */
    build() {
      addArtwork("assets/scenes/ex1_art.webp",
        7.5, GROUND_Y + 3.4, -112, 7.0, this.viewPos, { aspect: 1.499, maxOp: 1.0, near: 6.5, far: 28, dust: false });
      this.object = addPickProxy(7.5, -112, 7.4, 5.4, 3.2);
      /* 絵の周りに水彩の色斑をアクセントとして添える（絵より手前＝カメラ側、かつ画角がタイトなので絵に近づけて配置） */
      addWash(9.8, GROUND_Y + 6.2, -109.5, 4.5, "#8ba3ad", 0.18);
      addWash(5.3, GROUND_Y + 0.6, -109.8, 4.0, "#9aab7c", 0.16, 0.9);
      addWash(8.8, GROUND_Y + 1.3, -109.0, 3.4, "#a08a72", 0.16, 1.1);
    },
  },
  {
    name: "CONTACT", num: "07", t: 0.97,
    /* 旅の終着は、冒頭のマクロ（綿毛の接写）と対になる寄りで閉じる。
       注視点は咲いた綿毛の冠毛そのもの（bloom の頭＝ x-0.55 / y GROUND_Y+1.5 / z-128.2）。
       手前の小さい方(bloom2)に遮られないよう、左前から寄る */
    center: new THREE.Vector3(-0.55, 0.02, -128.2),
    viewPos: new THREE.Vector3(-1.05, 0.2, -127.15),
    hotspot: "escoval0626@gmail.com — Say hello",
    link: "mailto:escoval0626@gmail.com",
    email: "escoval0626@gmail.com",
    /* 「種が降りる」で終わると、詩的な着地の隣にいきなりメールアドレスが
       並び、余韻と連絡という行為の間に橋が無かった（ADレビュー指摘）。
       言い切らずに余白を残す一行を足して、静かなまま接続する */
    lines: ["旅の終わりに、", "また、種が降りる。", "いつか、どこかで。"],
    /* 旅の終着：綿毛の種が地面に降りて散る。近づくほど、その種から
       二輪だけ花が咲く（冒頭のマクロの一輪と対になり、旅が円環で閉じる） */
    build() {
      const seed = makeAttrArrays(120);
      for (let k = 0; k < 120; k++) {
        pushParticle(seed,
          (Math.random() - 0.5) * 1.2,
          GROUND_Y + 0.02 + Math.pow(Math.random(), 2) * 0.8,
          -128 + (Math.random() - 0.5) * 1.2,
          ["#a8a396", "#c4bfb0", "#8a857a"], 0.35, 0.75);
      }
      buildPoints(seed);
      this.object = addPickProxy(0, -128, 3.6, 2.8, 3.0);

      /* group渡しのmakeDandelionは基点(group.position)からscaleで成長できるので、
         updateContactBloomがcurrentWに応じてscaleを0→1へ動かすだけで開花になる */
      this.bloom = new THREE.Group();
      this.bloom.scale.setScalar(0.001);
      scene.add(this.bloom);
      makeDandelion(-0.55, -128.2, 1.5, 0.32, 130, this.bloom);

      this.bloom2 = new THREE.Group();
      this.bloom2.scale.setScalar(0.001);
      scene.add(this.bloom2);
      makeDandelion(0.6, -127.7, 1.1, 0.24, 90, this.bloom2);
    },
  },
];

/* 旅の終端。rig.target の上限をこれに合わせないと、CONTACT(t=0.97)より先の
   何も無い航路まで進めてしまい、連絡先が薄れながら霧が再び立つ最悪の終わり方になる */
const CONTACT_T = AREAS[AREAS.length - 1].t;

/* 表示用の総数。エリアを足し引きしてもハードコードした数字がズレないよう
   1箇所で持つ（以前は "/ 04" と "/ 07" が別々に決め打ちされ、画面ごとに
   総数の表記が食い違っていた）。SERIES=写真ギャラリーを持つ数 */
const SERIES_TOTAL = String(
  Math.max(...AREAS.filter((a) => a.photos && a.num).map((a) => +a.num))
).padStart(2, "0");

/* カットの寄り具合（100 = 従来のまま／小さいほど引き）。
   注視点から視点までの距離を伸ばして画角を引く。エリア別に上書き可能。 */
const FRAMING_DEFAULT = 90;
/* CONTACTは綿毛の接写で閉じるカットなので、既定の引き（90）を掛けず等倍で寄せる */
const FRAMING_BY_AREA = { PLANTS: 80, SNAPS: 80, EXHIBITIONS: 95, CONTACT: 100 };
for (const a of AREAS) {
  if (!a.viewPos || !a.center) continue;
  const pct = FRAMING_BY_AREA[a.name] ?? FRAMING_DEFAULT;
  a.framing = 100 / pct;
  a.viewPos.copy(a.center.clone().add(a.viewPos.clone().sub(a.center).multiplyScalar(a.framing)));
}

/* ビート（進行度で出現するコピー） */
/* 冒頭：綿毛が離脱する場面のコピー（他と同じボックス様式・固定カット）。
   タイトル「Common」ロックアップの下に来るよう、低め・左寄りに置いて重なりを回避 */
const OPENING_COPY = {
  lines: ["光が消える一瞬前の、", "世界のほうが美しい。"],
  en: "The world is most beautiful the instant before the light fades.",
  pos: new THREE.Vector3(-2.4, 0.05, -1.6),
  t: 0.0,
};

/* 谷の詩：情景と情景の"あいだ"、霧が閉じて何も見えない渡りにだけ漂う。
   opacity = near^1.25 * (veil / 0.85) なので、霧が晴れている情景の中では
   数式上ゼロになり、渡りの最中にしか現れない。

   行き先には触れない。渡っている最中の状態だけを書く。行き先を示すと
   霧が「通過すべき廊下」になり、読み手が先を急いで同じ長さの時間が
   長く感じられる。現在地と全体像はドットの現在地ラベルと 03 / 08 が
   担っているので、ここで案内をするとUIとして二重にもなる。

   組みは情景コピー（xp-copy）に合わせ、縦組みの和文の下に罫線＋横組みの
   英訳を添える。t は各情景の中間地点。 */
const VALLEY_LINES = [
  /* ABOUT → PLANTS */
  { t: 0.209,  jp: "まだ名前のない風景へ。",
                en: "Toward a landscape not yet named." },
  /* PLANTS → LANDSCAPES */
  { t: 0.3255, jp: "頬にあたる空気が、やわらかい。",
                en: "The air against my cheek is soft." },
  /* LANDSCAPES → ARCHITECTURES */
  { t: 0.443,  jp: "見えない時間が、目を澄ませる。",
                en: "Unseen time clears the eye." },
  /* ARCHITECTURES → SNAPS */
  { t: 0.5605, jp: "気配だけ、まだそこにいる気がした。",
                en: "Only the presence — I felt it was still there." },
  /* SNAPS → ABSTRACTS */
  { t: 0.6775, jp: "影も、いっしょに薄くなる。",
                en: "My shadow is fading with me." },
  /* ABSTRACTS → EXHIBITIONS */
  { t: 0.7945, jp: "記憶は、あとから追いついてくる。",
                en: "Memory comes catching up later." },
  /* EXHIBITIONS → CONTACT */
  { t: 0.912,  jp: "霧のむこうは、いつも明るい。",
                en: "Beyond the fog, it is always bright." },
];

/* ABOUT：自己紹介カット（commonbyshokitago.com/about/ の本文をそのまま使用） */
const ABOUT_BIO = {
  headline: "I'm COMMON.",
  name: "北郷 将", nameEn: "SHO KITAGO",
  role: "Photographer — Nagareyama, Chiba",
  bio: [
    "COMMON は、北郷 将による写真プロジェクト。",
    "千葉県流山市を拠点に、日常の中でふと立ち止まりたくなるような光や余白、ざらついた静けさを記録しています。",
    "かつてDJとして触れていたアナログレコードや、HIPHOPアーティスト「COMMON」から名を借り、オールドレンズを通して、都市と生活のすきまにある見過ごされがちな瞬間を抽象的にすくい取ろうとしています。",
    "写真はただの記録ではなく、かたちにならない「気配」や「温度」を探る手段。ざらつきやゆらぎの奥に残る静けさを、今日もファインダー越しに見つめています。",
  ],
  bioEn: [
    "COMMON is a photography project by Sho Kitago, based in Nagareyama, Chiba.",
    "His work quietly captures the light, space, and textured stillness found in everyday life.",
    "Inspired by the warmth of analog records and the raw textures of lo-fi hip-hop beats—echoing his past as a DJ—he uses old lenses to explore fleeting, often overlooked moments between city and life.",
    "His photography isn't about documentation, but about sensing the unspoken: atmosphere, texture, and silence.",
    "Through subtle grain and gentle shifts of light, he keeps seeking what lingers in the quiet.",
  ],
  exhibitions: [
    { jp: "BOKEHPHOTOFAN GROUP EXHIBITION 2024 出展", en: "Exhibited in BOKEHPHOTOFAN GROUP EXHIBITION 2024" },
    { jp: "epSITE ONLINE PHOTO CONTEST 2023 入賞", en: "Selected in epSITE ONLINE PHOTO CONTEST 2023" },
  ],
};

/* ===== 静的作品一覧（DOM層）：3D体験は視覚演出であり、作品そのものの
   唯一の窓口ではない。WebGLのCanvas上に描かれたテクスチャはスクリーン
   リーダーにも検索エンジンのクローラーにも「ただの絵」にしか見えないため、
   同じ写真・キャプションを通常のHTML（img alt + figcaption）として
   もう1系統、独立に用意する。画面には出さない（.sr-only）が、
   3D側のensureRoomTexture（正面付近だけ実体化するウィンドウ方式）を
   バイパスして全82枚を一括ダウンロードしないよう loading="lazy" にする。
   ページ表示直後にこのCanvas外の要素まで先読みされることはない */
function buildStaticGallery() {
  const root = document.getElementById("staticGallery");
  if (!root) return;
  AREAS.forEach((area) => {
    if (area.isAbout || area.name === "CONTACT" || !area.photos || !area.photos.length) return;
    const section = document.createElement("section");
    section.setAttribute("aria-labelledby", `sg-h-${area.name}`);
    const h2 = document.createElement("h2");
    h2.id = `sg-h-${area.name}`;
    h2.textContent = area.name;
    section.appendChild(h2);
    if (area.lines && area.lines.length) {
      const p = document.createElement("p");
      p.lang = "ja";
      p.textContent = area.lines.join("");
      section.appendChild(p);
    }
    const ul = document.createElement("ul");
    /* ここは検索エンジンとスクリーンリーダー向けの代替表現で、画面には
       .sr-only で隠してある（WebGLが使えない環境では手前で throw して
       #webglFallback に切り替わるので、この関数が動くのは3D体験が
       見られる環境だけ）。
       以前は <img loading="lazy"> を98枚並べていたが、.sr-only は
       1x1px に全要素が重なるため、ブラウザは「すべてビューポート内」と
       判定して遅延読み込みが働かず、ENTER前に98枚・41.4MBを丸ごと
       ダウンロードしていた（実測）。3Dで見せる環境では一枚も表示されない
       画像なので、リンクとキャプションだけに置き換える。
       クローラーには画像URLがリンクとして残り、読み上げにも影響しない */
    area.photos.forEach(([url, cap], i) => {
      const li = document.createElement("li");
      const fig = document.createElement("figure");
      const a = document.createElement("a");
      a.href = url;
      a.textContent = cap || `${area.name} ${i + 1}`;
      /* Tab順からは外す。ここは検索エンジンとスクリーンリーダー向けの
         代替表現で、視覚的には .sr-only で隠れている。フォーカス可能な
         ままだと98個のリンクがENTERより前に並び、キーボードだけの
         訪問者はTabを99回押さないと入場できなかった（ADレビュー実測で
         ENTERはタブ順100番目）。読み上げとクローラーの用途は
         tabindex=-1 でも損なわれない */
      a.tabIndex = -1;
      fig.appendChild(a);
      if (cap) {
        const figcap = document.createElement("figcaption");
        figcap.textContent = cap;
        fig.appendChild(figcap);
      }
      li.appendChild(fig);
      ul.appendChild(li);
    });
    section.appendChild(ul);
    root.appendChild(section);
  });
}
buildStaticGallery();

/* 綿毛ガイド */
let fluff = null;

/* タンポポ本体（buildHero）と地面の霞（buildWorldBase）は、粒子を手続き的に
   push するだけの純関数で、GLBモデル（loaded[key]）には一切依存しない。
   以前はGLB読み込み完了までまとめて待ってから組んでいたため、ローディング
   画面の間、背後の3Dシーンが空っぽのままだった。これでは「ローディングの
   ヴェール越しにタンポポが見える」という冒頭の狙いが成立しない。
   GLB依存の buildTransitObjects（遠景の木立、placeScan経由でloaded[key]を
   参照する）だけ読み込み完了後に残し、それ以外は先に組んで最初のフレームから
   見せる */
buildWorldBase();
buildHero();
/* 旅の主役である綿毛ひとつ（makeFluff）も同じく手続き的な点描で、
   GLBにもテクスチャにも依存しない。以前は「2エリア構築完了時点」まで
   生成を遅らせていたため、ローディング中は肝心の綿毛が存在せず、
   ヴェールの奥に浮いていなかった。タンポポと同時に、最初のフレームから
   HERO_HEAD の位置に浮かせておく（updateFluff が毎フレーム息づかせる） */
fluff = makeFluff(); /* 内部でscene.addされる */
/* ENTER前は霧のヴェールより手前に見せたいので、本編sceneから
   loaderFluffScene（別レンダラーで.loaderより上に重ねる専用シーン）へ
   移す。ENTER時に本編sceneへ戻す（enterBtnのクリックハンドラ参照） */
if (loaderFluffRenderer) {
  scene.remove(fluff);
  loaderFluffScene.add(fluff);
}
fluff.position.copy(HERO_HEAD);
AREAS.forEach((ar) => { ar.currentW = 0; });

/* エリアの build() は、そのエリアのコラージュ絵（assets/scenes、1枚あたり
   0.5〜1.7MB）の取得を始める副作用を持つ。旅は一本道で、いま居る場所と
   その前後しか視界に入らないため、必要になったものだけ組む。
   t昇順（旅の順番）に並べた buildOrder を Promise.all 側で用意する */
let buildOrder = [];
function ensureAreaBuilt(area) {
  if (!area || area._built) return;
  area._built = true;
  perf("build:" + area.name, () => area.build());
}
/* 指定した進行度の周辺を組む。手前に1つ残すのは、逆走（戻る）でも
   空白を出さないため。ahead は進行方向の先読み数 */
function ensureAreasAround(t, ahead = 1) {
  if (!buildOrder.length) return;
  let idx = 0, best = Infinity;
  for (let i = 0; i < buildOrder.length; i++) {
    const d = Math.abs(buildOrder[i].t - t);
    if (d < best) { best = d; idx = i; }
  }
  for (let i = Math.max(0, idx - 1); i <= Math.min(buildOrder.length - 1, idx + ahead); i++) {
    ensureAreaBuilt(buildOrder[i]);
  }
}

/* 入場したあと、まだ組んでいないエリアを旅の順に少しずつ組み足す。

   遅延構築を入れたとき「残りは背景で追いつく」と書いたが、実際には
   追いついていなかった。旧コードの setTimeout(buildNextArea, 180) が
   無くなり、ensureAreasAround が呼ばれる範囲（現在地の前後）しか
   組まれないままになっていたため、8エリア中どの瞬間も3つしか存在せず、
   霧の奥に見えるはずの先の情景が丸ごと消えていた。
   実測: artworks 4/12、総粒子 58,062。全部組むと 104,698 まで戻る。

   組むこと自体は安い（全エリアぶんで7ms、描画も1フレーム1.2msのまま）。
   高いのはコラージュ絵のダウンロードのほうなので、READYを待たせない
   よう入場後に回し、間隔を空けて最初のエリアの帯域を食わないようにする。
   画像は alphaQuality の調整で12枚2.80MB（モバイル）まで下がっており、
   遅延構築を入れた当時（5.59MB）とは前提が変わっている。 */
let bgBuildTimer = 0;
function buildRemainingAreas() {
  clearTimeout(bgBuildTimer);
  /* 通信量を切り詰めたい人（データセーバー）には先読みしない。
     従来どおり ensureAreasAround が近づいた分だけ組む */
  const net = navigator.connection;
  if (net && (net.saveData || /2g/.test(net.effectiveType || ""))) return;
  const next = buildOrder.find((a) => !a._built);
  if (!next) return;
  ensureAreaBuilt(next);
  bgBuildTimer = setTimeout(buildRemainingAreas, 450);
}

/* 全読込→シーン構築 */
Promise.all(
  Object.entries(MODELS).map(([k, u]) => loadModel(k, u))
).then(() => {
  buildTransitObjects();
  /* 各エリアのbuild()は、コラージュ絵（scenes/*.png、シリーズ合計30MB超）の
     ダウンロードを開始する副作用を持つ。7エリア分を同時に開始すると、
     ENTER直後に必要な最初のエリア分の帯域を、まだ訪れてもいない後方の
     エリアの画像が食い合っていた。旅の順番（t昇順）に沿って少しずつ
     間隔を空けて組み立て、最初の2エリア分が組み上がった時点でENTERを
     解禁する（残りは入場後に buildRemainingAreas が組み足す。詩コピー等のDOM要素やホットスポットは
     別途モジュール読み込み時に用意済みなので、旅の進行自体は妨げない） */
  /* 以前は180ms間隔で全8エリアを順に組んでいたため、READYの1秒強あとには
     まだ訪れてもいない情景を含む12枚すべての取得が始まっていた。
     旅は一本道で、いま居る場所とその前後しか視界に入らないので、
     必要になった範囲だけ組む（ensureAreasAround）。
     絵が間に合わず空白が出ないよう、進行方向に1つ先まで先回りし、
     ドットやCONTACTでの瞬間移動時は移動先を即座に組む（warpTo参照） */
  buildOrder = [...AREAS].sort((a, b) => a.t - b.t);
  /* 冒頭の2つ（ABOUT・PLANTS）はENTER直後に視界へ入るので先に組む。
     ここまで揃った時点でENTERを解禁する */
  ensureAreaBuilt(buildOrder[0]);
  ensureAreaBuilt(buildOrder[1]);
  /* 綿毛はローディング開始時点で既に生成・浮遊させてある（上記参照）。
     ここではENTERの解禁だけを行う */
  sceneReady = true; /* パネル画像の非同期ロードはこの後 panelPending で待つ */
});

/* 一人称視点で移動する3D空間＋常時揺れるカメラは、前庭障害・片頭痛・
   乗り物酔い体質の人にとってめまいの典型的なトリガーになる。
   手持ちカメラの呼吸とマウス首振りだけをここで抑える（CSS側は別途） */
const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
let REDUCE_MOTION = mqReduce.matches;
const onReduceMotionChange = (e) => { REDUCE_MOTION = e.matches; };
/* addEventListener("change", ...) はSafari 13以前・一部の古い組込みWebViewに
   無く、そこでは設定変更時にREDUCE_MOTIONが更新されないまま固まっていた。
   非推奨だがaddListener/removeListenerだけを持つ環境向けにfallbackする */
if (mqReduce.addEventListener) mqReduce.addEventListener("change", onReduceMotionChange);
else if (mqReduce.addListener) mqReduce.addListener(onReduceMotionChange);

/* ============================================================
   カメラリグ
============================================================ */
const rig = {
  progress: 0, target: 0, lookAhead: 0.02,
  mouse: new THREE.Vector2(), mouseDamped: new THREE.Vector2(),
  lastInput: 0, entered: false, started: false,
  detour: 0, roomView: null, roomLook: null, /* 案K：奥の場所への寄り道 */
  capArea: null, capW: 0, /* 綿毛を画角内に収めるため、直近の着地情景をfluff側にも共有する */
};

const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _offset = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _ahead = new THREE.Vector3();
const _look = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _fluffRight = new THREE.Vector3();
const _fluffNear = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* Firefox等は deltaMode=1（行単位、1ノッチ≒3）を返す。ピクセル値前提の
   係数のままだとChrome比で約1/40しか進まず、実質操作不能になる */
function wheelPixels(e) {
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1;
  return e.deltaY * unit;
}
window.addEventListener("wheel", (e) => {
  const dy = wheelPixels(e);
  /* 部屋にいる間は、旅ではなく掛かった写真の列を横に流す。
     縦ホイールを横移動に写すのが結局いちばん自然に操作できる */
  if (activeRoom) {
    /* 1枚を見ている間はホイールを無視する。
       見ている最中に勝手に隣へ移ると、意図しないまま写真が変わってしまう。
       送りたい時は矢印キーで明示的に操作する */
    if (activeRoom.zoomed) return;
    activeRoom.snapPending = false; /* 自分で動かし始めたら、もう勝手に戻さない */
    roomScroll.target += dy * 0.012;
    rig.lastInput = performance.now();
    return;
  }
  if (!rig.entered || galleryOpen) return;
  if (dy > 0) rig.started = true; /* 下スクロールで旅が動き出す */
  rig.target = THREE.MathUtils.clamp(rig.target + dy * 0.00005, 0, CONTACT_T);
  rig.lastInput = performance.now();
  hint.classList.add("is-faded");
}, { passive: true });

let dragging = false, dragMoved = 0, lastY = 0, lastX = 0, suppressNextClick = false;
/* preventDefaultを一切呼ばない（スクロール制御はcanvasのtouch-action:noneに
   任せている）ので、passive:trueを明示してブラウザに「このリスナーが
   スクロール/ジェスチャをブロックする可能性は無い」と伝える。
   passive指定が無いと、モバイルブラウザは念のためこのハンドラの完了を
   待ってからコンポジットすることがあり、ドラッグの追従が遅れて見えていた */
window.addEventListener("pointerdown", (e) => {
  if (!rig.entered) return;
  if (galleryOpen && !activeRoom) return;
  dragging = true; dragMoved = 0; lastY = e.clientY; lastX = e.clientX;
  suppressNextClick = false; /* 新しいジェスチャの開始で必ずクリアする */
  document.body.classList.add("dragging");
}, { passive: true });
window.addEventListener("pointermove", (e) => {
  rig.mouse.x = (e.clientX / innerWidth) * 2 - 1;
  rig.mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  if (dragging) {
    const dy = lastY - e.clientY;
    const dx = e.clientX - lastX;
    /* 縦だけでなく横の移動量も見る。部屋の主操作は横フリックなので、
       縦成分だけで判定すると「流したつもり」がクリック扱いされ、
       意図せずズームが開いてしまう */
    dragMoved += Math.hypot(dx, dy);
    if (activeRoom) {
      /* 部屋では横に掴んで流す。target だけ動かして current を
         updateRoom側のeasingで追いつかせる作りだと、ドラッグ中もずっと
         「1テンポ遅れてついてくる」慣性が乗り、指に吸い付かない
         もっさりした操作感になっていた。ドラッグ中は current も同時に
         動かして指に1:1で追従させ、easing（惰性）は手を離した後の
         スナップやキー送りだけに残す。
         ただしこれをタップ操作にも無条件で適用すると、タッチパネル特有の
         数px単位のジッター（触れているだけでも座標が細かく揺れ続ける）が
         そのまま写真の列の高速な振動として見えてしまい（実機で報告された
         "ブレブレ"）、かつ指を離した瞬間の写真の位置が毎回わずかにズレる
         せいでクリック判定（raycaster）が外れやすくなっていた。
         dragMoved が閾値（6px、クリック判定と同じ基準）を超えて
         「実際に流すジェスチャだ」と確定するまでは何もしない
         デッドゾーンにし、タップ中は写真を完全に静止させる */
      activeRoom.snapPending = false;
      if (dragMoved > 6) {
        roomScroll.target -= dx * 0.016;
        roomScroll.current = roomScroll.target;
      }
      lastX = e.clientX; lastY = e.clientY;
      rig.lastInput = performance.now();
      return;
    }
    if (dy > 0) rig.started = true; /* 上方向ドラッグ（＝下スクロール相当）で動き出す */
    rig.target = THREE.MathUtils.clamp(rig.target + dy * 0.0002, 0, CONTACT_T);
    lastX = e.clientX; lastY = e.clientY;
    rig.lastInput = performance.now();
    hint.classList.add("is-faded");
  }
}, { passive: true });
/* pointercancel（ブラウザにジェスチャを奪われた時）も pointerup と同じ後始末をする。
   これが無いと dragging=true のまま固着し、以後ドラッグが二重に効く */
window.addEventListener("pointerup", (e) => {
  dragging = false;
  document.body.classList.remove("dragging");
  /* iOS Safari（Instagram等の内蔵ブラウザも含む）は、touch-action:none を
     持つ要素上でのタップで、本来ブラウザが合成するはずの click イベントを
     発火しないことがある既知の癖がある。この canvas は pull-to-refresh
     対策で touch-action:none にしてあるため、タッチ由来の操作は click を
     待たずここで直接判定する。マウス操作は従来どおり click イベントに任せる
     （pointerType が touch/pen の場合だけここで処理し、後から本当に
     click が発火しても suppressNextClick で二重発火を防ぐ） */
  if (e.pointerType !== "mouse" && rig.entered && dragMoved <= 6) {
    suppressNextClick = true;
    handleActivate(e.clientX, e.clientY);
  }
});
window.addEventListener("pointercancel", () => {
  dragging = false;
  document.body.classList.remove("dragging");
});

/* スクロール直結（リンク）＋情景で着地：
   途中で止めればそこに留まり（自動前進しない）、情景の"着地圏"に入って
   手を止めた時だけ、そっと吸着して静止する。 */
const SNAP_ZONE = 0.05;   /* この距離まで近づいた情景にだけ吸着（外は自由スクロール＝リンク） */
function softSnap(dt) {
  if (!rig.started) return;              /* 冒頭は完全静止 */
  if (dragging || performance.now() - rig.lastInput < 550) return; /* 手を止めてすぐ着地 */
  let best = null, bestD = 1e9;
  for (const a of AREAS) {
    const d = Math.abs(rig.target - a.t);
    if (d < bestD) { bestD = d; best = a; }
  }
  /* 着地圏の外（情景と情景の間）では吸着しない＝スクロール位置に留まる */
  if (best && bestD > 0.0006 && bestD < SNAP_ZONE) {
    rig.target += (best.t - rig.target) * Math.min(1, dt * 1.6);
  }
}

const fogVeil = document.getElementById("fogVeil");
const heroTitle = document.getElementById("heroTitle");
function updateCamera(dt) {
  const now = clock.elapsedTime;
  /* エリア近傍 nearW（0..1）と、その反転 between（＝移動中）。
     冒頭（progress≈0）とラストは"晴れた領域"として扱い、白面化を防ぐ */
  let nearW = Math.max(0, 1 - rig.progress / 0.08);
  for (const a of AREAS) nearW = Math.max(nearW, Math.max(0, 1 - Math.abs(rig.progress - a.t) / 0.1));
  const between = 1 - nearW;

  /* ① スクロール直結：中間は速く追従（＝手の動きにリンク）、情景近傍だけ減速して着地の"間"を残す。
     reduced motionでは「なめらかに移動する」こと自体が負荷になるため、
     ほぼ1フレームで目標へ着く速さにして、実質的な即時ジャンプにする */
  const glide = REDUCE_MOTION ? 60 : (1.9 - 1.35 * nearW); /* 情景 0.55（そっと着地）／中間 1.9（スクロールに直結） */
  rig.progress += (rig.target - rig.progress) * Math.min(1, dt * glide);
  const p = THREE.MathUtils.clamp(rig.progress, 0, 1);
  curve.getPointAt(p, _pos);
  curve.getPointAt(Math.min(1, p + rig.lookAhead), _ahead);

  _look.copy(_ahead);
  let capArea = null, capW = 0;
  for (const a of AREAS) {
    const w = Math.max(0, 1 - Math.abs(p - a.t) / 0.075);
    a.currentW = w;
    if (w > capW) { capW = w; capArea = a; }
  }
  if (capArea && capW > 0) {
    const swBase = capW * capW * (3 - 2 * capW);
    /* ホットスポットは currentW(=capW) が0.5を超えた時点でクリック可能になる。
       つまりカメラがまだエリア定位置へ収束しきる前（sw<1）に、部屋への遷移
       （下の rig.detour による lerp）が始まることがある。この2つの収束が
       独立に動くと、視点の目標が競合して速度が不連続に変化し、部屋へ入る
       瞬間の動きがカクついて見えていた。部屋へ向かい始めたら、定位置への
       寄りを detour と同じ速さまで底上げし、1本の動きに合成する */
    const sw = Math.max(swBase, rig.detour);
    _pos.lerp(capArea.viewPos, sw * 0.92);
    _look.lerp(capArea.center, sw * 0.95);
    /* ④ 情景ごとの固有ジェスチャー（到着に向けて1つだけ効かせる） */
    if (capArea.gesture) {
      _pos.y += capArea.gesture.dy * sw;
      _look.y += capArea.gesture.lookDy * sw;
    }
  }
  rig.capArea = capArea;
  rig.capW = capW;

  /* ② 霧の谷：移動中は乳白に閉じ、情景で晴れる（＝白へ潜る渡り）
     背景がアイボリーで3D霧は見えないため、CSSの乳白ヴェールで視界を閉じる */
  const fogTarget = 0.024 + between * between * 0.05;
  const fd = THREE.MathUtils.lerp(pointsUniforms.uFogDensity.value, fogTarget, Math.min(1, dt * 1.6));
  pointsUniforms.uFogDensity.value = fd;
  if (scene.fog) scene.fog.density = fd;
  if (fogVeil) {
    /* 上限は 0.85 まで。残りの15%が"気配"の生存領域＝次の絵と道中の木立が霧の奥に透ける。
       1.0 にすると遮蔽になり、移動ではなく画面転換（ロード中）に見える */
    const v = Math.pow(THREE.MathUtils.clamp(between, 0, 1), 1.2) * 0.85;
    rig.veil = THREE.MathUtils.lerp(rig.veil || 0, v, Math.min(1, dt * 2.5));
    fogVeil.style.opacity = rig.veil.toFixed(3);
  }
  /* 谷の詩：霧が立っている間だけ、通過点に寄ると浮かび、離れると消える。
     情景に着くとヴェールが晴れるので、言葉も一緒に引いていく */
  for (const v of VALLEY_LINES) {
    if (!v.el) continue;
    const near = Math.max(0, 1 - Math.abs(rig.progress - v.t) / 0.05);
    v.el.style.opacity = (Math.pow(near, 1.25) * ((rig.veil || 0) / 0.85)).toFixed(3);
  }
  /* 写真の先読み：情景に近づいた時点で、部屋を開いた瞬間に正面へ来る
     先頭数枚だけ完了させる。以前はシリーズ全部（多いもので30枚超）を
     ここで一括ダウンロードしており、buildPlaceRoom側にせっかく用意した
     「正面付近だけ実体化する」ウィンドウ方式のHTTP転送量削減効果を
     相殺していた。残りはensureRoomTexture（ウィンドウ判定）に任せる */
  if (capArea && capW > 0.25 && capArea.photos && !capArea._pre) {
    capArea._pre = true;
    const PRELOAD_COUNT = 3;
    /* 部屋を開いた瞬間に見えるのは壁掛けの一覧表示（960pxで十分な解像度）。
       フル解像度が要るのは実際にzoomした時だけなので、ここでもサムネイルを使う */
    capArea.photos.slice(0, PRELOAD_COUNT).forEach(([u]) => { const im = new Image(); im.src = thumbUrl(u); });
    /* 案E：粒の組み替え先も、この時点で用意しておく（遷移開始後だと間に合わない） */
  }
  /* 部屋（カルーセル）の躯体（メッシュ・マテリアル群）も同じタイミングで
     先に組んでおく。openGallery側でbuildPlaceRoomを初めて呼ぶと、写真枚数分の
     生成コストがその1フレームに乗って詰まり、次のdtが膨らんでカメラが
     一気に動いて見えていた（部屋に入る瞬間のカクつきの原因） */
  if (capArea && capW > 0.25 && capArea.photos && !capArea._room) {
    const preRoom = buildPlaceRoom(capArea);
    /* 部屋の躯体は先に組んでおいても、正面付近の写真の実体化
       （ensureRoomTexture＝テクスチャの実ロード）は updateRoom(dt) の
       ウィンドウ判定に任せていた。だが updateRoom は activeRoom が
       設定された後（＝実際にopenGalleryのタイムラインが完了した後）
       にしか動かないため、「先に組んでおく」の恩恵が実質ゼロだった。
       正面（startIdx）付近だけ、この時点で先にロードを始めておく。
       これが無いと、部屋を開いた瞬間はまだ全メッシュが仮の縦横比
       （1.5固定）の白い板のままで、実サイズが判ってから一気に
       縦長へ組み直り、その様子がガタつきとして見えていた */
    const win = Math.ceil(ROOM_WINDOW_RADIUS / (ROW_H * 1.5 + ROOM_GAP));
    for (let i = Math.max(0, preRoom.startIdx - win); i <= preRoom.startIdx + win; i++) {
      if (preRoom.meshes[i]) ensureRoomTexture(preRoom.meshes[i]);
    }
  }
  /* ヒーロータイトル：冒頭で表示、スクロールで退場（progress 0.01→0.06 で消える） */
  if (heroTitle) {
    /* 退場が 0.06 まで続くと、その間ずっと副題（写真家名）と
       背後の縦組みコピーが重なって見える。半透明どうしなので
       にじみでは隠しきれない。露出する時間そのものを短くする */
    const tOp = (1 - THREE.MathUtils.smoothstep(rig.progress, 0.010, 0.040)) * (rig.entered ? 1 : 0);
    heroTitle.style.opacity = tOp.toFixed(3);
  }

  /* 案K：奥の場所へ進んでいる間は、経路から外れてそちらへ寄る */
  if (rig.detour > 0 && rig.roomView) {
    const e = rig.detour * rig.detour * (3 - 2 * rig.detour);
    _pos.lerp(rig.roomView, e);
    _look.lerp(rig.roomLook, e);
  }

  /* 変化：ゆっくりした上下の浮遊＋左右の微たゆたい（呼吸する手持ちカメラ）。
     冒頭（progress≈0）は"固定カット"として揺れを止め、動き出すと徐々に効かせる。
     reduced-motion では常に0＝三脚に固定したのと同じ状態にする */
  const moveAmp = REDUCE_MOTION ? 0 : THREE.MathUtils.smoothstep(rig.progress, 0.0, 0.1);
  _pos.y += (Math.sin(now * 0.22) * 0.12 + Math.sin(now * 0.13) * 0.06) * moveAmp;
  _pos.x += Math.sin(now * 0.17) * 0.14 * moveAmp;

  camera.position.lerp(_pos, Math.min(1, dt * (REDUCE_MOTION ? 60 : 2.4)));
  _mat.lookAt(camera.position, _look, UP);
  _quat.setFromRotationMatrix(_mat);

  rig.mouseDamped.lerp(rig.mouse, Math.min(1, dt * 2.2));
  /* マウス首振り＋ごく僅かなロール（水平の傾き）で生きた揺らぎ */
  const roll = Math.sin(now * 0.15) * 0.012 * moveAmp;
  _euler.set(
    REDUCE_MOTION ? 0 : rig.mouseDamped.y * 0.04,
    REDUCE_MOTION ? 0 : -rig.mouseDamped.x * 0.06,
    roll
  );
  _offset.setFromEuler(_euler);
  _quat.multiply(_offset);
  camera.quaternion.slerp(_quat, Math.min(1, dt * 2.3));

  return { capArea, capW };
}

/* 綿毛：カメラの少し先を、風に揺れながら先導する */
/* READY到達の瞬間だけ綿毛が一度大きく揺れる、その基準時刻。
   -1は「まだ起きていない」を表す（updateLoadProgress側で発火させる） */
let fluffBurstAt = -1;
function updateFluff(t, dt) {
  if (!fluff) return;
  if (!rig.entered) {
    /* 離脱前：タンポポの綿球のふちで震えている。
       ローダーのCOMMON／タグライン／ENTERは画面中央に縦積みされているため、
       元のオフセット（+0.42, +0.18）だと綿毛の頭がテキスト右端に接近し
       視認性を損なう一方、+1.1/+0.85まで離すと今度は画面の隅に寄り
       すぎて存在感が薄れてしまった。テキスト塊とは重ならず、かつ
       画面内に留まる中間の位置へ */
    /* READY到達＝文字が像を結び始める瞬間に、綿毛も一度だけ大きく
       揺れて呼応する。「旅の起点（綿毛）が合図を送り、COMMON／
       ENTERの文字が浮かび上がる」という因果関係を持たせるための
       演出。1.1秒で減衰しきる一過性の揺れで、常時ループはしない */
    let burst = 0;
    if (fluffBurstAt >= 0) {
      const el = (performance.now() - fluffBurstAt) / 1000;
      if (el < 1.1) burst = Math.sin(el * Math.PI * 1.6) * Math.max(0, 1 - el / 1.1);
    }
    fluff.position.set(
      HERO_HEAD.x + 0.72 + Math.sin(t * 1.3) * 0.02 + burst * 0.13,
      HERO_HEAD.y + 0.5 + Math.sin(t * 1.7) * 0.02 + burst * 0.08,
      HERO_HEAD.z + Math.cos(t * 1.1) * 0.02
    );
    fluff.rotation.z = Math.sin(t * 0.9) * 0.1 + burst * 0.35;
    return;
  }
  const lead = THREE.MathUtils.clamp(rig.progress + 0.035, 0, 1);
  curve.getPointAt(lead, _fp);
  /* 谷の底（移動中）では蛇行の振幅を広げ、霧の濃い所へ入って一瞬消え、また現れる。
     等速で漂うより、"消えて戻ってくる"動きが孤独な旅の情緒になる */
  const inTransit = rig.veil ? THREE.MathUtils.clamp(rig.veil / 0.85, 0, 1) : 0;
  const sway = 1 + inTransit * 0.5;
  _fp.y += 0.55 + Math.sin(t * 0.9) * 0.16 * sway;
  _fp.x += Math.sin(t * 0.6) * 0.22 * sway + Math.sin(t * 0.23) * 0.5 * inTransit;

  /* カーブ上の位置は経路の進行方向基準なので、情景ごとにカメラが大きく
     横へ振れる場面（ABSTRACTS/EXHIBITIONS等、絵に寄るほど顕著）では、
     カメラの視線から外れて画角の外に出てしまう。着地が深いほど、
     その情景の視野内（注視点の手前・右上）へ引き寄せる */
  if (rig.capArea && rig.capW > 0.3) {
    const area = rig.capArea;
    const dir = area.center.clone().sub(area.viewPos).normalize();
    const right = _fluffRight.crossVectors(dir, UP).normalize();
    /* カメラの画角(半角21°)に収まる範囲で右上に置く。距離3.2に対して
       オフセットを抑え、対角でも視野の半分程度に収める安全マージンを取る */
    _fluffNear.copy(area.viewPos)
      .addScaledVector(dir, 3.2)
      .addScaledVector(right, 0.55);
    _fluffNear.y += 0.35 + Math.sin(t * 0.9) * 0.08;
    const k = THREE.MathUtils.smoothstep(rig.capW, 0.3, 0.7);
    _fp.lerp(_fluffNear, k);
  }

  fluff.position.lerp(_fp, Math.min(1, dt * 2.2));
  fluff.rotation.z = Math.sin(t * 0.7) * 0.16;
  /* 見え隠れ：移動中だけ、ゆっくりした呼吸で濃度が上下する（完全には消さない） */
  if (fluff.userData.mats) {
    const breathe = 0.5 + 0.5 * Math.sin(t * 0.5);
    const hide = 1 - inTransit * 0.72 * breathe;
    for (const m of fluff.userData.mats) m.opacity = m.userData.baseOp * hide;
  }
  fluff.rotation.y += dt * 0.3;
}

/* ============================================================
   DOMアンカー：詩的コピー + ラベル + ABOUTビート
============================================================ */
const FOCUS_DIST = 5.6;
const anchorsWrap = document.getElementById("anchors");
const domAnchors = [];

function addTextLine(text, pos, opts = {}, cls = "xp-line") {
  const el = document.createElement("p");
  el.className = cls;
  el.textContent = text;
  anchorsWrap.appendChild(el);
  domAnchors.push({ el, pos, area: opts.area || null, beatT: opts.beatT ?? null });
  return el;
}

/* 詩コピーの英訳（北郷さんのトーン：静謐・写真家の眼差し） */
const COPY_EN = {
  PLANTS: "The quietest subject — the most eloquent life.",
  LANDSCAPES: "Only where no one stands does the landscape appear.",
  ARCHITECTURES: "Within straight lines, a search for human prayer.",
  SNAPS: "What I saw only in passing is what stays the longest.",
  ABSTRACTS: "Past where the outline comes undone, the true shape waits.",
  EXHIBITIONS: "To show something is to choose, and to let go.",
  CONTACT: "At the journey's end, a seed falls once more. Someday, somewhere.",
};

/* 縦組み＋英訳の"箱"は様式が強く、6回続くと飽きるので、どこかで型を
   崩して呼吸を作りたい。その意図は正しいが、当てる場所を間違えていた。

   もとは ARCHITECTURES と CONTACT の2つを落としていた。両方とも訳文は
   COPY_EN に書いてあるのに、一度も画面に出ないままだった。
   英語話者にとっては、6つのシリーズのうち1つが日本語だけになり、
   さらに旅全体の情緒的な着地（旅の終わりに、また、種が降りる。
   いつか、どこかで。）を訳なしで受け取ることになる。
   型を崩すために、最も渡してはいけない2箇所を落としていた。

   崩すのは ABSTRACTS の1箇所だけにする。ここは「輪郭がほどけていく先に、
   本当の形がある。」で、言葉が像を結ばないことそのものが主題なので、
   訳が無いことが意味として効く。 */
const COPY_NO_EN = new Set(["ABSTRACTS"]);

/* 各エリアの詩コピーを「1つの箱」に：日本語=縦組み／英訳=横組み。
   3D投影（座標追従・奥行きボケ）はそのまま、箱ごと動くので改行・余白が破綻しない */
function addCopyBox(area) {
  const el = document.createElement("div");
  el.className = "xp-copy";
  const jp = document.createElement("div");
  jp.className = "xp-copy__jp";
  area.lines.forEach((line) => {
    const col = document.createElement("span");
    col.className = "xp-copy__col";
    col.textContent = line;
    jp.appendChild(col);
  });
  el.appendChild(jp);
  if (COPY_EN[area.name] && !COPY_NO_EN.has(area.name)) {
    const en = document.createElement("div");
    en.className = "xp-copy__en";
    en.textContent = COPY_EN[area.name];
    el.appendChild(en);
  }
  /* CONTACT だけ、見出しを additionally 添える。
     メールリンク・SNSは以前ここにも重複して置いていたが、
     ページ下部のホットスポット（"escoval0626@gmail.com — Say hello →"、
     クリックで mailto を開く導線。他エリアの "View the series →" と同じ仕組み）
     およびヘッダーのSNSアイコンと同じ内容が二重に出て、しかも位置が重なって
     見えていたため、本文側は見出し＋一文だけに絞る */
  if (area.name === "CONTACT" && area.email) {
    const extra = document.createElement("div");
    extra.className = "xp-contact-extra";
    const headline = document.createElement("p");
    headline.className = "xp-contact-extra__headline";
    headline.lang = "en";
    headline.textContent = "Contact.";
    extra.appendChild(headline);
    /* 見た目は写真の依頼窓口だが、実際はWeb制作の受注導線も兼ねたい、という
       サイトの狙いを踏まえた一文。ラベルで二枚看板にすると世界観が壊れるため、
       詩的な一文の中に両方の間口をさりげなく織り込む */
    const lead = document.createElement("p");
    lead.className = "xp-contact-extra__lead";
    /* 幅の狭い画面だとブラウザ任せの折返しが「相談」の間に入り、
       「ものをつくる相」「談も。」と割れて読みにくくなっていた。
       意味の区切りで明示的に改行する（PCではコンテナが広く1行に収まるので、
       この <br> はモバイル幅でだけ効かせる。常時 <br> にすると、
       PCでも2行になって下のホットスポットと縦に近づいてしまう） */
    lead.innerHTML = "撮影のご依頼、<br class=\"xp-contact-extra__br\">それから、ものをつくる相談も。";
    extra.appendChild(lead);
    const leadEn = document.createElement("p");
    leadEn.className = "xp-contact-extra__lead-en";
    leadEn.lang = "en";
    leadEn.textContent = "For a photograph — or for something built.";
    extra.appendChild(leadEn);
    el.appendChild(extra);
  }
  /* EXHIBITIONSの展示歴は、以前はここ（詩コピー画面）にCONTACTと同じ
     追加情報ブロックとしてまとめて添えていたが、詩＋英訳＋展示歴2件で
     箱が縦に長くなり、モバイルでは下のホットスポットと文字が重なって
     いた。実績は「その作品が実際に選ばれた」という個別の話なので、
     詩コピー画面ではなく該当写真を開いた時（zoomCapText）に出す形へ
     移した。ABOUTには引き続き一覧として残してある */
  anchorsWrap.appendChild(el);
  const dir = area.center.clone().sub(area.viewPos).normalize();
  const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
  const p = area.center.clone()
    .addScaledVector(dir, -0.8)
    .addScaledVector(right, -1.5);
  p.y = 2.0;
  domAnchors.push({
    el, pos: p, area, beatT: null, clamp: true,
    /* デフォルトのclampRect（y1:0.72）は、ホットスポット側の帯（y0:0.72、
       CONTACTはy0:0.82）とちょうど隙間ゼロで接しており、実測高さ（baseH）が
       クランプ計算の想定よりわずかでも大きいと即座に食い込んで文字が重なる。
       Webフォントはdisplay=swapで読み込んでおり、確定前のフォールバック
       フォントで採寸されると縦組み日本語の実際の高さとズレが出やすい
       （フォント確定後に測り直す対策は別途入れたが、それでも余白ゼロは
       壊れやすいため、モバイルでは確実な余白を持たせておく） */
    clampRect: MOBILE_LAYOUT ? { x0: 0.1, x1: 0.7, y0: 0.12, y1: 0.60 } : undefined,
  });
}

/* ABOUT：自己紹介カット（見出し＋名前・肩書＋長文バイオ(日英)＋展示歴を1つの箱に） */
function addAboutBox(area) {
  const el = document.createElement("div");
  el.className = "xp-copy xp-copy--about";
  /* モバイルはこの箱だけ内部スクロールになる（CSS側 max-height + overflow-y）。
     window 側の wheel/pointerdown ハンドラが旅の移動・部屋のドラッグに使っており、
     素通しだと指でテキストを読もうとするたびカメラが動いてしまうため、
     このモバイル幅の間だけ伝播を止めてスクロールをこの箱の中に閉じ込める */
  el.addEventListener("wheel", (e) => { if (innerWidth <= 767) e.stopPropagation(); }, { passive: true });
  el.addEventListener("pointerdown", (e) => { if (innerWidth <= 767) e.stopPropagation(); });

  const name = document.createElement("div");
  name.className = "xp-about__name";
  name.textContent = ABOUT_BIO.name;
  const nameEn = document.createElement("span");
  nameEn.lang = "en";
  nameEn.textContent = ABOUT_BIO.nameEn;
  name.appendChild(nameEn);
  el.appendChild(name);

  const role = document.createElement("div");
  role.className = "xp-about__role";
  role.lang = "en";
  role.textContent = ABOUT_BIO.role;
  el.appendChild(role);

  /* 日本語列・英語列を横並びに（縦積みだと画面の高さを大きく超えるため） */
  const bioRow = document.createElement("div");
  bioRow.className = "xp-about__bio-row";

  const bio = document.createElement("div");
  bio.className = "xp-about__bio";
  ABOUT_BIO.bio.forEach((line) => {
    const p = document.createElement("p");
    p.textContent = line;
    bio.appendChild(p);
  });
  bioRow.appendChild(bio);

  const bioEn = document.createElement("div");
  bioEn.className = "xp-about__bio-en";
  /* 英文4段落と、その下の展示歴（見出しは英語）をまとめて英語にする */
  bioEn.lang = "en";
  ABOUT_BIO.bioEn.forEach((line) => {
    const p = document.createElement("p");
    p.textContent = line;
    bioEn.appendChild(p);
  });
  /* 展示歴は英訳コピーの下に続けて置く（右列の中で完結させる） */
  const ex = document.createElement("div");
  ex.className = "xp-about__exhibitions";
  const exH = document.createElement("h4");
  exH.textContent = "Exhibitions & Awards";
  ex.appendChild(exH);
  const exList = document.createElement("ul");
  ABOUT_BIO.exhibitions.forEach((item) => {
    const li = document.createElement("li");
    li.lang = "ja";   /* 親(bioEn)が英語なので、日本語側は戻す */
    li.textContent = item.jp;
    const em = document.createElement("em");
    em.lang = "en";
    em.textContent = item.en;
    li.appendChild(em);
    exList.appendChild(li);
  });
  ex.appendChild(exList);
  bioEn.appendChild(ex);

  bioRow.appendChild(bioEn);
  el.appendChild(bioRow);
  /* 狭い幅ではこの箱だけ内部スクロールになる。下に続きがあることを示す */
  const more = document.createElement("div");
  more.className = "xp-about__more";
  more.setAttribute("aria-hidden", "true");
  el.appendChild(more);

  anchorsWrap.appendChild(el);
  const dir = area.center.clone().sub(area.viewPos).normalize();
  const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
  const p = area.center.clone()
    .addScaledVector(dir, -0.8)
    .addScaledVector(right, -1.1);
  p.y = 1.7;
  domAnchors.push({ el, pos: p, area, beatT: null, clamp: true, noScale: true });
}

AREAS.forEach((area) => {
  const dir = area.center.clone().sub(area.viewPos).normalize();
  const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
  if (area.isAbout) addAboutBox(area);
  else if (area.lines && area.lines.length) addCopyBox(area);
  if (area.isAbout || !area.hotspot) return; /* ABOUTはビューアラベル無し */
  const hp = area.center.clone()
    .addScaledVector(dir, -0.8)
    .addScaledVector(right, -2.0);
  hp.y = 0.35;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "xp-hotspot";
  /* 下線の呼吸アニメーションは scaleX(0.6→1) を「箱の幅いっぱい」に掛けているため、
     "View the series" のような短いラベルでは小さな揺れで済むが、CONTACT の
     "escoval0626@gmail.com — Say hello" のように長いラベルだと振れ幅が122pxにも
     なり、下線が不安定に伸び縮みして見えてしまう。実用的なメールリンクなので
     装飾より安定を優先し、揺れを止めた静的な下線にする */
  if (area.name === "CONTACT") el.classList.add("xp-hotspot--static");
  el.setAttribute("aria-label", area.link ? area.hotspot : (area.hotspotAria || `${area.name} シリーズを見る`));
  el.innerHTML =
    `<span class="xp-hotspot__bullet">・</span>` +
    `<span class="xp-hotspot__label">${area.hotspot}</span>` +
    `<span class="xp-hotspot__arrow">→</span>`;
  anchorsWrap.appendChild(el);
  /* 画面下部・詩コピーの下あたりに必ず収める。ここが唯一のクリック導線。
     CONTACTだけは詩＋「Contact.」＋本文2行で箱が飛び抜けて高く、既定の帯だと
     コピーの裾とメールリンクが重なって両方読めなくなるため、一段下げた帯に置く */
  /* 帯（clampRect）は画面高に対する割合なので、画面が低いほど上に来る。
     一方でコピーの箱は中身の実寸で決まり縮まないため、低い画面では
     帯がコピーの裾に食い込む。iPhone SE の実効高 553px（Safari の
     ツールバーぶんを引いた高さ）で、メール導線とリード文
     「撮影のご依頼、それから、ものをつくる相談も。」が
     240x24px 重なっていた（実測。667px では 29px 空いていて起きない）。
     割合だけで決めず、同じエリアのコピー箱の実測下端も見て避ける */
  const avoid = domAnchors.find((z) => z.area === area && !z.isHotspot) || null;
  domAnchors.push({
    el, pos: hp, area, beatT: null, clamp: true, isHotspot: true, avoid,
    clampRect: area.name === "CONTACT"
      ? { x0: 0.2, x1: 0.8, y0: 0.82, y1: 0.93 }
      : { x0: 0.2, x1: 0.8, y0: 0.72, y1: 0.88 },
  });
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (area.link) {
      trackEvent("click_commission_cta", { area: area.name });
      window.location.href = area.link;
    } else {
      openGallery(area);
    }
  });
});

/* 冒頭コピーをボックスで（縦組み日本語＋英訳）。beatT で冒頭付近だけ表示 */
(function addOpeningBox() {
  const el = document.createElement("div");
  el.className = "xp-copy";
  const jp = document.createElement("div");
  jp.className = "xp-copy__jp";
  OPENING_COPY.lines.forEach((line) => {
    const col = document.createElement("span");
    col.className = "xp-copy__col";
    col.textContent = line;
    jp.appendChild(col);
  });
  el.appendChild(jp);
  const en = document.createElement("div");
  en.className = "xp-copy__en";
  en.textContent = OPENING_COPY.en;
  el.appendChild(en);
  anchorsWrap.appendChild(el);
  domAnchors.push({ el, pos: OPENING_COPY.pos.clone(), area: null, beatT: OPENING_COPY.t, clamp: true, sharp: true });
})();

/* Google Fontsはdisplay=swapで読み込んでおり、フォント確定前は一瞬フォールバック
   フォント（游ゴシック/Georgia等）で描画される。updateAnchors側のmeasureAnchor()は
   「一度measureしたら再測しない」作りのため、そのフォールバック時点の寸法が
   baseW/baseHとして固定されてしまい、実際のWebフォントに差し替わった後の
   本当の高さ（特に縦組み日本語は書体でかなり変わる）とズレる。
   結果、CONTACT/ABSTRACTS等コンテンツ量の多い箱で、クランプ計算が実際より
   低い高さを前提に行われ、下端がホットスポットの帯まで食い込んで文字が
   重なって見えていた。フォント確定後に一度だけ測り直す */
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    domAnchors.forEach((a) => { a.baseW = 0; a.baseH = 0; });
  });
}

/* 谷の詩は3D投影しない（絵に紐づかず、霧そのものの中に漂う言葉なので画面固定） */
VALLEY_LINES.forEach((v) => {
  const el = document.createElement("p");
  el.className = "valley-line";
  const jp = document.createElement("span");
  jp.className = "valley-line__jp";
  /* 狭い幅では和文が2行に折り返るが、日本語は分かち書きしないので
     ブラウザ任せだと「や／わらかい」「追い／ついてくる」のように
     語の途中で割れる。読点で明示的に割る（旧サイトの2行組と同じ）。
     縦組みのデスクトップでは <br> が新しい列を作ってしまうので、
     CSS側で display:none にして1列のまま見せる */
  const cut = v.jp.indexOf("、");
  if (cut > 0) {
    jp.appendChild(document.createTextNode(v.jp.slice(0, cut + 1)));
    const br = document.createElement("br");
    br.className = "valley-line__br";
    jp.appendChild(br);
    jp.appendChild(document.createTextNode(v.jp.slice(cut + 1)));
  } else {
    jp.textContent = v.jp;
  }
  el.appendChild(jp);
  if (v.en) {
    const en = document.createElement("span");
    en.className = "valley-line__en";
    en.lang = "en";
    en.textContent = v.en;
    el.appendChild(en);
  }
  document.body.appendChild(el);
  v.el = el;
});

/* updateAnchors 内の距離拡縮の上限（クランプの安全マージン計算でも使う） */
const ANCHOR_SCALE_MAX = 1.08;

const _v = new THREE.Vector3();
const _focus = new THREE.Vector3();
/* 箱の素の実寸（transform 適用前）を控える。getBoundingClientRect は毎フレーム当てている
   transform（scale）込みの値を返すので、採寸のタイミング次第で寸法が揺れ、クランプが
   効いたり効かなくなったりする。offsetWidth/Height は transform の影響を受けない */
function measureAnchor(a) {
  const w = a.el.offsetWidth, h = a.el.offsetHeight;
  if (!w && !h) return; /* まだレイアウトされていない（フォント待ち等）。次の機会に測る */
  a.baseW = w;
  a.baseH = h;
}
function updateAnchors() {
  for (const a of domAnchors) {
    _v.copy(a.pos).project(camera);
    if (_v.z > 1) { a.el.style.opacity = "0"; continue; }
    let x = (_v.x * 0.5 + 0.5) * innerWidth;
    let y = (-_v.y * 0.5 + 0.5) * innerHeight;
    /* 拡縮はクランプの余白計算にも要るので、先に出しておく。
       以前は「最大拡大率(1.08)で拡大されたら」を常に見込んでいたため、実際には
       画面に収まる箱まで"収まらない"と誤判定され、逃がし処理で中央へ落ちて
       ホットスポットに被っていた。いま実際に当てる倍率で測る */
    _wp.copy(a.pos).applyMatrix4(camera.matrixWorldInverse);
    const d = -_wp.z;
    /* 距離による拡縮の幅を狭め、遠い情景でも小さくなりすぎない／近くても大きすぎない。
       ABOUTのように長文で高さの余裕が少ない箱は、拡大するほど画面の天地から
       はみ出しやすくなるため、拡縮そのものを止めて常に基準サイズで見せる */
    const scale = a.noScale ? 1 : THREE.MathUtils.clamp(6.4 / d, 0.82, ANCHOR_SCALE_MAX);
    /* 見切れ防止：3D投影は保ちつつ、箱の中心を画面マージン内に収める。
       画角が極端に狭くなるモバイル縦持ちでは、既定の範囲だけでは
       クリックの主導線（ホットスポット）まで画面外に出てしまうため、
       要素ごとに専用のクランプ矩形を持てるようにする */
    if (a.clamp) {
      /* 起動時の採寸はフォント読込前だと0になり、そのまま高さ0扱いでクランプが
         素通りしていた（詩コピーの裾がホットスポットに被る原因）。測れるまで測り直す */
      if (!a.baseH) measureAnchor(a);
      const r = a.clampRect || { x0: 0.16, x1: 0.6, y0: 0.2, y1: 0.72 };
      /* 中心をクランプするだけでは、箱の半分幅が画面外に出ることがある
         （.xp-copy は max-width が vw基準で、狭い画面ほど相対的に大きい）。
         実測した半分幅ぶんだけ、許容範囲を内側へ詰める。詰めた結果
         範囲が反転するほど箱が大きい（狭い画面 + clampRect自体が元々
         PC想定で狭い）場合、以前は画面比率の中間点へ逃げていたが、
         その中間点自体が箱の半分幅より画面端に近いと結局はみ出していた
         （実測：ABOUT実測幅317pxに対しclampRectの中間点は142.5pxしかなく、
         左に16pxはみ出した）。今は「画面全体」を最終的な安全域として使い、
         箱の両端が画面内に収まる位置へ寄せる */
      const hw = ((a.baseW || 0) * scale) / 2;
      let xLo = innerWidth * r.x0 + hw;
      let xHi = innerWidth * r.x1 - hw;
      if (xLo > xHi) {
        const pad = 8, lo2 = hw + pad, hi2 = innerWidth - hw - pad;
        xLo = xHi = lo2 <= hi2 ? THREE.MathUtils.clamp(innerWidth / 2, lo2, hi2) : innerWidth / 2;
      }
      x = THREE.MathUtils.clamp(x, xLo, xHi);

      const hh = ((a.baseH || 0) * scale) / 2;
      let yLo = innerHeight * r.y0 + hh;
      let yHi = innerHeight * r.y1 - hh;
      if (yLo > yHi) {
        /* 帯に収まりきらない高い箱（詩＋英訳が2行になるSNAPS、詩＋本文のCONTACT等）は、
           以前は画面の天地中央へ逃がしていた。それだと箱の裾が下へ伸び、真下の帯に置いた
           ホットスポット（唯一のクリック導線）と重なって両方読めなくなる。
           中央ではなく「その箱に与えられた帯の上端」から吊るし、下に逃げ場を残す */
        const pad = 8, lo2 = hh + pad, hi2 = innerHeight - hh - pad;
        const top = innerHeight * r.y0 + hh;
        yLo = yHi = lo2 <= hi2 ? THREE.MathUtils.clamp(top, lo2, hi2) : innerHeight / 2;
      }
      y = THREE.MathUtils.clamp(y, yLo, yHi);

      /* コピー箱の裾を実測して、そこより下へ逃がす。帯の方が既に下にある
         （＝画面が十分高い）場合は Math.max が効かないので何も起きない。
         画面下端は超えられないので、そこで頭打ちにする */
      /* getBoundingClientRect はレイアウトを強制的に再計算させる。この
         ループは毎フレーム全アンカーへ transform を書いているので、
         書き→読み→書き→読み と交互になり本物のスラッシングになる。
         コピー箱は同じループの手前で処理済みなので、その時の中心 y と
         倍率を控えておけば DOM を読まずに裾が出せる（transform は
         translate(-50%,-50%) なので y は中心、高さは baseH * scale） */
      if (a.isHotspot && a.avoid && a.avoid._y != null && a.avoid.baseH && a.avoid._op > 0.02) {
        const bottom = a.avoid._y + (a.avoid.baseH * a.avoid._scale) / 2;
        const GAP = 10;
        const capLo = hh + 8, capHi = innerHeight - hh - 8;
        if (capLo <= capHi) {
          y = THREE.MathUtils.clamp(Math.max(y, bottom + hh + GAP), capLo, capHi);
        }
      }
    }
    /* ピント面は「カメラが実際に見ている点」＝そのエリアの注視点に置く。
       以前は全エリア共通の固定距離だったため、寄りの強いカット（CONTACTの綿毛接写など）
       では文字がピント面から大きく外れ、着地しても読みづらいままボケていた。
       d はカメラ空間の奥行きなので、ピント側も同じ奥行きで測る（直線距離と混ぜない） */
    let focusDist = FOCUS_DIST;
    if (a.area && a.area.center) {
      _focus.copy(a.area.center).applyMatrix4(camera.matrixWorldInverse);
      focusDist = -_focus.z;
    }
    /* コピーは読ませたいのでボケは弱め、拡大は控えめ。
       文字の箱は注視点ぴったりではなく少し手前・脇に置いてあるので、実際のレンズと
       同じく被写界深度（DOF）の幅を持たせる。これが無いと、着地して読ませたい場面でも
       常に 0.2〜0.4px 残って小さな文字がにじむ。移動中は差が大きいのでボケは効いたまま */
    const DOF = 1.25;
    const defocus = Math.max(0, Math.abs(d - focusDist) - DOF);
    const blur = a.sharp ? 0 : THREE.MathUtils.clamp(defocus * 0.28, 0, 3);
    let proximity;
    /* 消え際に余韻を残す。素の距離比をそのまま不透明度にすると、
       情景コピーは w が 0.4 を切った時点で完全に消えていた（実測で
       進行度にして 0.034 ぶんしか猶予が無く、読み終わる前に消える）。
       ①ゼロになる位置を遠くへ延ばして猶予そのものを広げ、
       ②べき 0.72 の曲線を掛けて、中盤を高いまま保たせる。
       これが無いと、線形なので「すっと均等に消える」＝素っ気なくなる */
    const LINGER = 0.72;
    if (a.beatT !== null) {
      /* ビート：窓を広げ、しっかり見える区間を長く */
      proximity = THREE.MathUtils.clamp(1 - Math.abs(rig.progress - a.beatT) / 0.15, 0, 1);
      proximity = Math.pow(Math.min(1, proximity * 1.35), LINGER);
    } else {
      const w = a.area ? a.area.currentW : 1;
      proximity = Math.pow(THREE.MathUtils.clamp((w - 0.22) / 0.6, 0, 1), LINGER);
    }
    /* 同フレームの後続アンカー（ホットスポット）が裾を知るために控える */
    a._y = y; a._scale = scale; a._op = proximity;
    a.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    a.el.style.filter = `blur(${blur.toFixed(2)}px)`;
    a.el.style.opacity = (proximity * (rig.entered ? 1 : 0)).toFixed(2);
    a.el.style.pointerEvents = proximity > 0.5 ? "auto" : "none";
    /* 見えていないホットスポットがTabで踏めてしまうと、フォーカスの
       所在が画面上どこにも見えなくなる。視覚状態とフォーカス可能状態を揃える */
    if (a.isHotspot) a.el.tabIndex = proximity > 0.5 ? 0 : -1;
  }
}

/* ============================================================
   クリック：エリア → ギャラリー / CONTACT → メール
============================================================ */
const raycaster = new THREE.Raycaster();
let galleryOpen = false;

/* 部屋（写真の一覧）にいる間だけ現れる「戻る」ボタン。ESCキー任せにしない */
const roomBack = document.getElementById("roomBack");
roomBack.addEventListener("click", (e) => {
  e.stopPropagation();
  if (galleryOpen) closeGallery();
});

const zoomCloseBtnEl = document.getElementById("zoomClose");
if (zoomCloseBtnEl) {
  zoomCloseBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    closeZoom();
  });
}

/* ============================================================
   情景 → 写真ページの遷移
   「絵が写真に変わる」のではなく「時間を巻き戻して、絵がまだ写真だった頃に還る」。
   鉛筆の線が先に消え、残った色面が明るい方から分解し、その隙間から写真が立ち上がる。
   ＝「線を引いて、彩色した」制作順の逆再生。カメラは動かさない（動くのは絵の"素材"だけ）。
============================================================ */
const paperFx = document.getElementById("paperFx");

/* ============================================================
   案K：遷移を作らない。写真ページは"演出"ではなく回廊の奥にある場所で、
   クリックするとカメラがそこへ進むだけ。切り替わる瞬間が存在しない。
   （Codrops「3Dシーンを破棄しない」設計を、1シーン内で完結させた形）
============================================================ */
/* 掛かった写真1枚ぶんのマテリアル。
   ・パララックス：画面内の位置に応じて、枠は動かさず中の像だけが逆に流れる
     （Codrops「Creating a Smooth Horizontal Parallax Gallery」の考え方。
      像を一回り大きく取って、その余白の内側でだけ動かす）
   ・ホバー：カーソルの周りの柔らかい円の中だけ、UVがカーソルへ引き寄せられる
     （Codrops / akella「Interactive WebGL Hover Effects」の mix(uv, mouse, circle)）
   原典のRGBずれは、このサイトのトーンでは即座に安っぽくなるので採っていない。 */
function makeRoomPhotoMat(tex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uOpacity: { value: 0 },
      uHover: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uParallax: { value: 0 },
      uFogDensity: { value: 0.02 },
      uBg: { value: BG },
      uDist: { value: 10 },
      uDim: { value: 0 }, /* 触れていない他の写真が引く量 */
      /* 印画紙。板の実寸と、プリント／像それぞれの矩形（板の中の座標） */
      uPlane: { value: new THREE.Vector2(1, 1) },
      uPrint: { value: new THREE.Vector4(0, 0, 1, 1) },
      uPhoto: { value: new THREE.Vector4(0, 0, 1, 1) },
      uPaper: { value: new THREE.Color("#fdfdfb") },
      uShadow: { value: new THREE.Color("#4a453d") },
      /* 極端な縦長・横長は表示上のプリント幅をクランプするので、
         そのぶん像側は中心から拡大してクロップする（対象そのものは歪めない） */
      uCrop: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform float uOpacity, uHover, uParallax, uFogDensity, uDist, uDim;
      uniform vec2 uMouse, uPlane;
      uniform vec4 uPrint, uPhoto;   /* 板の中での矩形（lo.xy, hi.xy） */
      uniform vec3 uBg, uPaper, uShadow;
      uniform vec2 uCrop;
      varying vec2 vUv;

      /* 矩形までの符号付き距離。内側が負になるので、境界の太さが測れる */
      float sdRect(vec2 p, vec2 lo, vec2 hi) {
        vec2 d = max(lo - p, p - hi);
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
      }
      float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

      /* 露出補正のためだけにリニア空間へ往復する（紙・影・合成は今まで通りsRGB値のまま
         扱う＝見た目を変えない。ここをリニアのまま混ぜると、影のグラデーションが
         知覚上より急に立ち上がって「影が濃く／不自然」に見えてしまう） */
      vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
      vec3 linearToSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

      void main() {
        vec2 p = vUv * uPlane;

        /* シェーダーの中で作った境界には MSAA が効かない。
           距離の変化量（fwidth）で自前にぼかすと、初めて縁が滑らかになる */
        float dPrint = sdRect(p, uPrint.xy, uPrint.zw);
        float aP = fwidth(dPrint) * 0.9 + 1e-5;
        float inPrint = 1.0 - smoothstep(-aP, aP, dPrint);

        float dPhoto = sdRect(p, uPhoto.xy, uPhoto.zw);
        float aH = fwidth(dPhoto) * 0.9 + 1e-5;
        float inPhoto = 1.0 - smoothstep(-aH, aH, dPhoto);

        /* 落ち影は二層。ひとつの大きなボケ影にすると、途端に作り物に見える。
           実物は「縁に密着した狭く濃い影」と「広くてごく淡い影」でできている */
        vec2 so1 = vec2(0.012, -0.016);
        float dSh1 = sdRect(p, uPrint.xy + so1, uPrint.zw + so1);
        float contact = (1.0 - smoothstep(0.0, 0.075, dSh1)) * 0.22;
        vec2 so2 = vec2(0.025, -0.040);
        float dSh2 = sdRect(p, uPrint.xy + so2, uPrint.zw + so2);
        float ambient = (1.0 - smoothstep(0.0, 0.30, dSh2)) * 0.06;
        float shadow = contact + ambient * (1.0 - contact);

        /* 像。一回り内側に取り、その余白の中でだけ流す＝端が破綻しない */
        vec2 f = (p - uPhoto.xy) / max(uPhoto.zw - uPhoto.xy, vec2(0.0001));
        vec2 uv = (f - 0.5) * 0.9 * uCrop + 0.5;
        uv.x += uParallax * 0.04;
        uv -= (uMouse - 0.5) * 0.04 * uHover;   /* 枠の中の奥行き */
        float dm = distance(vUv, uMouse);
        float circle = smoothstep(0.55, 0.0, dm);
        uv += (uMouse - vUv) * 0.04 * circle * uHover;
        vec3 img = srgbToLinear(texture2D(uTex, clamp(uv, 0.0, 1.0)).rgb);
        /* 露出を持ち上げる（紙・影には掛けず、写真本体だけ）。
           乗算だけだとハイライトから飽和するので、暗部を持ち上げる補正も併用する。
           元の値（0.82 / 1.15→0.75 / 1.22→0.70 / 1.27）から、
           まだ暗いとの指摘を受けさらにもう一段明るく */
        img = pow(img, vec3(0.64)) * 1.33;
        img = linearToSrgb(img); /* ここでsRGB値に戻す。以降は他の色と同じ空間で混ぜる */
        img = mix(img, img * 1.06, circle * uHover);

        /* 印画紙。粒も縁の沈みも、気づかない程度で十分。強くすると版画に見える */
        float g = (rnd(floor(p * 620.0)) - 0.5) * 0.011;
        vec3 paper = uPaper + g;
        paper *= 1.0 - smoothstep(0.028, 0.0, abs(dPrint)) * 0.035;

        vec3 printCol = mix(paper, img, inPhoto);

        /* プリントからはみ出た分だけ影が出る */
        float aSh = shadow * (1.0 - inPrint);
        float a = inPrint + aSh;
        vec3 col = (printCol * inPrint + uShadow * aSh) / max(a, 0.0001);

        /* 触れていない他の写真は、彩度と濃度を落として引く（誌面の"効かせ"） */
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(lum), uDim * 0.8);
        col = mix(col, uBg, uDim * 0.26);

        /* 物として立たせたいので、霧に溶かしきらない */
        float fog = (1.0 - exp(-uFogDensity * uFogDensity * uDist * uDist)) * 0.5;
        gl_FragColor = vec4(mix(col, uBg, fog), a * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/* 印画紙のプリント寸法。一覧（壁）と拡大表示の両方で使うのでモジュール直下に置く。
   板の高さは全部そろえ、その内側に印画紙のフチを取る。下だけ広いのは実プリントの体裁。 */
const ROW_H = 2.6, ROOM_GAP = 0.14;
const EDGE = 0.13, EDGE_BOTTOM = 0.30;
/* 落ち影を描くための余白。広い側の影（半径0.30）が板の外へ切れないだけ取る。
   見た目の間隔は GAP + PAD*2 で決まるので、PAD を増やしたぶん GAP を減らす */
const ROOM_PAD = 0.34;
/* プリントの縦横比が極端だと並びがガタつくので、一覧では表示上の幅をこの範囲に収める。
   はみ出た分は像の側で中心を保ったままクロップする（対象そのものは歪めない） */
const AR_MIN = 0.72, AR_MAX = 1.35;

/* 印画紙の色そのままの1x1テクスチャ。読み込み前・解放後の板はこれを指し、
   「白紙」として見える（真っ黒や未定義の描画にはならない）。
   全メッシュで共有するので生成は1回だけ */
const ROOM_PLACEHOLDER_TEX = new THREE.DataTexture(
  new Uint8Array([253, 253, 251, 255]), 1, 1, THREE.RGBAFormat
);
ROOM_PLACEHOLDER_TEX.needsUpdate = true;

/* 各シリーズは最大20枚超の実写真を持ち、全部を開いた瞬間に一括ロードすると
   フル解像度テクスチャがまとめてVRAMに乗ってGPUメモリを圧迫する。
   正面から見えている範囲＋前後の余白（ウィンドウ）だけを実体化し、
   外れたらdisposeして解放する */
/* タッチ端末はGPU/帯域が細く、同時に実体化する枚数が多いほど
   フレームが重くなり、横送り自体がもっさりして見える。窓を絞って
   同時ロード数を減らす（PCと同じ6枚窓のままでは、実機での重さが
   横スクロールの追従の遅さとして体感されていた）。3.5枚窓
   （＝前後合わせて実質7枚同時実体化）でもiPhone実機ではまだ重く、
   画面に同時に見えるのはせいぜい1〜2枚なので、前後2枚ぶんの
   先読みが確保できる線まで絞る */
const ROOM_WINDOW_RADIUS = (ROW_H * 1.5 + ROOM_GAP) * (IS_TOUCH ? 2.2 : 6);

/* 壁掛け表示は3D空間内の小さな板で、画面上の占有率も低い。
   フル解像度（最大2048px、平均400KB超）は明らかに過剰品質なので、
   一覧では960px版のサムネイル（平均66KB程度）を使い、拡大して
   見る時だけ（openZoomで）フル解像度へ差し替える */
function thumbUrl(url) {
  const i = url.lastIndexOf("/");
  return url.slice(0, i + 1) + "thumb/" + url.slice(i + 1);
}
function ensureRoomTexture(m) {
  const d = m.userData;
  if (d.loaded || d.loading) return;
  d.loading = true;
  const tex = texLoader.load(thumbUrl(d.url), () => {
    d.loading = false;
    d.loaded = true;
    d.tex = tex;
    m.material.uniforms.uTex.value = tex;
    /* 拡大中に届いた場合、その板が拡大対象でなければ伏せたままにする
       （出さないと、隣が後から浮かび上がってくる） */
    const shown = activeRoom && activeRoom.zoomed && activeRoom.zoomed !== m ? 0 : 1;
    gsap.to(m.material.uniforms.uOpacity, { value: shown, duration: 0.5, ease: "power2.out" });
    if (d.area._room) d.area._room.relayout();
    refitZoom(m);   /* 拡大中に届いた場合、拡大側の寸法も実寸で引き直す */
  }, undefined, () => {
    d.loading = false;
    trackEvent("asset_load_error", { type: "photo_thumb", area: d.area ? d.area.name : null, url: thumbUrl(d.url) });
  });
  tex.colorSpace = THREE.SRGBColorSpace;
}
/* 大きく見る時だけは960pxサムネイルでは粗さが見えるため、フル解像度へ
   差し替える。d.tex（=現在表示中のテクスチャ）自体を置き換えることで、
   releaseRoomTexture が呼ばれた時にサムネイル/フルのどちらでも正しく
   dispose される（差し替え忘れて2枚分GPUメモリに残ることがない） */
function ensureFullTexture(mesh) {
  const d = mesh.userData;
  if (d.isFull || d.fullLoading) return;
  d.fullLoading = true;
  texLoader.load(d.url, (fullTex) => {
    d.fullLoading = false;
    d.isFull = true;
    fullTex.colorSpace = THREE.SRGBColorSpace;
    if (d.tex) d.tex.dispose();
    d.tex = fullTex;
    if (activeRoom && activeRoom.zoomed === mesh) mesh.material.uniforms.uTex.value = fullTex;
    if (d.area && d.area._room) d.area._room.relayout();
    refitZoom(mesh);
  });
}
/* 拡大の寸法は bringToFront が「その時点で判っている縦横比」で決めて
   GSAP に焼き込む。テクスチャがまだ届いていないと
   ar = im && im.width ? im.width/im.height : 1.5（＝3:2の横位置）と
   決め打ちするため、縦位置の写真が横フレームに引き伸ばされたまま固定される。
   しかも uCrop は (1,1) へ tween されるので像がそのまま歪む。
   実測: 収録99点のうち54点（55%）が縦位置(2:3)で、この決め打ちは
   過半数で外れる。写真家のポートフォリオで作品を誤った縦横比で見せるのは
   起こしうる中で最悪に近い。実寸が判った時点で組み直す。 */
function refitZoom(mesh) {
  if (!activeRoom || activeRoom.zoomed !== mesh) return;
  const u = mesh.material.uniforms;
  /* 開く途中で届くこともある。同じプロパティを二重に動かさないよう、
     先に走っている tween を止めてから引き直す */
  gsap.killTweensOf([mesh.position, mesh.scale, u.uPlane.value, u.uPrint.value, u.uPhoto.value, u.uCrop.value]);
  bringToFront(mesh, gsap.timeline(), 0, 0.3);
}

function releaseRoomTexture(r, m) {
  const d = m.userData;
  if (!d.loaded) return;
  if (m === r.zoomed || (r.locked && r.locked.has(m))) return; /* 見ている最中/退避中は保持 */
  d.tex.dispose();
  d.tex = null;
  d.loaded = false;
  d.isFull = false; /* 解放時はフル解像度への差し替え状態も忘れる。再びウィンドウに
                        入った時はサムネイルから、次に見られたらまたフルへ差し替える */
  m.material.uniforms.uTex.value = ROOM_PLACEHOLDER_TEX;
}

function buildPlaceRoom(area) {
  if (area._room) return area._room;
  const dir = area.center.clone().sub(area.viewPos).setY(0).normalize();
  const right = new THREE.Vector3(-dir.z, 0, dir.x);
  const room = new THREE.Group();
  const mats = [], meshes = [];
  /* このシリーズの写真だけを掛ける。他エリアと混ざると「見ているもの」が
     不明瞭になるため、部屋はカテゴリごとに独立させる */
  const shots = (area.photos || []).map(([u, c, award]) => ({ u, c, award, ar: area }));
  const startIdx = 0;
  const GAP = ROOM_GAP, PAD = ROOM_PAD;
  const yBase = GROUND_Y + 2.5;
  const faceY = Math.atan2(-dir.x, -dir.z);
  shots.forEach((s, i) => {
    /* 実写真はここでロードしない。updateRoomのウィンドウ判定が、
       正面付近に来たものだけ ensureRoomTexture() で実体化する */
    const mat = makeRoomPhotoMat(ROOM_PLACEHOLDER_TEX);
    mats.push(mat);
    /* 1×1で作り、実際の縦横比が判った時点でスケールで整える */
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.rotation.y = faceY;
    m.userData = {
      idx: i, tex: null, url: s.u, loaded: false, loading: false,
      cap: s.c, award: s.award, area: s.ar, baseY: yBase, w: ROW_H * 1.5, h: ROW_H,
    };
    room.add(m);
    meshes.push(m);
  });

  /* 幅が判ってから並べ直す。写真は読み込み順が揃わないので、都度やる */
  let positions = [];
  function layout() {
    for (const m of meshes) {
      const im = m.userData.tex && m.userData.tex.image;
      const ar = im && im.width ? im.width / im.height : 1.5;
      /* 表示上の幅は範囲内に収め、はみ出た比率ぶんだけ像をクロップする */
      const dispAr = THREE.MathUtils.clamp(ar, AR_MIN, AR_MAX);
      const ph = ROW_H - EDGE - EDGE_BOTTOM;
      const pw = ph * dispAr;
      const printW = pw + EDGE * 2;
      const crop = new THREE.Vector2(
        ar > dispAr ? dispAr / ar : 1,
        ar < dispAr ? ar / dispAr : 1
      );
      /* 板 ＝ プリント ＋ 影のための余白 */
      const w = printW + PAD * 2, h = ROW_H + PAD * 2;
      m.userData.w = w;
      m.userData.h = h;
      /* 画面に合わせる時は板ではなくプリントの寸法を使う（板は影の余白を含む） */
      m.userData.printW = printW;
      m.userData.printH = ROW_H;
      m.scale.set(w, h, 1);
      const u = m.material.uniforms;
      u.uPlane.value.set(w, h);
      /* 板の中でのプリントと像の位置（左下が原点） */
      u.uPrint.value.set(PAD, PAD, PAD + printW, PAD + ROW_H);
      u.uPhoto.value.set(PAD + EDGE, PAD + EDGE_BOTTOM, PAD + EDGE + pw, PAD + ROW_H - EDGE);
      u.uCrop.value.copy(crop);
    }
    const total = meshes.reduce((s, m) => s + m.userData.w, 0) + GAP * (meshes.length - 1);
    let cur = -total / 2;
    positions = [];
    for (const m of meshes) {
      const cx2 = cur + m.userData.w / 2;
      const targetPos = area.center.clone().addScaledVector(dir, 9.5).addScaledVector(right, cx2);
      targetPos.y = yBase;
      /* 初回配置（まだ画面に見えていない組み立て中）はジャンプで問題ないが、
         2回目以降（写真の読み込みが進んで実サイズが判明するたびに呼ばれる）
         は、事前の先読み（updateCamera側）で大半は防げるものの、それでも
         間に合わなかった写真では位置が変わる。ここは滑らかな移動にして、
         万一のズレを「整列し直す」動きに見せる（ジャンプに見せない） */
      if (m.userData.laidOut) {
        gsap.to(m.position, {
          x: targetPos.x, y: targetPos.y, z: targetPos.z,
          duration: 0.4, ease: "power2.out",
        });
      } else {
        m.position.copy(targetPos);
        m.userData.laidOut = true;
      }
      m.userData.centerOff = cx2;
      positions.push(cx2);
      cur += m.userData.w + GAP;
    }
    if (area._room) {
      area._room.span = total / 2;
      area._room.positions = positions;
      /* 幅は写真が読めるまで判らないので、並べ直すたびに見る位置も取り直す。
         これをしないと、狙った1枚が正面から外れたままになる（＝どこにも触れない）。
         current は動かさず target だけ更新する＝読み込みが進むたびに列がガクッと
         飛ぶのではなく、常になめらかに寄り続けるだけになる。
         ただし部屋を開いた直後・まだ1枚も実写真が読めていない最初の確定だけは例外。
         暫定aspect(1.5)で組んだ仮レイアウトから実レイアウトへ target が大きく
         動くため、current が「なめらかに」追いつく間、選んだ1枚が半分近く
         画面外へ出たまま数百ms〜1秒ほど留まって見えていた。初回の確定でだけ
         current も一緒に飛ばし、以後の微調整はこれまで通りなめらかに追わせる */
      if (area._room.snapPending) {
        const snapTarget = positions[area._room.startIdx] || 0;
        roomScroll.target = snapTarget;
        if (!area._room.hasSnappedOnce) {
          roomScroll.current = snapTarget;
          area._room.hasSnappedOnce = true;
        }
      }
    }
  }
  layout();

  scene.add(room);
  /* 部屋は近づいた時点で先に組んでおく（openGallery内で初めて組むと、写真枚数分の
     生成コストが1フレームに乗って動きがカクつく）。ただし組んだだけで見せてはいけない。
     旅の途中で回廊の奥に写真の列が並んで見えてしまうので、開くまで伏せておく */
  room.visible = false;
  const view = area.center.clone().addScaledVector(dir, 3.4);
  view.y = GROUND_Y + 2.35;
  const look = area.center.clone().addScaledVector(dir, 9.5);
  look.y = yBase;
  const total0 = meshes.reduce((s, m) => s + m.userData.w, 0) + GAP * (meshes.length - 1);
  /* i 番目の写真を正面に持ってくるためのスクロール量 */
  const offsetOf = (i) => (area._room && area._room.positions ? area._room.positions[i] : positions[i]) || 0;
  area._room = {
    group: room, mats, meshes, view, look, right,
    dirX: dir.x, dirZ: dir.z, /* 傾きを足す時に、正面の向きへ戻す基準が要る */
    span: total0 / 2, positions, startIdx, offsetOf, relayout: layout,
  };
  return area._room;
}

/* ============================================================
   1枚を選んで大きく見る。
   ここでもオーバーレイは被せない。選んだ写真が壁から外れて手前へ来て、
   その背後に紙が敷かれる。DOMの箱を開くのではなく、空間の中の出来事にする。
============================================================ */
const zoomCap = document.getElementById("zoomCap");
if (IS_TOUCH && zoomCap) {
  /* タッチ端末はズーム中のスワイプ送りに未対応なので、実際に効く操作
     （タップで戻る）だけを案内する。矢印キーの案内は物理キーボードが
     無い前提だと誤解を招く */
  const zoomHint = zoomCap.querySelector(".zoom-cap__hint");
  if (zoomHint) zoomHint.textContent = "TAP TO RETURN";
}
/* 拡大表示で印画紙が占める画面高の上限。
   一度これを 0.76 まで下げ、空いた下の帯にキャプションを逃がしたことが
   あるが、横位置で画面幅の58.8%、縦位置で28.1%まで縮み、
   「作品が画面を支配する瞬間が一度も来ない」状態になった。
   キャプションは排他配置ではなく、サイト共通の4層ハローで
   絵の上に重ねる（.xp-copy__col と同じ手当て）ほうが正しい。 */
const ZOOM_FIT_H = 0.86;

const _fwd = new THREE.Vector3();
const _wp2 = new THREE.Vector3();
const _up2 = new THREE.Vector3();
let zoomTl = null;

/* 拡大中に隣のプリントが読めてしまう件。
   下地（r.backdrop）は renderOrder -1 かつ depthWrite:false で先に描かれるため、
   他のプリント（renderOrder 0）は距離に関係なくその上に乗る。
   紙を一枚敷くだけでは隠せないので、拡大している間は他の板を伏せる。
   未読込の板は元から uOpacity 0 なので、戻すときも 0 のままにする。 */
function setSiblingOpacity(r, keep, tl, at) {
  for (const m of r.meshes) {
    const target = m === keep ? 1 : (keep ? 0 : (m.userData.loaded ? 1 : 0));
    const u = m.material.uniforms.uOpacity;
    if (tl) tl.to(u, { value: target, duration: 0.45, ease: "power2.out" }, at);
    else gsap.to(u, { value: target, duration: 0.45, ease: "power2.out" });
  }
}

function zoomCapText(mesh, n, total) {
  const label = `${String(n + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  if (!zoomCap) return;
  const d = mesh.userData;
  /* EXHIBITIONSの受賞歴は、以前は詩コピー画面にまとめて出していたが、
     モバイルでは詩＋英訳＋展示歴2件で箱が縦に長くなりすぎ、下の
     ホットスポットと文字が重なっていた。作品ごとの実績なので、
     その写真を実際に開いた時（ここ）に出す方が自然かつ場所も足りる */
  const meta = d.award ? `${d.area.name} · ${d.award}` : d.area.name;
  zoomCap.querySelector(".zoom-cap__num span").textContent = label;
  zoomCap.querySelector(".zoom-cap__title span").textContent = String(d.cap || "");
  zoomCap.querySelector(".zoom-cap__meta span").textContent = meta;
  const live = document.getElementById("zoomLive");
  if (live) live.textContent = `${d.area.name}、${n + 1} / ${total}、${d.cap || ""}${d.award ? "、" + d.award : ""}`;
}

/* 動いている最中の1枚は、毎フレームの姿勢計算から外す。
   外さないと updateRoom が壁の値で上書きし、アニメーションと取り合って跳ねる */
function lockMesh(r, mesh) {
  if (!r.locked) r.locked = new Set();
  r.locked.add(mesh);
}
function unlockMesh(r, mesh) {
  if (r.locked) r.locked.delete(mesh);
}

/* 選んだ1枚をカメラの正面へ持ってくる。姿勢は全部ここで決める。
   一覧では並びを揃えるために幅をクランプ・クロップしているが、
   拡大して1枚だけ見せる時にクロップされたままでは作品として不誠実なので、
   ここで印画紙の矩形を実際の縦横比に組み直し、クロップを解く。 */
function bringToFront(mesh, tlLocal, at, dur) {
  const r = activeRoom, d = mesh.userData;
  const im = d.tex && d.tex.image;
  const ar = im && im.width ? im.width / im.height : (d.printW - EDGE * 2) / (ROW_H - EDGE - EDGE_BOTTOM);
  const ph2 = ROW_H - EDGE - EDGE_BOTTOM;
  const pw2 = ph2 * ar;
  const printW2 = pw2 + EDGE * 2;

  const D = 3.3;
  camera.getWorldDirection(_fwd);
  const vh = 2 * D * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const vw = vh * camera.aspect;
  /* 画面に収める基準は「プリントの実寸（クランプ前）」 */
  /* モバイルは画面自体が狭く、PC想定の74%幅だと写真がひとまわり
     小さく見えていた。タッチ端末は使える横幅の上限を引き上げる */
  /* 以前は高さの上限が 0.86 で、印画紙が画面中央に置かれていた。
     1280x720 では上下の余白が各50pxしか残らず、左下のキャプション
     （番号・タイトル・メタ・操作ヒントの4行・約100px）が完全に写真の上に
     乗っていた。実測で見出し幅286pxのうち150px（52%）が写真に重なり、
     暗い写真ではタイトルが読めなくなっていた。1920では13%まで減るので、
     いちばん台数の多いノートPC幅で最悪になる。
     写真は小さくなるが、作品を見る主画面で文字が像に乗るほうが損。 */
  const k = Math.min((vh * ZOOM_FIT_H) / ROW_H, (vw * (IS_TOUCH ? 0.92 : 0.82)) / printW2);
  const w2 = (printW2 + ROOM_PAD * 2) * k, h2 = (ROW_H + ROOM_PAD * 2) * k;
  _wp2.copy(camera.position).addScaledVector(_fwd, D).sub(r.group.position);
  /* 中央に置く。キャプションはハローで絵の上に重ねるので、
     下へ逃がすための持ち上げは要らない */

  if (!d.homePos) {
    d.homePos = mesh.position.clone();
    d.homeQuat = mesh.quaternion.clone();
    d.homeScale = mesh.scale.clone();
    const u0 = mesh.material.uniforms;
    d.homeUniforms = {
      plane: u0.uPlane.value.clone(), print: u0.uPrint.value.clone(),
      photo: u0.uPhoto.value.clone(), crop: u0.uCrop.value.clone(),
    };
  }

  const u = mesh.material.uniforms;
  /* GSAPはquaternionのx/y/z/wを独立したスカラーとして線形補間するため、
     中間フレームでノルムが1未満になり板がわずかに縮んで見える。
     進捗だけをtweenし、実際の回転はslerpQuaternionsで求める */
  const q0 = mesh.quaternion.clone();
  const q1 = camera.quaternion.clone();
  if (q0.dot(q1) < 0) q1.set(-q1.x, -q1.y, -q1.z, -q1.w); /* 短い方の弧を選ぶ */
  const qs = { t: 0 };
  tlLocal
    .to(mesh.position, { x: _wp2.x, y: _wp2.y, z: _wp2.z, duration: dur }, at)
    .to(mesh.scale, { x: w2, y: h2, duration: dur }, at)
    .to(qs, {
      t: 1, duration: dur,
      onUpdate: () => mesh.quaternion.slerpQuaternions(q0, q1, qs.t),
    }, at)
    /* uPlane はワールドサイズの基準（scale と常に一致させる）なので同じ値を渡す */
    .to(u.uPlane.value, { x: w2, y: h2, duration: dur }, at)
    .to(u.uPrint.value, {
      x: ROOM_PAD * k, y: ROOM_PAD * k,
      z: (ROOM_PAD + printW2) * k, w: (ROOM_PAD + ROW_H) * k, duration: dur,
    }, at)
    .to(u.uPhoto.value, {
      x: (ROOM_PAD + EDGE) * k, y: (ROOM_PAD + EDGE_BOTTOM) * k,
      z: (ROOM_PAD + EDGE + pw2) * k, w: (ROOM_PAD + ROW_H - EDGE) * k, duration: dur,
    }, at)
    .to(u.uCrop.value, { x: 1, y: 1, duration: dur }, at);
}

/* 壁の元の場所へ返す */
function returnToWall(mesh, tlLocal, at, dur) {
  const d = mesh.userData;
  if (!d.homePos) return;
  const u = mesh.material.uniforms;
  /* bringToFront と同じ理由でslerpに置き換える */
  const q0 = mesh.quaternion.clone();
  const q1 = d.homeQuat.clone();
  if (q0.dot(q1) < 0) q1.set(-q1.x, -q1.y, -q1.z, -q1.w);
  const qs = { t: 0 };
  tlLocal
    .to(mesh.position, { x: d.homePos.x, y: d.homePos.y, z: d.homePos.z, duration: dur }, at)
    .to(mesh.scale, { x: d.homeScale.x, y: d.homeScale.y, duration: dur }, at)
    .to(qs, {
      t: 1, duration: dur,
      onUpdate: () => mesh.quaternion.slerpQuaternions(q0, q1, qs.t),
    }, at);
  if (d.homeUniforms) {
    tlLocal
      .to(u.uPlane.value, { x: d.homeUniforms.plane.x, y: d.homeUniforms.plane.y, duration: dur }, at)
      .to(u.uPrint.value, {
        x: d.homeUniforms.print.x, y: d.homeUniforms.print.y,
        z: d.homeUniforms.print.z, w: d.homeUniforms.print.w, duration: dur,
      }, at)
      .to(u.uPhoto.value, {
        x: d.homeUniforms.photo.x, y: d.homeUniforms.photo.y,
        z: d.homeUniforms.photo.z, w: d.homeUniforms.photo.w, duration: dur,
      }, at)
      .to(u.uCrop.value, { x: d.homeUniforms.crop.x, y: d.homeUniforms.crop.y, duration: dur }, at);
  }
  /* タイムライン登録時ではなく、実際に戻り切った時点で外す。
     クリックガード（locked中は開けない）と二重の保険にする */
  tlLocal.call(() => { d.homePos = null; }, null, at + dur);
}

function openZoom(mesh) {
  const r = activeRoom;
  if (!r || r.zoomed) return;
  r.zoomed = mesh;
  const d = mesh.userData;
  trackEvent("zoom_open", { area: d.area ? d.area.name : null, idx: r.meshes.indexOf(mesh) });
  ensureRoomTexture(mesh); /* ウィンドウ外から選ばれた場合に備え、確実にロードを始める */
  ensureFullTexture(mesh);

  /* 紙の下地。世界の中に敷くので、写真だけが手前に浮いて見える */
  if (!r.backdrop) {
    r.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#f4f2ec"), transparent: true, opacity: 0, depthWrite: false })
    );
    /* renderOrder は大きいほど後に描かれる＝手前に来る。
       下地は必ず写真より先に描かせないと、紙が写真を覆ってしまう */
    r.backdrop.renderOrder = -1;
    r.group.add(r.backdrop);
  }

  /* カメラの正面 D の位置に、画面いっぱい手前まで持ってくる */
  const D = 3.3;
  camera.getWorldDirection(_fwd);
  const vh = 2 * D * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  /* 下地はさらに奥に、視界を覆う大きさで */
  const BD = 4.4;
  const bh = 2 * BD * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.6;
  camera.getWorldDirection(_fwd);
  r.backdrop.position.copy(camera.position).addScaledVector(_fwd, BD).sub(r.group.position);
  r.backdrop.quaternion.copy(camera.quaternion);
  r.backdrop.scale.set(bh * camera.aspect, bh, 1);

  mesh.renderOrder = 2; /* 下地と他の写真より必ず手前へ */
  zoomCapText(mesh, r.meshes.indexOf(mesh), r.meshes.length);
  const spans = zoomCap.querySelectorAll("span");
  /* 通常の操作ヒント・波線・クレジットはzoomCapと同じ下部領域を使うため、
     特に375px前後のモバイルでは重なって読めなくなっていた。
     1枚を見ている間だけ退かせる */
  hint.classList.add("is-faded");
  const waveEl = document.querySelector(".hud__wave");
  const socialEl = document.querySelector(".hud__social");
  if (waveEl) waveEl.classList.add("is-zoom-hidden");
  /* SNSの円は閉じるボタンと重なる位置にあり、390px幅では実際に衝突して
     いた。閉じるつもりで外部サイトへ飛ぶ誤操作を防ぐため一緒に退場させる */
  if (socialEl) { socialEl.classList.add("is-zoom-hidden"); socialEl.inert = true; }
  if (roomStrip) { roomStrip.classList.add("is-zoom-hidden"); roomStrip.inert = true; }
  /* モーダルとして扱う：背景（HUD・3Dアンカー群）をinertにしてTabが
     抜けないようにし、閉じるボタンへフォーカスを移す */
  zoomCap.setAttribute("aria-modal", "true");
  zoomCap.setAttribute("aria-hidden", "false");
  if (hud) hud.inert = true;
  if (anchorsWrap) anchorsWrap.inert = true;
  const zoomCloseBtn = document.getElementById("zoomClose");
  if (zoomCloseBtn) {
    zoomCloseBtn.classList.add("is-visible");
    zoomCloseBtn.tabIndex = 0;
    zoomCloseBtn.focus();
  }

  if (zoomTl) zoomTl.kill();
  zoomTl = gsap.timeline({ defaults: { ease: "expo.out" } });
  zoomTl.to(r.backdrop.material, { opacity: 0.94, duration: 0.8, ease: "power2.out" }, 0);
  bringToFront(mesh, zoomTl, 0, 1.05);
  setSiblingOpacity(r, mesh, zoomTl, 0);   /* 拡大する1枚以外を伏せる */
  zoomFullRes = true; applyPixelRatio();   /* 作品を見せる画面だけ実解像度で描く */
  zoomTl
    .to(zoomCap, { opacity: 1, duration: 0.5 }, 0.42)
    .fromTo(spans, { yPercent: 120 }, { yPercent: 0, duration: 0.85, stagger: 0.07 }, 0.42);
  if (REDUCE_MOTION) zoomTl.timeScale(6);
}

/* 見たまま隣へ送る。いちいち壁へ戻して選び直させない */
function stepZoom(dir) {
  const r = activeRoom;
  if (!r || !r.zoomed) return;
  const i = r.meshes.indexOf(r.zoomed);
  const n = THREE.MathUtils.clamp(i + dir, 0, r.meshes.length - 1);
  if (n === i) return;
  const prev = r.zoomed, next = r.meshes[n];
  ensureRoomTexture(next); /* キーボードでウィンドウ外へ送られる場合に備える */
  prev.renderOrder = 0;
  next.renderOrder = 2;
  r.zoomed = next;
  ensureFullTexture(next); /* 送り先も同じく大きく見るので、フル解像度へ差し替える */
  lockMesh(r, prev); /* 退く1枚も、戻り切るまでは触らせない */
  /* 閉じた時にこの写真が正面に来るよう、裏で列も合わせておく */
  roomScroll.target = r.positions[n] ?? roomScroll.target;

  zoomCapText(next, n, r.meshes.length);
  const spans = zoomCap.querySelectorAll("span");
  if (zoomTl) zoomTl.kill();
  zoomTl = gsap.timeline({
    defaults: { ease: "expo.out" },
    onComplete: () => unlockMesh(r, prev),
  });
  /* 前の1枚は先に退き、入れ替わりで次が入ってくる */
  returnToWall(prev, zoomTl, 0, 0.62);
  bringToFront(next, zoomTl, 0.1, 0.9);
  setSiblingOpacity(r, next, zoomTl, 0.1);
  zoomTl
    .set(zoomCap, { opacity: 1 }, 0)
    .fromTo(spans, { yPercent: 120 }, { yPercent: 0, duration: 0.7, stagger: 0.05 }, 0.18);
  if (REDUCE_MOTION) zoomTl.timeScale(6);
}

function closeZoom() {
  const r = activeRoom;
  if (!r || !r.zoomed) return;
  const mesh = r.zoomed;
  r.zoomed = null;
  /* openZoomで退かせた部屋のヒント・波線・クレジットを戻す。
     部屋自体を出る場合は、この直後に closeGallery が改めて隠す */
  hint.classList.remove("is-faded");
  const waveEl = document.querySelector(".hud__wave");
  const socialEl = document.querySelector(".hud__social");
  if (waveEl) waveEl.classList.remove("is-zoom-hidden");
  if (socialEl) { socialEl.classList.remove("is-zoom-hidden"); socialEl.inert = false; }
  if (roomStrip) { roomStrip.classList.remove("is-zoom-hidden"); roomStrip.inert = false; }
  zoomCap.setAttribute("aria-modal", "false");
  zoomCap.setAttribute("aria-hidden", "true");
  if (hud) hud.inert = false;
  if (anchorsWrap) anchorsWrap.inert = false;
  const zoomCloseBtn = document.getElementById("zoomClose");
  if (zoomCloseBtn) {
    zoomCloseBtn.classList.remove("is-visible");
    zoomCloseBtn.tabIndex = -1;
  }
  focusIfKeyboard(roomBack); /* 部屋の中へ戻る。キーボードで操作している時だけ */
  lockMesh(r, mesh); /* 戻り切るまでは毎フレーム処理に触らせない */
  if (zoomTl) zoomTl.kill();
  zoomTl = gsap.timeline({
    defaults: { ease: "expo.inOut" },
    onComplete: () => { mesh.renderOrder = 0; unlockMesh(r, mesh); },
  });
  zoomTl
    .to(zoomCap, { opacity: 0, duration: 0.3, ease: "power2.in" }, 0)
    .to(r.backdrop.material, { opacity: 0, duration: 0.6 }, 0.1);
  zoomFullRes = false; applyPixelRatio(); /* 旅へ戻るので粒子向けの上限に戻す */
  setSiblingOpacity(r, null, zoomTl, 0);   /* 読み込み済みの板を戻す */
  returnToWall(mesh, zoomTl, 0, 0.85);
  if (REDUCE_MOTION) zoomTl.timeScale(6);
}

/* 触れた写真のキャプション。写真の下辺に付いて回り、窓から出るように現れる */
const roomCap = document.getElementById("roomCap");
const roomCapSpan = roomCap ? roomCap.querySelector("span") : null;
const _cp = new THREE.Vector3();
let capShown = 0, capFor = null;
function updateRoomCaption(hit, dt) {
  if (!roomCap) return;
  const want = hit ? 1 : 0;
  capShown += (want - capShown) * Math.min(1, dt * 6);
  if (hit && hit.object !== capFor) {
    capFor = hit.object;
    const d = capFor.userData;
    roomCapSpan.textContent = `${d.area.name} — ${d.cap}`;
  }
  if (capShown < 0.01) { roomCap.style.opacity = "0"; capFor = null; return; }
  if (capFor) {
    /* 写真の下辺の中央に置く */
    _cp.set(0, -0.5, 0).applyMatrix4(capFor.matrixWorld).project(camera);
    const x = (_cp.x * 0.5 + 0.5) * innerWidth;
    const y = (-_cp.y * 0.5 + 0.5) * innerHeight;
    roomCap.style.left = `${x}px`;
    roomCap.style.top = `${y + 18}px`;
  }
  roomCap.style.opacity = capShown.toFixed(3);
  roomCapSpan.style.transform = `translateY(${((1 - capShown) * 110).toFixed(1)}%)`;
  roomCap.querySelector("i").style.transform = `scaleX(${capShown.toFixed(3)})`;
}

/* 横スクロール。lerp で target へ寄せるだけの素直な作りにする
   （Codrops のギャラリーと同じ ease 0.07。速く動き出して静かに止まる）。
   タッチ端末は指の移動量がそのまま target に乗る一方、current の追従が
   PC想定の減衰のままだと「指について来ない・もっさり」に感じられるため、
   タッチだけ追従を速める */
const roomScroll = { current: 0, target: 0, ease: IS_TOUCH ? 0.16 : 0.07 };

/* 直前の入力がキーボードだったか。部屋を開いた時・拡大を閉じた時に
   フォーカスを BACK へ移すのは、キーボード操作の起点を作るためだが、
   指で開いた時にも同じことをすると枠が出る。CSS は :focus-visible に
   限定してあるものの、iOS Safari はプログラム的な focus() も
   focus-visible とみなすため、タップしただけでボタンが四角く囲まれていた。
   キーボードで開いた時だけ移す */
let lastInputKeyboard = false;
addEventListener("keydown", () => { lastInputKeyboard = true; }, true);
addEventListener("pointerdown", () => { lastInputKeyboard = false; }, true);
function focusIfKeyboard(el) { if (el && lastInputKeyboard) el.focus(); }

/* 部屋の一覧ストリップ。32点あるSNAPSでは1440px幅で同時に見えるのが
   約1.5枚しかなく、端から端まで31ステップかかっていた。全体量と現在地を
   一目で見せ、1タップで任意の1枚へ飛べるようにする。
   画像は表示サイズに見合う派生（assets/photos/<series>/strip、1枚1.7KB）を使う。
   thumb（41〜89KB）を並べるとSNAPSだけで1.56MB落ちることになる。 */
const roomStrip = document.getElementById("roomStrip");
let stripItems = [], stripIdx = -1;

function stripUrl(url) {
  const i = url.lastIndexOf("/");
  return url.slice(0, i + 1) + "strip/" + url.slice(i + 1).replace(/\.jpe?g$/i, ".webp");
}

function buildRoomStrip(r) {
  if (!roomStrip) return;
  roomStrip.innerHTML = "";
  stripItems = r.meshes.map((m, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "room-strip__item";
    b.setAttribute("aria-label", (i + 1) + "枚目へ");
    const img = document.createElement("img");
    img.src = stripUrl(m.userData.url);
    img.alt = "";
    img.decoding = "async";
    b.appendChild(img);
    /* window 側の pointerdown/wheel が旅の移動と部屋のドラッグを拾うため、
       素通しだとストリップを指でなぞるたびに奥の写真の列も一緒に流れ、
       さらに updateRoomStrip の scrollTo({behavior:"smooth"}) と
       取り合いになる。ABOUTの箱（addAboutBox）と同じ手当てをここにも入れる */
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      /* 読み込みが進むたびに列を開いた位置へ引き戻す snapPending は、
         自分で動かした時点で解除する約束になっている（2356行付近と同じ）。
         ここで解除しないと、飛んだ先からすぐ先頭へ戻されてしまう */
      r.snapPending = false;
      roomScroll.target = r.offsetOf(i);
    });
    roomStrip.appendChild(b);
    return b;
  });
  stripIdx = -1;
  roomStrip.setAttribute("aria-hidden", "false");
  roomStrip.classList.add("is-visible");
}

function clearRoomStrip() {
  if (!roomStrip) return;
  roomStrip.classList.remove("is-visible", "is-zoom-hidden");
  roomStrip.setAttribute("aria-hidden", "true");
  roomStrip.innerHTML = "";
  stripItems = [];
  stripIdx = -1;
}

/* 現在地の更新。列の位置（roomScroll.current）に最も近い1枚を選ぶ。
   選ばれた項目が枠の外にあれば、ストリップ自身も横に送って見せる */
function updateRoomStrip(r) {
  if (!stripItems.length || !r || !r.positions) return;
  let idx = 0, best = Infinity;
  for (let i = 0; i < r.positions.length; i++) {
    const d = Math.abs((r.positions[i] || 0) - roomScroll.current);
    if (d < best) { best = d; idx = i; }
  }
  if (idx === stripIdx) return;
  stripIdx = idx;
  stripItems.forEach((b, i) => {
    const on = i === idx;
    b.classList.toggle("is-current", on);
    b.setAttribute("aria-current", on ? "true" : "false");
  });
  const el = stripItems[idx];
  if (el) {
    const sl = roomStrip.scrollLeft, w = roomStrip.clientWidth;
    const l = el.offsetLeft, rr = l + el.offsetWidth;
    if (l < sl + 24) roomStrip.scrollTo({ left: Math.max(0, l - 24), behavior: "smooth" });
    else if (rr > sl + w - 24) roomStrip.scrollTo({ left: rr - w + 24, behavior: "smooth" });
  }
}
let activeRoom = null;
/* ?debug=1 のときだけ内部状態を覗けるようにする（挙動の切り分け用） */
if (DEV_TOOLS_ALLOWED && new URLSearchParams(location.search).get("debug") === "1") {
  window.__xp = {
    get room() { return activeRoom; },
    get open() { return galleryOpen; },
    get busy() { return transitionActive; },
    get scroll() { return roomScroll; },
    get tl() { return tl; },
    get zoomTl() { return zoomTl; },
    gsap, bringToFront, ROW_H, EDGE, EDGE_BOTTOM, ROOM_PAD, openZoom, closeZoom,
    openGallery, closeGallery: () => closeGallery(), AREAS,
    camera, scene, THREE,
    rig, updateRoom, artworks, frame, updateAnchors,
    ensureAreasAround, get buildOrder() { return buildOrder; },
    /* 実際に画面へ描かれている量を数える。推測で軽くしても意味がないので */
    stats() {
      let pts = 0, drawn = 0, objs = 0;
      scene.traverse((o) => {
        if (!o.isPoints) return;
        objs++;
        const n = o.geometry.getAttribute("position").count;
        pts += n;
        if (o.visible) drawn += n;
      });
      return {
        pointObjects: objs,
        particlesTotal: pts,
        particlesEnabled: drawn,
        info: renderer.info.render,
        pixelRatio: +renderer.getPixelRatio().toFixed(3),
        quality: +qualityScale.toFixed(2),
        buffer: `${renderer.domElement.width}x${renderer.domElement.height}`,
      };
    },
  };
}
const _rv = new THREE.Vector3();
function updateRoom(dt) {
  if (!activeRoom) return;
  const r = activeRoom;
  updateRoomStrip(r);   /* 一覧の現在地。列が動いた分だけ追従させる */
  /* 1枚を見ている間は列を動かさない（横に流れると見ている物が逃げる） */
  if (!r.zoomed) {
    /* ±span（板の総幅の半分）だと最後の1枚を正面に置いた先にも
       板半分ぶんの余白が残ってしまう。実際の並び位置の両端で止める */
    const positions = r.positions;
    const lo = positions && positions.length ? positions[0] : -r.span;
    const hi = positions && positions.length ? positions[positions.length - 1] : r.span;
    roomScroll.target = THREE.MathUtils.clamp(roomScroll.target, lo, hi);
    /* ease は「1フレームあたりの係数」として書かれていたため、
       高リフレッシュレート端末ほど速く収束していた。等価な連続時間の
       減衰に変換し、他の補間と同じく dt で正規化する */
    const k = 1 - Math.pow(1 - roomScroll.ease, dt * 60);
    roomScroll.current += (roomScroll.target - roomScroll.current) * k;
    r.group.position.copy(r.right).multiplyScalar(-roomScroll.current);

    /* 正面のウィンドウに入った写真だけテクスチャを実体化し、外れたら解放する。
       スクロールが止まっている間は毎フレーム同じ判定を繰り返すだけで無害 */
    for (const m of r.meshes) {
      const off = m.userData.centerOff ?? 0;
      const d = Math.abs(off - roomScroll.current);
      if (d < ROOM_WINDOW_RADIUS) ensureRoomTexture(m);
      else releaseRoomTexture(r, m);
    }
  }

  /* ホバー判定は1本のレイで足りる */
  raycaster.setFromCamera(rig.mouse, camera);
  const hit = r.zoomed ? null : raycaster.intersectObjects(r.meshes, false)[0];
  const anyHover = !!hit;
  for (const m of r.meshes) {
    if (m === r.zoomed || (r.locked && r.locked.has(m))) {
      /* 選ばれた1枚と、戻っている最中の1枚は GSAP が姿勢を握っているので触らない */
      const u0 = m.material.uniforms;
      u0.uHover.value += (0 - u0.uHover.value) * Math.min(1, dt * 6);
      u0.uDim.value += (0 - u0.uDim.value) * Math.min(1, dt * 6);
      u0.uFogDensity.value = 0;
      continue;
    }
    const u = m.material.uniforms;
    const d = m.userData;
    const on = hit && hit.object === m;
    if (on && hit.uv) u.uMouse.value.lerp(hit.uv, Math.min(1, dt * 12));
    u.uHover.value += ((on ? 1 : 0) - u.uHover.value) * Math.min(1, dt * 7);
    /* 触れている1枚以外は引く。全部が同じ強さで並んでいると視線が止まらない。
       1枚を見ている間は、他は完全に退く */
    const dimTarget = r.zoomed ? 1 : (anyHover && !on ? 1 : 0);
    u.uDim.value += (dimTarget - u.uDim.value) * Math.min(1, dt * 5);

    /* 画面内のどこにいるかで、中の像だけが逆に流れる（枠は動かない） */
    _rv.setFromMatrixPosition(m.matrixWorld).project(camera);
    u.uParallax.value = THREE.MathUtils.clamp(_rv.x, -1, 1);
    u.uDist.value = camera.position.distanceTo(_rv.setFromMatrixPosition(m.matrixWorld));
    u.uFogDensity.value = pointsUniforms.uFogDensity.value;

    /* 触れた1枚だけ、カーソルの方へ傾いて手前に起きる。
       傾きは即時に当てず、目標へ寄せて減衰させる（動きが硬くならない） */
    const lift = u.uHover.value;
    const tx = on ? -rig.mouseDamped.y * 0.10 : 0;
    const ty = on ?  rig.mouseDamped.x * 0.10 : 0;
    d.tiltX = (d.tiltX || 0) + (tx - (d.tiltX || 0)) * Math.min(1, dt * 5);
    d.tiltY = (d.tiltY || 0) + (ty - (d.tiltY || 0)) * Math.min(1, dt * 5);
    m.rotation.x = d.tiltX;
    m.rotation.y = Math.atan2(-r.dirX, -r.dirZ) + d.tiltY;
    m.position.y = d.baseY + lift * 0.10;
    /* 幅がそれぞれ違うので、setScalar ではなく元の寸法に掛ける */
    const k = 1 + lift * 0.03;
    m.scale.set(d.w * k, d.h * k, 1);
  }
  document.body.style.cursor = (anyHover || r.zoomed) ? "pointer" : "";
  updateRoomCaption(hit, dt);
}

let transitionActive = false;
let hasPlayedTransition = false; /* 2周目以降は短縮版に切り替える */

/* 絵の画面上の矩形（写真をそこから立ち上げるため） */
const _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3();
function screenRectOf(rec) {
  const g = rec.group;
  const hw = 0.5, hh = (rec.aspect || 0.66) * 0.5;
  _c0.set(-hw, hh, 0).applyMatrix4(g.matrixWorld).project(camera);
  _c1.set(hw, -hh, 0).applyMatrix4(g.matrixWorld).project(camera);
  const x0 = (_c0.x * 0.5 + 0.5) * innerWidth, y0 = (-_c0.y * 0.5 + 0.5) * innerHeight;
  const x1 = (_c1.x * 0.5 + 0.5) * innerWidth, y1 = (-_c1.y * 0.5 + 0.5) * innerHeight;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/* ビートの位置（総尺1.7秒に対する比率。2周目は同じ比率のまま0.9秒へ圧縮） */
const BEAT = {
  othersOut: [0.00, 0.147], /* 選ばれた絵以外を引く＝「選択」の宣言 */
  lift:      [0.147, 0.32], /* わずかに前へ＋紙のテクスチャが抜ける（紙から剥がれる） */
  line:      [0.206, 0.53], /* 鉛筆の線が先に消える */
  dissolve:  [0.324, 0.80], /* 色面が分解して光に還る */
  photo:     [0.50, 0.794], /* 写真が粒子の隙間から立ち上がる */
  strip:     0.91,          /* サムネイルが1枚ずつ */
};
const segAt = (p, [a, b]) => THREE.MathUtils.clamp((p - a) / (b - a), 0, 1);
const ease = (k) => k * k * (3 - 2 * k);
let tl = null;                             /* 開閉を1本で持つGSAPタイムライン */
let focusBeforeGallery = null;             /* 部屋を出た時、呼び出し元へフォーカスを戻すための記憶 */

function openGallery(area) {
  if (galleryOpen || transitionActive || !area.photos) return;
  galleryOpen = true;
  focusBeforeGallery = document.activeElement;
  trackEvent("gallery_open", { area: area.name, count: area.photos.length });

  /* 勢いよくスクロールした直後にホットスポットを踏むと、rig.target が
     まだこのエリアの t を行き過ぎた（あるいは手前で止まっている）ことがある。
     その状態のままだと、旅の移動速度が乗ったまま部屋への遷移が重なって
     動きが速く・不安定に見える。部屋へ入る瞬間に狙いを一旦きっちり
     このエリアへ固定し、以後は detour だけで滑らかに寄せる */
  rig.target = area.t;

  /* オーバーレイを開かず、カメラが奥の場所（回廊の奥）へ進む */
  const room = buildPlaceRoom(area);
  room.group.visible = true; /* 先に組んで伏せてあるので、ここで初めて見せる */
  rig.roomView = room.view;
  rig.roomLook = room.look;
  /* クリックした情景に対応する写真が、正面に来る位置から始める。
     写真の読み込みで幅が変わるので、並べ直しのたびに取り直させる */
  room.snapPending = true;
  roomScroll.target = roomScroll.current = room.offsetOf(room.startIdx);
  /* white-space:nowrap と組ませて、モバイル幅では明示的な位置で2行に割る。
     自動折返しに任せると "SCROL" "L" のように単語の途中で割れていた */
  hint.innerHTML = IS_TOUCH
    ? '<span lang="en">SWIPE</span> — 流す<span class="hud__hint__sep"></span><br class="hud__hint__br"><span lang="en">TAP</span> — 大きく見る'
    : '<span lang="en">DRAG / SCROLL</span> — 流す<span class="hud__hint__sep"></span><br class="hud__hint__br"><span lang="en">CLICK</span> — 大きく見る';
  hint.classList.remove("is-faded");
  roomBack.classList.add("is-visible");
  hud.classList.add("is-room");   /* 部屋の中だけ効かせたいCSSのための状態 */
  buildRoomStrip(room);           /* 全体量と現在地を出す一覧 */
  roomBack.tabIndex = 0; /* 非表示中はTab順から外している。表示に合わせて戻す */
  focusIfKeyboard(roomBack); /* キーボード操作の起点。指で開いた時は枠を出さない */
  transitionActive = true;
  if (tl) tl.kill();

  /* このエリアの3Dコラージュ絵（addArtwork、線画+水彩の点描が1枚あたり
     数千個規模）は、部屋（カルーセル）に入っても元の位置に残ったまま
     描画され続けていた。opacityを0にしても、GPU側では透明な点群として
     頂点シェーダー・フラグメントシェーダーの計算コストがそのままかかる。
     モバイルではこれがカルーセル操作のもたつきとして体感されていたため、
     フェードで見えなくなった後は visible=false にして描画自体を止める */
  const mine = artworks.filter((a) => a.area === area);
  room.artworks = mine; /* closeGalleryから、戻す対象として参照する */

  tl = gsap.timeline({
    onComplete: () => {
      transitionActive = false;
      activeRoom = room;
      mine.forEach((a) => { a.group.visible = false; });
    },
    onReverseComplete: () => {
      transitionActive = false;
      galleryOpen = false;
      rig.detour = 0;
      activeRoom = null;
      room.group.visible = false; /* 旅に戻ったら、また伏せる */
      document.body.style.cursor = "";
    },
  });
  tl.to(rig, { detour: 1, duration: 1.9, ease: "power2.inOut" }, 0)
    /* 濃度はシェーダー側の uOpacity が持つ（マテリアルの opacity では効かない）。
       room.mats全体を一律にフェードインすると、まだ画像が読み込まれて
       いない板（仮の縦横比1.5のまま、白い横長のプレースホルダー）まで
       ここで見えるようになってしまい、その直後に実サイズへ組み直って
       ガタつく。既に読み込み済みの板だけをここでフェードインし、
       未読み込みの板は個別のensureRoomTexture完了時（既存のコールバック）
       に、実サイズが確定した状態でフェードインさせる */
    .to(room.meshes.filter((m) => m.userData.loaded).map((m) => m.material.uniforms.uOpacity),
      { value: 0.98, duration: 1.1, stagger: 0.06, ease: "power2.out" }, 0.5)
    .to(anchorsWrap, { opacity: 0, duration: 0.5 }, 0)
    .to(mine.map((a) => a.mat), { opacity: 0, duration: 0.7, ease: "power2.out" }, 0);
  /* reduced motionでは「移動を減らす」以上に「連続アニメーションそのもの」が
     負荷になる人がいるため、演出を消すのではなく大幅に速めて実質即時にする */
  tl.timeScale((hasPlayedTransition ? 1.5 : 1) * (REDUCE_MOTION ? 6 : 1));
  hasPlayedTransition = true;
}

/* 閉じる：開いたのと同じタイムラインを逆再生する。
   別実装で"戻し"を書くと往路と復路がズレるが、reverse なら完全に対称になる。
   （写真 → 粒子 → 色面 → 線 の順に、来た道をそのまま戻る） */
/* instant=true は warpTo() からの呼び出し専用。フェードヴェールが
   完全に不透明でいられる時間はごく短く、通常の tl.reverse()（逆再生、
   実質1秒近く）だとヴェールが薄くなるより前に終わらず、
   「カルーセルが閉じていく巻き戻り」がフェードインの裏に透けて
   見えてしまっていた。instant時はアニメーションを飛ばし、
   タイムラインを開始状態へ即座に戻す */
function closeGallery(instant = false) {
  if (activeRoom && activeRoom.zoomed) closeZoom(); /* 見ていた1枚を壁へ戻してから出る */
  if (zoomCap) zoomCap.style.opacity = "0";
  /* updateRoomCaption() は updateRoom() の中でしか呼ばれず、updateRoom() は
     activeRoom が無いと即returnする。そのため退出後はこのキャプションの
     更新が止まり、直前に触れていた写真名が旅の画面やCONTACTまで
     居残っていた。退出の瞬間に確実に消す */
  if (roomCap) { roomCap.style.opacity = "0"; }
  if (roomCapSpan) roomCapSpan.textContent = "";
  capShown = 0; capFor = null;
  hint.textContent = IS_TOUCH ? "SWIPE — 綿毛を追う" : "SCROLL / DRAG — 綿毛を追う";
  hint.classList.add("is-faded");
  roomBack.classList.remove("is-visible");
  hud.classList.remove("is-room");
  clearRoomStrip();
  roomBack.tabIndex = -1; /* 見えないボタンにTabで止まり、Enterで意図せず旅の外へ出てしまうのを防ぐ */
  /* 部屋に入る前にフォーカスしていた場所（ホットスポット等）へ戻す。
     その要素が消えている場合（ドット操作等）は無理に追わず諦める */
  if (focusBeforeGallery && document.body.contains(focusBeforeGallery)) {
    focusBeforeGallery.focus();
  }
  focusBeforeGallery = null;
  /* 次にこのシリーズを開いた時、見ていた位置から再開できるよう憶えておく。
     以前は毎回 startIdx=0（先頭）に戻り、22枚あるシリーズを見返すたびに
     最初から流し直す必要があった */
  if (activeRoom && activeRoom.positions && activeRoom.positions.length) {
    let bestIdx = 0, bestD = Infinity;
    activeRoom.positions.forEach((p, i) => {
      const d = Math.abs(p - roomScroll.current);
      if (d < bestD) { bestD = d; bestIdx = i; }
    });
    activeRoom.startIdx = bestIdx;
  }
  /* openGallery側で描画を止めたエリアの絵を、フェードインが効くよう
     先に見える状態へ戻す（visible=falseのままだとopacityを戻しても映らない） */
  if (activeRoom && activeRoom.artworks) {
    activeRoom.artworks.forEach((a) => { a.group.visible = true; });
  }
  const closingRoom = activeRoom; /* nullにする前に、後片付け用に保持しておく */
  activeRoom = null;              /* 先に操作対象を旅へ戻す */
  document.body.style.cursor = "";
  if (!tl) { galleryOpen = false; return; }
  if (instant) {
    /* onReverseCompleteは自然にreverse()が終わった時だけ発火するため、
       progress(0)で開始状態へ飛ばす場合は同じ後片付けをここで手動で行う */
    tl.progress(0).kill();
    tl = null;
    transitionActive = false;
    galleryOpen = false;
    rig.detour = 0;
    if (closingRoom) closingRoom.group.visible = false;
    return;
  }
  transitionActive = true;
  tl.timeScale(1.7 * (REDUCE_MOTION ? 6 : 1)).reverse(); /* 戻りは速く。往復のコストを下げる */
}

window.addEventListener("keydown", (e) => {
  /* Spaceキーは、旅を進める操作にも部屋内で写真を開く操作にも割り当てて
     いるが、ボタンにフォーカスがある状態でSpaceを押した場合は話が別。
     本来は「そのボタンを押す」というブラウザ標準の動作を期待しているのに、
     このグローバルハンドラが割り込んで奪ってしまっていた */
  if (e.key === " " && e.target && e.target.closest &&
      e.target.closest('button, a, input, textarea, select, [role="button"]')) {
    return;
  }
  /* 1枚を見ている間は矢印で送る */
  if (activeRoom && activeRoom.zoomed) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { stepZoom(1); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { stepZoom(-1); return; }
  }
  /* 部屋には入ったがまだ1枚も選んでいない間：以前はホイール/ドラッグでしか
     列を流せず、キーボードだけでは1枚も写真を選べなかった。正面に最も近い
     1枚を矢印で送り、Enter/Spaceでそれを開く */
  if (activeRoom && !activeRoom.zoomed) {
    const positions = activeRoom.positions || [];
    if (positions.length) {
      let idx = 0, best = Infinity;
      for (let i = 0; i < positions.length; i++) {
        const d = Math.abs(positions[i] - roomScroll.target);
        if (d < best) { best = d; idx = i; }
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        activeRoom.snapPending = false;
        roomScroll.target = positions[Math.min(idx + 1, positions.length - 1)];
        rig.lastInput = performance.now();
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        activeRoom.snapPending = false;
        roomScroll.target = positions[Math.max(idx - 1, 0)];
        rig.lastInput = performance.now();
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (activeRoom.meshes[idx]) openZoom(activeRoom.meshes[idx]);
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key === "Escape") {
    /* 見ている写真があればまずそれを戻し、次にもう一度で旅へ戻る */
    if (activeRoom && activeRoom.zoomed) { closeZoom(); return; }
    if (galleryOpen) closeGallery();
    return;
  }
  /* 旅の本体：これまでホイール/ドラッグでしか進められず、キーボードだけでは
     写真シリーズ本体（サイトの主要コンテンツ）に到達できなかった */
  if (!rig.entered || activeRoom || galleryOpen) return;
  const STEP = 0.02;
  switch (e.key) {
    case "ArrowDown": case "PageDown": case " ":
      rig.started = true;
      rig.target = THREE.MathUtils.clamp(rig.target + STEP, 0, CONTACT_T);
      rig.lastInput = performance.now();
      hint.classList.add("is-faded");
      e.preventDefault();
      return;
    case "ArrowUp": case "PageUp":
      rig.target = THREE.MathUtils.clamp(rig.target - STEP, 0, CONTACT_T);
      rig.lastInput = performance.now();
      hint.classList.add("is-faded");
      e.preventDefault();
      return;
    case "Home":
      rig.target = 0;
      rig.lastInput = performance.now();
      e.preventDefault();
      return;
    case "End":
      rig.started = true;
      rig.target = CONTACT_T;
      rig.lastInput = performance.now();
      e.preventDefault();
      return;
  }
});

/* クリック相当の操作（写真を選ぶ／情景に入る）をまとめた関数。
   マウスの click イベントと、タッチ由来の pointerup（下記）の
   両方から呼ばれる */
function handleActivate(clientX, clientY) {
  if (!rig.entered) return;
  /* 部屋の中：写真を選ぶ／見終わって戻す */
  if (activeRoom) {
    if (activeRoom.zoomed) { closeZoom(); return; }
    raycaster.setFromCamera(new THREE.Vector2(
      (clientX / innerWidth) * 2 - 1,
      -(clientY / innerHeight) * 2 + 1
    ), camera);
    const h = raycaster.intersectObjects(activeRoom.meshes, false)[0];
    /* 壁へ戻るアニメーションの最中（locked）はクリックを無視する。
       戻り切る前に同じ写真を開くと、飛行中の座標が新しい定位置として
       記録されてしまい、以後どこにも戻らなくなる */
    if (h && !(activeRoom.locked && activeRoom.locked.has(h.object))) openZoom(h.object);
    return;
  }
  if (galleryOpen) return;
  raycaster.setFromCamera(new THREE.Vector2(
    (clientX / innerWidth) * 2 - 1,
    -(clientY / innerHeight) * 2 + 1
  ), camera);
  const objects = AREAS.map((a) => a.object).filter(Boolean);
  const hits = raycaster.intersectObjects(objects, false);
  if (hits.length) {
    const area = AREAS.find((a) => a.object === hits[0].object);
    if (!area) return;
    if (area.currentW > 0.5) {
      if (area.link) {
        trackEvent("click_commission_cta", { area: area.name });
        window.location.href = area.link;
      } else {
        openGallery(area);
      }
    } else {
      rig.started = true;
      rig.target = area.t;
      rig.lastInput = performance.now();
    }
  }
}
window.addEventListener("click", (e) => {
  /* タッチ由来のpointerupで既に処理済みなら、後から発火した（かもしれない）
     このclickは無視する（suppressNextClickはpointerdownで必ずクリアされる） */
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (dragMoved > 6) return;
  handleActivate(e.clientX, e.clientY);
});

let hoverThrottle = 0;
window.addEventListener("pointermove", (e) => {
  if (!rig.entered || galleryOpen) return;
  const now = performance.now();
  if (now - hoverThrottle < 100) return;
  hoverThrottle = now;
  raycaster.setFromCamera(new THREE.Vector2(
    (e.clientX / innerWidth) * 2 - 1,
    -(e.clientY / innerHeight) * 2 + 1
  ), camera);
  const objects = AREAS.map((a) => a.object).filter(Boolean);
  const hits = raycaster.intersectObjects(objects, false);
  document.body.style.cursor = hits.length ? "pointer" : "";
});

/* ============================================================
   UI 配線
============================================================ */
const loader = document.getElementById("loader");
const loaderContent = document.getElementById("loaderContent");
const loaderStatus = document.getElementById("loaderStatus");
const enterBtn = document.getElementById("enterBtn");
const enterLabel = document.getElementById("enterLabel");
const loaderTagline = document.getElementById("loaderTagline");
/* COMMON／タグラインを1文字ずつspanに分割し、霧の中から像を結ぶように
   1文字ずつ現れさせる。既存の「霧が晴れる」語彙を文字単位に落とし込む。

   ★演出の実行はCSSアニメーションに任せ、JSはanimation-delayを一度
   書き込むだけにしている。理由はexperience.html側 .loader__char の
   コメント参照（ローディング中はシーン構築がメインスレッドを最長1.7秒
   ブロックするため、rAF駆動のGSAPでは演出そのものが固まってしまう）。 */
function splitChars(el, baseDelay, step) {
  const text = el.textContent;
  el.textContent = "";
  const spans = [...text].map((ch, i) => {
    const span = document.createElement("span");
    span.className = "loader__char";
    /* スペースも1文字ずつspanになるが、display:inline-block では
       中身が空白だけの要素の幅が0に潰れ、word-spacing も単語境界と
       見なされないため ONESEED,MANYJOURNEYS と一語に見えていた。
       スペースの span にだけ実寸の幅を持たせる */
    if (ch === " ") {
      span.innerHTML = "&nbsp;";
      span.style.width = "0.42em";
    } else {
      span.textContent = ch;
    }
    /* 完全な等間隔だと機械的に見えるので、わずかな乱れを混ぜて
       不揃いに像を結ぶ有機的な間をつくる */
    span.style.animationDelay = `${(baseDelay + i * step + Math.random() * 0.05).toFixed(3)}s`;
    el.appendChild(span);
    return span;
  });
  return spans;
}
/* 全文字が出揃うまで：ブランドは0秒から、タグラインは0.22秒から始まり、
   最後の文字が収束するのが約1.5秒後。MIN_LOAD_MSはこれに合わせてある */
const brandChars = splitChars(document.getElementById("loaderBrandWord"), 0, 0.05);
const brandMark = document.getElementById("loaderBrandMark");
if (brandMark) {
  /* © も文字の一員として同じ扱いにする */
  brandMark.style.animationDelay = `${(brandChars.length * 0.05).toFixed(3)}s`;
  brandChars.push(brandMark);
}
const taglineChars = splitChars(loaderTagline, 0.22, 0.022);
/* 分割が済んだ時点で発火。以降の描画はコンポジタスレッドが担当し、
   メインスレッドが何をしていても影響を受けない */
loaderContent.classList.add("is-revealing");
const hud = document.getElementById("hud");
const hint = document.getElementById("hint");
/* HTML側の初期文言はマウス操作前提。タッチ端末では最初の表示から入れ替える */
if (IS_TOUCH) hint.innerHTML = '<span lang="en">SWIPE</span> — 綿毛を追う';
const caption = document.getElementById("caption");
const captionNum = document.getElementById("captionNum");
const captionTitle = document.getElementById("captionTitle");
const areaLive = document.getElementById("areaLive");
const progressBar = document.getElementById("progressBar");
const dotsWrap = document.getElementById("dots");

/* ロゴ／ドットナビ／CONTACTは、今いる場所から遠く離れた地点へ
   一気に移動する操作。以前は rig.target を設定するだけで、
   rig.progress がイージング付きで追いかける実装だったため、経路上を
   逆再生・早送りする形になり「巻き戻し」に見えていた。
   ここでは画面をヴェールで覆い、その裏で rig.progress を目的地へ
   即座に差し替えることで、カット編集のような瞬間移動にする。
   通常のスクロール／ドラッグによる経路移動（updateCamera内のlerp）は
   意図した体験なのでそのまま残す */
const jumpVeil = document.getElementById("jumpVeil");
function warpTo(targetT) {
  if (galleryOpen) closeGallery(true); /* 逆再生の巻き戻りを見せず、即座に閉じる */
  rig.started = true;
  rig.lastInput = performance.now();
  /* 瞬間移動なので、通常の「1つ先を先読み」では間に合わない。
     ヴェールが降りている0.42秒のあいだに移動先を組んでおく */
  ensureAreasAround(targetT, 1);
  gsap.timeline()
    .to(jumpVeil, { opacity: 1, duration: 0.42, ease: "power2.in" })
    .add(() => {
      rig.progress = targetT;
      rig.target = targetT;
    })
    .to(jumpVeil, { opacity: 0, duration: 0.6, ease: "power2.out" }, "+=0.04");
}

const dotWraps = [];
const dots = AREAS.map((a) => {
  const wrap = document.createElement("div");
  wrap.className = "hud__dot-wrap";
  const label = document.createElement("span");
  label.className = "hud__dot-label";
  label.textContent = a.name;
  label.setAttribute("aria-hidden", "true");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "hud__dot";
  b.setAttribute("aria-label", `${a.name} へ移動`);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    warpTo(a.t);
    hint.classList.add("is-faded");
  });
  wrap.appendChild(label);
  wrap.appendChild(b);
  dotsWrap.appendChild(wrap);
  dotWraps.push(wrap);
  return b;
});

/* 「03 / 08」。大見出し（hud__caption-title）は情景に着いた時しか出ないので、
   道中は自分が旅のどこにいるのか分からなくなっていた。ドット列の下に
   小さく常時置く。読み上げには各ドットの aria-current が既に効いており、
   ここは同じ情報の見た目ぶんなので aria-hidden にする */
const dotsCount = document.createElement("p");
dotsCount.className = "hud__dots-count";
dotsCount.lang = "en";
dotsCount.setAttribute("aria-hidden", "true");
dotsWrap.appendChild(dotsCount);
const pad2 = (n) => String(n).padStart(2, "0");
let shownCountIdx = -1;

/* ロゴ＝サイトの入口。クリックで旅の最初（綿毛が離脱する場面）へ戻る。
   index.html を切り離した今、experience.html だけで完結するポートフォリオ
   として機能する必要があり、どこにいても頭に戻れる導線が要る */
const hudLogo = document.getElementById("hudLogo");
if (hudLogo) {
  hudLogo.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!rig.entered) return; /* ENTER前は押しても何もしない（旅がまだ始まっていない） */
    warpTo(0);
    hint.classList.remove("is-faded");
  });
}

/* CONTACTへの常設ショートカット。以前は問い合わせ先が旅の最後（進行度97%）
   にしか無く、興味を持った訪問者がそこまで毎回旅をやり直す必要があった */
const hudContact = document.getElementById("hudContact");
if (hudContact) {
  hudContact.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!rig.entered) return;
    warpTo(CONTACT_T);
    hint.classList.add("is-faded");
  });
}

/* 実読み込みが速い（キャッシュ済み・高速回線）と、1文字ずつ像を結ぶ
   演出が再生しきる前にほぼ同時に全文字が現れてしまい、体験が回線状況
   次第で毎回変わってしまう。表示用の進捗は「実進捗」と「経過時間から
   逆算した進捗」の遅い方を採用し、最低でもMIN_LOAD_MSはかけて
   100%に到達するようにする（実際に読み込みが遅い場合はそのまま伸びる） */
const loadStartTime = performance.now();
/* CSSアニメーション側で最後の文字が収束しきるのが約1.5秒後（splitChars
   のdelay設計＋本体0.75秒）。文字が出揃う前にENTERが現れてしまわない
   よう、READYまでの最短時間をそこに合わせる */
const MIN_LOAD_MS = 1500;
let loadCompleted = false;

/* 文字の出現そのものはCSSアニメーションに任せてあり（splitChars参照）、
   この関数がやるのは進捗テキストの更新と「いつREADYに切り替えるか」の
   判定だけ。以前はここでrevealChars／GSAPを毎フレーム駆動していたが、
   ローディング中はaddSceneDustがメインスレッドを最長1.7秒ブロックする
   ため、rAF駆動では演出そのものが固まっていた。
   表示用の進捗は、実進捗（loadedCount/totalCount）だけに任せると5モデルの
   完了が不揃いで0→20→40…と階段状に飛ぶ。かといって経過時間だけに固定して
   99%で足踏みさせると、回線の遅い実機では「LOADING 99%」のまま十数秒
   止まって見え、正直なバーより体感が悪くなる（ADレビューでの指摘）。
   そこで両者の低い方を採って、実進捗を上限としつつ時間で滑らかに近づける。
   実進捗が伸びれば表示も伸び、止まっていれば手前で待つ。数字は嘘をつかない */
function updateLoadProgress() {
  if (loadCompleted) return;
  const loaded = loadedCount >= totalCount && sceneReady;
  const elapsed = performance.now() - loadStartTime;
  /* 読むモデルが無くなった（totalCount 0）ときに NaN にしない */
  const realPct = totalCount ? (loadedCount / totalCount) * 100 : 100;
  const timePct = (elapsed / MIN_LOAD_MS) * 100;
  const shown = loaded ? Math.min(100, timePct) : Math.min(realPct, timePct);
  loaderStatus.textContent = `LOADING ${Math.round(shown)}%`;
  /* 以前は全パネル画像（写真・コラージュ、200枚以上）を含む panelPending===0 まで
     待たせていたが、これが初回訪問者を最も長く足止めする箇所だった。
     3D空間の構造（モデル＋配置）さえ整えば旅は始められ、写真は各情景に
     近づく間にバックグラウンドで届いて距離ベースのopacityでフェードインする
     （updateArtworksが元々そう作られている）ので、待たずに入って問題ない */
  if (loaded && elapsed >= MIN_LOAD_MS) {
    loadCompleted = true;
    loaderStatus.textContent = "READY";
    /* 綿毛が一度だけ大きく揺れる合図（updateFluff参照）。
       「旅の起点が呼びかけ、文字が浮かび上がる」という因果関係にする */
    fluffBurstAt = performance.now();
    /* ENTERの出現も、READYの退場も、CSS側のクラス切り替えだけで行う。
       JSはクラスを付けるところまでで、描画はコンポジタに委ねる */
    enterBtn.classList.add("is-ready");
    loaderStatus.classList.add("is-done");
    /* opacity/pointer-eventsだけの制御だと、支援技術やフォーム送信は
       「押せるボタン」として扱ってしまう。実際に押せるようになるまでは
       意味的にもdisabledにしておく */
    enterBtn.disabled = false;
  }
}

enterBtn.addEventListener("click", () => {
  loader.classList.add("is-hidden");
  loaderContent.classList.add("is-hidden");
  hud.classList.add("is-active");
  /* 綿毛を専用シーンから本編sceneへ戻す。以後は通常どおりrenderer.render
     （メインのxpCanvas）だけが綿毛を描き、loaderFluffCanvas側は
     何も残っていないシーンをレンダリングし続けるだけになる
     （空シーンのレンダリングは軽いので、animation loop側の分岐は
     rig.enteredのタイミングに委ね、ここでは要素の移動だけ行う） */
  if (loaderFluffRenderer && fluff) {
    loaderFluffScene.remove(fluff);
    scene.add(fluff);
  }
  /* このクリックは window まで bubble し、そちらのレイキャストハンドラは
     rig.entered を見て発火を決めている。同じイベント内で同期的に true にすると、
     マクロショットの姿勢のまま同一クリックがレイキャストに流れ、
     カメラの呼吸位相によっては ABOUT のピック判定に入って旅が勝手に始まってしまう。
     1フレーム遅らせ、このクリックの伝播が完全に終わってから有効化する */
  requestAnimationFrame(() => {
    rig.entered = true;
    /* 先の情景を霧の奥に立たせるため、残りのエリアを背景で組み足す */
    buildRemainingAreas();
    /* URLに情景のハッシュ（#plants 等、updateUrlHash が着地時に付ける）が
       付いていれば、共有されたリンクとしてそこへ着地する。
       まっさらな訪問（ハッシュ無し）はいつも通り冒頭から始まる。
       最初は rig.target だけ動かしていたが、それだと rig.progress が
       0から目的地まで通常のスクロール速度で連続的に動き、旅の全行程を
       早送りで見せられているような違和感になっていた。progress 自体を
       直接その場へ置き、代わりに霧を一瞬濃くして「霧の中から現れる」
       演出（updateCamera が毎フレーム自然に晴らしていく、着地時と同じ絵）
       に差し替える */
    const hashName = location.hash.slice(1).toLowerCase();
    const shared = hashName && AREAS.find((a) => a.name.toLowerCase() === hashName);
    if (shared) {
      rig.started = true;
      /* 共有リンクは progress を直接その場へ置くため、毎フレームの
         先読みでは間に合わない。着地点を先に組んでおく */
      ensureAreasAround(shared.t, 1);
      rig.progress = shared.t;
      rig.target = shared.t;
      rig.veil = 0.85;
      if (fogVeil) fogVeil.style.opacity = "0.85";
      rig.lastInput = performance.now();
      hint.classList.add("is-faded");
    }
  });
  /* 霧は以降 updateCamera が動的に駆動（移動＝乳白の谷／情景＝晴れる）。
     初期の高密度から自動で薄まっていく＝入場のリビール */
});

let shownArea = null;
function updateHud(capArea, capW) {
  /* 部屋にいる間は情景の見出しを出さない。
     写真のキャプションと同じ左下に出るため、重なって読めなくなる */
  const active = (activeRoom || galleryOpen) ? null : (capArea && capW > 0.45 ? capArea : null);
  /* 旅の終端。CONTACT は rig.target の上限（CONTACT_T = 0.97）なので、
     ここから先へ進む余地は無い。それなのに波線は流れ続け、ヒントは
     is-faded が外れるたび「SWIPE — 綿毛を追う」と復帰していた。
     案内すべき先が無くなったら案内を下げる */
  hud.classList.toggle("is-end",
    !activeRoom && !galleryOpen && !!capArea && capArea.name === "CONTACT" && capW > 0.5);
  if (active !== shownArea) {
    shownArea = active;
    if (active) {
      /* 小さいラベル（"01 / 08 — SERIES" 等）は真下の大見出しと
         情報が重複するだけだったため、全エリア共通で表示しない */
      captionNum.textContent = "";
      captionTitle.textContent = active.name;
      /* ABOUTは日英バイオだけで画面の高さいっぱいまで伸びるモバイル幅では、
         左下固定のこの見出しが本文の末尾（英語バイオ）に重なって埋もれていた。
         他のエリアは短いのでこの見出しだけが頼りだが、ABOUTは名前・肩書きが
         本文内に既にあるため無くても迷わない。
         CONTACT も同じ。375x667 実測で、この見出し（[20,554,164,589]）が
         ホットスポットの "escoval0626@gmail.com — Say hello"（[11,547,364,571]）と
         144x17px 重なっていた。本文側に既に「Contact.」の見出しがあるので、
         ここでも大見出しは無くて迷わない */
      const hideCap = innerWidth <= 767 && (active.isAbout || active.name === "CONTACT");
      caption.classList.toggle("is-visible", !hideCap);
      /* 見出しは hideCap で消えることがあり、そもそも読み上げには
         位置の変化そのものが届いていなかった。矢印キーだけで旅をすると
         8区間ぜんぶ無音で、現在地を知る手段がドットへTabして
         aria-current を聞くことしか無い */
      if (areaLive) {
        const idx = AREAS.indexOf(active);
        areaLive.textContent = idx >= 0
          ? active.name + "。" + AREAS.length + "区間中 " + (idx + 1) + " 番目。"
          : active.name;
      }
    } else {
      caption.classList.remove("is-visible");
      if (areaLive) areaLive.textContent = "";
    }
  }
  dots.forEach((d, i) => {
    const isActive = AREAS[i] === active;
    d.classList.toggle("is-active", isActive);
    d.setAttribute("aria-current", isActive ? "true" : "false");
  });
  /* 現在地の表示は active（＝情景に着いている時だけ入る）ではなく capArea
     （＝常に最も近い情景）で出す。active で出すと、情景と情景のあいだで
     名前も番号も消えてしまい、旅の半分がどこにいるか分からない区間になる */
  const nearIdx = capArea ? AREAS.indexOf(capArea) : -1;
  if (nearIdx !== shownCountIdx) {
    shownCountIdx = nearIdx;
    dotWraps.forEach((w, i) => w.classList.toggle("is-current", i === nearIdx));
    dotsCount.textContent = nearIdx >= 0 ? pad2(nearIdx + 1) + " / " + pad2(AREAS.length) : "";
  }
  progressBar.style.width = `${rig.progress * 100}%`;
  /* 部屋の中（別の「戻る」導線がある）と、既にCONTACTにいる間は隠す。
     それ以外は常に出しておき、どこからでも1クリックで問い合わせ先へ行ける */
  if (hudContact) {
    const hideContact = !!activeRoom || !!galleryOpen || (active && active.name === "CONTACT");
    hudContact.classList.toggle("is-hidden", hideContact);
    /* opacity:0 + pointer-events:none はマウスのヒットテストしか塞がない。
       Tabで見えないボタンにフォーカスが乗り、Enterで部屋の外へ飛ばされて
       いた（.hud__back と違い、こちらは closeGallery 等のガードが無いため
       実際にナビゲーションが起きる）。隠す時は確実に踏めないようにする */
    hudContact.tabIndex = hideContact ? -1 : 0;
  }
  /* 同じことがドット列にも起きていた。狭い幅の部屋では
     .hud.is-room .hud__dots { opacity:0; pointer-events:none } で伏せているが、
     opacity と pointer-events はマウスのヒットテストしか塞がない。
     Tabで見えないドットに止まり、Enterで warpTo → closeGallery され、
     部屋の外へ無言で飛ばされていた */
  const dotsHidden = !!(activeRoom || galleryOpen) && innerWidth <= 767;
  for (const d of dots) d.tabIndex = dotsHidden ? -1 : 0;
  updateUrlHash(capArea, capW);
}

/* URLで直接その情景を共有できるようにする。着地した（capWが高い）情景の
   名前をハッシュに反映し、次に開いた時はそのハッシュを見て自動的に旅する */
let shownHashArea = null;
/* popstate（ブラウザの戻る/進む）による変更中は、その結果としてここが
   再度呼ばれてもpushStateしない。抑制しないと、戻った先でまたpushされ、
   履歴が伸び続けて「戻る」を押すたび同じ場所を行き来するだけになる */
let suppressPushState = false;
function updateUrlHash(capArea, capW) {
  const target = capArea && capW > 0.6 ? capArea : null;
  if (target === shownHashArea) return;
  shownHashArea = target;
  const hash = target ? "#" + target.name.toLowerCase() : "";
  if (location.hash !== hash) {
    const url = location.pathname + location.search + hash;
    /* 情景へ「着地」した瞬間だけ意味のある履歴として積む。通過中・
       離脱時（targetがnull）まで毎回積むと、素早く巡っただけで
       大量の履歴エントリができ、戻るボタンが実用にならなくなる */
    if (target && !suppressPushState) {
      history.pushState({ area: target.name }, "", url);
    } else {
      history.replaceState({ area: target ? target.name : null }, "", url);
    }
  }
}

/* ブラウザの戻る/進むで、対応する情景へ実際にジャンプする */
window.addEventListener("popstate", () => {
  if (!rig.entered) return; /* まだENTER前なら何もしない */
  const hashName = location.hash.slice(1).toLowerCase();
  const target = hashName && AREAS.find((a) => a.name.toLowerCase() === hashName);
  suppressPushState = true;
  if (galleryOpen) closeGallery();
  if (target) {
    rig.started = true;
    rig.target = target.t;
    rig.veil = 0.85; /* URL直接アクセス時と同じ、霧をかぶせた自然な着地にする */
    if (fogVeil) fogVeil.style.opacity = "0.85";
  } else {
    rig.target = 0; /* 対応する情景が無いハッシュ（＝旅の起点）まで戻す */
  }
  rig.lastInput = performance.now();
  shownHashArea = target || null; /* updateUrlHashの重複判定と状態を合わせる */
  setTimeout(() => { suppressPushState = false; }, 100);
});

/* ---------- resize / loop ---------- */
/* fovは横長(16:9)を基準に決めた画角。縦持ちのまま aspect だけ変えると
   水平画角が極端に狭まり（9:19.5で約20°）、center からオフセットして
   置いてある3D配置物（ホットスポット等）が軒並り画角の外に出てしまう。
   水平画角をできるだけ保つ方向に fov を広げる。
   上限1.6倍（fov≈63°）では、寄りのコラージュ絵が画面の天地から
   まだはみ出し切っていて、モバイルで絵の全体像が見えなかった。
   実機幅375pxで数値を振って確認し、絵の周囲に余白が生まれる
   2.35倍（fov≈84°）まで許容する */
const BASE_FOV = 42, BASE_ASPECT = 16 / 9;
function resize() {
  applyPixelRatio(); /* 窓の大きさが変われば塗る面積も変わるので、そのつど上限に収め直す */
  renderer.setSize(innerWidth, innerHeight, false);
  if (loaderFluffRenderer) {
    loaderFluffRenderer.setPixelRatio(renderer.getPixelRatio());
    loaderFluffRenderer.setSize(innerWidth, innerHeight, false);
  }
  camera.aspect = innerWidth / innerHeight;
  if (camera.aspect < BASE_ASPECT) {
    const k = Math.min(BASE_ASPECT / camera.aspect, 2.35);
    camera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2) * k)
    );
  } else {
    camera.fov = BASE_FOV;
  }
  camera.updateProjectionMatrix();
  /* 線幅は画面空間なので解像度を渡す必要がある */
  lineMats.forEach((m) => m.resolution.set(innerWidth, innerHeight));
  /* コピー本文（.xp-copy系）は max-width が vw基準で、画面が狭いほど
     相対的に大きな箱になる。updateAnchors は箱の中心だけを画面比率で
     クランプしていたため、モバイル縦持ちでは箱の半分幅・半分高さぶんが
     画面外へはみ出していた（ABOUTは実測1163pxにもなり、天地がヘッダーや
     隣の情景に食い込んでいた）。実測寸法を控えておき、クランプ範囲を
     その分内側へ詰める */
  for (const a of domAnchors) {
    if (a.clamp) measureAnchor(a);
  }
}
window.addEventListener("resize", resize);
/* iOS Safari等では画面回転時、resizeイベントの発火が遅れたり、
   回転アニメーションの途中サイズで一度発火してから確定サイズで
   もう一度発火する等、タイミングが不安定なことがある。
   orientationchangeも合わせて拾い、実際のサイズが確定するのを
   少し待ってから再計算する（早すぎるとinnerWidth/Heightが
   まだ回転前の値のまま） */
window.addEventListener("orientationchange", () => { setTimeout(resize, 200); });
resize();

/* 入場前：タンポポのマクロ（綿球が画面いっぱい） */
camera.position.set(0.12, 1.52, 4.7);
camera.lookAt(HERO_HEAD);

const clock = new THREE.Clock();
/* 環境差（GPU・画面の大きさ・他タブの負荷）は事前に読めないので、
   実際のフレーム時間を見て解像度を上下させる。重ければ落とし、余裕が戻れば戻す。 */
/* ?debug=1 の時だけ、実測を画面に出す。
   こちらの環境では Edge を測れないので、数字を見える所に置く */
const perfBox = (() => {
  if (!DEV_TOOLS_ALLOWED || new URLSearchParams(location.search).get("debug") !== "1") return null;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;right:10px;bottom:10px;z-index:99;font:11px/1.5 ui-monospace,monospace;" +
    "color:#2f2b25;background:rgba(247,246,242,.86);padding:8px 10px;border:1px solid rgba(30,26,20,.18);white-space:pre";
  document.body.appendChild(el);
  return el;
})();
let perfAcc = 0, perfN = 0, perfWorst = 0;
function showPerf(dt) {
  if (!perfBox) return;
  perfAcc += dt; perfN++; perfWorst = Math.max(perfWorst, dt);
  if (perfN < 30) return;
  const fps = 1 / (perfAcc / perfN);
  const worst = 1 / perfWorst;
  const s = window.__xp ? window.__xp.stats() : null;
  perfBox.textContent =
    `${fps.toFixed(0)} fps  (worst ${worst.toFixed(0)})\n` +
    (s ? `draw ${s.info.calls}  pts ${s.info.points}\n${s.buffer}  pr ${s.pixelRatio}  q ${s.quality}` : "");
  perfAcc = 0; perfN = 0; perfWorst = 0;
}

let frameAcc = 0, frameN = 0, lastQualityAdjust = 0;
function adaptQuality(dt) {
  /* 裏に回っている間はフレーム間隔が伸びる。それを「重い」と誤読すると、
     戻ってきた時に画質が落ちたままになるので、測るのをやめる */
  if (document.hidden) { frameAcc = 0; frameN = 0; return; }
  frameAcc += dt; frameN++;
  /* 重い時ほど早く手を打つ。様子を見ている間ずっと重いのでは意味がない */
  if (frameN < 18) return;
  const avg = frameAcc / frameN;
  frameAcc = 0; frameN = 0;
  const now = performance.now();
  if (now - lastQualityAdjust < 350) return;
  let q = qualityScale;
  if (avg > 0.040) q -= 0.22;                    /* 25fps未満：一気に落とす */
  else if (avg > 0.023) q -= 0.10;               /* 43fps未満：少し落とす */
  /* 戻す条件は 60fps(16.7ms)より速いことを求めてはいけない。
     画面同期で60fpsに張り付くと永久に満たされず、一度下がった画質が戻らなくなる */
  else if (avg < 0.0178 && q < 1) q += 0.04;     /* 56fps超：ゆっくり戻す */
  /* PC想定の下限0.7では、非力なモバイル機で重い場面（部屋を開いた直後など）
     に画質を十分落とし切れず、fpsが上がらないまま張り付いていた。
     タッチ端末はもう一段下まで許容し、確実にフレームレートを取り戻す */
  q = THREE.MathUtils.clamp(q, IS_TOUCH ? 0.55 : 0.7, 1);
  if (Math.abs(q - qualityScale) > 0.001) {
    qualityScale = q;
    lastQualityAdjust = now;
    applyPixelRatio();
  }
}

/* ============================================================
   トレーラー撮影モード（?trailer=1）
   canvas だけ録っても、タイトル・詩・霧のヴェールは DOM 側なので写らない。
   そこで 1コマずつ「WebGLの絵 → 紙の目 → 霧 → 文字」の順に2Dへ合成し、
   サーバーへ送って保存する。時間は実時間ではなく固定の刻みで進めるので、
   重い環境でもコマ落ちせず、毎回まったく同じ絵が撮れる。
============================================================ */
const TRAILER = DEV_TOOLS_ALLOWED && new URLSearchParams(location.search).get("trailer") === "1";
if (TRAILER) {
  const W = 1080, H = 1920, FPS = 30, SECONDS = 30;
  const TOTAL = FPS * SECONDS;
  const cap = document.createElement("canvas");
  cap.width = W; cap.height = H;
  const cx = cap.getContext("2d");

  /* 紙の目は既にDOM側で作ってあるので、その画像をそのまま借りる */
  const paperImg = new Image();
  const bg = paperFx ? paperFx.style.backgroundImage : "";
  const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
  if (m) paperImg.src = m[1];

  const ease = (k) => k * k * (3 - 2 * k);
  const ease2 = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2); /* GSAP power2.inOut相当 */
  const seg = (t, a, b) => THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);

  /* 下層カルーセルを見せる2箇所。旅を一旦止めてここだけ部屋を開く */
  const AREA_BY_NAME = {};
  AREAS.forEach((a) => { AREA_BY_NAME[a.name] = a; });
  const ROOM_SPOTS = [
    { name: "ARCHITECTURES", openStart: 11.0, openDur: 1.3, holdDur: 2.0, closeDur: 1.2 },
    { name: "EXHIBITIONS", openStart: 22.5, openDur: 1.1, holdDur: 1.5, closeDur: 1.2 },
  ].map((s) => {
    const holdStart = s.openStart + s.openDur;
    const closeStart = holdStart + s.holdDur;
    return { ...s, area: AREA_BY_NAME[s.name], holdStart, closeStart, end: closeStart + s.closeDur };
  });
  function findRoomSpot(t) {
    return ROOM_SPOTS.find((s) => t >= s.openStart && t < s.end);
  }
  let roomOpenedFor = null;
  function updateRoomSpot(spot, t, dt) {
    const area = spot.area;
    if (roomOpenedFor !== spot.name) {
      const room = buildPlaceRoom(area);
      room.group.visible = true;
      rig.roomView = room.view;
      rig.roomLook = room.look;
      room.snapPending = true;
      roomScroll.target = roomScroll.current = room.offsetOf(0);
      room.mats.forEach((mm) => { mm.uniforms.uOpacity.value = 0; });
      roomOpenedFor = spot.name;
      /* updateRoom(dt) はこのグローバルを見て初めて写真の実体化(ensureRoomTexture)や
         列送りを行う。ここが未設定だと板は最後まで白紙のプレースホルダーのまま
         （openGallery の通常経路では onComplete で自動的にセットされていた） */
      activeRoom = room;
    }
    const room = area._room;
    rig.target = area.t;
    let detour;
    if (t < spot.holdStart) {
      detour = ease2(seg(t, spot.openStart, spot.holdStart));
    } else if (t < spot.closeStart) {
      detour = 1;
      /* 見せ場を1枚だけで終わらせず、隣の1枚へゆっくり流す */
      if (room.positions && room.positions.length > 1) {
        const k = seg(t, spot.holdStart + spot.holdDur * 0.3, spot.holdStart + spot.holdDur * 0.85);
        roomScroll.target = THREE.MathUtils.lerp(room.positions[0], room.positions[1], k);
      }
    } else {
      detour = 1 - ease2(seg(t, spot.closeStart, spot.end));
    }
    rig.detour = detour;
    const op = THREE.MathUtils.clamp(detour, 0, 1) * 0.98;
    room.mats.forEach((mm) => { mm.uniforms.uOpacity.value = op; });
    updateCamera(dt);
    updateRoom(dt);
    /* 個々の写真のロード完了フェードは通常 GSAP tween が担うが、GSAP の
       ticker は requestAnimationFrame 依存で、撮影中の tab がバックグラウンド
       扱いだと進まないことがある。ロード済みのものは確実に前面へ出す */
    room.meshes.forEach((mm) => {
      if (mm.userData.loaded) {
        const u = mm.material.uniforms;
        u.uOpacity.value = Math.min(1, u.uOpacity.value + dt * 6);
      }
    });
    if (t >= spot.end - dt * 0.5) {
      room.group.visible = false;
      rig.detour = 0;
      rig.roomView = null;
      rig.roomLook = null;
      activeRoom = null;
    }
    return area;
  }

  function drawVeil(alpha) {
    if (alpha <= 0.002) return;
    const g = cx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, W * 0.62);
    g.addColorStop(0, `rgba(238,241,234,${(0.10 * alpha).toFixed(3)})`);
    g.addColorStop(0.42, `rgba(236,239,232,${(0.58 * alpha).toFixed(3)})`);
    g.addColorStop(0.72, `rgba(233,237,230,${(0.90 * alpha).toFixed(3)})`);
    g.addColorStop(1, `rgba(231,235,228,${alpha.toFixed(3)})`);
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
  }

  function drawType(t) {
    /* 冒頭のロックアップ／終わりの署名。旅の最中は文字を出さない。
       縦長は横幅に余裕がないので、常に中央寄せの一本組みで統一する */
    const inTitle = seg(t, 0.8, 1.6) * (1 - seg(t, 3.0, 3.8));
    const endCard = seg(t, 27.6, 28.6);
    const a = Math.max(inTitle, endCard);
    if (a <= 0.01) return;
    const x = W * 0.5;
    const y = H * 0.47;
    cx.save();
    cx.globalAlpha = a;
    cx.textAlign = "center";

    /* 「サイトをリニューアルしました」のバッジ。既存ENTERボタンと同じ、
       線で囲んだだけの控えめな意匠に合わせる。
       ctx.letterSpacing はブラウザの実装によって、実際の描画位置と
       measureText() が返す値の基準がズレる（textAlign=center と組むと
       末尾の余白ぶん文字列全体が右へ寄って見えていた）。Canvas標準の
       letterSpacing には頼らず、1文字ずつ手動で置くことで、幅の計算と
       実際の描画位置を完全に一致させ、枠との対称性を保証する */
    cx.font = `400 ${Math.round(W * 0.026)}px "Josefin Sans", sans-serif`;
    const badge = "SITE RENEWED";
    const letterGap = W * 0.014;
    const chars = [...badge];
    cx.textAlign = "left";
    const charWidths = chars.map((c) => cx.measureText(c).width);
    const textW = charWidths.reduce((s, w) => s + w, 0) + letterGap * (chars.length - 1);
    const padX = W * 0.032, padY = H * 0.0095;
    const badgeY = y - H * 0.085;
    const boxL = x - textW / 2 - padX, boxR = x + textW / 2 + padX;
    cx.strokeStyle = "rgba(23,20,16,0.5)";
    cx.lineWidth = Math.max(1, W * 0.0014);
    cx.strokeRect(boxL, badgeY - padY * 1.9, boxR - boxL, padY * 3.8);
    cx.fillStyle = "#171410";
    let charX = x - textW / 2;
    chars.forEach((c, i) => {
      cx.fillText(c, charX, badgeY);
      charX += charWidths[i] + letterGap;
    });
    cx.textAlign = "center";

    cx.fillStyle = "#171410";
    cx.font = `300 italic ${Math.round(W * 0.135)}px "Cormorant Garamond", serif`;
    cx.fillText("Common", x, y);
    cx.font = `300 ${Math.round(W * 0.0225)}px "Josefin Sans", sans-serif`;
    cx.letterSpacing = `${Math.round(W * 0.009)}px`;
    cx.fillStyle = "#4e4941";
    cx.fillText("PORTFOLIO — SHO KITAGO", x, y + H * 0.038);
    cx.restore();
  }

  /* 情景に着いた時の見出しと詩コピー。CONTACT は署名カードで別に扱うため除く */
  function drawAreaCaption(area, capW) {
    if (!area || area.isAbout || area.name === "CONTACT") return;
    const a = THREE.MathUtils.clamp((capW - 0.45) / 0.25, 0, 1);
    if (a <= 0.01) return;
    const x = W * 0.09;
    const yBase = H * 0.87;
    cx.save();
    cx.globalAlpha = a;
    cx.textAlign = "left";
    cx.fillStyle = "#171410";
    cx.font = `400 ${Math.round(W * 0.052)}px "Josefin Sans", sans-serif`;
    cx.letterSpacing = `${Math.round(W * 0.008)}px`;
    cx.fillText(area.name, x, yBase);
    if (area.lines && area.lines.length) {
      cx.font = `400 ${Math.round(W * 0.0275)}px "Zen Old Mincho", serif`;
      cx.letterSpacing = "0px";
      cx.fillStyle = "#55534e";
      area.lines.forEach((ln, i) => cx.fillText(ln, x, yBase + H * 0.048 + i * H * 0.037));
    }
    cx.restore();
  }

  async function shoot() {
    loader.classList.add("is-hidden");
    loaderContent.classList.add("is-hidden");
    hud.classList.remove("is-active");   /* HUDは合成側で描くので出さない */
    anchorsWrap.style.display = "none";
    if (heroTitle) heroTitle.style.display = "none";
    if (fogVeil) fogVeil.style.display = "none";
    await document.fonts.ready;

    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    /* 縦長は resize() と同じ補正で水平画角を保つ（BASE_FOV/BASE_ASPECTは
       この後ろで定義される通常の resize() 用の値をそのまま流用する） */
    if (camera.aspect < BASE_ASPECT) {
      const k = Math.min(BASE_ASPECT / camera.aspect, 2.35);
      camera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2) * k)
      );
    } else {
      camera.fov = BASE_FOV;
    }
    camera.updateProjectionMatrix();
    lineMats.forEach((mm) => mm.resolution.set(W, H));

    const dt = 1 / FPS;
    const pending = [];
    const MAX_INFLIGHT = 6; /* fetchの完了を待たずに次のコマへ進み、体感速度を上げる */
    const ARCH_T = AREA_BY_NAME.ARCHITECTURES.t, EXH_T = AREA_BY_NAME.EXHIBITIONS.t;
    for (let f = 0; f < TOTAL; f++) {
      const t = f * dt;
      pointsUniforms.uTime.value = t;
      let capArea = null, capW = 0;

      if (t < 4.0) {
        /* ① マクロの一輪。息づくだけで動かない（ここで十分に溜める） */
        rig.entered = false;
        camera.position.set(
          0.12 + Math.sin(t * 0.4) * 0.05,
          1.52 + Math.sin(t * 0.55) * 0.03,
          4.7 + Math.cos(t * 0.3) * 0.05
        );
        camera.lookAt(HERO_HEAD);
      } else {
        /* ② 綿毛が離れ、旅が始まり、③ 霧を抜けて ④ 情景に着いて止まる。
           ARCHITECTURES と EXHIBITIONS では旅を一旦止め、下層カルーセルを
           開いて写真が流れる様子まで見せる。それ以外は通過するだけ */
        rig.entered = true; rig.started = true;
        const spot = findRoomSpot(t);
        if (spot) {
          capArea = updateRoomSpot(spot, t, dt);
          capW = 1;
        } else {
          if (t < 11.0) rig.target = ease(seg(t, 4.0, 11.0)) * ARCH_T;
          else if (t < 22.5) rig.target = ARCH_T + ease(seg(t, 15.5, 22.5)) * (EXH_T - ARCH_T);
          else rig.target = EXH_T;
          const r = updateCamera(dt);
          capArea = r.capArea; capW = r.capW;
        }
      }
      updateFluff(t, dt);
      updatePanels();
      updateArtworks();
      renderer.render(scene, camera);

      /* --- 合成 --- */
      cx.fillStyle = "#f7f6f2";
      cx.fillRect(0, 0, W, H);
      cx.drawImage(renderer.domElement, 0, 0, W, H);
      if (paperImg.complete && paperImg.naturalWidth) {
        cx.save();
        cx.globalCompositeOperation = "multiply";
        cx.globalAlpha = 0.55;
        const p = cx.createPattern(paperImg, "repeat");
        cx.fillStyle = p; cx.fillRect(0, 0, W, H);
        cx.restore();
      }
      drawVeil((rig.veil || 0) * 0.85);
      drawAreaCaption(capArea, capW);
      /* 終わりは紙そのものに還す。移動中の霧は中心を抜く作りなので、
         そのまま流用すると署名の真下だけ情景が透けてしまう。ここは平らに敷く */
      const endWhite = ease(seg(t, 26.3, 27.6)) * 0.96;
      if (endWhite > 0.002) {
        cx.fillStyle = `rgba(244,242,236,${endWhite.toFixed(3)})`;
        cx.fillRect(0, 0, W, H);
      }
      drawType(t);

      const blob = await new Promise((r) => cap.toBlob(r, "image/jpeg", 0.94));
      const req = fetch(`/frame/${String(f).padStart(5, "0")}.jpg`, { method: "POST", body: blob });
      pending.push(req);
      if (pending.length >= MAX_INFLIGHT) await pending.shift();
    }
    await Promise.all(pending);
    document.title = `TRAILER DONE ${TOTAL}`;
  }
  /* シーンが組み上がってから撮り始める */
  const wait = setInterval(() => {
    if (sceneReady && panelPending === 0 && loadedCount >= totalCount) {
      clearInterval(wait);
      shoot();
    }
  }, 200);
}

/* 無名だと外から1フレームだけ進めることができない。名前を付けて
   __xp から呼べるようにしておく。ヘッドレスや非表示タブでは
   requestAnimationFrame も document.timeline も止まるため、
   アンカーの座標やHUDの状態を実測する手段がこれしか無い */
function frame() {
  if (contextLost) return;
  if (TRAILER) return; /* 撮影中は自前のループで進める */
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsedTime();
  pointsUniforms.uTime.value = t;
  adaptQuality(dt);
  showPerf(dt);

  if (rig.entered) {
    softSnap(dt);
    /* 進行先のエリアを先回りして組む。rig.target（目的地）を基準にすると
       スクロール中も1つ先が常に用意され、着く頃には絵が届いている */
    ensureAreasAround(rig.target, 1);
    const { capArea, capW } = updateCamera(dt);
    updateHud(capArea, capW);
  } else {
    /* マクロショット：わずかに息づく手持ちカメラ。
       着地後の呼吸（updateCamera内）はREDUCE_MOTIONで振幅0にしているのに、
       ENTER前のこの区間だけ揺れが素通りしていた。前庭系に敏感な訪問者が
       最初に触れる瞬間なので、同じ基準で振幅を0にする */
    const macroAmp = REDUCE_MOTION ? 0 : 1;
    camera.position.set(
      0.12 + Math.sin(t * 0.4) * 0.05 * macroAmp,
      1.52 + Math.sin(t * 0.55) * 0.03 * macroAmp,
      4.7 + Math.cos(t * 0.3) * 0.05 * macroAmp
    );
    camera.lookAt(HERO_HEAD);
    updateLoadProgress();
  }

  updateFluff(t, dt);
  updateContactBloom(dt);
  updatePanels();
  updateArtworks();
  updateRoom(dt);
  updateAnchors();
  renderer.render(scene, camera);
  /* 綿毛（霧のヴェールより手前）はENTER前だけ描く。ENTER後はfluffを
     本編sceneへ戻し済み（enterBtnのクリックハンドラ参照）なので、
     こちらは空シーンのレンダリングになるが、以後は呼ぶ必要が無い */
  if (!rig.entered && loaderFluffRenderer) {
    loaderFluffRenderer.render(loaderFluffScene, camera);
  }
}
renderer.setAnimationLoop(frame);

/* CONTACT：近づくほど種から花が咲く（0→1へ成長、わずかに揺れる） */
const contactArea = AREAS.find((a) => a.name === "CONTACT");
function updateContactBloom(dt) {
  if (!contactArea || !contactArea.bloom) return;
  const w = contactArea.currentW || 0;
  const target = THREE.MathUtils.clamp((w - 0.3) / 0.7, 0, 1);
  const grow = target * target * (3 - 2 * target); /* smoothstep */
  for (const g of [contactArea.bloom, contactArea.bloom2]) {
    const s = THREE.MathUtils.lerp(g.scale.x, Math.max(0.001, grow), Math.min(1, dt * 2.2));
    g.scale.setScalar(s);
    g.rotation.z = Math.sin(clock.elapsedTime * 0.6 + g.position.x) * 0.03 * grow;
  }
}
