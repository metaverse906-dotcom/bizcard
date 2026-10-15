/* 高準確度文字辨識：PaddleOCR PP-OCRv5 行動版，用 ONNX Runtime Web 在手機上跑，照片不會上傳。
   檔案（約 26MB）只在使用者按「下載」後才抓，存在獨立的快取「bizcard-ocr」裡：
   app 改版不會被清掉，設定頁可以單獨刪除。
   流程：偵測文字位置（det）→ 每一塊拉正、縮成 48px 高 → 辨識（rec）→ CTC 解碼成文字。
   不用 OpenCV：找區塊、最小外接矩形、拉正都用自己寫的幾十行程式（拉正借用 crop.js 的 CardCrop.warp）。 */
(function(root){
  const ORT_VER="1.22.0", ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@"+ORT_VER+"/dist/";
  const MODELS=new URL("./ocr-models/", location.href).href;
  const FILES={
    ort:{url:ORT_BASE+"ort.wasm.min.js", size:48327},
    loader:{url:ORT_BASE+"ort-wasm-simd-threaded.mjs", size:20856},
    wasm:{url:ORT_BASE+"ort-wasm-simd-threaded.wasm", size:11210254},
    det:{url:MODELS+"det.ort", size:4896928},
    rec:{url:MODELS+"rec.onnx", size:9219908},
    dict:{url:MODELS+"dict.txt", size:74014}
  };
  const OCR_CACHE="bizcard-ocr";
  const TOTAL=Object.values(FILES).reduce((s,f)=>s+f.size,0);
  const st={det:null, rec:null, chars:null, loading:null};

  async function cacheGet(url){ const c=await caches.open(OCR_CACHE); return c.match(url); }
  async function fetchToCache(url, onBytes){
    const res=await fetch(url,{mode:"cors", cache:"no-store"});
    if(!res.ok) throw new Error("下載失敗（"+res.status+"）");
    const reader=res.body.getReader(), parts=[]; let n=0;
    for(;;){ const {done,value}=await reader.read(); if(done) break; parts.push(value); n+=value.length; onBytes&&onBytes(value.length); }
    const blob=new Blob(parts,{type:res.headers.get("Content-Type")||"application/octet-stream"});
    const c=await caches.open(OCR_CACHE);
    await c.put(url, new Response(blob,{headers:{"Content-Type":blob.type,"Content-Length":String(blob.size)}}));
    return blob;
  }
  async function isReady(){
    try{ for(const f of Object.values(FILES)) if(!(await cacheGet(f.url))) return false; return true; }catch(e){ return false; }
  }
  // 下載全部檔案；onProgress(0–1)
  async function download(onProgress){
    let got=0; const tick=b=>{ got+=b; onProgress&&onProgress(Math.min(1,got/TOTAL)); };
    for(const f of Object.values(FILES)){
      const hit=await cacheGet(f.url);
      if(hit){ tick(f.size); continue; }
      await fetchToCache(f.url, tick);
    }
    onProgress&&onProgress(1);
  }
  async function remove(){
    st.det=st.rec=st.chars=null; st.loading=null;
    const c=await caches.open(OCR_CACHE);
    for(const f of Object.values(FILES)) await c.delete(f.url);
  }
  async function blobOf(key){ const r=await cacheGet(FILES[key].url); if(!r) throw new Error("辨識資料還沒下載"); return r.blob(); }

  async function init(){
    if(st.det) return;
    if(st.loading) return st.loading;
    st.loading=(async()=>{
      if(!root.ort){
        const u=URL.createObjectURL(new Blob([await (await blobOf("ort")).text()],{type:"text/javascript"}));
        await new Promise((ok,bad)=>{ const s=document.createElement("script"); s.src=u; s.onload=ok; s.onerror=()=>bad(new Error("辨識元件載入失敗")); document.head.appendChild(s); });
      }
      const ort=root.ort;
      ort.env.wasm.numThreads=1;          // GitHub Pages 不能開跨來源隔離，只能單執行緒
      ort.env.wasm.proxy=false;
      // 載入器（.mjs）用原本的網址：service worker 會從「bizcard-ocr」快取拿，離線也能用；wasm 本體直接給記憶體裡的資料
      ort.env.wasm.wasmPaths=ORT_BASE;
      ort.env.wasm.wasmBinary=await (await blobOf("wasm")).arrayBuffer();
      const opt={executionProviders:["wasm"], graphOptimizationLevel:"all"};
      st.det=await ort.InferenceSession.create(new Uint8Array(await (await blobOf("det")).arrayBuffer()), opt);
      st.rec=await ort.InferenceSession.create(new Uint8Array(await (await blobOf("rec")).arrayBuffer()), opt);
      st.chars=[""].concat((await (await blobOf("dict")).text()).split("\n").filter(x=>x!==""));
    })();
    try{ await st.loading; }catch(e){ st.loading=null; st.det=st.rec=null; throw e; }
  }

  /* ---- 偵測後處理（DB 演算法的簡化版） ---- */
  function hull(pts){
    pts.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]), lo=[], up=[];
    for(const p of pts){ while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop(); lo.push(p); }
    for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  function minRect(h){   // 旋轉卡尺：回傳面積最小的外接矩形 {cx,cy,w,h,ux,uy}
    let best=null;
    const dirs=h.length<2?[[1,0]]:h.map((p,i)=>{ const q=h[(i+1)%h.length], L=Math.hypot(q[0]-p[0],q[1]-p[1])||1; return [(q[0]-p[0])/L,(q[1]-p[1])/L]; });
    for(const [ux,uy] of dirs){
      let a0=Infinity,a1=-Infinity,b0=Infinity,b1=-Infinity;
      for(const [x,y] of h){ const a=x*ux+y*uy, b=-x*uy+y*ux; if(a<a0)a0=a; if(a>a1)a1=a; if(b<b0)b0=b; if(b>b1)b1=b; }
      const area=(a1-a0)*(b1-b0);
      if(!best||area<best.area){ const ca=(a0+a1)/2, cb=(b0+b1)/2; best={area, w:a1-a0, h:b1-b0, ux, uy, cx:ca*ux-cb*uy, cy:ca*uy+cb*ux}; }
    }
    return best;
  }
  function corners(r){   // 依序左上、右上、右下、左下
    const {cx,cy,ux,uy}=r, hw=r.w/2, hh=r.h/2, vx=-uy, vy=ux;
    const p=[[cx-ux*hw-vx*hh, cy-uy*hw-vy*hh],[cx+ux*hw-vx*hh, cy+uy*hw-vy*hh],[cx+ux*hw+vx*hh, cy+uy*hw+vy*hh],[cx-ux*hw+vx*hh, cy-uy*hw+vy*hh]];
    const s=p.map(q=>q[0]+q[1]), d=p.map(q=>q[1]-q[0]);
    const ix=a=>a.indexOf(Math.min(...a)), ax=a=>a.indexOf(Math.max(...a));
    return [p[ix(s)], p[ix(d)], p[ax(s)], p[ax(d)]];
  }
  function boxesFrom(prob, W, H){
    const n=W*H, lab=new Int32Array(n), stack=new Int32Array(n), out=[]; let cur=0;
    for(let i=0;i<n;i++){
      if(lab[i]||prob[i]<=0.3) continue;
      cur++; let sp=0, cnt=0, sum=0; stack[sp++]=i; lab[i]=cur;
      const rows=new Map();
      while(sp){
        const j=stack[--sp], x=j%W, y=(j/W)|0; cnt++; sum+=prob[j];
        const r=rows.get(y); if(!r) rows.set(y,[x,x]); else { if(x<r[0]) r[0]=x; if(x>r[1]) r[1]=x; }
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
          if(!dx&&!dy) continue; const xx=x+dx, yy=y+dy;
          if(xx<0||yy<0||xx>=W||yy>=H) continue; const k=yy*W+xx;
          if(!lab[k]&&prob[k]>0.3){ lab[k]=cur; stack[sp++]=k; }
        }
      }
      if(cnt<4 || sum/cnt<0.6) continue;
      const pts=[]; rows.forEach((r,y)=>{ pts.push([r[0],y],[r[1]+1,y],[r[0],y+1],[r[1]+1,y+1]); });
      const r=minRect(hull(pts));
      if(Math.min(r.w,r.h)<3) continue;
      const d=r.w*r.h*1.5/(2*(r.w+r.h));   // unclip：往外擴張，補回模型縮小的文字框
      r.w+=2*d; r.h+=2*d;
      if(Math.min(r.w,r.h)<5) continue;
      out.push(r);
    }
    return out;
  }

  function toCHW(data, w, h, mean, std, bgr){
    const f=new Float32Array(3*w*h), plane=w*h;
    for(let i=0;i<plane;i++){
      const r=data[i*4]/255, g=data[i*4+1]/255, b=data[i*4+2]/255;
      const c=bgr?[b,g,r]:[r,g,b];
      for(let k=0;k<3;k++) f[k*plane+i]=(c[k]-mean[k])/std[k];
    }
    return f;
  }
  const yieldUI=()=>new Promise(r=>setTimeout(r,0));

  /* canvas → [{text, conf(0–100), h, box:{x,y,w,h}（0–1）}] */
  async function recognize(canvas, onStatus){
    await init();
    const ort=root.ort, IW=canvas.width, IH=canvas.height;
    const src=canvas.getContext("2d",{willReadFrequently:true}).getImageData(0,0,IW,IH).data;
    // 1. 偵測
    const s=Math.min(1, 960/Math.max(IW,IH)), DW=Math.max(32,Math.round(IW*s/32)*32), DH=Math.max(32,Math.round(IH*s/32)*32);
    const dc=document.createElement("canvas"); dc.width=DW; dc.height=DH;
    const dg=dc.getContext("2d",{willReadFrequently:true}); dg.drawImage(canvas,0,0,DW,DH);
    const dIn=toCHW(dg.getImageData(0,0,DW,DH).data, DW, DH, [0.485,0.456,0.406], [0.229,0.224,0.225], true);
    const dOut=await st.det.run({[st.det.inputNames[0]]: new ort.Tensor("float32", dIn, [1,3,DH,DW])});
    const prob=dOut[st.det.outputNames[0]].data;
    const rects=boxesFrom(prob, DW, DH);
    const kx=IW/DW, ky=IH/DH;
    let boxes=rects.map(r=>corners(r).map(([x,y])=>[Math.max(0,Math.min(IW,x*kx)), Math.max(0,Math.min(IH,y*ky))]));
    // 由上而下、同一行由左而右
    boxes.sort((a,b)=>a[0][1]-b[0][1]||a[0][0]-b[0][0]);
    for(let i=0;i<boxes.length-1;i++) for(let j=i;j>=0;j--){
      const A=boxes[j], B=boxes[j+1], hA=Math.hypot(A[3][0]-A[0][0],A[3][1]-A[0][1]);
      if(Math.abs(B[0][1]-A[0][1])<Math.max(10,hA*0.5) && B[0][0]<A[0][0]){ boxes[j]=B; boxes[j+1]=A; } else break;
    }
    // 2. 逐塊辨識
    const lines=[], rc=document.createElement("canvas"), rg=rc.getContext("2d",{willReadFrequently:true});
    for(let bi=0;bi<boxes.length;bi++){
      const q=boxes[bi], d=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
      const cw=Math.max(1,Math.round(Math.max(d(q[0],q[1]),d(q[3],q[2])))), ch=Math.max(1,Math.round(Math.max(d(q[0],q[3]),d(q[1],q[2]))));
      const crop=root.CardCrop.warp(src, IW, IH, q, cw, ch);
      let cc=document.createElement("canvas"); cc.width=cw; cc.height=ch; cc.getContext("2d").putImageData(new ImageData(crop,cw,ch),0,0);
      if(ch/cw>=1.5){   // 直排的一塊：轉成橫的再辨識
        const t=document.createElement("canvas"); t.width=ch; t.height=cw; const tg=t.getContext("2d");
        tg.translate(0,cw); tg.rotate(-Math.PI/2); tg.drawImage(cc,0,0); cc=t;
      }
      const RW=Math.max(16, Math.min(1600, Math.ceil(48*cc.width/cc.height)));
      rc.width=RW; rc.height=48; rg.drawImage(cc,0,0,RW,48);
      const rIn=toCHW(rg.getImageData(0,0,RW,48).data, RW, 48, [0.5,0.5,0.5], [0.5,0.5,0.5], true);
      const o=(await st.rec.run({[st.rec.inputNames[0]]: new ort.Tensor("float32", rIn, [1,3,48,RW])}))[st.rec.outputNames[0]];
      const [,T,C]=o.dims, P=o.data; let last=0, text="", ps=[];
      for(let t=0;t<T;t++){
        let mi=0, mv=-1; const off=t*C; for(let c=0;c<C;c++){ const v=P[off+c]; if(v>mv){ mv=v; mi=c; } }
        if(mi!==0 && mi!==last){ text+=st.chars[mi]??""; ps.push(mv); }
        last=mi;
      }
      const conf=ps.length?ps.reduce((a,b)=>a+b,0)/ps.length:0;
      text=text.replace(/　/g," ").trim();
      if(text && conf>=0.5){
        const xs=q.map(p=>p[0]), ys=q.map(p=>p[1]), x0=Math.min(...xs), y0=Math.min(...ys);
        lines.push({text, conf:Math.round(conf*100), h:ch, box:{x:x0/IW, y:y0/IH, w:(Math.max(...xs)-x0)/IW, h:(Math.max(...ys)-y0)/IH}});
      }
      if(onStatus && bi%4===3) onStatus(bi+1, boxes.length);
      await yieldUI();
    }
    return lines;
  }
  async function usage(){
    let b=0; try{ for(const f of Object.values(FILES)){ const r=await cacheGet(f.url); if(r) b+=+(r.headers.get("Content-Length")||0) || (await r.clone().blob()).size; } }catch(e){}
    return b;
  }
  root.PaddleOCR={isReady, download, remove, recognize, usage, TOTAL, OCR_CACHE, init};
})(typeof self!=="undefined"?self:this);
