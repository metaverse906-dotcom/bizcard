/* 名片自動裁切：找出照片裡名片的四個角，再拉正成長方形。
   不用 OpenCV（約 8MB），只用幾 KB 的純 JavaScript，全部在手機上算，照片不會上傳。
   作法：
   1. 照片縮到約 320px，從照片四周取樣估計「背景色」
   2. 每個像素和背景色的差距 → 用 Otsu 自動找門檻 → 分出前景（名片）
   3. 取最大的一塊前景，算外框（凸包），再簡化成四邊形，最後用直線擬合把四個角對準邊緣
   4. 檢查形狀像不像長方形；不像就回傳 null，讓使用者手動拖四個角
   拉正：用四個角算出透視轉換（homography），逐點取樣成新的長方形圖。 */
(function(root, factory){
  if(typeof module==="object" && module.exports) module.exports=factory();
  else root.CardCrop=factory();
})(typeof self!=="undefined"?self:this, function(){

  function otsu(hist, total){
    let sum=0; for(let i=0;i<256;i++) sum+=i*hist[i];
    let sumB=0, wB=0, best=0, thr=0;
    for(let t=0;t<256;t++){
      wB+=hist[t]; if(!wB) continue;
      const wF=total-wB; if(!wF) break;
      sumB+=t*hist[t];
      const mB=sumB/wB, mF=(sum-sumB)/wF, v=wB*wF*(mB-mF)*(mB-mF);
      if(v>best){ best=v; thr=t; }
    }
    return thr;
  }
  const median = a => { const s=Array.from(a).sort((x,y)=>x-y); return s[s.length>>1]; };

  function hull(pts){   // Andrew monotone chain，回傳逆時針（y 向下的座標系裡是順時針）
    pts=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
    const lo=[], up=[];
    for(const p of pts){ while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop(); lo.push(p); }
    for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(up.length>=2&&cross(up[up.length-2],up[up.length-1],p)<=0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  const triArea=(a,b,c)=>Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
  function polyArea(p){ let s=0; for(let i=0;i<p.length;i++){ const a=p[i], b=p[(i+1)%p.length]; s+=a[0]*b[1]-b[0]*a[1]; } return Math.abs(s)/2; }

  // 依序 左上、右上、右下、左下
  function order(q){
    const c=[q.reduce((s,p)=>s+p[0],0)/4, q.reduce((s,p)=>s+p[1],0)/4];
    const s=q.slice().sort((a,b)=>Math.atan2(a[1]-c[1],a[0]-c[0])-Math.atan2(b[1]-c[1],b[0]-c[0]));
    // atan2 排序後從左上開始（x+y 最小的點）
    let k=0, m=Infinity; s.forEach((p,i)=>{ if(p[0]+p[1]<m){ m=p[0]+p[1]; k=i; } });
    return [0,1,2,3].map(i=>s[(k+i)%4]);
  }

  function fitLine(pts){   // 總最小平方法：回傳 [點, 方向]
    const n=pts.length; let mx=0,my=0; for(const p of pts){ mx+=p[0]; my+=p[1]; } mx/=n; my/=n;
    let sxx=0,syy=0,sxy=0; for(const p of pts){ const dx=p[0]-mx, dy=p[1]-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
    const th=0.5*Math.atan2(2*sxy, sxx-syy); return [[mx,my],[Math.cos(th),Math.sin(th)]];
  }
  function intersect(L1, L2){
    const [p,d]=L1, [q,e]=L2, den=d[0]*e[1]-d[1]*e[0]; if(Math.abs(den)<1e-6) return null;
    const t=((q[0]-p[0])*e[1]-(q[1]-p[1])*e[0])/den; return [p[0]+t*d[0], p[1]+t*d[1]];
  }
  function segDist(p,a,b){
    const vx=b[0]-a[0], vy=b[1]-a[1], L=vx*vx+vy*vy||1; let t=((p[0]-a[0])*vx+(p[1]-a[1])*vy)/L; t=Math.max(0,Math.min(1,t));
    return Math.hypot(p[0]-a[0]-t*vx, p[1]-a[1]-t*vy);
  }

  /* rgba：Uint8ClampedArray（建議最長邊 240–400px）。找到回傳 [[x,y]×4]（0–1，左上起順時針），找不到回傳 null */
  function detect(rgba, w, h){
    const n=w*h, m=Math.max(2, Math.round(Math.min(w,h)*0.03));
    const R=[],G=[],B=[];
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      if(x>=m && x<w-m && y>=m && y<h-m) continue;
      if((x+y)&1) continue;
      const i=(y*w+x)*4; R.push(rgba[i]); G.push(rgba[i+1]); B.push(rgba[i+2]);
    }
    const br=median(R), bg=median(G), bb=median(B);
    // 和背景色的差距（0–255），先做 3×3 平均降低雜訊
    const dist=new Uint8Array(n), hist=new Uint32Array(256);
    for(let i=0;i<n;i++){
      const r=rgba[i*4]-br, g=rgba[i*4+1]-bg, b=rgba[i*4+2]-bb;
      dist[i]=Math.min(255, Math.sqrt(r*r+g*g+b*b)*0.6|0);
    }
    const sm=new Uint8Array(n);
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
      let s=0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) s+=dist[(y+dy)*w+x+dx];
      sm[y*w+x]=s/9|0;
    }
    for(let i=0;i<n;i++) hist[sm[i]]++;
    const thr=otsu(hist, n);
    if(thr<12) return null;                      // 名片和背景幾乎同色，交給手動
    const mask=new Uint8Array(n); for(let i=0;i<n;i++) mask[i]=sm[i]>thr?1:0;
    // 四周邊框大多是前景：名片塞滿畫面或背景太花，交給手動
    let edgeOn=0, edgeAll=0;
    for(let x=0;x<w;x++){ edgeOn+=mask[x]+mask[(h-1)*w+x]; edgeAll+=2; }
    for(let y=0;y<h;y++){ edgeOn+=mask[y*w]+mask[y*w+w-1]; edgeAll+=2; }
    if(edgeOn/edgeAll>0.35) return null;
    // 最大連通區塊
    const lab=new Int32Array(n), stack=new Int32Array(n); let best=0, bestN=0, cur=0;
    for(let i=0;i<n;i++){
      if(!mask[i]||lab[i]) continue;
      cur++; let sp=0, cnt=0; stack[sp++]=i; lab[i]=cur;
      while(sp){ const j=stack[--sp]; cnt++; const x=j%w, y=(j/w)|0;
        if(x>0&&mask[j-1]&&!lab[j-1]){ lab[j-1]=cur; stack[sp++]=j-1; }
        if(x<w-1&&mask[j+1]&&!lab[j+1]){ lab[j+1]=cur; stack[sp++]=j+1; }
        if(y>0&&mask[j-w]&&!lab[j-w]){ lab[j-w]=cur; stack[sp++]=j-w; }
        if(y<h-1&&mask[j+w]&&!lab[j+w]){ lab[j+w]=cur; stack[sp++]=j+w; } }
      if(cnt>bestN){ bestN=cnt; best=cur; }
    }
    if(bestN<n*0.08) return null;
    // 外框點：每列最左最右、每欄最上最下
    const pts=[];
    for(let y=0;y<h;y++){ let a=-1,b=-1; for(let x=0;x<w;x++) if(lab[y*w+x]===best){ if(a<0) a=x; b=x; } if(a>=0){ pts.push([a,y]); pts.push([b+1,y]); } }
    for(let x=0;x<w;x++){ let a=-1,b=-1; for(let y=0;y<h;y++) if(lab[y*w+x]===best){ if(a<0) a=y; b=y; } if(a>=0){ pts.push([x,a]); pts.push([x,b+1]); } }
    let hp=hull(pts);
    if(hp.length<4) return null;
    const hullArea=polyArea(hp);
    while(hp.length>4){
      let k=0, mn=Infinity;
      for(let i=0;i<hp.length;i++){ const a=triArea(hp[(i-1+hp.length)%hp.length], hp[i], hp[(i+1)%hp.length]); if(a<mn){ mn=a; k=i; } }
      hp.splice(k,1);
    }
    let q=order(hp);
    // 用直線擬合把四個邊對準（名片的圓角會讓簡化後的角往內縮）
    const tol=Math.max(2, Math.min(w,h)*0.02);
    const lines=[];
    for(let e=0;e<4;e++){
      const a=q[e], b=q[(e+1)%4], len=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const near=pts.filter(p=>{ if(segDist(p,a,b)>tol) return false;
        const t=((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]))/(len*len); return t>0.12&&t<0.88; });
      lines.push(near.length>=6?fitLine(near):[a,[(b[0]-a[0])/len,(b[1]-a[1])/len]]);
    }
    const ref=[0,1,2,3].map(i=>intersect(lines[(i+3)%4], lines[i]));
    if(ref.every(p=>p && p[0]>-w*0.1 && p[0]<w*1.1 && p[1]>-h*0.1 && p[1]<h*1.1)) q=order(ref);
    // 形狀檢查：面積、角度、和實際區塊的吻合度
    const qa=polyArea(q);
    if(qa<n*0.1 || qa>n*0.98) return null;
    if(Math.abs(qa-hullArea)/hullArea>0.15) return null;
    for(let i=0;i<4;i++){
      const p=q[(i+3)%4], c=q[i], nx=q[(i+1)%4];
      const v1=[p[0]-c[0],p[1]-c[1]], v2=[nx[0]-c[0],nx[1]-c[1]];
      const ang=Math.acos(Math.max(-1,Math.min(1,(v1[0]*v2[0]+v1[1]*v2[1])/(Math.hypot(...v1)*Math.hypot(...v2)))))*180/Math.PI;
      if(ang<50||ang>130) return null;
    }
    return q.map(p=>[Math.max(0,Math.min(1,p[0]/w)), Math.max(0,Math.min(1,p[1]/h))]);
  }

  // 解 8×8 線性方程：把輸出長方形 (0,0)-(W,H) 對應到來源四邊形
  function homography(src, W, H){
    const dst=[[0,0],[W,0],[W,H],[0,H]], A=[], bv=[];
    for(let i=0;i<4;i++){
      const [u,v]=dst[i], [x,y]=src[i];
      A.push([u,v,1,0,0,0,-u*x,-v*x]); bv.push(x);
      A.push([0,0,0,u,v,1,-u*y,-v*y]); bv.push(y);
    }
    for(let c=0;c<8;c++){
      let p=c; for(let r=c+1;r<8;r++) if(Math.abs(A[r][c])>Math.abs(A[p][c])) p=r;
      [A[c],A[p]]=[A[p],A[c]]; [bv[c],bv[p]]=[bv[p],bv[c]];
      for(let r=0;r<8;r++){ if(r===c) continue; const f=A[r][c]/A[c][c]; for(let k=c;k<8;k++) A[r][k]-=f*A[c][k]; bv[r]-=f*bv[c]; }
    }
    return bv.map((b,i)=>b/A[i][i]);
  }

  // 四邊形（像素座標，左上起順時針）的輸出尺寸：對邊長度取平均，最長邊不超過 maxSide
  function outSize(q, maxSide){
    const d=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
    const W=(d(q[0],q[1])+d(q[3],q[2]))/2, H=(d(q[0],q[3])+d(q[1],q[2]))/2;
    const s=maxSide/Math.max(W,H); return [Math.max(1,Math.round(W*s)), Math.max(1,Math.round(H*s))];
  }

  /* src：ImageData 來源（rgba, sw, sh）；q：像素座標四點；回傳新的 rgba 與尺寸 */
  function warp(rgba, sw, sh, q, W, H){
    const m=homography(q, W, H), out=new Uint8ClampedArray(W*H*4);
    for(let v=0;v<H;v++){
      for(let u=0;u<W;u++){
        const den=m[6]*(u+.5)+m[7]*(v+.5)+1;
        let x=(m[0]*(u+.5)+m[1]*(v+.5)+m[2])/den-.5, y=(m[3]*(u+.5)+m[4]*(v+.5)+m[5])/den-.5;
        x=Math.max(0,Math.min(sw-1.001,x)); y=Math.max(0,Math.min(sh-1.001,y));
        const x0=x|0, y0=y|0, fx=x-x0, fy=y-y0, i00=(y0*sw+x0)*4, i10=i00+4, i01=i00+sw*4, i11=i01+4, o=(v*W+u)*4;
        for(let c=0;c<3;c++){
          out[o+c]=(rgba[i00+c]*(1-fx)+rgba[i10+c]*fx)*(1-fy)+(rgba[i01+c]*(1-fx)+rgba[i11+c]*fx)*fy;
        }
        out[o+3]=255;
      }
    }
    return out;
  }

  /* ---- 瀏覽器用的包裝（canvas） ---- */
  function detectCanvas(canvas){
    const s=Math.min(1, 320/Math.max(canvas.width,canvas.height));
    const c=document.createElement("canvas"); c.width=Math.max(1,Math.round(canvas.width*s)); c.height=Math.max(1,Math.round(canvas.height*s));
    const g=c.getContext("2d",{willReadFrequently:true}); g.drawImage(canvas,0,0,c.width,c.height);
    try{ return detect(g.getImageData(0,0,c.width,c.height).data, c.width, c.height); }catch(e){ return null; }
  }
  // q：0–1 四點；rot：0–3（每次轉 90°）；回傳 canvas
  function cropCanvas(canvas, q, rot, maxSide){
    const pts=q.map(p=>[p[0]*canvas.width, p[1]*canvas.height]);
    const r=((rot||0)%4+4)%4, src=[0,1,2,3].map(i=>pts[(i+r)%4]);
    const [W,H]=outSize(src, maxSide);
    // 先縮到剛好比輸出大一些再取樣，避免大圖逐點計算太慢、也減少鋸齒
    const need=Math.min(1, (maxSide*1.4)/Math.max(canvas.width,canvas.height));
    const sc=document.createElement("canvas"); sc.width=Math.round(canvas.width*need); sc.height=Math.round(canvas.height*need);
    const sg=sc.getContext("2d",{willReadFrequently:true}); sg.drawImage(canvas,0,0,sc.width,sc.height);
    const data=sg.getImageData(0,0,sc.width,sc.height).data;
    const out=warp(data, sc.width, sc.height, src.map(p=>[p[0]*need,p[1]*need]), W, H);
    const oc=document.createElement("canvas"); oc.width=W; oc.height=H;
    oc.getContext("2d").putImageData(new ImageData(out,W,H),0,0);
    return oc;
  }
  return {detect, warp, homography, outSize, order, detectCanvas, cropCanvas};
});
