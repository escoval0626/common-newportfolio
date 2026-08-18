// ローカル確認用の最小静的サーバー（依存ゼロ・npx/cmd に依存しない）
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = 4173;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "image/vnd.radiance",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

http
  .createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      urlPath = req.url.split("?")[0];
    }
    if (urlPath === "/") urlPath = "/index.html";

    /* トレーラーのコマ受け取り（ブラウザからは書き出せないので、ここで受けて保存する） */
    if (req.method === "POST" && urlPath.startsWith("/frame/")) {
      const name = path.basename(urlPath);
      if (!/^[0-9]{5}\.jpg$/.test(name)) { res.writeHead(400); res.end("bad name"); return; }
      const dir = path.join(ROOT, "trailer-frames");
      fs.mkdirSync(dir, { recursive: true });
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        fs.writeFile(path.join(dir, name), Buffer.concat(chunks), (err) => {
          res.writeHead(err ? 500 : 200, { "Access-Control-Allow-Origin": "*" });
          res.end(err ? "fail" : "ok");
        });
      });
      return;
    }

    /* ROOT の外に出るパスは拒否 */
    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(file, (err, st) => {
      let target = !err && st.isDirectory() ? path.join(file, "index.html") : file;
      /* 拡張子なしURL（/experience）は .html にフォールバック */
      const send = (t) => {
        fs.readFile(t, (err2, data) => {
          if (err2) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
          }
          res.writeHead(200, {
            "Content-Type": MIME[path.extname(t).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-cache",
            /* 本番(vercel.json)と同じCSP等をここでも返し、ローカルで
               動作確認できるようにする（本番デプロイには使われない） */
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'sha256-MyzGJLvLJiAK6ZRWs4iLCdum7R3YuhvvouXCROeMvDU='; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; " +
              "media-src 'self'; connect-src 'self' https://cdn.jsdelivr.net; " +
              "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          });
          res.end(data);
        });
      };
      if (err && !path.extname(file) && fs.existsSync(file + ".html")) target = file + ".html";
      send(target);
    });
  })
  .listen(PORT, () => {
    console.log(`serving ${ROOT} at http://localhost:${PORT}`);
  });
