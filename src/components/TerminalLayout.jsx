/* eslint-disable */
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import './QuantumCommand.css';

// ── Seeded RNG ────────────────────────────────────────────────────────────────
function rng32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Color palette ─────────────────────────────────────────────────────────────
const C = {
  bg:'#020408', s1:'#060C12', s2:'#0A1520', b:'#152030', b2:'#1C2E42',
  t:'#C8D8E8', t2:'#7A9AB5', t3:'#3A5570',
  gold:'#C89820', gold2:'#F0BC28',
  green:'#22A060', green2:'#2ECC80', red:'#C03040', red2:'#E04050',
  blue3:'#3AA0D8', ml2:'#9070E0', teal2:'#22A090', warn2:'#D0A030',
};

// ── Specialists config ────────────────────────────────────────────────────────
const SPECS = [
  { key:'gold-specialist',     label:'GS1', sym:'XAUUSD', tf:'H+M · Frankfurt+NY ORB',  color:C.gold,  seed:101, wr:61.3, pf:1.19, trades:346, sessions:['FRANKFURT 07:00','NY 13:30'], day:true },
  { key:'nas100-specialist',   label:'NAS', sym:'NAS100', tf:'AMD · TJR BOS FVG',         color:C.blue3, seed:303, wr:59.7, pf:2.51, trades:72,  sessions:['ASIAN 02:00','LONDON 07:00','NY 13:30'], day:false },
  { key:'ger40-bg-specialist', label:'GER', sym:'GER40',  tf:'15m FVG · Tue+Thu only',   color:C.teal2, seed:404, wr:64.1, pf:1.73, trades:52,  sessions:['FRANKFURT 08:00'],              day:false, dayOnly:true },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt     = (n, d=2) => n == null || isNaN(n) ? '—' : Number(n).toFixed(d);
const fmtMony = n => n == null ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const fmtTime = ts => !ts ? '—' : new Date(ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
const fmtDate = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return fmtTime(ts);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
};

function activePosFor(positions, key) {
  return (positions || []).find(p => {
    const c = (p.comment || '').toLowerCase();
    if (!c.includes('qb-v20-')) return false;
    if (key === 'gold-specialist-2')   return c.includes('gs2');
    if (key === 'gold-specialist')     return !c.includes('gs2') && /xau|gold/.test((p.symbol||'').toLowerCase());
    if (key === 'nas100-specialist')   return /nas|us100|ustec/.test((p.symbol||'').toLowerCase());
    if (key === 'ger40-bg-specialist') return /ger|dax|de40/.test((p.symbol||'').toLowerCase());
    return false;
  });
}

function todayPnLFor(ledger, key) {
  const today = new Date().toISOString().slice(0,10);
  return (ledger||[])
    .filter(t => t.template===key && t.closedAt && new Date(t.closedAt).toISOString().slice(0,10)===today)
    .reduce((s,t) => s+(t.finalPnL||0), 0);
}

// ── Canvas drawing (module-level, no React deps) ──────────────────────────────
function sizeCv(canvas, wrap) {
  const dpr = window.devicePixelRatio || 1;
  const W = wrap?.clientWidth || 300;
  const H = wrap?.clientHeight || 100;
  const pw = Math.round(W * dpr);
  const ph = Math.round(H * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, W, H];
}

function drawFTMO(canvas, daily, total) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth || 240;
  const cssH = canvas.offsetHeight || 110;
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw; canvas.height = ph;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;
  ctx.clearRect(0,0,W,H);
  const pi = Math.PI;

  function arc(cx, cy, r, pct, color, label, val, sub) {
    const s = 2.3, span = (0.84+2*pi-s);
    ctx.beginPath(); ctx.arc(cx, cy, r, s, s+span);
    ctx.strokeStyle = C.b2; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke();
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, s, s + span * Math.min(pct, 1));
      ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // Warn dot (75% of arc = 3% of 4%)
    const wA = s + span * 0.75;
    ctx.beginPath(); ctx.arc(cx+Math.cos(wA)*r, cy+Math.sin(wA)*r, 3, 0, 2*pi);
    ctx.fillStyle = C.warn2; ctx.fill();
    // Block dot (100% of arc = 4%)
    const bA = s + span * 0.99;
    ctx.beginPath(); ctx.arc(cx+Math.cos(bA)*r, cy+Math.sin(bA)*r, 3, 0, 2*pi);
    ctx.fillStyle = C.red2; ctx.fill();
    ctx.fillStyle = C.t3; ctx.font = 'bold 7px JetBrains Mono'; ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy-9);
    ctx.fillStyle = color; ctx.font = 'bold 12px JetBrains Mono';
    ctx.fillText(val, cx, cy+4);
    ctx.fillStyle = C.t3; ctx.font = '6px Inter';
    ctx.fillText(sub, cx, cy+15);
  }
  arc(65,  55, 40, daily/4,  C.green2, 'DAILY', daily.toFixed(2)+'%', 'of 4%');
  arc(175, 55, 40, total/8.5, C.blue3,  'TOTAL', total.toFixed(2)+'%', 'of 8.5%');
  ctx.fillStyle = C.warn2; ctx.font = '6px Inter'; ctx.textAlign = 'left';
  ctx.fillText('● WARN', 10, H-5);
  ctx.fillStyle = C.red2;
  ctx.fillText('● BLOCK', 60, H-5);
}

function drawEquityCurve(canvas, wrap, ledger) {
  const [ctx, W, H] = sizeCv(canvas, wrap);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=C.t3; ctx.font='7px Inter'; ctx.textAlign='center';
  ctx.fillText('CUMULATIVE P&L', W/2, 10);

  const SPEC_COL={'gold-specialist':C.gold,'nas100-specialist':C.blue3,'ger40-bg-specialist':C.teal2};
  const closed=(ledger||[]).filter(t=>t.closedAt&&t.finalPnL!=null).sort((a,b)=>(a.closedAt||0)-(b.closedAt||0));

  if(closed.length===0){
    ctx.fillStyle=C.t2; ctx.font='9px JetBrains Mono'; ctx.textAlign='center';
    ctx.fillText('NO TRADES YET', W/2, H/2);
    return;
  }

  const PAD={l:48,r:12,t:20,b:18};
  let cum=0;
  const pts=closed.map(t=>{cum+=t.finalPnL;return{v:cum,color:SPEC_COL[t.template]||C.t2};});
  const allVals=[0,...pts.map(p=>p.v)];
  const rawMn=Math.min(...allVals),rawMx=Math.max(...allVals);
  const pad=(rawMx-rawMn)*0.08+5;
  const mn=rawMn-pad,mx=rawMx+pad;
  const n=pts.length;
  const toX=i=>PAD.l+i*(W-PAD.l-PAD.r)/(n||1);
  const toY=v=>H-PAD.b-(v-mn)/(mx-mn||1)*(H-PAD.t-PAD.b);

  for(let g=0;g<=4;g++){
    const v=mn+(mx-mn)*g/4,y=toY(v);
    ctx.beginPath();ctx.moveTo(PAD.l,y);ctx.lineTo(W-PAD.r,y);
    ctx.strokeStyle=C.b;ctx.lineWidth=.5;ctx.stroke();
    ctx.fillStyle=C.t3;ctx.font='7px JetBrains Mono';ctx.textAlign='right';
    ctx.fillText((v>=0?'+':'')+v.toFixed(0),PAD.l-4,y+3);
  }

  const zeroY=toY(0);
  if(zeroY>PAD.t&&zeroY<H-PAD.b){
    ctx.beginPath();ctx.moveTo(PAD.l,zeroY);ctx.lineTo(W-PAD.r,zeroY);
    ctx.strokeStyle=C.t3;ctx.lineWidth=.5;ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);
  }

  let px=toX(0),py=toY(0);
  pts.forEach((pt,i)=>{
    const x=toX(i+1),y=toY(pt.v);
    ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(x,y);
    ctx.strokeStyle=pt.color;ctx.lineWidth=1.8;ctx.stroke();
    px=x;py=y;
  });

  ctx.beginPath();
  ctx.moveTo(toX(0),toY(0));
  pts.forEach((pt,i)=>ctx.lineTo(toX(i+1),toY(pt.v)));
  ctx.lineTo(px,H-PAD.b);ctx.lineTo(toX(0),H-PAD.b);ctx.closePath();
  const lastV=pts[pts.length-1]?.v||0;
  const gr=ctx.createLinearGradient(0,PAD.t,0,H-PAD.b);
  gr.addColorStop(0,lastV>=0?'rgba(34,160,96,.14)':'rgba(192,48,64,.14)');
  gr.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gr;ctx.fill();

  ctx.fillStyle=C.t3;ctx.font='7px Inter';ctx.textAlign='right';
  ctx.fillText(`${n} trades`,W-PAD.r,PAD.t+8);

  ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);
  ctx.fillStyle=lastV>=0?C.green2:C.red2;
  ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=6;ctx.fill();ctx.shadowBlur=0;

  [{color:C.gold,name:'GS1'},{color:C.blue3,name:'NAS'},{color:C.teal2,name:'GER'}].forEach((l,i)=>{
    ctx.fillStyle=l.color;ctx.fillRect(PAD.l+8+i*32,PAD.t,14,2);
    ctx.fillStyle=C.t3;ctx.font='7px Inter';ctx.textAlign='left';ctx.fillText(l.name,PAD.l+8+i*32,PAD.t+10);
  });
}

function drawAtomFrame(canvas, wrap, angle) {
  const W = wrap?.clientWidth||400, H = wrap?.clientHeight||300;
  if (canvas.width!==W || canvas.height!==H) { canvas.width=W; canvas.height=H; }
  const ctx = canvas.getContext('2d');
  const cx=W/2, cy=H/2-8, sz=Math.min(W,H);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  const rings=[
    {rx:sz*.38,ry:sz*.14,rot:0,          col:C.blue3, sp:1,   dot:C.gold2},
    {rx:sz*.33,ry:sz*.13,rot:Math.PI/3,  col:C.ml2,   sp:-.7, dot:C.green2},
    {rx:sz*.27,ry:sz*.11,rot:2*Math.PI/3,col:C.teal2, sp:1.3, dot:C.blue3},
    {rx:sz*.20,ry:sz*.08,rot:Math.PI,    col:C.t3,    sp:-.5, dot:C.warn2},
  ];
  rings.forEach(ring => {
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(ring.rot);
    ctx.beginPath(); ctx.ellipse(0,0,ring.rx,ring.ry,0,0,Math.PI*2);
    ctx.strokeStyle=ring.col; ctx.lineWidth=.8; ctx.globalAlpha=.4; ctx.stroke(); ctx.globalAlpha=1;
    const a=angle*ring.sp, dx=Math.cos(a)*ring.rx, dy=Math.sin(a)*ring.ry;
    ctx.beginPath(); ctx.arc(dx,dy,3,0,Math.PI*2);
    ctx.fillStyle=ring.dot; ctx.shadowColor=ring.dot; ctx.shadowBlur=12; ctx.fill(); ctx.shadowBlur=0;
    ctx.restore();
  });
  const cg=ctx.createRadialGradient(cx,cy,0,cx,cy,24);
  cg.addColorStop(0,'rgba(58,160,216,.9)'); cg.addColorStop(.5,'rgba(42,128,184,.3)'); cg.addColorStop(1,'rgba(42,128,184,0)');
  ctx.beginPath(); ctx.arc(cx,cy,24,0,Math.PI*2); ctx.fillStyle=cg; ctx.fill();
  ctx.beginPath(); ctx.arc(cx,cy,9,0,Math.PI*2);
  ctx.fillStyle=C.blue3; ctx.shadowColor=C.blue3; ctx.shadowBlur=22; ctx.fill(); ctx.shadowBlur=0;
  ctx.fillStyle=C.t2; ctx.font='700 10px JetBrains Mono'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('JARVIS',cx,cy); ctx.textBaseline='alphabetic';
  const p=.5+.5*Math.sin(angle*2);
  ctx.beginPath(); ctx.arc(cx,cy,36+p*5,0,Math.PI*2);
  ctx.strokeStyle=`rgba(58,160,216,${.08+.08*p})`; ctx.lineWidth=1; ctx.stroke();
}

function drawRadar(canvas, wrap, perf) {
  const [ctx, W, H] = sizeCv(canvas, wrap);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  const cx=W/2, cy=H/2+5, R=Math.min(W,H)/2-28, n=5;
  const axes=['WIN RATE','PROF FACTOR','VOLUME','R-MULTIPLE','CONSISTENCY'];
  const specs=[
    {name:'GS1',col:C.gold,  vals:[.613,.595,1.0,.71,.72]},
    {name:'NAS',col:C.blue3, vals:[.597,1.0, .21,.95,.80]},
    {name:'GER',col:C.teal2, vals:[.641,.865,.15,.75,.88]},
  ];
  // If real perf data available, update WR
  specs.forEach(sp => {
    const k = sp.name==='GS1'?'gold-specialist':sp.name==='NAS'?'nas100-specialist':'ger40-bg-specialist';
    const wr = perf?.[k]?.winRate;
    if (wr != null) sp.vals[0] = Math.min(wr/100,1);
  });
  for (let r=1;r<=4;r++) {
    ctx.beginPath();
    for (let i=0;i<n;i++) {
      const a=i*2*Math.PI/n-Math.PI/2;
      i===0?ctx.moveTo(cx+Math.cos(a)*R*r/4,cy+Math.sin(a)*R*r/4):ctx.lineTo(cx+Math.cos(a)*R*r/4,cy+Math.sin(a)*R*r/4);
    }
    ctx.closePath(); ctx.strokeStyle=C.b2; ctx.lineWidth=.5; ctx.stroke();
  }
  for (let i=0;i<n;i++) {
    const a=i*2*Math.PI/n-Math.PI/2;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+Math.cos(a)*R,cy+Math.sin(a)*R);
    ctx.strokeStyle=C.b2; ctx.lineWidth=.5; ctx.stroke();
    ctx.fillStyle=C.t3; ctx.font='6px Inter'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(axes[i],cx+Math.cos(a)*(R+14),cy+Math.sin(a)*(R+14));
  }
  specs.forEach(sp => {
    ctx.beginPath();
    sp.vals.forEach((v,i)=>{const a=i*2*Math.PI/n-Math.PI/2;i===0?ctx.moveTo(cx+Math.cos(a)*R*v,cy+Math.sin(a)*R*v):ctx.lineTo(cx+Math.cos(a)*R*v,cy+Math.sin(a)*R*v);});
    ctx.closePath(); ctx.strokeStyle=sp.col; ctx.lineWidth=1.5; ctx.stroke();
    ctx.fillStyle=sp.col+'40'; ctx.fill();
  });
  specs.forEach((sp,i)=>{
    ctx.fillStyle=sp.col; ctx.fillRect(8,H-46+i*11,14,2);
    ctx.fillStyle=C.t3; ctx.font='7px Inter'; ctx.textAlign='left'; ctx.textBaseline='alphabetic';
    ctx.fillText(sp.name,26,H-40+i*11);
  });
}

function drawCalendar(canvas, wrap, ledger) {
  const [ctx, W, H] = sizeCv(canvas, wrap);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=C.t3; ctx.font='8px JetBrains Mono'; ctx.textAlign='center';
  const now = new Date();
  const monthStr = now.toLocaleString('en-US',{month:'long',year:'numeric'}).toUpperCase();
  ctx.fillText('P&L CALENDAR — '+monthStr, W/2, 13);
  const days=['M','T','W','T','F','S','S'];
  const cW=(W-30)/7, rH=(H-28)/5;
  // Build day → P&L from real ledger
  const dayPnl = {};
  (ledger||[]).forEach(t => {
    if (!t.closedAt || t.finalPnL == null) return;
    const d = new Date(t.closedAt);
    if (d.getMonth()!==now.getMonth() || d.getFullYear()!==now.getFullYear()) return;
    const k = d.getDate();
    dayPnl[k] = (dayPnl[k]||0) + t.finalPnL;
  });
  days.forEach((d,i)=>{ctx.fillStyle=C.t3;ctx.font='7px Inter';ctx.textAlign='center';ctx.fillText(d,18+i*cW+cW/2,26);});
  const daysInMonth = new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  // First day of month
  const firstDay = new Date(now.getFullYear(),now.getMonth(),1).getDay();
  const startCol = firstDay===0?6:firstDay-1; // Mon-based
  let d=1;
  for (let row=0;row<5;row++) for (let col=0;col<7;col++) {
    const cellIdx=row*7+col;
    if (cellIdx<startCol||d>daysInMonth) continue;
    const x=18+col*cW, y=28+row*rH;
    const p = dayPnl[d] ?? null;
    ctx.fillStyle = p==null ? C.b : (p===0 ? C.b : (p>0 ? `rgba(34,160,96,${.15+Math.min(Math.abs(p)/200,.8)*.55})` : `rgba(192,48,64,${.15+Math.min(Math.abs(p)/200,.8)*.55})`));
    ctx.fillRect(x+1,y+1,cW-2,rH-2);
    ctx.fillStyle=C.t3; ctx.font='6px Inter'; ctx.textAlign='left'; ctx.fillText(d,x+3,y+9);
    if (p!=null && p!==0){ctx.fillStyle=p>0?C.green2:C.red2;ctx.font='6px JetBrains Mono';ctx.textAlign='center';ctx.fillText((p>0?'+':'')+p.toFixed(0),x+cW/2,y+rH-3);}
    d++;
  }
}

function drawCompound(canvas, wrap, month, startVal) {
  const [ctx, W, H] = sizeCv(canvas, wrap);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  const sv = startVal||100000;
  let val=sv; const pts=[val];
  for (let i=1;i<=12;i++) { val*=1.025; pts.push(val); }
  const mn=pts[0], mx=pts[12];
  ctx.beginPath();
  pts.forEach((p,i)=>{const x=8+i*(W-16)/12,y=H-14-(p-mn)/(mx-mn)*(H-22);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
  ctx.strokeStyle=C.gold; ctx.lineWidth=1.5; ctx.stroke();
  const curX=8+month*(W-16)/12, curY=H-14-(pts[month]-mn)/(mx-mn)*(H-22);
  ctx.beginPath(); ctx.arc(curX,curY,4,0,Math.PI*2);
  ctx.fillStyle=C.gold2; ctx.shadowColor=C.gold2; ctx.shadowBlur=8; ctx.fill(); ctx.shadowBlur=0;
  ctx.beginPath();
  pts.slice(0,month+1).forEach((p,i)=>{const x=8+i*(W-16)/12,y=H-14-(p-mn)/(mx-mn)*(H-22);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
  ctx.lineTo(curX,H-14); ctx.lineTo(8,H-14); ctx.closePath();
  ctx.fillStyle='rgba(200,152,32,.12)'; ctx.fill();
  for (let i=0;i<=12;i+=2){ctx.fillStyle=C.t3;ctx.font='6px JetBrains Mono';ctx.textAlign='center';ctx.fillText('M'+i,8+i*(W-16)/12,H-2);}
}

function drawHeatmap(canvas, wrap) {
  const [ctx, W, H] = sizeCv(canvas, wrap);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=C.t3; ctx.font='8px JetBrains Mono'; ctx.textAlign='center';
  ctx.fillText('WIN RATE HEATMAP — HOUR × SPECIALIST (SIMULATED)', W/2, 12);
  const cols=['GS1','NAS','GER'], rows=['06','07','08','09','10','11','12','13','14','15','16','17'];
  const cW=(W-52)/3, rH=(H-24)/12, rn=rng32(12345);
  cols.forEach((col,ci)=>{
    ctx.fillStyle=C.t3; ctx.font='7px Inter'; ctx.textAlign='center'; ctx.fillText(col,52+ci*cW+cW/2,23);
    rows.forEach((row,ri)=>{
      const v=rn();
      const x=52+ci*cW, y=24+ri*rH;
      ctx.fillStyle=v<.35?`rgba(192,48,64,${.3+v*.8})`:v<.55?`rgba(176,128,32,${.3+v*.5})`:`rgba(34,160,96,${.2+v*.6})`;
      ctx.fillRect(x+1,y+1,cW-2,rH-2);
      ctx.fillStyle=C.t; ctx.font='6px JetBrains Mono'; ctx.textAlign='center';
      ctx.fillText(Math.round(v*100)+'%',x+cW/2,y+rH/2+2);
    });
  });
  rows.forEach((row,ri)=>{ctx.fillStyle=C.t3;ctx.font='7px JetBrains Mono';ctx.textAlign='right';ctx.fillText(row+':00',48,24+(ri+.65)*rH);});
}

function drawMiniCurve(canvas, pts, color) {
  if (!canvas||!canvas.parentElement) return;
  canvas.width=canvas.parentElement.clientWidth||240;
  const W=canvas.width, H=canvas.height;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle=C.s2; ctx.fillRect(0,0,W,H);
  if (!pts||pts.length<2) {
    ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2);
    ctx.strokeStyle=color+'50'; ctx.lineWidth=.8; ctx.stroke();
    return;
  }
  const mx=Math.max(...pts),mn=Math.min(...pts),range=mx-mn||1;
  ctx.beginPath();
  pts.forEach((p,i)=>{const x=i*(W/(pts.length-1)),y=H-2-(p-mn)/range*(H-4);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
  ctx.strokeStyle=color; ctx.lineWidth=1.2; ctx.stroke();
  ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.fillStyle=color+'28'; ctx.fill();
}

function drawMiniPerf(canvas, wrap, perf) {
  const [ctx, W, H] = sizeCv(canvas, wrap);
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=C.t3; ctx.font='7px JetBrains Mono'; ctx.textAlign='center';
  ctx.fillText('SPECIALIST P&L OVERVIEW', W/2, 10);
  const specs=[
    {key:'gold-specialist',     label:'GS1', col:C.gold},
    {key:'nas100-specialist',   label:'NAS', col:C.blue3},
    {key:'ger40-bg-specialist', label:'GER', col:C.teal2},
  ];
  const bW=(W-24)/3, bH=H-28;
  specs.forEach((sp,i)=>{
    const p=perf?.[sp.key];
    const wr=p?.winRate??null;
    const trades=p?.trades??0;
    const ox=12+i*bW;
    ctx.fillStyle=C.t3;ctx.font='7px Inter';ctx.textAlign='center';
    ctx.fillText(sp.label,ox+bW/2,22);
    if(wr!=null){
      const barH=bH*(wr/100);
      ctx.fillStyle=sp.col+'40';ctx.fillRect(ox+4,H-8-bH,bW-8,bH);
      ctx.fillStyle=sp.col;ctx.fillRect(ox+4,H-8-barH,bW-8,barH);
      ctx.fillStyle=sp.col;ctx.font='bold 9px JetBrains Mono';ctx.textAlign='center';
      ctx.fillText(wr.toFixed(0)+'%',ox+bW/2,H-10-barH-2);
      ctx.fillStyle=C.t3;ctx.font='6px Inter';
      ctx.fillText(trades+'t',ox+bW/2,H-5);
    } else {
      ctx.fillStyle=C.b;ctx.fillRect(ox+4,H-8-bH,bW-8,bH);
      ctx.fillStyle=C.t3;ctx.font='8px JetBrains Mono';ctx.textAlign='center';
      ctx.fillText('—',ox+bW/2,H/2+4);
    }
  });
}

function drawCorrGauge(canvas) {
  if (!canvas||!canvas.parentElement) return;
  canvas.width=canvas.parentElement.clientWidth-20||240;
  const W=canvas.width, H=canvas.height, ctx=canvas.getContext('2d');
  ctx.fillStyle=C.s1; ctx.fillRect(0,0,W,H);
  const exp=.34;
  ctx.fillStyle=C.b; ctx.fillRect(0,H/2-5,W,10);
  const g=ctx.createLinearGradient(0,0,W,0);
  g.addColorStop(0,C.green2); g.addColorStop(.5,C.warn2); g.addColorStop(1,C.red2);
  ctx.fillStyle=g; ctx.fillRect(0,H/2-5,W*exp,10);
  const px=W*exp;
  ctx.beginPath();ctx.moveTo(px,H/2-10);ctx.lineTo(px+5,H/2-18);ctx.lineTo(px-5,H/2-18);ctx.closePath();
  ctx.fillStyle=C.t; ctx.fill();
  ['LOW','MED','HIGH'].forEach((l,i)=>{ctx.fillStyle=C.t3;ctx.font='6px Inter';ctx.textAlign='left';ctx.fillText(l,W*i/3,H-2);});
}

// ── QB Logo SVG ───────────────────────────────────────────────────────────────
function QBLogo() {
  return (
    <svg width="110" height="28" viewBox="0 0 110 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink:0,marginRight:2}}>
      <ellipse cx="14" cy="14" rx="12" ry="12" stroke="#C89820" strokeWidth="1.2" opacity="0.35"/>
      <ellipse cx="14" cy="14" rx="12" ry="5.5" stroke="#C89820" strokeWidth="0.8" opacity="0.5" transform="rotate(-30 14 14)"/>
      <ellipse cx="14" cy="14" rx="12" ry="5.5" stroke="#3AA0D8" strokeWidth="0.8" opacity="0.4" transform="rotate(60 14 14)"/>
      <circle cx="14" cy="14" r="3.2" fill="#C89820"/>
      <circle cx="25.5" cy="10.5" r="1.6" fill="#F0BC28"/>
      <text x="32" y="19" fontFamily="JetBrains Mono,monospace" fontWeight="700" fontSize="13" letterSpacing="2" fill="#C89820">QUANTUM</text>
      <text x="32" y="27" fontFamily="JetBrains Mono,monospace" fontWeight="400" fontSize="7.5" letterSpacing="3.5" fill="#3A5570">BOT  v20</text>
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function TerminalLayout({
  positions, quotes, capital, jarvis, ledger, perf, totalPerf, ftmoStatus, gatingRules, onPositionAction,
  accounts, accountStatus, upcomingNews = [], newsStatus = 'clear',
}) {
  const [activeView, setActiveView] = useState('telemetry');
  const [specOn,  setSpecOn]  = useState({gs1:true,nas:true,ger:true});
  const [compound, setCompound] = useState(3);
  const [utc, setUtc] = useState('--:--:-- UTC');
  const [sessions, setSessions] = useState({asian:false,london:false,ny:false});

  // Canvas refs
  const ftmoRef   = useRef(null);
  const equityRef = useRef(null); const equityWrap = useRef(null);
  const atomRef   = useRef(null); const atomWrap   = useRef(null);
  const radarRef  = useRef(null); const radarWrap  = useRef(null);
  const calRef    = useRef(null); const calWrap    = useRef(null);
  const compRef   = useRef(null); const compWrap   = useRef(null);
  const hmRef     = useRef(null); const hmWrap     = useRef(null);
  const miniPRef  = useRef(null); const miniPWrap  = useRef(null);
  const corrRef   = useRef(null);
  const mcGs1     = useRef(null);
  const mcNas     = useRef(null); const mcGer = useRef(null);
  const rafRef    = useRef(null); const angleRef = useRef(0);

  // ── Derived values ──────────────────────────────────────────────────────────
  const dailyDD  = ftmoStatus?.dailyLossPct ?? 0;
  const totalDD  = ftmoStatus?.totalDDPct   ?? 0;
  const canTrade = ftmoStatus?.canTrade !== false;
  const balance  = ftmoStatus?.debug?.balance ?? capital ?? 0;
  const equity   = ftmoStatus?.debug?.equity  ?? ftmoStatus?.debug?.balance ?? capital ?? 0;
  const ftmoBadge = !canTrade ? 'BLOCK' : dailyDD>=3||totalDD>=7 ? 'WARN' : 'CLEAR';
  const ftmoColor = !canTrade ? C.red2 : dailyDD>=3||totalDD>=7 ? C.warn2 : C.green2;
  const openPos  = (positions||[]).filter(p => /QB-V20-/i.test(p.comment||''));
  const today    = new Date().toISOString().slice(0,10);
  const todayPnl = (ledger||[]).filter(t => t.closedAt && new Date(t.closedAt).toISOString().slice(0,10)===today).reduce((s,t)=>s+(t.finalPnL||0),0);
  const jarvisText = jarvis?.speech ?? jarvis?.text ?? jarvis?.directive ?? 'Monitoring market conditions. Watching for high-probability setups across GS1, NAS and GER specialists.';
  const jarvisScore = jarvis?.score ?? null;
  const jarvisUrgency = (jarvis?.urgency ?? 'nominal').toUpperCase();
  const lastTrade = (ledger||[]).filter(t=>t.closedAt).sort((a,b)=>(b.closedAt||0)-(a.closedAt||0))[0] ?? null;
  const lastSpec = lastTrade ? (lastTrade.template||'').replace('ger40-bg-specialist','GER').replace('nas100-specialist','NAS').replace('gold-specialist','GS1') : null;

  // ── Clock ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const h=String(n.getUTCHours()).padStart(2,'0'), m=String(n.getUTCMinutes()).padStart(2,'0'), s=String(n.getUTCSeconds()).padStart(2,'0');
      setUtc(`${h}:${m}:${s} UTC`);
      const utcH = n.getUTCHours()+n.getUTCMinutes()/60;
      setSessions({ asian:utcH<9||utcH>=21, london:utcH>=7&&utcH<16, ny:utcH>=13.5&&utcH<22 });
    };
    tick(); const id=setInterval(tick,1000); return ()=>clearInterval(id);
  },[]);

  // ── Canvas draw ──────────────────────────────────────────────────────────────
  const drawAll = useCallback(() => {
    if (ftmoRef.current) drawFTMO(ftmoRef.current, dailyDD, totalDD);
    const specPts = key => {
      let c=0; const p=[0];
      (ledger||[]).filter(t=>t.template===key&&t.closedAt&&t.finalPnL!=null)
        .sort((a,b)=>(a.closedAt||0)-(b.closedAt||0)).forEach(t=>{c+=t.finalPnL;p.push(c);});
      return p.length>1?p:null;
    };
    drawMiniCurve(mcGs1.current,specPts('gold-specialist'),C.gold);
    drawMiniCurve(mcNas.current,specPts('nas100-specialist'),C.blue3);
    drawMiniCurve(mcGer.current,specPts('ger40-bg-specialist'),C.teal2);
    drawCorrGauge(corrRef.current);
    if (activeView==='telemetry') drawEquityCurve(equityRef.current, equityWrap.current, ledger);
    if (activeView==='performance') { drawCalendar(calRef.current,calWrap.current,ledger); drawMiniPerf(miniPRef.current,miniPWrap.current,perf); }
    if (activeView==='specialists') { drawRadar(radarRef.current,radarWrap.current,perf); drawCompound(compRef.current,compWrap.current,compound,equity); }
    if (activeView==='nexus') drawHeatmap(hmRef.current,hmWrap.current);
  }, [activeView, dailyDD, totalDD, ledger, perf, compound, equity, newsStatus, ftmoStatus, accountStatus]);

  useLayoutEffect(() => { drawAll(); }, [drawAll]);

  // ── Atom animation loop ──────────────────────────────────────────────────────
  useEffect(() => {
    const loop = () => {
      if (activeView==='jarvis' && atomRef.current && atomWrap.current) {
        drawAtomFrame(atomRef.current, atomWrap.current, angleRef.current);
        angleRef.current += .018;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeView]);

  useEffect(() => { window.addEventListener('resize',drawAll); return ()=>window.removeEventListener('resize',drawAll); },[drawAll]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const switchView = v => setActiveView(v);
  const togSpec = k => setSpecOn(prev=>({...prev,[k]:!prev[k]}));

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div id="qc-root">

      {/* TOP BAR */}
      <div id="qc-topbar">
        <QBLogo />
        <div className="qc-sep"/>
        <div className="qc-tb-blk">
          <span className={`qc-dot ${accountStatus==='live'?'qc-dot-live':accountStatus==='standby'?'qc-dot-warn':'qc-dot-dead'}`}/>
          <span className="qc-tb-lbl">META</span>
          <span className="qc-tb-val" style={{color:accountStatus==='live'?C.green2:accountStatus==='standby'?C.warn2:C.t3}}>
            {accountStatus==='live'?'LIVE':accountStatus==='standby'?'STANDBY':accountStatus==='loading'?'…':'NO ACCT'}
          </span>
        </div>
        <div className="qc-tb-blk"><span className={`qc-dot ${ftmoStatus!=null?'qc-dot-live':'qc-dot-dead'}`}/><span className="qc-tb-lbl">REDIS</span><span className="qc-tb-val" style={{color:ftmoStatus!=null?C.green2:C.t3}}>{ftmoStatus!=null?'OK':'—'}</span></div>
        <div className="qc-sep"/>
        <div className="qc-tb-blk"><span className="qc-tb-lbl">BAL</span><span className="qc-tb-val qc-mono">{balance>0?`$${Number(balance).toLocaleString('en-US',{minimumFractionDigits:0})}`:'—'}</span></div>
        <div className="qc-tb-blk"><span className="qc-tb-lbl">EQUITY</span><span className="qc-tb-val qc-mono" style={{color:C.green2}}>{equity>0?`$${Number(equity).toLocaleString('en-US',{minimumFractionDigits:0})}`:'—'}</span></div>
        <div className="qc-tb-blk"><span className="qc-tb-lbl">DAILY P&L</span><span className="qc-tb-val qc-mono" style={{color:todayPnl>=0?C.green2:C.red2}}>{fmtMony(todayPnl)}</span></div>
        <div className="qc-sep"/>
        {(accounts||[]).map((a,i)=>(
          <div key={i} className="qc-tb-blk" style={{gap:3}}>
            <span className={`qc-dot ${a.connected?'qc-dot-live':'qc-dot-dead'}`}/>
            <span className="qc-tb-lbl" style={{maxWidth:60,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{(a.name||'ACCT').toUpperCase()}</span>
            {a.connected&&a.balance!=null&&<span className="qc-tb-val qc-mono" style={{color:C.gold}}>{a.currency||'$'}{Number(a.balance).toLocaleString('en-US',{maximumFractionDigits:0})}</span>}
            {!a.connected&&<span className="qc-tb-val" style={{color:C.t3,fontSize:8}}>OFFLINE</span>}
          </div>
        ))}
        <div className="qc-tb-blk"><span className="qc-tb-lbl">FTMO</span><span className="qc-tb-val qc-mono" style={{color:ftmoColor}}>{ftmoBadge}</span></div>
        <div className="qc-tb-blk"><span className="qc-tb-lbl">NEWS</span><span className="qc-tb-val qc-mono" style={{color:newsStatus==='block'?C.red2:newsStatus==='warn'?C.warn2:C.green2}}>{newsStatus==='block'?'BLOCK':newsStatus==='warn'?'WARN':'CLEAR'}</span></div>
        <div className="qc-spacer"/>
        <div className="qc-sessions">
          {[['asian','ASIAN'],['london','LONDON'],['ny','NEW YORK']].map(([k,lbl])=>(
            <div key={k} className={`qc-si${sessions[k]?' active':''}`}>
              <div className={`qc-sess-bar${sessions[k]?' active':''}`}/>
              <span>{lbl}</span>
            </div>
          ))}
        </div>
        <div className="qc-sep"/>
        <span id="qc-time" className="qc-mono">{utc}</span>
      </div>

      {/* MAIN */}
      <div id="qc-main">

        {/* ═══ LEFT PANEL ═══ */}
        <div id="qc-left" className="qc-scroll">

          {/* FTMO */}
          <div className="qc-psec">
            <div className="qc-phdr">
              <span className="qc-phdr-t">FTMO INTELLIGENCE</span>
              <span className={`qc-badge ${!canTrade?'qc-b-block':dailyDD>=3||totalDD>=7?'qc-b-warn':'qc-b-ok'}`}>{ftmoBadge}</span>
            </div>
            <div className="qc-pbody">
              <canvas ref={ftmoRef} width={240} height={108} style={{display:'block',margin:'4px auto'}}/>
              <div className="qc-ftmo-grid">
                <div className="qc-fstat"><div className="qc-fs-l">DAILY DD</div><div className="qc-fs-v" style={{color:dailyDD>=4?C.red2:dailyDD>=3?C.warn2:C.green2}}>{dailyDD.toFixed(2)}%</div><div className="qc-fs-s">block @4.00%</div></div>
                <div className="qc-fstat"><div className="qc-fs-l">TOTAL DD</div><div className="qc-fs-v" style={{color:totalDD>=8.5?C.red2:totalDD>=7?C.warn2:C.green2}}>{totalDD.toFixed(2)}%</div><div className="qc-fs-s">block @8.50%</div></div>
                <div className="qc-fstat"><div className="qc-fs-l">SAFE BUDGET</div><div className="qc-fs-v qc-mono">{balance>0?`$${((0.04-dailyDD/100)*balance).toFixed(0)}`:'—'}</div><div className="qc-fs-s">today remaining</div></div>
                <div className="qc-fstat"><div className="qc-fs-l">PROFIT PACE</div><div className="qc-fs-v qc-mono" style={{color:C.green2}}>{equity>0&&balance>0?((equity/balance-1)*100).toFixed(2)+'%':'—'}</div><div className="qc-fs-s">target 10%/30d</div></div>
                <div className="qc-fstat"><div className="qc-fs-l">MIN DAYS</div><div className="qc-fs-v qc-mono">4 req</div><div className="qc-fs-s">FTMO minimum</div></div>
                <div className="qc-fstat"><div className="qc-fs-l">DAYS REM</div><div className="qc-fs-v qc-mono">30d</div><div className="qc-fs-s">challenge window</div></div>
              </div>
              <div className="qc-worst"><span style={{color:C.t2}}>WORST-CASE:</span> 3 losses @1R = <span className="qc-mono" style={{color:C.warn2}}>~-$450 · 0.45% daily</span></div>
            </div>
          </div>

          {/* JARVIS */}
          <div className="qc-psec">
            <div className="qc-phdr">
              <span className="qc-phdr-t">JARVIS DIRECTIVE</span>
              <span className="qc-badge qc-b-ok">{canTrade?'NOMINAL':'BLOCKED'}</span>
            </div>
            <div className="qc-pbody">
              <div className="qc-jdir">
                <div className="qc-jdir-l">ACTIVE DIRECTIVE</div>
                <div className="qc-jdir-t">{String(jarvisText).slice(0,200)}</div>
                <div className="qc-jdir-m">
                  <span className="qc-jscore">SCORE: {jarvisScore!=null?`${jarvisScore}/100`:'—'}</span>
                  <span className="qc-jurg">{jarvisUrgency}</span>
                </div>
              </div>
              <div className="qc-stitle" style={{marginBottom:5}}>SIZING ENGINE</div>
              <div className="qc-row"><span className="qc-rl">Risk per trade</span><span className="qc-rv" style={{color:C.gold}}>{equity>0?`$${(equity*0.01).toFixed(0)}`:'—'}</span></div>
              <div className="qc-row"><span className="qc-rl">Account risk</span><span className="qc-rv">1.00%</span></div>
              <div className="qc-row"><span className="qc-rl">Lot size</span><span className="qc-rv" style={{color:C.t3}}>—</span></div>
              <div className="qc-row"><span className="qc-rl">Compound mode</span><span className="qc-rv" style={{color:C.ml2}}>ADAPTIVE</span></div>
              <div className="qc-stitle" style={{margin:'8px 0 5px'}}>LAST CLOSED TRADE</div>
              <div className="qc-verdict">{lastTrade?`${lastSpec} · ${(lastTrade.direction||'').toUpperCase()||'—'} · ${fmtMony(lastTrade.finalPnL??0)}`:<span style={{color:C.t3}}>No trades closed yet</span>}</div>
            </div>
          </div>

          {/* SYS OPS */}
          <div className="qc-psec">
            <div className="qc-phdr"><span className="qc-phdr-t">SYS OPS</span><span className={`qc-badge ${accountStatus==='live'?'qc-b-ok':accountStatus==='standby'?'qc-b-warn':'qc-b-block'}`}>{accountStatus==='live'?'ONLINE':accountStatus==='standby'?'STANDBY':'OFFLINE'}</span></div>
            <div className="qc-pbody">
              <div className="qc-so-row"><span className="qc-so-l">MetaAPI</span><span className="qc-so-v" style={{color:accountStatus==='live'?C.green2:accountStatus==='standby'?C.warn2:C.t3}}>{accountStatus==='live'?'LIVE':accountStatus==='standby'?'STANDBY':accountStatus==='loading'?'CONNECTING…':'OFFLINE'}</span></div>
              <div className="qc-so-row" style={{marginTop:4}}><span className="qc-so-l">Redis</span><span className="qc-so-v" style={{color:ftmoStatus!=null?C.green2:C.t3}}>{ftmoStatus!=null?'OK':'—'}</span></div>
              <div className="qc-so-row"><span className="qc-so-l">FTMO Guard</span><span className="qc-so-v" style={{color:ftmoColor}}>{ftmoBadge}</span></div>
              <div className="qc-so-row"><span className="qc-so-l">News Filter</span><span className="qc-so-v" style={{color:newsStatus==='block'?C.red2:newsStatus==='warn'?C.warn2:C.green2}}>{newsStatus==='block'?'BLOCK':newsStatus==='warn'?'WARN':'CLEAR'}</span></div>
              <div className="qc-so-row"><span className="qc-so-l">Webhook hits</span><span className="qc-so-v" style={{color:C.green2}}>{openPos.length} open · today</span></div>
              <div className="qc-wh-log">
                {(ledger||[]).filter(t=>t.closedAt).sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,5).map((t,i)=>{
                  const spec=(t.template||'').replace('ger40-bg-specialist','GER').replace('nas100-specialist','NAS').replace('gold-specialist-2','GS2').replace('gold-specialist','GS1');
                  return <div key={i} className={`qc-wle ${(t.finalPnL||0)>=0?'ok':'err'}`}>{fmtDate(t.closedAt)} {spec} ▸ {(t.finalPnL||0)>=0?'+':'−'}${Math.abs(t.finalPnL||0).toFixed(0)}</div>;
                })}
                {!(ledger||[]).filter(t=>t.closedAt).length&&<div className="qc-wle" style={{color:C.t3}}>No closed trades yet</div>}
              </div>
              <div className="qc-exp-wrap">
                <div className="qc-exp-lbl">CORRELATION EXPOSURE</div>
                <div className="qc-exp-bar"><div className="qc-exp-fill" style={{width:`${Math.min(openPos.length*17,100)}%`}}/></div>
                <div className="qc-exp-val">{openPos.length} positions · {openPos.length<=1?'LOW':openPos.length<=2?'MODERATE':'HIGH'} RISK</div>
              </div>
            </div>
          </div>
        </div>

        {/* ═══ CENTER PANEL ═══ */}
        <div id="qc-center">
          <div className="qc-tabs">
            {[['telemetry','TELEMETRY'],['performance','PERFORMANCE'],['jarvis','JARVIS'],['specialists','SPECIALISTS'],['nexus','SIGNAL NEXUS']].map(([k,lbl])=>(
              <button key={k} className={`qc-tab${activeView===k?' active':''}`} onClick={()=>switchView(k)}>{lbl}</button>
            ))}
          </div>

          {/* STANDBY OVERLAY — shown when no funded account is connected */}
          {accountStatus!=='live'&&(
            <div style={{position:'absolute',inset:0,top:32,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',background:C.bg,zIndex:10,gap:16}}>
              <QBLogo/>
              <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,letterSpacing:3,color:C.t3,marginTop:8}}>
                {accountStatus==='loading'?'CONNECTING…':accountStatus==='standby'?'AWAITING FUNDED ACCOUNT':'NO ACCOUNT CONFIGURED'}
              </div>
              {accountStatus==='none'&&(
                <div style={{fontSize:8,color:C.t3,fontFamily:'Inter,sans-serif',textAlign:'center',maxWidth:280,lineHeight:1.7}}>
                  Set <span style={{color:C.gold,fontFamily:'JetBrains Mono,monospace'}}>METAAPI_ACCOUNTS</span> env var as a JSON array
                  <br/>e.g. <span style={{color:C.blue3,fontFamily:'JetBrains Mono,monospace'}}>{'[{"id":"...","name":"FTMO 100K","type":"challenge"}]'}</span>
                </div>
              )}
              {(accounts||[]).length>0&&(
                <div style={{display:'flex',flexDirection:'column',gap:6,marginTop:4}}>
                  {(accounts||[]).map((a,i)=>(
                    <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'4px 14px',background:C.s1,border:`1px solid ${a.connected?C.green2:C.b}`,fontSize:9,fontFamily:'JetBrains Mono,monospace',letterSpacing:1}}>
                      <span className={`qc-dot ${a.connected?'qc-dot-live':'qc-dot-dead'}`}/>
                      <span style={{color:C.t}}>{(a.name||'ACCOUNT').toUpperCase()}</span>
                      <span style={{color:C.t3}}>{(a.type||'').toUpperCase()}</span>
                      <span style={{color:a.connected?C.green2:C.t3,marginLeft:4}}>{a.connected?'CONNECTED':'OFFLINE'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TELEMETRY */}
          <div className={`qc-view${activeView==='telemetry'?' active':''}`} id="qc-view-telemetry">
            <div className="qc-tel">
              <div className="qc-stat-row">
                {[
                  {lbl:'EQUITY',val:equity>0?`$${Number(equity).toLocaleString('en-US',{minimumFractionDigits:0})}`:'—',sub:fmtMony(todayPnl)+' today',color:C.green2,fill:equity>0?100:0},
                  {lbl:'WIN RATE',val:totalPerf?.winRate!=null?totalPerf.winRate.toFixed(1)+'%':'—',sub:totalPerf?.trades?`${totalPerf.trades} trades`:'no data',color:C.blue3,fill:totalPerf?.winRate??0},
                  {lbl:'PROF FACTOR',val:totalPerf?.profitFactor!=null?totalPerf.profitFactor.toFixed(2):'—',sub:'gross P/L ratio',color:C.gold,fill:totalPerf?.profitFactor!=null?Math.min(totalPerf.profitFactor/3*100,100):0},
                  {lbl:'CLOSED TRADES',val:totalPerf?.trades??'—',sub:'all specialists',color:C.ml2,fill:Math.min((totalPerf?.trades||0)*2,100)},
                ].map(({lbl,val,sub,color,fill})=>(
                  <div key={lbl} className="qc-sbc">
                    <div className="qc-sbc-l">{lbl}</div>
                    <div className="qc-sbc-v" style={{color}}>{val}</div>
                    <div className="qc-sbc-s" style={{color}}>{sub}</div>
                    <div className="qc-sbc-bar"><div className="qc-sbc-fill" style={{width:`${fill}%`,background:color}}/></div>
                  </div>
                ))}
              </div>
              <div className="qc-eq-wrap" ref={equityWrap}>
                <canvas ref={equityRef} style={{display:'block'}}/>
              </div>
              <div className="qc-pos-table">
                <div className="qc-pt-hdr"><span>SYMBOL</span><span>DIR</span><span>LOTS</span><span>ENTRY</span><span>SL</span><span>TP</span><span>P&L / ACT</span></div>
                {openPos.length===0
                  ? <div style={{padding:'8px 10px',fontSize:9,color:C.t3,fontFamily:'JetBrains Mono,monospace'}}>No active positions · monitoring</div>
                  : openPos.slice(0,4).map(p=>{
                    const long=p.type==='POSITION_TYPE_BUY';
                    const pnl=p.unrealizedProfit??0;
                    return (
                      <div key={p.id} className="qc-pt-row">
                        <span style={{color:C.gold,fontWeight:600}}>{p.symbol}</span>
                        <span style={{color:long?C.green2:C.red2}}>{long?'BUY':'SELL'}</span>
                        <span>{fmt(p.volume,2)}</span>
                        <span className="qc-mono">{fmt(p.openPrice,2)}</span>
                        <span className="qc-mono" style={{color:C.red2}}>{p.stopLoss?fmt(p.stopLoss,2):'—'}</span>
                        <span className="qc-mono" style={{color:C.green2}}>{p.takeProfit?fmt(p.takeProfit,2):'—'}</span>
                        <div className="qc-pt-btns">
                          <button className="qc-pt-btn" onClick={()=>onPositionAction?.('be',p.id)}>BE</button>
                          <button className="qc-pt-btn" onClick={()=>onPositionAction?.('partial',p.id)}>50%</button>
                          <button className="qc-pt-btn danger" onClick={()=>onPositionAction?.('close',p.id)}>✕</button>
                          <span style={{fontFamily:'JetBrains Mono,monospace',fontSize:9,color:pnl>=0?C.green2:C.red2,marginLeft:4}}>{fmtMony(pnl)}</span>
                        </div>
                      </div>
                    );
                  })
                }
              </div>
            </div>
          </div>

          {/* PERFORMANCE */}
          <div className={`qc-view${activeView==='performance'?' active':''}`} id="qc-view-performance">
            <div className="qc-perf">
              <div className="qc-cal-wrap" ref={calWrap}><canvas ref={calRef}/></div>
              <div className="qc-eq-quality">
                <div className="qc-eq-t">SPECIALIST PERFORMANCE</div>
                {[
                  {key:'gold-specialist',   label:'GS1 · GOLD',  col:C.gold},
                  {key:'nas100-specialist', label:'NAS · NAS100', col:C.blue3},
                  {key:'ger40-bg-specialist',label:'GER · GER40', col:C.teal2},
                ].map(m=>{
                  const p=perf?.[m.key];
                  const wr=p?.winRate; const pf=p?.profitFactor; const n=p?.trades??0;
                  return (
                    <div key={m.key} className="qc-eq-m">
                      <div className="qc-eq-lbl">{m.label}</div>
                      <div className="qc-eq-bw"><div className="qc-eq-bf" style={{width:wr!=null?`${Math.min(wr,100)}%`:'0%',background:m.col}}/></div>
                      <div className="qc-eq-nums">
                        <span style={{color:m.col}}>{wr!=null?wr.toFixed(1)+'% WR':'—'}</span>
                        <span>{pf!=null?'PF '+pf.toFixed(2):n>0?n+'t':'no data'}</span>
                      </div>
                    </div>
                  );
                })}
                <div style={{marginTop:10,padding:6,background:C.bg,border:`1px solid ${C.b}`}}>
                  <div className="qc-stitle" style={{marginBottom:4}}>RECOVERY EST.</div>
                  <div className="qc-mono" style={{fontSize:10}}>{equity>0&&balance>0&&equity<balance?`$${(balance-equity).toFixed(0)} needed`:'On track'}</div>
                  <div style={{fontSize:8,color:C.t2,marginTop:2}}>{balance>0&&equity>0?`$${(equity-balance>=0?'+':'')}${(equity-balance).toFixed(0)} vs start`:'—'}</div>
                </div>
              </div>
              <div className="qc-mini-c" ref={miniPWrap}><canvas ref={miniPRef} height={72}/></div>
            </div>
          </div>

          {/* JARVIS VIEW */}
          <div className={`qc-view${activeView==='jarvis'?' active':''}`} id="qc-view-jarvis">
            <div className="qc-jv">
              <div className="qc-atom-wrap" ref={atomWrap}>
                <canvas ref={atomRef} style={{display:'block'}}/>
                <div className="qc-atom-lbl">QUANTUM INTELLIGENCE LAYER · v20</div>
              </div>
              <div className="qc-j-sidebar">
                <div className="qc-j-health">
                  <div className="qc-jf-t">SYSTEM HEALTH</div>
                  {[
                    ['Decision score',`${jarvisScore}/100`,C.gold],
                    ['Intent parsed', jarvis?.intent?.toUpperCase()||'NOMINAL', C.green2],
                    ['Anomalies',     '0 active',  C.green2],
                    ['FTMO guard',    ftmoBadge,   ftmoColor],
                    ['News filter',   newsStatus.toUpperCase(), newsStatus==='block'?C.red2:newsStatus==='warn'?C.warn2:C.green2],
                    ['Last cycle',    fmtTime(Date.now()), null],
                  ].map(([l,v,col])=>(
                    <div key={l} className="qc-row">
                      <span className="qc-rl">{l}</span>
                      <span className="qc-rv" style={col?{color:col}:{}}>{v}</span>
                    </div>
                  ))}
                </div>
                <div className="qc-j-feed">
                  <div className="qc-jf-t">DECISION FEED</div>
                  {(ledger||[]).filter(t=>t.closedAt).sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,6).map((t,i)=>{
                    const spec=(t.template||'').replace('ger40-bg-specialist','GER').replace('nas100-specialist','NAS').replace('gold-specialist-2','GS2').replace('gold-specialist','GS1');
                    const pnl=t.finalPnL??0;
                    return (
                      <div key={i} className="qc-jfe">
                        <div className="qc-jfe-time">{fmtDate(t.closedAt)}</div>
                        <div className="qc-jfe-txt" style={{color:pnl>0?C.green2:pnl<0?C.red2:C.t2}}>{spec} · {(t.direction||'').toUpperCase()||'—'} · {fmtMony(pnl)}</div>
                      </div>
                    );
                  })}
                  {!(ledger||[]).filter(t=>t.closedAt).length&&<div className="qc-jfe"><div className="qc-jfe-time">--:--</div><div className="qc-jfe-txt" style={{color:C.t3}}>Awaiting first closed trade</div></div>}
                </div>
                <div className="qc-ticker">
                  <div className="qc-ticker-l">ANOMALY DETECTOR</div>
                  <div className="qc-ticker-w">
                    <span className="qc-ticker-s">◆ FTMO {dailyDD.toFixed(2)}% DAILY WITHIN LIMITS &nbsp;·&nbsp; TOTAL DD {totalDD.toFixed(2)}% &nbsp;·&nbsp; ALL 3 SPECIALISTS ACTIVE &nbsp;·&nbsp; NEWS {newsStatus.toUpperCase()} &nbsp;·&nbsp;</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* SPECIALISTS VIEW */}
          <div className={`qc-view${activeView==='specialists'?' active':''}`} id="qc-view-specialists">
            <div className="qc-sv">
              <div className="qc-radar-wrap" ref={radarWrap}><canvas ref={radarRef} style={{display:'block'}}/></div>
              <div className="qc-spec-rank">
                <div className="qc-sr-t">SPECIALIST RANKING</div>
                {[
                  {rank:'#1',name:'GER40 B+G',   sub:'Tue+Thu · 15m FVG · Both dirs', wr:perf?.['ger40-bg-specialist']?.winRate, pf:perf?.['ger40-bg-specialist']?.profitFactor, bkWr:64.1, bkPf:1.73, col:C.teal2},
                  {rank:'#2',name:'NAS100 TJR',  sub:'AMD · London→NY · BOS FVG',     wr:perf?.['nas100-specialist']?.winRate,   pf:perf?.['nas100-specialist']?.profitFactor,   bkWr:59.7, bkPf:2.51, col:C.blue3},
                  {rank:'#3',name:'GOLD S1 ORB', sub:'Frankfurt+NY · H+M timeframe',  wr:perf?.['gold-specialist']?.winRate,     pf:perf?.['gold-specialist']?.profitFactor,     bkWr:61.3, bkPf:1.19, col:C.gold},
                ].map(s=>(
                  <div key={s.rank} className="qc-srank-row">
                    <span className="qc-srank-n">{s.rank}</span>
                    <div style={{flex:1}}>
                      <div className="qc-srank-name" style={{color:s.col}}>{s.name}</div>
                      <div className="qc-srank-sub">{s.sub}</div>
                    </div>
                    <div className="qc-srank-stats">
                      <span style={{color:s.wr!=null?C.green2:C.t3}}>{s.wr!=null?s.wr.toFixed(1)+'%':s.bkWr+'%*'}</span>
                      <span style={{color:s.pf!=null?C.blue3:C.t3}}>{s.pf!=null?s.pf.toFixed(2):s.bkPf+'*'}</span>
                      <span style={{color:C.gold}}>ON</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="qc-compound" ref={compWrap}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                  <span className="qc-stitle">COMPOUND GROWTH TRACKER</span>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <input type="range" min={1} max={12} value={compound} onChange={e=>{ setCompound(Number(e.target.value)); setTimeout(()=>drawCompound(compRef.current,compWrap.current,Number(e.target.value),equity),0); }} style={{width:90,accentColor:C.gold}}/>
                    <span className="qc-mono" style={{fontSize:9,color:C.gold}}>M{compound}: ${equity>0?(equity*Math.pow(1.025,compound)).toFixed(0):'—'}</span>
                  </div>
                </div>
                <canvas ref={compRef} height={56} style={{display:'block',width:'100%'}}/>
              </div>
            </div>
          </div>

          {/* SIGNAL NEXUS */}
          <div className={`qc-view${activeView==='nexus'?' active':''}`} id="qc-view-nexus">
            <div className="qc-nx">
              <div className="qc-hm-wrap" ref={hmWrap}><canvas ref={hmRef}/></div>
              <div className="qc-sess-edges">
                <div className="qc-se-t">SESSION EDGE BY SPECIALIST</div>
                {[
                  {lbl:'GOLD S1 · Frankfurt ORB', key:'gold-specialist',     bkWr:61, col:C.gold},
                  {lbl:'NAS100 · AMD FVG',         key:'nas100-specialist',   bkWr:60, col:C.blue3},
                  {lbl:'GER40 · B+G Tue/Thu',      key:'ger40-bg-specialist', bkWr:64, col:C.teal2},
                ].map(s=>{
                  const wr=perf?.[s.key]?.winRate;
                  return (
                    <div key={s.lbl} className="qc-se-r">
                      <div className="qc-se-lbl"><span>{s.lbl}</span><span style={{color:wr!=null?C.green2:C.t3}}>{wr!=null?wr.toFixed(0)+'%':s.bkWr+'%*'}</span></div>
                      <div className="qc-se-bar"><div className="qc-se-fill" style={{width:`${Math.min(wr??s.bkWr,100)}%`,background:s.col}}/></div>
                    </div>
                  );
                })}
                <div style={{marginTop:10,borderTop:`1px solid ${C.b}`,paddingTop:8}}>
                  <div className="qc-stitle" style={{marginBottom:6}}>BEST ENTRY WINDOWS</div>
                  <div style={{fontSize:9,color:C.t2,display:'flex',flexDirection:'column',gap:3}}>
                    <span><span className="qc-mono" style={{color:C.gold}}>07:00</span> Frankfurt ORB — GS1</span>
                    <span><span className="qc-mono" style={{color:C.teal2}}>08:00</span> GER40 B+G window</span>
                    <span><span className="qc-mono" style={{color:C.blue3}}>13:30</span> NY open + NAS AMD</span>
                    <span><span className="qc-mono" style={{color:C.gold}}>13:30</span> GS1 NY ORB</span>
                  </div>
                </div>
              </div>
              <div className="qc-sigs">
                <div className="qc-sigs-t">RECENT SIGNALS</div>
                <div className="qc-sig-row" style={{fontSize:8,color:C.t3}}><span>TIME</span><span>SPEC</span><span>DIR</span><span>REASON</span><span>RESULT</span></div>
                {(ledger||[]).filter(t=>t.closedAt).sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,6).map((t,i)=>{
                  const spec=(t.template||'').replace('ger40-bg-specialist','GER').replace('nas100-specialist','NAS').replace('gold-specialist-2','GS2').replace('gold-specialist','GS1');
                  const dir=(t.direction||'BUY').toUpperCase();
                  const pnl=t.finalPnL??0;
                  return (
                    <div key={i} className="qc-sig-row">
                      <span style={{color:C.t2}}>{fmtDate(t.closedAt)}</span>
                      <span style={{color:C.gold}}>{spec}</span>
                      <span style={{color:dir==='BUY'||dir==='LONG'?C.green2:C.red2}}>{dir}</span>
                      <span style={{color:C.t2}}>{t.symbol||'—'} entry</span>
                      <span style={{color:pnl>=0?C.green2:C.red2}}>{fmtMony(pnl)}</span>
                    </div>
                  );
                })}
                {!(ledger||[]).filter(t=>t.closedAt).length&&<div className="qc-sig-row" style={{color:C.t3,gridColumn:'1/-1',padding:'4px 0'}}>No signals closed yet — monitoring</div>}
              </div>
            </div>
          </div>
        </div>

        {/* ═══ RIGHT PANEL ═══ */}
        <div id="qc-right" className="qc-scroll">
          {SPECS.map(sp=>{
            const pos = activePosFor(positions, sp.key);
            const wr  = perf?.[sp.key]?.winRate ?? sp.wr;
            const pnlDay = todayPnLFor(ledger, sp.key);
            const mc  = sp.label==='GS1'?mcGs1:sp.label==='NAS'?mcNas:mcGer;
            return (
              <div key={sp.key} className="qc-spec-card">
                <div className="qc-sc-hdr">
                  <div>
                    <div className="qc-sc-name">{sp.label==='GS1'?'GOLD SPECIALIST 1':sp.label==='GS2'?'GOLD SPECIALIST 2':sp.label==='NAS'?'NAS100 SPECIALIST':'GER40 SPECIALIST'}</div>
                    <div className="qc-sc-sym">{sp.sym} · {sp.tf}</div>
                  </div>
                  <div className={`qc-sc-tog${specOn[sp.label.toLowerCase()]?' on':''}`} onClick={()=>togSpec(sp.label.toLowerCase())}/>
                </div>
                {(()=>{
                  const lv=perf?.[sp.key]; const hasLive=lv?.trades>0;
                  const dispWr=lv?.winRate!=null?lv.winRate.toFixed(1)+'%':sp.wr+'%*';
                  const dispPf=lv?.profitFactor!=null?lv.profitFactor.toFixed(2):sp.pf+'*';
                  const dispTr=hasLive?lv.trades:sp.trades+(hasLive?'':'/yr*');
                  const wrCol=lv?.winRate!=null?C.green2:C.t2;
                  const pfCol=lv?.profitFactor!=null?C.blue3:C.t2;
                  const trCol=hasLive?C.gold:C.t2;
                  return (
                    <div className="qc-sc-metrics">
                      <div className="qc-sc-m"><div className="qc-sc-mv" style={{color:wrCol}}>{dispWr}</div><div className="qc-sc-ml">WIN RATE</div></div>
                      <div className="qc-sc-m"><div className="qc-sc-mv" style={{color:pfCol}}>{dispPf}</div><div className="qc-sc-ml">PROF FAC</div></div>
                      <div className="qc-sc-m"><div className="qc-sc-mv" style={{color:trCol}}>{dispTr}</div><div className="qc-sc-ml">{hasLive?'TRADES':'TRADES/YR'}</div></div>
                    </div>
                  );
                })()}
                <div className="qc-sc-sess">
                  {sp.sessions.map(s=><span key={s} className={`qc-sc-s${(s.includes('LONDON')&&sessions.london)||(s.includes('NY')&&sessions.ny)||(s.includes('FRANKFURT')&&sessions.london)||(s.includes('ASIAN')&&sessions.asian)?' active':''}`}>{s}</span>)}
                  {sp.dayOnly&&<span className="qc-sc-s day">TUE+THU ONLY</span>}
                </div>
                {pos&&<div style={{fontSize:8,fontFamily:'JetBrains Mono,monospace',color:(pos.unrealizedProfit||0)>=0?C.green2:C.red2,marginBottom:3}}>↕ OPEN {fmtMony(pos.unrealizedProfit)}</div>}
                {pnlDay!==0&&<div style={{fontSize:8,fontFamily:'JetBrains Mono,monospace',color:pnlDay>0?C.green2:C.red2,marginBottom:3}}>Today {fmtMony(pnlDay)}</div>}
                <canvas ref={mc} height={28} style={{width:'100%',display:'block'}}/>
              </div>
            );
          })}

          {/* Correlation guard */}
          <div className="qc-corr-blk">
            <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:8,color:C.t3,letterSpacing:1,marginBottom:6,display:'flex',justifyContent:'space-between'}}>
              <span>CORRELATION GUARD</span>
              <span style={{color:openPos.length<=1?C.green2:openPos.length<=2?C.warn2:C.red2}}>{openPos.length<=1?'LOW':openPos.length<=2?'MODERATE':'HIGH'} RISK</span>
            </div>
            <canvas ref={corrRef} height={38} style={{width:'100%',display:'block'}}/>
            <div style={{marginTop:5,display:'grid',gridTemplateColumns:'1fr 1fr',gap:4,fontSize:8,color:C.t3}}>
              <span>XAU/NAS: <span className="qc-mono" style={{color:C.t2}}>—</span></span>
              <span>XAU/GER: <span className="qc-mono" style={{color:C.t2}}>—</span></span>
            </div>
          </div>

          {/* News */}
          <div className="qc-news-sec">
            <div className="qc-news-hdr">UPCOMING NEWS</div>
            {(upcomingNews||[]).filter(n=>['USD','EUR'].includes(n.currency)&&n.impact!=='low').slice(0,5).map((n,i)=>{
              const mAbs=Math.abs(n.minutesAway);
              const when=n.minutesAway<=0?`${mAbs}m ago`:mAbs<60?`in ${mAbs}m`:mAbs<1440?`in ${Math.round(mAbs/60)}h`:`in ${Math.round(mAbs/1440)}d`;
              return (
                <div key={i} className="qc-ne">
                  <div className={`qc-ne-impact ${n.impact}`}>{n.impact.toUpperCase()} · {n.currency}</div>
                  <div className="qc-ne-title">{n.event}</div>
                  <div className="qc-ne-meta"><span className="qc-mono">{new Date(n.time).toUTCString().slice(17,22)} UTC</span><span className="qc-ne-cd">{when}</span></div>
                </div>
              );
            })}
            {!(upcomingNews||[]).filter(n=>['USD','EUR'].includes(n.currency)&&n.impact!=='low').length&&(
              <div style={{fontSize:9,color:C.t3,fontFamily:'Inter,sans-serif',padding:'4px 0'}}>No high-impact news next 24h</div>
            )}
          </div>
        </div>
      </div>

      {/* CONTROLS */}
      <div id="qc-controls">
        <div className="qc-ctl-grp">
          <span className="qc-ctl-lbl">SPECIALISTS</span>
          {['GS1','NAS','GER'].map(k=>(
            <button key={k} className={`qc-btn${specOn[k.toLowerCase()]?' on-g':''}`} onClick={()=>togSpec(k.toLowerCase())}>{k}</button>
          ))}
        </div>
        <div className="qc-sep"/>
        <div className="qc-ctl-grp">
          <span className="qc-ctl-lbl">PANELS</span>
          <button className="qc-btn on" onClick={()=>{const e=document.getElementById('qc-left');e.style.display=e.style.display==='none'?'':'none';}}>LEFT</button>
          <button className="qc-btn on" onClick={()=>{const e=document.getElementById('qc-right');e.style.display=e.style.display==='none'?'':'none';}}>RIGHT</button>
        </div>
        <div className="qc-sep"/>
        <div className="qc-ctl-grp">
          <span className="qc-ctl-lbl">VIEW</span>
          {[['telemetry','TELEMETRY'],['performance','PERF'],['jarvis','JARVIS'],['specialists','SPECS'],['nexus','NEXUS']].map(([k,lbl])=>(
            <button key={k} className={`qc-btn${activeView===k?' on':''}`} onClick={()=>switchView(k)}>{lbl}</button>
          ))}
        </div>
        <div className="qc-sep"/>
        <div className="qc-ctl-grp">
          <span className="qc-ctl-lbl">FILTERS</span>
          <button className="qc-btn on">NEWS FILTER</button>
          <button className="qc-btn on">FTMO GUARD</button>
          <button className="qc-btn on">CORR GUARD</button>
        </div>
        <div className="qc-sep"/>
        <div className="qc-ctl-grp">
          <button className="qc-btn danger" onClick={()=>confirm('Reset JARVIS session state?')}>RESET JARVIS</button>
        </div>
      </div>
    </div>
  );
}
