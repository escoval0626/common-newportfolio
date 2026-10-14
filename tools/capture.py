"""
Headless Edge + CDP driver for commonphotograph.com (local dev server, debug=1 hooks).

Time is VIRTUAL: performance.now() is patched and advanced by a fixed dt per tick,
GSAP is driven with gsap.updateRoot(). This keeps the site's adaptive quality at 1.0
(it believes it runs at 60fps) and makes every animation deterministic frame by frame.

  from capture import Session
  s = Session(port=9321)                 # 1920x1080 desktop
  s.enter()                              # loads, presses ENTER, installs virtual clock
  s.journey("PLANTS", mouse=(0.1,-0.05)); s.shot("plants.png")
  s.room("SNAPS", index=1); s.shot("room.png")
  s.zoom(1); s.shot("zoom.png")
  s.close()

  # mobile (phone layout) rendered at 1080x1920:
  s = Session(port=9331, w=432, h=768, dpr=2.5)

  # any other site:
  s = Session(port=9341); s.open("https://common-ordinarydays.com/"); s.scroll(1200); s.shot("x.png")
"""
import json, subprocess, time, urllib.request, base64, os, sys
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
BASE = "http://localhost:4173/experience.html?debug=1"


class Session:
    def __init__(self, port=9321, w=1920, h=1080, dpr=1, touch=False, freeze_clock=False):
        self.port, self.w, self.h, self.dpr = port, w, h, dpr
        udd = os.path.join(os.environ.get("TEMP", "."), "edge-cdp-%d" % port)
        self.proc = subprocess.Popen([
            EDGE, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist", "--hide-scrollbars", "--remote-allow-origins=*",
            "--mute-audio", "--no-first-run", "--disable-background-timer-throttling",
            "--window-size=%d,%d" % (w, h), "--remote-debugging-port=%d" % port,
            "--user-data-dir=%s" % udd, "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        for _ in range(60):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json" % port) as r:
                    for t in json.load(r):
                        if t.get("type") == "page":
                            target = t
                            break
                if target:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not target:
            raise RuntimeError("Edge CDP target not found on port %d" % port)
        # SwiftShader は遅い。並列で動かすと1呼び出しが数分かかることがあるので長めに待つ
        self.ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=1800)
        self._id = 0
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Emulation.setDeviceMetricsOverride",
                  {"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": dpr > 1.5})
        if touch:
            # IS_TOUCH（pointer:coarse / maxTouchPoints）を成立させ、SWIPE表示やタッチ向けの挙動にする
            self.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
        if freeze_clock:
            # 読み込み画面（LOADING 0→100%）はサイト側が performance.now で最低1.5秒かけて数える。
            # フックを掴む頃には終わっているので、ページのどのスクリプトより先に時計を止めておき、
            # 撮影側の tick でだけ進める。setTimeout や通信は実時間のまま
            self.send("Page.addScriptToEvaluateOnNewDocument", {"source":
                "window.__vt = 0; window.__realNow = performance.now.bind(performance); performance.now = () => window.__vt;"})
        self.vclock = False

    # ---------- low level ----------
    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self._id:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})

    def eval(self, expr, wait=False):
        r = self.send("Runtime.evaluate",
                      {"expression": expr, "awaitPromise": wait, "returnByValue": True})
        res = r.get("result", {})
        if res.get("subtype") == "error":
            raise RuntimeError(res.get("description"))
        return res.get("value")

    def sleep(self, ms):
        """real-time wait (network / texture loading). Virtual time does not advance."""
        self.eval("new Promise(r=>setTimeout(r,%d))" % int(ms), wait=True)

    def open(self, url):
        self.send("Page.navigate", {"url": url})
        for _ in range(120):
            if self.eval("document.readyState") == "complete":
                return
            time.sleep(0.5)
        raise RuntimeError("page did not load: " + url)

    def network(self, throttle_mbps=None, disable_cache=False):
        """回線を絞る／キャッシュを無効化する（読み込み画面を見せたいとき用）。throttle_mbps=None で解除"""
        self.send("Network.enable")
        self.send("Network.setCacheDisabled", {"cacheDisabled": bool(disable_cache)})
        if throttle_mbps:
            bps = int(throttle_mbps * 1e6 / 8)
            self.send("Network.emulateNetworkConditions",
                      {"offline": False, "latency": 20, "downloadThroughput": bps, "uploadThroughput": bps})
        else:
            self.send("Network.emulateNetworkConditions",
                      {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})

    def scroll(self, y):
        self.eval("window.scrollTo(0,%d); true" % int(y))
        self.sleep(700)

    def shot(self, path, full=False):
        params = {"format": "png"}
        if full:
            params["captureBeyondViewport"] = True
            h = self.eval("Math.ceil(document.documentElement.scrollHeight)")
            params["clip"] = {"x": 0, "y": 0, "width": self.w, "height": h, "scale": 1}
        r = self.send("Page.captureScreenshot", params)
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass

    # ---------- 3D site ----------
    VCLOCK_JS = """(()=>{
      const x = window.__xp;
      if (window.__vt === undefined) {            // 事前凍結（freeze_clock）していなければここで差し替える
        window.__vt = performance.now();
        performance.now = () => window.__vt;
      }
      if (!window.__step) {
        window.__vt0 = window.__vt;
        window.__gsapBase = x.gsap.ticker.time;
        x.gsap.ticker.sleep();
        window.__lastErr = null;
        window.addEventListener('error', (e) => { window.__lastErr = String(e.message || e); });
        window.__step = (n, dt) => {
          for (let i = 0; i < n; i++) {
            window.__vt += dt * 1000;
            x.gsap.updateRoot(window.__gsapBase + (window.__vt - window.__vt0) / 1000);
            x.frame();
          }
          return true;
        };
      }
      return true;
    })()"""

    def _install_vclock(self):
        self.eval(self.VCLOCK_JS)
        self.vclock = True

    def tick(self, n=30, dt=1 / 60):
        """advance virtual time by n steps of dt seconds, rendering each step"""
        if not self.vclock:
            self._install_vclock()
        # 1回のCDP呼び出しを短く保つ（長い同期ループはwebsocketのタイムアウトを招く）
        while n > 0:
            k = min(n, 15)
            self.eval("window.__step(%d,%f)" % (k, dt))
            n -= k

    def hide_debug(self):
        """hide the ?debug=1 perf box (fixed div, z-index 99)"""
        self.eval("(()=>{for(const d of document.querySelectorAll('body>div')){"
                  "if(d.style.position==='fixed'&&d.style.zIndex==='99'){d.style.display='none';}}return true;})()")

    def hide_hud(self, hide=True):
        v = "hidden" if hide else ""
        self.eval("(()=>{for(const id of ['hud','anchors']){const e=document.getElementById(id);"
                  "if(e)e.style.visibility='%s';}return true;})()" % v)

    def load(self):
        """load the 3D site and wait until ENTER is enabled (assets ready). Does not press ENTER."""
        self.open(BASE)
        for _ in range(240):
            if self.eval("!!window.__xp") and self.eval(
                    "(()=>{const b=document.getElementById('enterBtn');return !!b && !b.disabled;})()"):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("enterBtn never enabled")
        self._install_vclock()
        self.hide_debug()
        self.tick(10)

    def press_enter(self):
        self.eval("document.getElementById('enterBtn').click();"
                  "window.__xp.rig.entered=true; window.__xp.rig.started=true; true")

    def enter(self):
        """load + ENTER + settle (for stills)"""
        self.load()
        self.press_enter()
        self.tick(90)
        self.sleep(300)
        self.tick(30)

    def _area(self, name):
        return "window.__xp.AREAS.find(a=>a.name==='%s')" % name

    def area_t(self, name):
        return self.eval("%s.t" % self._area(name))

    def set_progress(self, t, mouse=None):
        m = "" if mouse is None else "x.rig.mouse.x=%f;x.rig.mouse.y=%f;" % (mouse[0], mouse[1])
        self.eval("(()=>{const x=window.__xp;x.ensureAreasAround(%f,1);x.rig.progress=%f;x.rig.target=%f;%sreturn true;})()"
                  % (t, t, t, m))

    def journey(self, name, t_offset=0.0, mouse=(0, 0), settle_ms=2500):
        """arrive at an area (journey view). t_offset shifts along the path (e.g. -0.05 = still in the fog)."""
        t = self.area_t(name) + t_offset
        self.set_progress(t, mouse)
        self.tick(30)
        self.sleep(settle_ms)
        self.tick(120)
        self.sleep(400)
        self.tick(30)

    def room(self, name, index=None, settle_ms=3000):
        """open the photo wall of an area; index = which photo comes to the front"""
        a = self._area(name)
        self.journey(name, settle_ms=800)
        self.eval("(()=>{const x=window.__xp;if(x.open)x.closeGallery(true);x.openGallery(%s);return true;})()" % a)
        for _ in range(40):
            self.tick(20)
            if self.eval("(()=>{const x=window.__xp;return !!x.tl && x.tl.progress()>=1;})()"):
                break
        if index is not None:
            self.eval("(()=>{const x=window.__xp,r=x.room;if(r&&r.sphere){x.sphereTurnTo(r,%d);}else if(r&&r.positions){r.snapPending=false;"
                      "x.scroll.target=r.offsetOf(%d);}return true;})()" % (index, index))
        self.sleep(settle_ms)
        self.tick(120)
        self.sleep(400)
        self.tick(30)

    def zoom(self, index=0, settle_ms=1500):
        self.eval("(()=>{const x=window.__xp,r=x.room;x.openZoom(r.meshes[%d]);return true;})()" % index)
        for _ in range(40):
            self.tick(20)
            if self.eval("(()=>{const x=window.__xp;return !x.zoomTl || x.zoomTl.progress()>=1;})()"):
                break
        self.sleep(settle_ms)
        self.tick(30)

    def close_zoom(self):
        self.eval("window.__xp.closeZoom(); true")
        for _ in range(40):
            self.tick(20)
            if self.eval("(()=>{const x=window.__xp;return !x.room || !x.room.zoomed;})()"):
                break

    def close_room(self):
        self.eval("window.__xp.closeGallery(); true")
        for _ in range(60):
            self.tick(20)
            if not self.eval("window.__xp.open"):
                break


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    s = Session(port=9311)
    t0 = time.time()
    s.enter()
    s.journey("PLANTS", mouse=(0.1, -0.05))
    s.shot(os.path.join(out, "v2_plants.png"))
    s.close()
    print("done in %.0fs" % (time.time() - t0))
