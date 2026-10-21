// 離線快取：沒有網路時也能打開 app、遞名片。
// 版本號由 index.html 註冊時帶進來（sw.js?v=0.6.0），這裡不用改：index.html 開頭的 APP_VERSION 一變，手機下次連線就會換成新版。
// 文字辨識的檔案（Tesseract、PaddleOCR、ONNX Runtime）放在另一個快取 OCR_CACHE：
// 改版時不會被清掉，也不用重新下載；只有使用者在設定頁按「刪除」才會移除。
const V = new URL(self.location.href).searchParams.get("v") || "0";
const CACHE = "bizcard-" + V;
const OCR_CACHE = "bizcard-ocr";
const SHELL = ["./", "./index.html", "./cardparse.js?v=" + V, "./crop.js?v=" + V, "./paddle.js?v=" + V, "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

// 不透明回應（沒有 CORS 的外部檔案）在 Chrome 裡每個會被算成約 7MB 的空間，所以不存；舊版存過的也清掉
async function purgeOpaque(name){
  const c=await caches.open(name);
  for(const req of await c.keys()){ const r=await c.match(req); if(!r || r.type==="opaque") await c.delete(req); }
}
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => (k !== CACHE && k !== OCR_CACHE) ? caches.delete(k) : purgeOpaque(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // 頁面本身：先拿網路上的新版，離線時用快取
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req, {cache: "no-cache"})   // 不用瀏覽器暫存的舊頁面（GitHub Pages 會讓頁面暫存 10 分鐘），有網路就拿最新版
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }
  // 只快取 app 自己的檔案、字體、QR code 與文字辨識元件；Google 登入與 Drive 的請求一律直接上網、不留存
  const url = new URL(req.url);
  if (url.searchParams.has("vcheck")) return;   // 檢查新版本：一定直接上網，不經過快取
  const isOcr = url.hostname === "cdn.jsdelivr.net" || url.pathname.includes("/ocr-models/");
  const cacheable = isOcr || url.origin === self.location.origin ||
    ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"].includes(url.hostname);
  if (!cacheable) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // 辨識模型檔很大，由 app 自己下載並存進 OCR_CACHE（才能顯示進度）；這裡不重複存
      if (res.ok && res.type !== "opaque" && !url.pathname.includes("/ocr-models/")) {
        const copy = res.clone(); caches.open(isOcr ? OCR_CACHE : CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
