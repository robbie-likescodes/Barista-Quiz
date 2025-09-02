/* Palette Mapper — Cup Print Helper (FULL JS)
   v4 — Everything so far + HALFTONE DOTS

   Adds:
   - iOS-safe Eyedropper (non-passive + preventDefault)
   - Library upload + optional Camera-only input
   - Full-screen Editor overlay (Eyedropper, Lasso polygon, Pan)
   - Polygon regions with per-region palette restrictions (persisted as points)
   - Rectangle regions (legacy)
   - Dithering / perceptual mapping in Lab
   - Projects (IndexedDB), Saved palettes (localStorage)
   - NEW: Halftone (tiny dots) renderer with cell size, jitter, background color
          + region restrictions respected per-cell

   No dependencies. GitHub Pages-ready.
*/

/* ---------------------------------- DOM ---------------------------------- */
const els = {
  // Image & canvases
  fileInput: document.getElementById('fileInput'),
  cameraInput: document.getElementById('cameraInput'),
  pasteBtn: document.getElementById('pasteBtn'),
  resetBtn: document.getElementById('resetBtn'),
  maxW: document.getElementById('maxW'),
  keepFullRes: document.getElementById('keepFullRes'),
  srcCanvas: document.getElementById('srcCanvas'),
  outCanvas: document.getElementById('outCanvas'),

  // Palette
  addColor: document.getElementById('addColor'),
  clearColors: document.getElementById('clearColors'),
  loadExample: document.getElementById('loadExample'),
  paletteList: document.getElementById('paletteList'),
  kColors: document.getElementById('kColors'),
  autoExtract: document.getElementById('autoExtract'),

  // Mapping options
  wChroma: document.getElementById('wChroma'),
  wLight: document.getElementById('wLight'),
  wChromaOut: document.getElementById('wChromaOut'),
  wLightOut: document.getElementById('wLightOut'),
  useDither: document.getElementById('useDither'),
  bgMode: document.getElementById('bgMode'),
  applyBtn: document.getElementById('applyBtn'),
  downloadBtn: document.getElementById('downloadBtn'),

  // Halftone controls (NEW)
  useHalftone: document.getElementById('useHalftone'),
  dotCell: document.getElementById('dotCell'),
  dotBg: document.getElementById('dotBg'),
  dotJitter: document.getElementById('dotJitter'),

  // Projects + saved palettes
  openProjects: document.getElementById('openProjects'),
  closeProjects: document.getElementById('closeProjects'),
  projectsPane: document.getElementById('projectsPane'),
  saveProject: document.getElementById('saveProject'),
  refreshProjects: document.getElementById('refreshProjects'),
  projectsList: document.getElementById('projectsList'),
  exportProject: document.getElementById('exportProject'),
  importProject: document.getElementById('importProject'),
  deleteProject: document.getElementById('deleteProject'),
  savedPalettes: document.getElementById('savedPalettes'),
  savePalette: document.getElementById('savePalette'),
  clearSavedPalettes: document.getElementById('clearSavedPalettes'),

  // Rectangle region UI
  regionMode: document.getElementById('regionMode'),
  regionClear: document.getElementById('regionClear'),
  regionConfig: document.getElementById('regionConfig'),
  regionPaletteChecks: document.getElementById('regionPaletteChecks'),
  regionApply: document.getElementById('regionApply'),
  regionCancel: document.getElementById('regionCancel'),

  // Eyedropper popover
  eyePopover: document.getElementById('eyedropperPopover'),
  eyeSwatch: document.getElementById('eyeSwatch'),
  eyeHex: document.getElementById('eyeHex'),
  eyeAdd: document.getElementById('eyeAdd'),
  eyeCancel: document.getElementById('eyeCancel'),

  // Full-screen editor overlay
  openEditor: document.getElementById('openEditor'),
  editorOverlay: document.getElementById('editorOverlay'),
  toolEyedrop: document.getElementById('toolEyedrop'),
  toolLasso: document.getElementById('toolLasso'),
  toolPan: document.getElementById('toolPan'),
  editorDone: document.getElementById('editorDone'),
  editCanvas: document.getElementById('editCanvas'),
  editOverlay: document.getElementById('editOverlay'),
  editorPalette: document.getElementById('editorPalette'),
  lassoChecks: document.getElementById('lassoChecks'),
  lassoSave: document.getElementById('lassoSave'),
  lassoClear: document.getElementById('lassoClear'),
};
const sctx = els.srcCanvas.getContext('2d', { willReadFrequently: true });
const octx = els.outCanvas.getContext('2d', { willReadFrequently: true });

/* --------------------------------- State --------------------------------- */
const state = { fullBitmap: null, fullW: 0, fullH: 0, selectedProjectId: null };
/*
  Regions array items:
  - Rect: { x0,y0,x1,y1, allowed:Set<number> }
  - Poly: { type:'polygon', points:[[x,y]...](preview coords), mask:Uint8Array, allowed:Set<number> }
*/
const regions = [];

const editor = {
  active:false, tool:'eyedrop',
  ectx:null, octx:null, lassoPts:[], lassoActive:false,
};

/* ------------------------------- Utilities ------------------------------- */
const clamp = (v, min, max) => (v < min ? min : (v > max ? max : v));
const hexToRgb = (hex) => { let h=(hex||'').trim(); if(!h.startsWith('#')) h='#'+h; const m=/^#([0-9a-f]{6})$/i.exec(h); if(!m) return null; const n=parseInt(m[1],16); return {r:(n>>16)&255, g:(n>>8)&255, b:n&255}; };
const rgbToHex = (r,g,b) => '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
const fmtMult = n => (Number(n)/100).toFixed(2)+'×';
const inRect = (x,y,r) => x>=r.x0 && x<=r.x1 && y>=r.y0 && y<=r.y1;
const normalizeRect = r => ({ x0:Math.min(r.x0,r.x1), y0:Math.min(r.y0,r.y1), x1:Math.max(r.x0,r.x1), y1:Math.max(r.y0,r.y1) });
const scaleRect = (r,sx,sy)=>({ x0:Math.floor(r.x0*sx), y0:Math.floor(r.y0*sy), x1:Math.floor(r.x1*sx), y1:Math.floor(r.y1*sy) });

/* -------------------------------- Storage -------------------------------- */
const LS_KEYS = { PALETTES:'pm_saved_palettes_v1', PREFS:'pm_prefs_v1' };
const loadSavedPalettes = () => { try { return JSON.parse(localStorage.getItem(LS_KEYS.PALETTES)||'[]'); } catch { return []; } };
const saveSavedPalettes = arr => localStorage.setItem(LS_KEYS.PALETTES, JSON.stringify(arr));
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(LS_KEYS.PREFS)||'{}'); } catch { return {}; } };
const savePrefs = obj => localStorage.setItem(LS_KEYS.PREFS, JSON.stringify(obj));

const DB_NAME='palette_mapper_db', DB_STORE='projects';
function openDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open(DB_NAME,1); r.onupgradeneeded=()=>{const db=r.result; if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE,{keyPath:'id',autoIncrement:true});}; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });}
async function dbPutProject(rec){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readwrite'); const st=tx.objectStore(DB_STORE); const r=st.put(rec); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });}
async function dbGetAll(){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readonly'); const st=tx.objectStore(DB_STORE); const r=st.getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });}
async function dbGet(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readonly'); const st=tx.objectStore(DB_STORE); const r=st.get(id); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });}
async function dbDelete(id){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(DB_STORE,'readwrite'); const st=tx.objectStore(DB_STORE); const r=st.delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });}

/* ------------------------------ Palette UI ------------------------------- */
function addPaletteRow(hex='#FFFFFF'){
  const row=document.createElement('div'); row.className='palette-item';
  row.innerHTML=`
    <input type="color" value="${hex}" aria-label="color picker">
    <input type="text" value="${hex}" aria-label="hex code" placeholder="#RRGGBB">
    <button class="ghost remove" type="button">Remove</button>
  `;
  const colorInput=row.querySelector('input[type=color]');
  const hexInput=row.querySelector('input[type=text]');
  const delBtn=row.querySelector('.remove');
  const sync=(fromColor)=>{
    if(fromColor) hexInput.value = colorInput.value.toUpperCase();
    let v=hexInput.value.trim(); if(!v.startsWith('#')) v='#'+v;
    if(/^#([0-9A-Fa-f]{6})$/.test(v)){ colorInput.value=v; hexInput.value=v.toUpperCase(); }
  };
  colorInput.addEventListener('input',()=>sync(true));
  hexInput.addEventListener('change',()=>sync(false));
  delBtn.addEventListener('click',()=>row.remove());
  els.paletteList.appendChild(row);
}
function getPalette(){
  const rows=[...els.paletteList.querySelectorAll('.palette-item')];
  const out=[]; for(const r of rows){ const hex=r.querySelector('input[type=text]').value.trim(); const rgb=hexToRgb(hex); if(rgb) out.push([rgb.r,rgb.g,rgb.b]); }
  return out;
}
function setPalette(hexes){ els.paletteList.innerHTML=''; hexes.forEach(h=>addPaletteRow(h)); }
function renderSavedPalettes(){
  if(!els.savedPalettes) return;
  const list=loadSavedPalettes(); els.savedPalettes.innerHTML='';
  list.forEach((p,idx)=>{ const div=document.createElement('div'); div.className='item';
    const sw=p.colors.map(h=>`<span title="${h}" style="display:inline-block;width:16px;height:16px;border-radius:4px;border:1px solid #334155;background:${h}"></span>`).join('');
    div.innerHTML=`<div><strong>${p.name||('Palette '+(idx+1))}</strong><br><small>${p.colors.join(', ')}</small></div><div>${sw}</div>`;
    div.addEventListener('click',()=>setPalette(p.colors));
    els.savedPalettes.appendChild(div);
  });
}

/* --------------------------- Image load/preview -------------------------- */
async function handleFile(file){ const bmp=await createImageBitmap(file); state.fullBitmap=bmp; state.fullW=bmp.width; state.fullH=bmp.height; drawSrc(bmp); toggleImageActions(true); }
function drawSrc(bmp){
  const mW=parseInt(els.maxW.value||'1400',10); let w=bmp.width, h=bmp.height;
  if(w>mW){ const s=mW/w; w=Math.round(w*s); h=Math.round(h*s); }
  els.srcCanvas.width=w; els.srcCanvas.height=h; sctx.clearRect(0,0,w,h); sctx.drawImage(bmp,0,0,w,h);
  els.outCanvas.width=w; els.outCanvas.height=h; octx.clearRect(0,0,w,h); els.downloadBtn.disabled=true;
}
function toggleImageActions(enable){ els.applyBtn.disabled=!enable; if(els.autoExtract) els.autoExtract.disabled=!enable; els.resetBtn.disabled=!enable; }

/* ------------------------------ Color math ------------------------------- */
function srgbToLinear(u){ u/=255; return (u<=0.04045)? u/12.92 : Math.pow((u+0.055)/1.055,2.4); }
function rgbToXyz(r,g,b){ r=srgbToLinear(r); g=srgbToLinear(g); b=srgbToLinear(b);
  const x=r*0.4124564 + g*0.3575761 + b*0.1804375;
  const y=r*0.2126729 + g*0.7151522 + b*0.0721750;
  const z=r*0.0193339 + g*0.1191920 + b*0.9503041; return [x,y,z]; }
function xyzToLab(x,y,z){ const Xn=0.95047,Yn=1.0,Zn=1.08883; x/=Xn; y/=Yn; z/=Zn;
  const f=t=>(t>0.008856)?Math.cbrt(t):(7.787*t+16/116); const fx=f(x),fy=f(y),fz=f(z);
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}
function rgbToLab(r,g,b){ const [x,y,z]=rgbToXyz(r,g,b); return xyzToLab(x,y,z); }
function deltaE2Weighted(l1,l2,wL,wC){ const dL=l1[0]-l2[0], da=l1[1]-l2[1], db=l1[2]-l2[2]; return wL*dL*dL + wC*(da*da+db*db); }
function buildPaletteLab(pal){ return pal.map(([r,g,b])=>({ rgb:[r,g,b], lab:rgbToLab(r,g,b) })); }

/* ------------------------------- Mapping --------------------------------- */
function mapToPalette(imgData, palette, wL=1.0, wC=1.0, dither=false, bgMode='keep', effRegions=[]){
  const w=imgData.width, h=imgData.height, src=imgData.data;
  const out=new ImageData(w,h); out.data.set(src);

  if(bgMode!=='keep'){
    for(let i=0;i<src.length;i+=4){
      const a=src[i+3];
      if(bgMode==='white'){ out.data[i+3]=255; }
      else if(bgMode==='transparent'){ if(a<128) out.data[i+3]=0; }
    }
  }

  const palLab=buildPaletteLab(palette);
  const errR=dither?new Float32Array(w*h):null;
  const errG=dither?new Float32Array(w*h):null;
  const errB=dither?new Float32Array(w*h):null;

  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const idx=y*w+x, i4=idx*4;
      if(out.data[i4+3]===0) continue;

      let r=out.data[i4], g=out.data[i4+1], b=out.data[i4+2];
      if(dither){ r=clamp(Math.round(r+errR[idx]),0,255); g=clamp(Math.round(g+errG[idx]),0,255); b=clamp(Math.round(b+errB[idx]),0,255); }

      // Region restrictions (last wins)
      let allowedSet=null;
      if(effRegions && effRegions.length){
        for(let ri=effRegions.length-1; ri>=0; ri--){
          const R=effRegions[ri];
          if(R.type==='polygon'){ if(R.mask[idx]){ allowedSet=R.allowed; break; } }
          else if(inRect(x,y,R)){ allowedSet=R.allowed; break; }
        }
      }

      const lab=rgbToLab(r,g,b);
      let best=0, bestD=Infinity;
      for(let p=0;p<palLab.length;p++){
        if(allowedSet && !allowedSet.has(p)) continue;
        const d2=deltaE2Weighted(lab,palLab[p].lab,wL,wC);
        if(d2<bestD){ bestD=d2; best=p; }
      }
      const [nr,ng,nb]=palLab[best].rgb;
      out.data[i4]=nr; out.data[i4+1]=ng; out.data[i4+2]=nb;

      if(dither){
        const er=r-nr, eg=g-ng, eb=b-nb;
        const push=(xx,yy,fr,fg,fb)=>{ if(xx<0||xx>=w||yy<0||yy>=h) return; const j=yy*w+xx; errR[j]+=fr; errG[j]+=fg; errB[j]+=fb; };
        push(x+1,y,     er*7/16, eg*7/16, eb*7/16);
        push(x-1,y+1,   er*3/16, eg*3/16, eb*3/16);
        push(x,  y+1,   er*5/16, eg*5/16, eb*5/16);
        push(x+1,y+1,   er*1/16, eg*1/16, eb*1/16);
      }
    }
  }
  return out;
}

/* ------------------------------- Halftone -------------------------------- */
/* Average RGBA over a cell */
function avgColorInCell(data, w, h, x0, y0, sz) {
  let r=0,g=0,b=0,a=0,count=0;
  const x1=Math.min(w, x0+sz), y1=Math.min(h, y0+sz);
  for (let y=y0; y<y1; y++) {
    let i=(y*w + x0)*4;
    for (let x=x0; x<x1; x++, i+=4) {
      const A=data[i+3]; if (A===0) continue;
      r+=data[i]; g+=data[i+1]; b+=data[i+2]; a+=A; count++;
    }
  }
  if (count===0) return {r:255,g:255,b:255,a:0};
  return { r:Math.round(r/count), g:Math.round(g/count), b:Math.round(b/count), a:Math.round(a/count) };
}
/* coverage = closeness to foreground vs background (0..1) */
function coverageBetweenColors(cellRGB, fgLab, bgLab, wL, wC) {
  const lab = rgbToLab(cellRGB.r, cellRGB.g, cellRGB.b);
  const dFg = Math.sqrt(deltaE2Weighted(lab, fgLab, wL, wC));
  const dBg = Math.sqrt(deltaE2Weighted(lab, bgLab, wL, wC));
  const eps = 1e-6;
  const wFg = 1 / Math.max(eps, dFg);
  const wBg = 1 / Math.max(eps, dBg);
  return wFg / (wFg + wBg);
}
/* Determine allowed palette indices at a specific pixel, using regions (last wins) */
function allowedAt(x, y, w, effRegions){
  let allowed=null;
  if (effRegions && effRegions.length){
    const idx = y*w + x;
    for (let ri=effRegions.length-1; ri>=0; ri--){
      const R = effRegions[ri];
      if (R.type==='polygon'){ if (R.mask[idx]){ allowed=R.allowed; break; } }
      else if (inRect(x,y,R)){ allowed=R.allowed; break; }
    }
  }
  return allowed;
}
/* Render halftone into ctx; respects region restrictions per cell center */
function renderHalftone(ctx, imgData, palette, bgHex, cellSize=6, jitter=false, wL=1.0, wC=1.0, effRegions=[]) {
  const w = imgData.width, h = imgData.height, data = imgData.data;
  const palLab = buildPaletteLab(palette);
  const bg = hexToRgb(bgHex) || {r:255,g:255,b:255};
  const bgLab = rgbToLab(bg.r, bg.g, bg.b);

  ctx.save();
  ctx.fillStyle = rgbToHex(bg.r, bg.g, bg.b);
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < h; y += cellSize) {
    for (let x = 0; x < w; x += cellSize) {
      const cell = avgColorInCell(data, w, h, x, y, cellSize);
      if (cell.a === 0) continue;

      // Find allowed palette set for this cell (use center pixel)
      const cxPix = clamp(Math.floor(x + cellSize*0.5), 0, w-1);
      const cyPix = clamp(Math.floor(y + cellSize*0.5), 0, h-1);
      const allowed = allowedAt(cxPix, cyPix, w, effRegions);

      // nearest palette color (respect allowed)
      const lab = rgbToLab(cell.r, cell.g, cell.b);
      let best = 0, bestD = Infinity, found=false;
      for (let p = 0; p < palLab.length; p++) {
        if (allowed && !allowed.has(p)) continue;
        const d2 = deltaE2Weighted(lab, palLab[p].lab, wL, wC);
        if (d2 < bestD) { bestD = d2; best = p; found=true; }
      }
      if (!found && palLab.length) best = 0; // fallback if region disallows all

      const fg = palLab[best];
      const cov = coverageBetweenColors(cell, fg.lab, bgLab, wL, wC); // 0..1
      const maxR = (cellSize * 0.5);
      const radius = Math.max(0.4, Math.sqrt(cov) * maxR);
      let cx = x + cellSize * 0.5;
      let cy = y + cellSize * 0.5;
      if (jitter) {
        const j = (cellSize * 0.15);
        cx += (Math.random()*2-1) * j;
        cy += (Math.random()*2-1) * j;
      }
      ctx.fillStyle = rgbToHex(fg.rgb[0], fg.rgb[1], fg.rgb[2]);
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI*2); ctx.fill();
    }
  }
  ctx.restore();
}

/* ------------------------------- K-means --------------------------------- */
function kmeans(data,k=5,iters=10){
  const n=data.length/4;
  const centers=[]; for(let c=0;c<k;c++){ const idx=Math.floor((c+0.5)*n/k); centers.push([data[idx*4],data[idx*4+1],data[idx*4+2]]); }
  const counts=new Array(k).fill(0); const sums=new Array(k).fill(0).map(()=>[0,0,0]);
  for(let it=0;it<iters;it++){
    counts.fill(0); for(const s of sums){ s[0]=s[1]=s[2]=0; }
    for(let i=0;i<n;i++){
      const a=data[i*4+3]; if(a===0) continue;
      const r=data[i*4], g=data[i*4+1], b=data[i*4+2];
      let best=0, bestD=Infinity;
      for(let c=0;c<k;c++){ const dr=r-centers[c][0], dg=g-centers[c][1], db=b-centers[c][2]; const d=dr*dr+dg*dg+db*db; if(d<bestD){ bestD=d; best=c; } }
      counts[best]++; sums[best][0]+=r; sums[best][1]+=g; sums[best][2]+=b;
    }
    for(let c=0;c<k;c++){ if(counts[c]>0){ centers[c][0]=Math.round(sums[c][0]/counts[c]); centers[c][1]=Math.round(sums[c][1]/counts[c]); centers[c][2]=Math.round(sums[c][2]/counts[c]); } }
  }
  return centers;
}

/* ------------------------- Eyedropper on srcCanvas ----------------------- */
function getCanvasPointFromEvent(canvas, evt){
  const rect=canvas.getBoundingClientRect();
  const x=Math.floor((evt.clientX-rect.left)*canvas.width/rect.width);
  const y=Math.floor((evt.clientY-rect.top )*canvas.height/rect.height);
  return {x,y,rect};
}
(function wireSrcEyedropper(){
  if(!els.eyePopover) return;
  let eyeTimer=null, currentHex='#000000', anchor={x:0,y:0};
  function sample(evt){
    const pt=getCanvasPointFromEvent(els.srcCanvas,evt);
    if(pt.x<0||pt.y<0||pt.x>=els.srcCanvas.width||pt.y>=els.srcCanvas.height) return null;
    const d=sctx.getImageData(pt.x,pt.y,1,1).data; return rgbToHex(d[0],d[1],d[2]);
  }
  const show=(x,y,hex)=>{ els.eyeSwatch.style.background=hex; els.eyeHex.textContent=hex; els.eyePopover.style.left=(x+12)+'px'; els.eyePopover.style.top=(y+12)+'px'; els.eyePopover.hidden=false; };
  const hide=()=>{ els.eyePopover.hidden=true; };

  function start(evt){ evt.preventDefault(); clearTimeout(eyeTimer); anchor={x:evt.clientX,y:evt.clientY};
    eyeTimer=setTimeout(()=>{ const hex=sample(evt); if(!hex) return; currentHex=hex; show(anchor.x,anchor.y,hex); },300);
  }
  const end=(evt)=>{ evt.preventDefault(); clearTimeout(eyeTimer); };
  const move=(evt)=>{ if(els.eyePopover.hidden) return; evt.preventDefault(); const hex=sample(evt); if(!hex) return; currentHex=hex; els.eyeSwatch.style.background=hex; els.eyeHex.textContent=hex; };

  els.srcCanvas.addEventListener('pointerdown', start, {passive:false});
  els.srcCanvas.addEventListener('pointerup', end, {passive:false});
  els.srcCanvas.addEventListener('pointerleave', end, {passive:false});
  els.srcCanvas.addEventListener('pointercancel', end, {passive:false});
  els.srcCanvas.addEventListener('pointermove', move, {passive:false});

  els.eyeAdd.addEventListener('click', ()=>{ addPaletteRow(currentHex); hide(); });
  els.eyeCancel.addEventListener('click', hide);

  // ALT-click quick add
  els.srcCanvas.addEventListener('click',(evt)=>{ if(!evt.altKey) return; const pt=getCanvasPointFromEvent(els.srcCanvas,evt); const d=sctx.getImageData(pt.x,pt.y,1,1).data; addPaletteRow(rgbToHex(d[0],d[1],d[2])); });
})();

/* ----------------------- Rectangle region tool (src) --------------------- */
let marquee=null, regionIsDrawing=false, rStart=null, pendingRect=null;
(function wireRectRegions(){
  if(!els.regionMode) return;
  const wrap=els.srcCanvas.parentElement;
  marquee=document.createElement('div'); marquee.className='marquee'; marquee.style.cssText='position:absolute;border:2px dashed #93c5fd;pointer-events:none;display:none;';
  wrap.style.position=wrap.style.position||'relative'; wrap.appendChild(marquee);

  els.regionMode.addEventListener('change',()=>{ marquee.style.display='none'; });
  els.regionClear.addEventListener('click',()=>{ regions.length=0; marquee.style.display='none'; alert('Regions cleared.'); });

  function canvasClientToCanvasXY(clientX, clientY){
    const rect=els.srcCanvas.getBoundingClientRect();
    const x=clamp(Math.floor((clientX-rect.left)*els.srcCanvas.width/rect.width),0,els.srcCanvas.width-1);
    const y=clamp(Math.floor((clientY-rect.top )*els.srcCanvas.height/rect.height),0,els.srcCanvas.height-1);
    return {x,y,rect};
  }
  function begin(evt){ if(!els.regionMode.checked) return; evt.preventDefault();
    const {x,y,rect}=canvasClientToCanvasXY(evt.clientX,evt.clientY);
    rStart={x,y,rect}; regionIsDrawing=true; marquee.style.display='block'; marquee.style.left=evt.clientX+'px'; marquee.style.top=evt.clientY+'px'; marquee.style.width='0px'; marquee.style.height='0px';
    marquee._rect={x0:x,y0:y,x1:x,y1:y};
  }
  function move(evt){ if(!regionIsDrawing||!els.regionMode.checked) return; evt.preventDefault();
    const {x,y,rect}=canvasClientToCanvasXY(evt.clientX,evt.clientY);
    const x0=Math.min(rStart.x,x), y0=Math.min(rStart.y,y), x1=Math.max(rStart.x,x), y1=Math.max(rStart.y,y);
    const left=rect.left + (x0*rect.width/els.srcCanvas.width);
    const top =rect.top  + (y0*rect.height/els.srcCanvas.height);
    const right=rect.left + (x1*rect.width/els.srcCanvas.width);
    const bottom=rect.top + (y1*rect.height/els.srcCanvas.height);
    marquee.style.left=left+'px'; marquee.style.top=top+'px'; marquee.style.width=Math.max(1,right-left)+'px'; marquee.style.height=Math.max(1,bottom-top)+'px';
    marquee._rect={x0,y0,x1,y1};
  }
  function end(evt){ if(!regionIsDrawing||!els.regionMode.checked) return; evt.preventDefault(); regionIsDrawing=false; if(!marquee._rect){ marquee.style.display='none'; return; } openRectConfig(marquee._rect); }

  els.srcCanvas.addEventListener('pointerdown', begin, {passive:false});
  els.srcCanvas.addEventListener('pointermove', move, {passive:false});
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>els.srcCanvas.addEventListener(ev, end, {passive:false}));

  function openRectConfig(rect){
    pendingRect=rect; els.regionPaletteChecks.innerHTML='';
    const pal=getPalette();
    pal.forEach((rgb,idx)=>{ const hex=rgbToHex(rgb[0],rgb[1],rgb[2]); const id='rchk_'+idx+'_'+Math.random().toString(36).slice(2,7);
      const label=document.createElement('label'); label.style.display='inline-flex'; label.style.alignItems='center'; label.style.gap='6px'; label.style.margin='4px 8px 4px 0';
      label.innerHTML=`<input type="checkbox" id="${id}" checked>
        <span style="width:16px;height:16px;border-radius:4px;border:1px solid #334155;display:inline-block;background:${hex}"></span> ${hex}`;
      els.regionPaletteChecks.appendChild(label);
    });
    els.regionConfig.hidden=false; marquee.style.display='block';
  }
  els.regionCancel?.addEventListener('click',()=>{ els.regionConfig.hidden=true; marquee.style.display='none'; pendingRect=null; });
  els.regionApply?.addEventListener('click',()=>{ if(!pendingRect) return; const allowed=new Set();
    [...els.regionPaletteChecks.querySelectorAll('input[type=checkbox]')].forEach((cb,i)=>{ if(cb.checked) allowed.add(i); });
    const rect=normalizeRect(pendingRect); regions.push({ ...rect, allowed }); els.regionConfig.hidden=true; marquee.style.display='none'; pendingRect=null; alert('Rectangle region saved.');
  });
})();

/* ------------------------- Full-screen Editor (NEW) ---------------------- */
function setToolActive(id){ ['toolEyedrop','toolLasso','toolPan'].forEach(x=>{ const b=document.getElementById(x); if(!b) return; (x===id)? b.classList.add('active'):b.classList.remove('active'); }); }
function openEditor(){
  if(!state.fullBitmap){ alert('Load an image first.'); return; }
  els.editorOverlay?.classList.remove('hidden'); els.editorOverlay?.setAttribute('aria-hidden','false'); editor.active=true;
  const vw=window.innerWidth, vh=window.innerHeight, rightW=(vw>900)?320:0, toolbarH=50;
  els.editCanvas.width=vw-rightW; els.editCanvas.height=vh-toolbarH;
  els.editOverlay.width=els.editCanvas.width; els.editOverlay.height=els.editCanvas.height;
  editor.ectx=els.editCanvas.getContext('2d',{willReadFrequently:true});
  editor.octx=els.editOverlay.getContext('2d',{willReadFrequently:true});
  editor.ectx.clearRect(0,0,els.editCanvas.width,els.editCanvas.height);
  editor.ectx.drawImage(els.srcCanvas,0,0,els.editCanvas.width,els.editCanvas.height);
  editor.tool='eyedrop'; setToolActive('toolEyedrop'); editor.lassoPts=[]; editor.lassoActive=false; drawLassoStroke(false);
  renderEditorPalette(); buildLassoChecks();
}
function closeEditor(){ if(!editor.active) return; editor.active=false; els.editorOverlay?.classList.add('hidden'); els.editorOverlay?.setAttribute('aria-hidden','true'); }
els.openEditor?.addEventListener('click', openEditor);
els.editorDone?.addEventListener('click', closeEditor);
els.toolEyedrop?.addEventListener('click', ()=>{ editor.tool='eyedrop'; setToolActive('toolEyedrop'); });
els.toolLasso?.addEventListener('click', ()=>{ editor.tool='lasso'; setToolActive('toolLasso'); });
els.toolPan?.addEventListener('click', ()=>{ editor.tool='pan'; setToolActive('toolPan'); });

function renderEditorPalette(){ if(!els.editorPalette) return; els.editorPalette.innerHTML=''; getPalette().forEach(([r,g,b])=>{ const sw=document.createElement('span'); sw.className='sw'; sw.style.background=rgbToHex(r,g,b); els.editorPalette.appendChild(sw); }); }
function buildLassoChecks(){ if(!els.lassoChecks) return; els.lassoChecks.innerHTML=''; getPalette().forEach((rgb,idx)=>{ const hex=rgbToHex(rgb[0],rgb[1],rgb[2]); const id='lasso_'+idx+'_'+Math.random().toString(36).slice(2,7);
  const label=document.createElement('label'); label.innerHTML=`<input type="checkbox" id="${id}" checked>
    <span class="sw" style="width:16px;height:16px;border-radius:4px;border:1px solid #334155;display:inline-block;background:${hex}"></span> ${hex}`;
  els.lassoChecks.appendChild(label);
}); }

/* Eyedropper in editor */
(function wireEditorEyedropper(){
  const wrap=document.querySelector('.editor-canvas-wrap') || els.editCanvas?.parentElement; if(!wrap) return;
  let pressTimer=null, currentHex='#000000';
  const start=(evt)=>{ if(!editor.active || editor.tool!=='eyedrop') return; evt.preventDefault(); clearTimeout(pressTimer);
    pressTimer=setTimeout(()=>{ const rect=els.editCanvas.getBoundingClientRect();
      const x=Math.floor((evt.clientX-rect.left)*els.editCanvas.width/rect.width);
      const y=Math.floor((evt.clientY-rect.top )*els.editCanvas.height/rect.height);
      const d=editor.ectx.getImageData(x,y,1,1).data; const hex=rgbToHex(d[0],d[1],d[2]); currentHex=hex;
      els.eyeSwatch.style.background=hex; els.eyeHex.textContent=hex; els.eyePopover.style.left=(evt.clientX+12)+'px'; els.eyePopover.style.top=(evt.clientY+12)+'px'; els.eyePopover.hidden=false;
      els.eyeAdd.onclick = ()=>{ addPaletteRow(currentHex); els.eyePopover.hidden=true; renderEditorPalette(); buildLassoChecks(); };
      els.eyeCancel.onclick = ()=>{ els.eyePopover.hidden=true; };
    },300);
  };
  const move=(evt)=>{ if(!editor.active || editor.tool!=='eyedrop' || els.eyePopover.hidden) return; evt.preventDefault();
    const rect=els.editCanvas.getBoundingClientRect();
    const x=Math.floor((evt.clientX-rect.left)*els.editCanvas.width/rect.width);
    const y=Math.floor((evt.clientY-rect.top )*els.editCanvas.height/rect.height);
    const d=editor.ectx.getImageData(x,y,1,1).data; const hex=rgbToHex(d[0],d[1],d[2]); currentHex=hex; els.eyeSwatch.style.background=hex; els.eyeHex.textContent=hex;
  };
  const end=(evt)=>{ if(!editor.active || editor.tool!=='eyedrop') return; evt.preventDefault(); clearTimeout(pressTimer); };
  wrap.addEventListener('pointerdown', start, {passive:false});
  wrap.addEventListener('pointermove', move, {passive:false});
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>wrap.addEventListener(ev, end, {passive:false}));
})();

/* Lasso tool */
(function wireLasso(){
  const wrap=document.querySelector('.editor-canvas-wrap') || els.editCanvas?.parentElement; if(!wrap) return;
  const begin=(evt)=>{ if(!editor.active || editor.tool!=='lasso') return; evt.preventDefault(); editor.lassoPts=[]; editor.lassoActive=true; els.lassoSave.disabled=true; els.lassoClear.disabled=false; addPoint(evt); };
  const addPoint=(evt)=>{ const rect=els.editCanvas.getBoundingClientRect();
    const x=Math.max(0,Math.min(els.editCanvas.width,  Math.round((evt.clientX-rect.left)*els.editCanvas.width /rect.width  )));
    const y=Math.max(0,Math.min(els.editCanvas.height, Math.round((evt.clientY-rect.top )*els.editCanvas.height/rect.height )));
    editor.lassoPts.push([x,y]); drawLassoStroke(false);
  };
  const move=(evt)=>{ if(!editor.active || editor.tool!=='lasso' || !editor.lassoActive) return; evt.preventDefault(); addPoint(evt); };
  const end=(evt)=>{ if(!editor.active || editor.tool!=='lasso' || !editor.lassoActive) return; evt.preventDefault(); editor.lassoActive=false; drawLassoStroke(true); els.lassoSave.disabled=false; };

  wrap.addEventListener('pointerdown', begin, {passive:false});
  wrap.addEventListener('pointermove', move, {passive:false});
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>wrap.addEventListener(ev, end, {passive:false}));

  els.lassoClear?.addEventListener('click', ()=>{ editor.lassoPts=[]; drawLassoStroke(false); els.lassoSave.disabled=true; els.lassoClear.disabled=true; });
  els.lassoSave?.addEventListener('click', ()=>{
    if(!editor.lassoPts.length) return;
    const allowed=new Set(); [...els.lassoChecks.querySelectorAll('input[type=checkbox]')].forEach((cb,i)=>{ if(cb.checked) allowed.add(i); });
    const mask=rasterizePolygonToMask(editor.lassoPts, els.srcCanvas.width, els.srcCanvas.height);
    regions.push({ type:'polygon', points: editor.lassoPts.map(p=>[p[0],p[1]]), mask, allowed });
    alert('Lasso region saved.');
    editor.lassoPts=[]; drawLassoStroke(false); els.lassoSave.disabled=true; els.lassoClear.disabled=true;
  });
})();
function drawLassoStroke(close=false){
  if(!editor.octx) return;
  const ctx=editor.octx; ctx.clearRect(0,0,els.editOverlay.width,els.editOverlay.height);
  if(editor.lassoPts.length<2) return;
  ctx.lineWidth=2; ctx.strokeStyle='#93c5fd'; ctx.fillStyle='rgba(147,197,253,0.15)';
  ctx.beginPath(); ctx.moveTo(editor.lassoPts[0][0],editor.lassoPts[0][1]);
  for(let i=1;i<editor.lassoPts.length;i++) ctx.lineTo(editor.lassoPts[i][0],editor.lassoPts[i][1]);
  if(close) ctx.closePath(); ctx.stroke(); if(close) ctx.fill();
}
function rasterizePolygonToMask(points, targetW, targetH){
  const tmp=document.createElement('canvas'); tmp.width=targetW; tmp.height=targetH; const tctx=tmp.getContext('2d');
  const sW=els.editCanvas.width, sH=els.editCanvas.height; const ratioX=targetW/sW, ratioY=targetH/sH;
  tctx.clearRect(0,0,targetW,targetH); tctx.fillStyle='#fff'; tctx.beginPath();
  const p0=points[0]; tctx.moveTo(Math.round(p0[0]*ratioX), Math.round(p0[1]*ratioY));
  for(let i=1;i<points.length;i++){ const p=points[i]; tctx.lineTo(Math.round(p[0]*ratioX), Math.round(p[1]*ratioY)); }
  tctx.closePath(); tctx.fill();
  const img=tctx.getImageData(0,0,targetW,targetH).data; const mask=new Uint8Array(targetW*targetH);
  for(let i=0;i<mask.length;i++) mask[i] = img[i*4+3]>0 ? 1 : 0;
  return mask;
}
function scaleMask(mask,w0,h0,w1,h1){
  const c0=document.createElement('canvas'); c0.width=w0; c0.height=h0; const x0=c0.getContext('2d'); const id0=x0.createImageData(w0,h0);
  for(let i=0;i>w0*h0;i++){} // (no-op guard; old minifier quirk)
  for(let i=0;i<w0*h0;i++){ const k=i*4; id0.data[k]=255; id0.data[k+1]=255; id0.data[k+2]=255; id0.data[k+3]=mask[i]?255:0; }
  x0.putImageData(id0,0,0);
  const c1=document.createElement('canvas'); c1.width=w1; c1.height=h1; const x1=c1.getContext('2d'); x1.imageSmoothingEnabled=false; x1.drawImage(c0,0,0,w0,h0,0,0,w1,h1);
  const out=new Uint8Array(w1*h1); const id1=x1.getImageData(0,0,w1,h1).data; for(let i=0;i<w1*h1;i++) out[i]=id1[i*4+3]>0?1:0; return out;
}

/* ------------------------------ Actions/UI ------------------------------- */
function updateWeightsUI(){ if(els.wChromaOut) els.wChromaOut.textContent=fmtMult(els.wChroma.value); if(els.wLightOut) els.wLightOut.textContent=fmtMult(els.wLight.value); }
function bindEvents(){
  // Uploads
  els.fileInput?.addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); });
  els.cameraInput?.addEventListener('change', e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); });

  // Clipboard paste (desktop)
  els.pasteBtn?.addEventListener('click', async ()=>{
    if(!navigator.clipboard || !navigator.clipboard.read){ alert('Clipboard image paste not supported on this browser. Use Upload instead.'); return; }
    try{
      const items=await navigator.clipboard.read();
      for(const item of items){ for(const type of item.types){ if(type.startsWith('image/')){ const blob=await item.getType(type); await handleFile(blob); return; } } }
      alert('No image in clipboard.');
    }catch{ alert('Clipboard read failed. Try Upload instead.'); }
  });

  els.resetBtn?.addEventListener('click', ()=>{ if(!state.fullBitmap) return; drawSrc(state.fullBitmap); });
  els.maxW?.addEventListener('change', ()=>{ if(state.fullBitmap) drawSrc(state.fullBitmap); });

  // Palette
  els.addColor?.addEventListener('click', ()=>addPaletteRow('#FFFFFF'));
  els.clearColors?.addEventListener('click', ()=>{ els.paletteList.innerHTML=''; });
  els.loadExample?.addEventListener('click', ()=>{ setPalette(['#FFFFFF','#B3753B','#5B3A21','#D22C2C','#1D6E2E']); });

  // Auto-extract
  els.autoExtract?.addEventListener('click', ()=>{
    if(!els.srcCanvas.width){ alert('Load an image first.'); return; }
    const k=clamp(parseInt(els.kColors.value||'5',10),2,16);
    const img=sctx.getImageData(0,0,els.srcCanvas.width,els.srcCanvas.height);
    const centers=kmeans(img.data,k,10); setPalette(centers.map(([r,g,b])=>rgbToHex(r,g,b)));
  });

  // Sliders
  ['input','change'].forEach(ev=>{ els.wChroma?.addEventListener(ev, updateWeightsUI); els.wLight?.addEventListener(ev, updateWeightsUI); });

  // Apply mapping (with Halftone branch)
  els.applyBtn?.addEventListener('click', async ()=>{
    const pal=getPalette(); if(!pal.length){ alert('Add at least one color to the palette.'); return; }
    const wL=parseInt(els.wLight.value,10)/100, wC=parseInt(els.wChroma.value,10)/100;
    const dither=!!els.useDither.checked, bgMode=els.bgMode.value;

    let procCanvas=els.srcCanvas, usingFull=false;
    if(els.keepFullRes.checked && state.fullBitmap){
      procCanvas=document.createElement('canvas'); procCanvas.width=state.fullW; procCanvas.height=state.fullH;
      procCanvas.getContext('2d',{willReadFrequently:true}).drawImage(state.fullBitmap,0,0); usingFull=true;
    }

    // Build effective regions
    let effectiveRegions=[];
    if(regions.length){
      if(usingFull){
        const sx=state.fullW/els.srcCanvas.width, sy=state.fullH/els.srcCanvas.height;
        effectiveRegions = regions.map(r=>{
          if(r.type==='polygon'){ const fullMask=scaleMask(r.mask, els.srcCanvas.width, els.srcCanvas.height, state.fullW, state.fullH); return { type:'polygon', mask:fullMask, allowed:r.allowed }; }
          return { ...scaleRect(normalizeRect(r), sx, sy), allowed:r.allowed };
        });
      } else {
        effectiveRegions = regions.map(r=> r.type==='polygon' ? { type:'polygon', mask:r.mask, allowed:r.allowed } : normalizeRect(r));
      }
    }

    const ctx=procCanvas.getContext('2d',{willReadFrequently:true});
    // HALFTONE mode?
    if (els.useHalftone?.checked) {
      // ensure we have original pixels in imgData
      ctx.clearRect(0,0,procCanvas.width,procCanvas.height);
      if (usingFull) ctx.drawImage(state.fullBitmap, 0, 0); else ctx.drawImage(els.srcCanvas, 0, 0);
      const srcData = ctx.getImageData(0,0,procCanvas.width,procCanvas.height);

      const cell = clamp(parseInt(els.dotCell?.value || '6',10), 3, 64);
      const bgHex = (els.dotBg?.value || '#FFFFFF').toUpperCase();
      const jitter = !!els.dotJitter?.checked;

      ctx.clearRect(0,0,procCanvas.width,procCanvas.height);
      renderHalftone(ctx, srcData, pal, bgHex, cell, jitter, wL, wC, effectiveRegions);

      const outData = ctx.getImageData(0,0,procCanvas.width,procCanvas.height);

      if(usingFull){
        const previewW=Math.min(state.fullW, parseInt(els.maxW.value,10));
        const scale=previewW/state.fullW;
        els.outCanvas.width=Math.round(state.fullW*scale); els.outCanvas.height=Math.round(state.fullH*scale);
        octx.clearRect(0,0,els.outCanvas.width,els.outCanvas.height);
        octx.drawImage(procCanvas,0,0,els.outCanvas.width,els.outCanvas.height);
      } else {
        els.outCanvas.width=outData.width; els.outCanvas.height=outData.height; octx.putImageData(outData,0,0);
      }
      els.outCanvas._fullImageData = outData;
      els.downloadBtn.disabled=false;
      return;
    }

    // Pixel mapping path
    const imgData=ctx.getImageData(0,0,procCanvas.width,procCanvas.height);
    const out=mapToPalette(imgData,pal,wL,wC,dither,bgMode,effectiveRegions);

    if(usingFull){
      const previewW=Math.min(state.fullW, parseInt(els.maxW.value,10)); const scale=previewW/state.fullW;
      els.outCanvas.width=Math.round(state.fullW*scale); els.outCanvas.height=Math.round(state.fullH*scale);
      const off=(typeof OffscreenCanvas!=='undefined')? new OffscreenCanvas(state.fullW,state.fullH) : Object.assign(document.createElement('canvas'),{width:state.fullW,height:state.fullH});
      const offCtx=off.getContext('2d'); offCtx.putImageData(out,0,0);
      let bmp; if(off.convertToBlob){ const blob=await off.convertToBlob(); bmp=await createImageBitmap(blob); } else { const blob=await new Promise(res=>off.toBlob(res)); bmp=await createImageBitmap(blob); }
      octx.clearRect(0,0,els.outCanvas.width,els.outCanvas.height); octx.drawImage(bmp,0,0,els.outCanvas.width,els.outCanvas.height);
      els.outCanvas._fullImageData=out;
    } else {
      els.outCanvas.width=out.width; els.outCanvas.height=out.height; octx.putImageData(out,0,0); els.outCanvas._fullImageData=out;
    }
    els.downloadBtn.disabled=false;
  });

  // Download
  els.downloadBtn?.addEventListener('click', ()=>{
    const out=els.outCanvas._fullImageData;
    if(!out){ // if halftone full-res path used, fallback to drawing the canvas
      const c=document.createElement('canvas'); c.width=els.outCanvas.width; c.height=els.outCanvas.height;
      const cx=c.getContext('2d'); cx.drawImage(els.outCanvas,0,0);
      c.toBlob(blob=>{ const a=document.createElement('a'); a.download='mapped.png'; a.href=URL.createObjectURL(blob); a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }, 'image/png');
      return;
    }
    const c=document.createElement('canvas'); c.width=out.width; c.height=out.height; c.getContext('2d').putImageData(out,0,0);
    c.toBlob(blob=>{ const a=document.createElement('a'); a.download='mapped.png'; a.href=URL.createObjectURL(blob); a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }, 'image/png');
  });

  // Saved palettes
  els.savePalette?.addEventListener('click', ()=>{
    const pal=getPalette(); if(!pal.length){ alert('No colors to save.'); return; }
    const name=prompt('Palette name?')||`Palette ${Date.now()}`; const hexes=pal.map(([r,g,b])=>rgbToHex(r,g,b));
    const arr=loadSavedPalettes(); arr.unshift({name,colors:hexes}); saveSavedPalettes(arr.slice(0,30)); renderSavedPalettes();
  });
  els.clearSavedPalettes?.addEventListener('click', ()=>{ if(!confirm('Clear all saved palettes?')) return; saveSavedPalettes([]); renderSavedPalettes(); });

  // Projects
  els.openProjects?.addEventListener('click', ()=>setPane(true));
  els.closeProjects?.addEventListener('click', ()=>setPane(false));
  els.refreshProjects?.addEventListener('click', refreshProjectsList);

  els.saveProject?.addEventListener('click', async ()=>{
    if(!state.fullBitmap){ alert('Load an image first.'); return; }
    const name=prompt('Project name?')||`Project ${Date.now()}`;
    const tmp=document.createElement('canvas'); tmp.width=state.fullW; tmp.height=state.fullH; tmp.getContext('2d').drawImage(state.fullBitmap,0,0);
    const blob=await new Promise(res=>tmp.toBlob(res,'image/png',0.92));
    const rec={ id: state.selectedProjectId||undefined, name, createdAt:Date.now(), updatedAt:Date.now(), settings:getCurrentSettings(), imageBlob:blob };
    const id=await dbPutProject(rec); state.selectedProjectId=id; await refreshProjectsList(); alert('Saved.');
  });

  els.exportProject?.addEventListener('click', async ()=>{
    const id=state.selectedProjectId; if(!id){ alert('Select a project first.'); return; }
    const rec=await dbGet(id); if(!rec){ alert('Project not found.'); return; }
    const b64=await blobToBase64(rec.imageBlob);
    const out={ name:rec.name, createdAt:rec.createdAt, updatedAt:rec.updatedAt, settings:rec.settings, imageBase64:b64 };
    const blob=new Blob([JSON.stringify(out)],{type:'application/json'}); const a=document.createElement('a'); a.download=(rec.name||'project')+'.json'; a.href=URL.createObjectURL(blob); a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  });

  els.importProject?.addEventListener('change', async (e)=>{
    const f=e.target.files?.[0]; if(!f) return; const text=await f.text();
    try{
      const obj=JSON.parse(text);
      if(!obj.imageBase64 || !obj.settings){ alert('Invalid project file.'); return; }
      const blob=base64ToBlob(obj.imageBase64);
      const rec={ name:obj.name||`Imported ${Date.now()}`, createdAt:obj.createdAt||Date.now(), updatedAt:Date.now(), settings:obj.settings, imageBlob:blob };
      const id=await dbPutProject(rec); await refreshProjectsList(); await loadProject(id); setPane(false); alert('Imported.');
    }catch{ alert('Invalid JSON.'); } finally { e.target.value=''; }
  });

  els.deleteProject?.addEventListener('click', async ()=>{
    const id=state.selectedProjectId; if(!id){ alert('Select a project then Delete.'); return; }
    if(!confirm('Delete selected project?')) return; await dbDelete(id); state.selectedProjectId=null; await refreshProjectsList();
  });
}

/* ------------------------- Settings & Persistence ------------------------ */
function getCurrentSettings(){
  return {
    palette: getPalette().map(([r,g,b])=>rgbToHex(r,g,b)),
    maxW: parseInt(els.maxW.value,10),
    keepFullRes: !!els.keepFullRes.checked,
    wChroma: parseInt(els.wChroma.value,10),
    wLight: parseInt(els.wLight.value,10),
    useDither: !!els.useDither.checked,
    bgMode: els.bgMode.value,
    // halftone
    useHalftone: !!els.useHalftone?.checked,
    dotCell: parseInt(els.dotCell?.value||'6',10),
    dotBg: els.dotBg?.value || '#FFFFFF',
    dotJitter: !!els.dotJitter?.checked,
    // regions
    regions: regions.map(r=>{
      if(r.type==='polygon'){ return { type:'polygon', points:r.points, allowed:Array.from(r.allowed) }; }
      return { type:'rect', x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1, allowed:Array.from(r.allowed) };
    }),
  };
}
function applySettings(s){
  if(!s) return;
  if(s.palette) setPalette(s.palette);
  if(s.maxW) els.maxW.value=s.maxW;
  if('keepFullRes' in s) els.keepFullRes.checked=!!s.keepFullRes;
  if(s.wChroma) els.wChroma.value=s.wChroma;
  if(s.wLight) els.wLight.value=s.wLight;
  if('useDither' in s) els.useDither.checked=!!s.useDither;
  if(s.bgMode) els.bgMode.value=s.bgMode;
  if('useHalftone' in s) els.useHalftone.checked=!!s.useHalftone;
  if(s.dotCell) els.dotCell.value=s.dotCell;
  if(s.dotBg) els.dotBg.value=s.dotBg;
  if('dotJitter' in s) els.dotJitter.checked=!!s.dotJitter;
  updateWeightsUI();
  regions.length=0;
  if(s.regions && Array.isArray(s.regions)){
    s.regions.forEach(r=>{
      if(r.type==='polygon'){ const mask=rasterizePolygonToMask(r.points, els.srcCanvas.width, els.srcCanvas.height); regions.push({ type:'polygon', points:r.points, mask, allowed:new Set(r.allowed||[]) }); }
      else { regions.push({ x0:r.x0,y0:r.y0,x1:r.x1,y1:r.y1, allowed:new Set(r.allowed||[]) }); }
    });
  }
}
async function loadProject(id){
  const rec=await dbGet(id); if(!rec){ alert('Project not found.'); return; }
  const bmp=await createImageBitmap(rec.imageBlob);
  state.fullBitmap=bmp; state.fullW=bmp.width; state.fullH=bmp.height; drawSrc(bmp); toggleImageActions(true); applySettings(rec.settings); state.selectedProjectId=id;
}

/* --------------------------------- Blobs --------------------------------- */
function blobToBase64(blob){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.readAsDataURL(blob); }); }
function base64ToBlob(b64){ const byteChars=atob(b64); const len=byteChars.length; const bytes=new Uint8Array(len); for(let i=0;i<len;i++) bytes[i]=byteChars.charCodeAt(i); return new Blob([bytes],{type:'image/png'}); }

/* ------------------------------- Projects UI ----------------------------- */
function setPane(open){ if(!els.projectsPane) return; els.projectsPane.classList.toggle('open',open); els.projectsPane.setAttribute('aria-hidden',String(!open)); }
async function refreshProjectsList(){
  if(!els.projectsList) return; const arr=await dbGetAll(); arr.sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt));
  els.projectsList.innerHTML=''; arr.forEach(rec=>{
    const div=document.createElement('div'); div.className='item'; const d=new Date(rec.updatedAt||rec.createdAt);
    div.innerHTML=`<div><strong>${rec.name||('Project '+rec.id)}</strong><br><small>${d.toLocaleString()}</small></div><div><button class="ghost" data-id="${rec.id}" type="button">Load</button></div>`;
    div.addEventListener('click',()=>{ state.selectedProjectId=rec.id; [...els.projectsList.children].forEach(ch=>ch.classList.remove('selected')); div.classList.add('selected'); });
    div.querySelector('button').addEventListener('click', async (e)=>{ e.stopPropagation(); await loadProject(rec.id); setPane(false); });
    els.projectsList.appendChild(div);
  });
}

/* ---------------------------------- Init --------------------------------- */
function init(){
  if(!els.fileInput){ const up=document.createElement('input'); up.type='file'; up.accept='image/*'; up.id='fileInput'; up.style.display='none'; document.body.appendChild(up); up.addEventListener('change',e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); }); els.fileInput=up; }

  const prefs=loadPrefs();
  if(prefs.lastPalette) setPalette(prefs.lastPalette); else setPalette(['#FFFFFF','#000000']);
  if(prefs.keepFullRes!==undefined) els.keepFullRes.checked=!!prefs.keepFullRes;
  if(prefs.maxW) els.maxW.value=prefs.maxW;
  if(prefs.wChroma) els.wChroma.value=prefs.wChroma;
  if(prefs.wLight) els.wLight.value=prefs.wLight;
  if(prefs.bgMode) els.bgMode.value=prefs.bgMode;
  if(prefs.useDither!==undefined) els.useDither.checked=!!prefs.useDither;
  if(prefs.useHalftone!==undefined) els.useHalftone.checked=!!prefs.useHalftone;
  if(prefs.dotCell) els.dotCell.value=prefs.dotCell;
  if(prefs.dotBg) els.dotBg.value=prefs.dotBg;
  if(prefs.dotJitter!==undefined) els.dotJitter.checked=!!prefs.dotJitter;
  updateWeightsUI(); renderSavedPalettes();

  // persist prefs
  const savePrefsNow=()=>savePrefs({
    lastPalette: getPalette().map(([r,g,b])=>rgbToHex(r,g,b)),
    keepFullRes: els.keepFullRes.checked,
    maxW: parseInt(els.maxW.value,10),
    wChroma: parseInt(els.wChroma.value,10),
    wLight: parseInt(els.wLight.value,10),
    bgMode: els.bgMode.value,
    useDither: els.useDither.checked,
    useHalftone: els.useHalftone?.checked,
    dotCell: parseInt(els.dotCell?.value||'6',10),
    dotBg: els.dotBg?.value||'#FFFFFF',
    dotJitter: !!els.dotJitter?.checked,
  });
  ['change','input'].forEach(ev=>{
    document.addEventListener(ev,(e)=>{
      if(!e.target) return;
      if(e.target.closest?.('.palette-item') ||
         [els.keepFullRes,els.maxW,els.wChroma,els.wLight,els.bgMode,els.useDither,els.useHalftone,els.dotCell,els.dotBg,els.dotJitter].includes(e.target)){
        savePrefsNow();
      }
    }, {passive:true});
  });

  refreshProjectsList();
  toggleImageActions(!!state.fullBitmap);
}
bindEvents();
window.addEventListener('load', init);

/* ======================================================================
   💾 Google Sheets Sync (Apps Script Web App client)
   (Replace SCRIPT_URL & API_KEY, then call via window.GSync.*)
   ====================================================================== */

/* --------------------------- CONFIG (EDIT) --------------------------- */
const GSYNC = {
  SCRIPT_URL: 'https://script.google.com/macros/s/REPLACE_WITH_EXEC_URL/exec',
  API_KEY:    'REPLACE_WITH_YOUR_SCRIPT_PROPERTIES_API_KEY'
};

/* ---------------------------- HTTP helpers --------------------------- */
async function gsApiGet(params = {}) {
  const url = new URL(GSYNC.SCRIPT_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.error || `GET failed`);
  return json.data;
}

async function gsApiPost(body) {
  const res = await fetch(GSYNC.SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, apiKey: GSYNC.API_KEY })
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.error || `POST failed`);
  return json.data ?? json;
}

/* ----------------------------- Public reads -------------------------- */
async function gsPing() { return gsApiGet({ action: 'ping' }); }
async function gsListAll() { return gsApiGet({ action: 'list' }); }
async function gsReadResults({ limit, since } = {}) {
  const p = { action: 'results' };
  if (limit) p.limit = limit;
  if (since) p.since = since;
  return gsApiGet(p);
}

/* ----------------------------- Write actions ------------------------- */
async function gsSubmitResult(result) {
  return gsApiPost({
    action: 'submitResult',
    row: {
      resId:   result.resId || ('res_' + Math.random().toString(36).slice(2)),
      name:    result.name || '',
      location:result.location || '',
      date:    result.date || '',
      time:    Number.isFinite(result.time) ? result.time : Date.now(),
      testId:  result.testId || '',
      testName:result.testName || '',
      score:   Number(result.score || 0),
      correct: Number(result.correct || 0),
      of:      Number(result.of || 0),
      answers: Array.isArray(result.answers) ? result.answers : []
    }
  });
}

async function gsBackupDecksCardsTests(
  { decksRows = [], cardsRows = [], testsRows = [], resultsRows = [], archivedRows = [], schema = '' },
  mode = 'merge'
) {
  return gsApiPost({
    action: 'bulkupsert',
    mode,
    decksRows,
    cardsRows,
    testsRows,
    resultsRows,
    archivedRows,
    schema
  });
}

async function gsArchiveMove(resId, toArchived = true) {
  return gsApiPost({ action: 'archivemove', id: String(resId), to: toArchived ? 'archived' : 'results' });
}
async function gsDeleteForever(resId, from = 'results') {
  return gsApiPost({ action: 'deleteForever', id: String(resId), from });
}

/* --------------- Convenience builders (admin data shaping) ------------ */
function gsBuildDeckRow(d) {
  return {
    deckId:    String(d.id),
    className: String(d.className || ''),
    deckName:  String(d.name || d.deckName || ''),
    tags:      Array.isArray(d.tags) ? d.tags.join('|') : String(d.tags || ''),
    createdAt: Number(d.createdAt || Date.now())
  };
}
function gsBuildCardRow(c) {
  return {
    cardId:      String(c.id),
    deckId:      String(c.deckId),
    q:           String(c.q || c.question || ''),
    a:           String(c.a || c.answer || ''),
    distractors: Array.isArray(c.distractors) ? c.distractors.map(String).join('|') : String(c.distractors || ''),
    sub:         String(c.sub || ''),
    createdAt:   Number(c.createdAt || Date.now())
  };
}
function gsBuildTestRow(t) {
  return {
    testId:         String(t.id || t.testId || ('test_' + Math.random().toString(36).slice(2))),
    name:           String(t.name || 'Test'),
    title:          String(t.title || t.name || 'Test'),
    n:              Number(t.n || 30),
    selectionsJSON: JSON.stringify(Array.isArray(t.selections) ? t.selections : [])
  };
}

/* ---------------------------- Smoke-test hook --------------------------- */
(function wireTestButton(){
  const btn = document.getElementById('testWrite');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const out = await gsSubmitResult({
        name: 'Test Student',
        location: 'Demo',
        testId: 't.demo',
        testName: 'Hello World',
        score: 10, correct: 10, of: 10,
        answers: [{ q: 'Q1', a: 'A' }]
      });
      alert('Write OK: ' + JSON.stringify(out));
    } catch (e) {
      alert('Write FAILED: ' + e.message);
    }
  });
})();

/* ------------------------------ Global access --------------------------- */
window.GSync = {
  // reads
  ping: gsPing,
  listAll: gsListAll,
  readResults: gsReadResults,
  // writes
  submitResult: gsSubmitResult,
  backupDecksCardsTests: gsBackupDecksCardsTests,
  archiveMove: gsArchiveMove,
  deleteForever: gsDeleteForever,
  // builders
  buildDeckRow: gsBuildDeckRow,
  buildCardRow: gsBuildCardRow,
  buildTestRow: gsBuildTestRow
};
