// 離線快取：沒有網路時也能打開 app、遞名片。
// 改版時把 CACHE 的版本號 +1，index.html 裡程式檔的 ?v= 也一起改成同一個數字，手機下次連線就會換成新版。
// 文字辨識的檔案（Tesseract、PaddleOCR、ONNX Runtime）放在另一個快取 OCR_CACHE：
// 改版時不會被清掉，也不用重新下載；只有使用者在設定頁按「刪除」才會移除。
const CACHE = "bizcard-v15";
const OCR_CACHE = "bizcard-ocr";
const SHELL = ["./", "./index.html", "./cardparse.js?v=15", "./crop.js?v=15", "./paddle.js?v=15", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // 頁面本身：先拿網路上的新版，離線時用快取
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }
  // 只快取 app 自己的檔案、字體、QR code 與文字辨識元件；Google 登入與 Drive 的請求一律直接上網、不留存
  const url = new URL(req.url);
  const isOcr = url.hostname === "cdn.jsdelivr.net" || url.pathname.includes("/ocr-models/");
  const cacheable = isOcr || url.origin === self.location.origin ||
    ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"].includes(url.hostname);
  if (!cacheable) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // 辨識模型檔很大，由 app 自己下載並存進 OCR_CACHE（才能顯示進度）；這裡不重複存
      if ((res.ok || res.type === "opaque") && !url.pathname.includes("/ocr-models/")) {
        const copy = res.clone(); caches.open(isOcr ? OCR_CACHE : CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
