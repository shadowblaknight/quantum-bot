/* eslint-disable */
// JARVIS · Quantum Bot v17 — Full HUD Dashboard
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import "./index.css";

const API = p => `/api/${p}`;

const TPLS_META = {
  'orb-pro':       { glyph:'⊕', label:'ORB-PRO',    alexG:false },
  'silver-bullet': { glyph:'🎯', label:'SILVER-BLT', alexG:false },
  'alexg':         { glyph:'🤖', label:'ALEX-G',     alexG:true  },
  'reaction-fvg':  { glyph:'⚡', label:'REACT-FVG',  alexG:false },
  'reaction':      { glyph:'⚡', label:'REACT-IMP',  alexG:false },
  'reaction-ifvg': { glyph:'◈', label:'REACT-IFVG', alexG:false },
  'am-ifvg':       { glyph:'◈', label:'AM-IFVG',    alexG:false },
  'orb':           { glyph:'○', label:'ORB',         alexG:false },
};

const SESSION_LABELS = {
  london:'LONDON', london_open:'LONDON', new_york:'NY AM',
  ny_am:'NY AM', ny_pm:'NY PM', asian:'ASIA', sydney:'SYDNEY', unknown:'—',
};

const UTC_SESSIONS = [
  { id:'ASIA',  s:0,  e:8,  wr:45, col:'rgba(90,130,220,' },
  { id:'LON',   s:7,  e:12, wr:62, col:'rgba(0,180,255,'  },
  { id:'NY AM', s:13, e:18, wr:75, col:'rgba(0,255,157,'  },
  { id:'NY PM', s:18, e:22, wr:52, col:'rgba(245,158,11,' },
];

const fmtMoney  = (n,d=0)  => typeof n==='number'&&isFinite(n) ? (n>=0?'+':'')+n.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g,',') : '—';
const fmtMoneyAbs=(n,d=0)  => typeof n==='number'&&isFinite(n) ? '$'+Math.abs(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g,',') : '—';
const fmtR      = n         => typeof n==='number'&&isFinite(n) ? (n>=0?'+':'')+n.toFixed(1)+'R' : '—';
const pct       = (n,d=0)  => typeof n==='number'&&isFinite(n) ? (n*100).toFixed(d)+'%' : '—';
const fmtTime   = ts        => ts ? new Date(ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false}) : '—';
const fmtRelTime= ts        => { if(!ts)return''; const d=(Date.now()-ts)/1000; if(d<60)return`${Math.round(d)}s ago`; if(d<3600)return`${Math.round(d/60)}m ago`; return`${Math.round(d/3600)}h ago`; };
const tplLabel  = id        => TPLS_META[id]?.label || id?.toUpperCase() || '?';
const tplGlyph  = id        => TPLS_META[id]?.glyph || '⊕';
const sessLabel = s         => SESSION_LABELS[s?.toLowerCase()] || s?.toUpperCase() || '—';

function computeNexus(trades) {
  if(!trades||trades.length<10) return null;
  const isWin=t=>t.outcome==='WIN';
  const rOf=t=>(typeof t.pnlR==='number'&&isFinite(t.pnlR))?t.pnlR:null;
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const total=trades.length;
  const overallWR=trades.filter(isWin).length/total;
  const overallAvgR=avg(trades.map(rOf).filter(v=>v!==null));
  const byTpl={};
  for(const t of trades){const k=t.template||'unknown';if(!byTpl[k])byTpl[k]={w:0,l:0,r:[]};if(isWin(t))byTpl[k].w++;else byTpl[k].l++;const r=rOf(t);if(r!==null)byTpl[k].r.push(r);}
  const tplStats=Object.entries(byTpl).map(([id,s])=>({id,total:s.w+s.l,wins:s.w,wr:s.w+s.l?s.w/(s.w+s.l):0,avgR:avg(s.r)})).filter(s=>s.total>=4).sort((a,b)=>b.wr-a.wr);
  const bySess={};
  for(const t of trades){const k=t.session||'unknown';if(!bySess[k])bySess[k]={w:0,total:0,r:[]};bySess[k].total++;if(isWin(t))bySess[k].w++;const r=rOf(t);if(r!==null)bySess[k].r.push(r);}
  const sessStats=Object.entries(bySess).map(([id,s])=>({id,total:s.total,wins:s.w,wr:s.total?s.w/s.total:0,avgR:avg(s.r)})).filter(s=>s.total>=4).sort((a,b)=>b.wr-a.wr);
  const bestTpl=tplStats[0]||null, bestSess=sessStats[0]||null;
  const nexus=trades.filter(t=>(!bestTpl||t.template===bestTpl.id)&&(!bestSess||t.session===bestSess.id)&&!t.highImpactWithin60min);
  const nexusWR=nexus.length?nexus.filter(isWin).length/nexus.length:0;
  const nexusAvgR=avg(nexus.map(rOf).filter(v=>v!==null));
  return{total,overallWR,overallAvgR,tplStats,sessStats,bestTpl,bestSess,nexusSample:nexus.length,nexusWR,nexusAvgR,confidence:nexus.length>=25?'HIGH':nexus.length>=12?'MEDIUM':'LOW'};
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

function EKGCanvas() {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height;
    let pts=[],t=0,raf;
    const s=t=>{const b=.05*Math.sin(t*.3),p=t%60;if(p>25&&p<30)return b+1.5*Math.sin((p-25)/5*Math.PI);if(p>30&&p<33)return b-.5*Math.sin((p-30)/3*Math.PI);return b;};
    const draw=()=>{x.clearRect(0,0,W,H);t+=.8;pts.push(s(t));if(pts.length>W)pts.shift();x.strokeStyle='rgba(0,229,255,.85)';x.lineWidth=1.5;x.shadowColor='rgba(0,229,255,.5)';x.shadowBlur=4;x.beginPath();pts.forEach((v,i)=>{const py=H/2-v*(H*.35);i===0?x.moveTo(i,py):x.lineTo(i,py);});x.stroke();x.shadowBlur=0;raf=requestAnimationFrame(draw);};
    draw(); return()=>cancelAnimationFrame(raf);
  },[]);
  return <canvas ref={ref} width={100} height={28}/>;
}

function GateRingCanvas({pass,total}) {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height,cx=W/2,cy=H/2,R=W/2-3;
    let t=0,raf;
    const draw=()=>{
      x.clearRect(0,0,W,H);
      x.strokeStyle='rgba(0,229,255,.08)';x.lineWidth=5;x.lineCap='butt';x.beginPath();x.arc(cx,cy,R,0,Math.PI*2);x.stroke();
      const frac=total>0?pass/total:0;
      const g=x.createLinearGradient(0,0,W,H);g.addColorStop(0,'rgba(0,229,255,.9)');g.addColorStop(1,'rgba(0,255,157,.9)');
      x.strokeStyle=g;x.lineWidth=5;x.lineCap='round';x.shadowColor='rgba(0,255,157,.5)';x.shadowBlur=6;
      if(frac>0){x.beginPath();x.arc(cx,cy,R,-Math.PI/2,frac*Math.PI*2-Math.PI/2);x.stroke();}
      if(pass<total){x.strokeStyle='rgba(245,158,11,.5)';x.lineWidth=5;x.shadowBlur=0;const ea=frac*Math.PI*2-Math.PI/2;x.beginPath();x.arc(cx,cy,R,ea,ea+.35);x.stroke();}
      const p=.6+.4*Math.abs(Math.sin(t));x.fillStyle=`rgba(0,255,157,${p})`;x.shadowColor='rgba(0,255,157,.7)';x.shadowBlur=6;x.beginPath();x.arc(cx,cy,3,0,Math.PI*2);x.fill();x.shadowBlur=0;
      t+=.05;raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[pass,total]);
  return <canvas ref={ref} width={36} height={36} style={{flexShrink:0}}/>;
}

function KillZoneRadar({trades}) {
  const ref=useRef(null);
  const wrMap=useMemo(()=>{
    const m={};
    for(const sess of UTC_SESSIONS){
      const id=sess.id;
      const st=(trades||[]).filter(t=>{const s=(t.session||'').toLowerCase();return(id==='ASIA'&&(s==='asian'||s==='sydney'))||(id==='LON'&&(s==='london'||s==='london_open'))||(id==='NY AM'&&(s==='ny_am'||s==='new_york'))||(id==='NY PM'&&s==='ny_pm');});
      const wins=st.filter(t=>t.outcome==='WIN').length;
      m[id]=st.length?Math.round(wins/st.length*100):sess.wr;
    }
    return m;
  },[trades]);

  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height,cx=W/2,cy=H/2+4,R=Math.min(W,H)/2-10;
    const sessions=UTC_SESSIONS.map(s=>({...s,wr:wrMap[s.id]||s.wr}));
    let t=0,raf;
    const getUTCH=()=>{const n=new Date(),u=n.getTime()+n.getTimezoneOffset()*60000;return((u%86400000)/86400000)*24;};
    const draw=()=>{
      x.clearRect(0,0,W,H);
      const bg=x.createRadialGradient(cx,cy,0,cx,cy,R);bg.addColorStop(0,'rgba(0,10,30,.7)');bg.addColorStop(1,'rgba(0,5,18,.95)');
      x.fillStyle=bg;x.beginPath();x.arc(cx,cy,R+6,0,Math.PI*2);x.fill();
      x.strokeStyle='rgba(0,229,255,.1)';x.lineWidth=1;x.beginPath();x.arc(cx,cy,R+5,0,Math.PI*2);x.stroke();
      for(let h=0;h<24;h++){const a=(h/24)*Math.PI*2-Math.PI/2,r1=R*.92,r2=R*(h%6===0?.74:.84);x.strokeStyle=h%6===0?'rgba(0,229,255,.35)':'rgba(0,229,255,.12)';x.lineWidth=h%6===0?1.2:.5;x.beginPath();x.moveTo(cx+r1*Math.cos(a),cy+r1*Math.sin(a));x.lineTo(cx+r2*Math.cos(a),cy+r2*Math.sin(a));x.stroke();if(h%6===0){const lr=R*.62;x.fillStyle='rgba(0,229,255,.5)';x.font='7px monospace';x.textAlign='center';x.textBaseline='middle';x.fillText(String(h).padStart(2,'0')+'h',cx+lr*Math.cos(a),cy+lr*Math.sin(a));}}
      const utcH=getUTCH();
      sessions.forEach(s=>{
        const isA=utcH>=s.s&&utcH<s.e,a1=(s.s/24)*Math.PI*2-Math.PI/2,a2=(s.e/24)*Math.PI*2-Math.PI/2;
        const alpha=(isA?(0.6+0.2*Math.abs(Math.sin(t*.04))):0.3)+s.wr/100*.25;
        const rr=R*(isA?.85:.82),lw=isA?9:6;
        x.strokeStyle=`${s.col}${Math.min(alpha,1)})`;x.lineWidth=lw;x.lineCap='round';
        if(isA){x.shadowColor=`${s.col}.6)`;x.shadowBlur=10;}
        x.beginPath();x.arc(cx,cy,rr,a1,a2);x.stroke();x.shadowBlur=0;
        const am=(a1+a2)/2,lr=R*(isA?.85:.82);
        x.fillStyle=`${s.col}${isA?.9:.55})`;x.font=`${isA?7.5:6.5}px monospace`;x.textAlign='center';x.textBaseline='middle';
        x.fillText(s.id,cx+lr*Math.cos(am),cy+lr*Math.sin(am));
      });
      const ha=(utcH/24)*Math.PI*2-Math.PI/2;
      x.strokeStyle='rgba(0,229,255,.95)';x.lineWidth=2;x.lineCap='round';x.shadowColor='rgba(0,229,255,.7)';x.shadowBlur=8;
      x.beginPath();x.moveTo(cx,cy);x.lineTo(cx+R*.7*Math.cos(ha),cy+R*.7*Math.sin(ha));x.stroke();x.shadowBlur=0;
      x.fillStyle='rgba(0,229,255,.9)';x.shadowColor='rgba(0,229,255,.8)';x.shadowBlur=6;x.beginPath();x.arc(cx,cy,3,0,Math.PI*2);x.fill();x.shadowBlur=0;
      t++;raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[wrMap]);

  const kzWRs=UTC_SESSIONS.map(s=>({id:s.id,wr:wrMap[s.id]||s.wr,col:s.col}));
  return (
    <>
      <canvas ref={ref} width={234} height={142} style={{display:'block',margin:'0 auto'}}/>
      <div style={{display:'flex',justifyContent:'space-around',padding:'3px 8px 5px',borderTop:'1px solid var(--b2)'}}>
        {kzWRs.map(s=>(
          <div key={s.id} style={{textAlign:'center'}}>
            <div style={{fontSize:'6.5px',color:`${s.col}.65)`}}>{s.id}</div>
            <div style={{fontFamily:'var(--mono)',fontSize:9,color:`${s.col}.9)`}}>{s.wr}%</div>
          </div>
        ))}
      </div>
    </>
  );
}

function SignalFunnel({jarvisState}) {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height;
    const kzPct=jarvisState?.killZone?.inKillZone?78:45;
    const layers=[
      {label:'Raw Signals',n:100,pct:100,col:'rgba(0,229,255,'},
      {label:'Kill Zone',n:Math.round(kzPct),pct:kzPct,col:'rgba(0,229,255,'},
      {label:'D1 EMA + CVD',n:58,pct:58,col:'rgba(0,210,200,'},
      {label:'All Gates',n:38,pct:38,col:'rgba(0,255,157,'},
      {label:'→ Trades',n:27,pct:27,col:'rgba(0,255,157,'},
      {label:'✓ Wins',n:20,pct:20,col:'rgba(0,255,120,'},
    ];
    const lH=(H-10)/layers.length,maxW=W-32,minW=maxW*.18;
    x.clearRect(0,0,W,H);
    layers.forEach((l,i)=>{
      const w=minW+(maxW-minW)*(l.pct/100),topX=(W-w)/2,y=5+i*lH;
      const nw=i<layers.length-1?minW+(maxW-minW)*(layers[i+1].pct/100):w*.7,nx=(W-nw)/2;
      x.fillStyle=`${l.col}${.12+i*.02})`;x.strokeStyle=`${l.col}${.5+i*.05})`;x.lineWidth=1;
      x.beginPath();x.moveTo(topX,y);x.lineTo(topX+w,y);x.lineTo(nx+nw,y+lH-1);x.lineTo(nx,y+lH-1);x.closePath();x.fill();x.stroke();
      x.fillStyle=`${l.col}.85)`;x.font='8px monospace';x.textAlign='left';x.textBaseline='middle';x.fillText(l.label,4,y+lH/2);
      x.textAlign='right';x.fillStyle=`${l.col}.9)`;x.fillText(`${l.n} (${l.pct}%)`,W-4,y+lH/2);
    });
  },[jarvisState]);
  return <canvas ref={ref} width={234} height={118} style={{display:'block',margin:'0 auto'}}/>;
}

function OrbCanvas({state}) {
  const containerRef=useRef(null),canvasRef=useRef(null),rafRef=useRef(null);
  useEffect(()=>{
    const container=containerRef.current,c=canvasRef.current; if(!c||!container) return;
    const resize=()=>{const Wc=container.offsetWidth,Hc=Math.min(Math.max(Wc*.45,140),220);c.width=Wc;c.height=Hc;};
    resize(); window.addEventListener('resize',resize);
    const ctx=c.getContext('2d');
    const nodes=Array.from({length:18},()=>({x:Math.random(),y:Math.random(),vx:(Math.random()-.5)*.003,vy:(Math.random()-.5)*.003,r:1+Math.random()*1.5}));
    let t=0;
    const col=state==='signal'?'0,255,157':state==='warn'?'245,158,11':state==='critical'?'255,45,85':'0,229,255';
    const draw=()=>{
      const W=c.width,H=c.height,cx=W/2,cy=H/2;
      ctx.clearRect(0,0,W,H);
      const bg=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.min(W,H)*.5);
      bg.addColorStop(0,`rgba(${col},.06)`);bg.addColorStop(.6,'rgba(0,10,28,.3)');bg.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
      const R=Math.min(W,H)*.42;
      [{r:R*.9,spd:.005,gap:.18,c:`rgba(${col},.7)`,w:1.5},{r:R*.65,spd:-.008,gap:.25,c:`rgba(${col},.65)`,w:1.5},{r:R*.42,spd:.013,gap:.32,c:'rgba(167,139,250,.6)',w:1}].forEach(ring=>{
        const rot=t*ring.spd*60;ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);ctx.strokeStyle=ring.c;ctx.lineWidth=ring.w;ctx.lineCap='round';ctx.shadowColor=ring.c;ctx.shadowBlur=8;ctx.beginPath();ctx.arc(0,0,ring.r,ring.gap/2,Math.PI*2-ring.gap/2);ctx.stroke();ctx.restore();
      });
      ctx.shadowBlur=0;
      nodes.forEach(n=>{n.x+=n.vx;n.y+=n.vy;if(n.x<.05||n.x>.95)n.vx*=-1;if(n.y<.05||n.y>.95)n.vy*=-1;});
      nodes.forEach((a,i)=>nodes.forEach((b,j)=>{if(j<=i)return;const dx=(a.x-b.x)*W,dy=(a.y-b.y)*H,d=Math.sqrt(dx*dx+dy*dy);if(d<R*.7){ctx.strokeStyle=`rgba(${col},${.25*(1-d/(R*.7))})`;ctx.lineWidth=.4;ctx.beginPath();ctx.moveTo(a.x*W,a.y*H);ctx.lineTo(b.x*W,b.y*H);ctx.stroke();}}));
      nodes.forEach(n=>{ctx.fillStyle=`rgba(${col},.7)`;ctx.beginPath();ctx.arc(n.x*W,n.y*H,n.r,0,Math.PI*2);ctx.fill();});
      const cr=R*.15,sphG=ctx.createRadialGradient(cx-cr*.3,cy-cr*.3,0,cx,cy,cr);
      sphG.addColorStop(0,'rgba(180,255,255,.95)');sphG.addColorStop(.4,`rgba(${col},.7)`);sphG.addColorStop(.8,'rgba(0,50,120,.5)');sphG.addColorStop(1,'rgba(0,20,48,.8)');
      ctx.shadowColor=`rgba(${col},.8)`;ctx.shadowBlur=20;ctx.fillStyle=sphG;ctx.beginPath();ctx.arc(cx,cy,cr,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      for(let i=0;i<6;i++){const a=(i/6)*Math.PI*2+t*.008;ctx.strokeStyle=`rgba(${col},.2)`;ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+cr*Math.cos(a),cy+cr*Math.sin(a));ctx.stroke();}
      t++;rafRef.current=requestAnimationFrame(draw);
    };
    draw();
    return()=>{window.removeEventListener('resize',resize);cancelAnimationFrame(rafRef.current);};
  },[state]);
  return <div ref={containerRef} style={{width:'100%'}}><canvas ref={canvasRef} style={{display:'block',position:'relative',zIndex:1}}/></div>;
}

function EquitySparkline({trades}) {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height;
    x.clearRect(0,0,W,H);
    const sorted=(trades||[]).slice().sort((a,b)=>(a.closedAt||0)-(b.closedAt||0)).slice(-30);
    if(sorted.length<2) return;
    let running=0;
    const data=[0,...sorted.map(t=>{running+=(t.pnl||0);return running;})];
    const mn=Math.min(...data),mx=Math.max(...data)||100;
    const range=mx-mn||100;
    const pt=(v,i)=>({x:i/(data.length-1)*W,y:H-(v-mn)/range*H*.88-H*.06});
    const pts=data.map(pt);
    const isPos=data[data.length-1]>=0;
    const g=x.createLinearGradient(0,0,0,H);
    g.addColorStop(0,isPos?'rgba(0,229,255,.22)':'rgba(255,45,85,.15)');
    g.addColorStop(1,isPos?'rgba(0,229,255,0)':'rgba(255,45,85,0)');
    x.beginPath();pts.forEach((p,i)=>i===0?x.moveTo(p.x,p.y):x.lineTo(p.x,p.y));x.lineTo(W,H);x.lineTo(0,H);x.closePath();x.fillStyle=g;x.fill();
    x.beginPath();pts.forEach((p,i)=>i===0?x.moveTo(p.x,p.y):x.lineTo(p.x,p.y));x.strokeStyle=isPos?'rgba(0,229,255,.75)':'rgba(255,45,85,.75)';x.lineWidth=1.5;x.stroke();
    const last=pts[pts.length-1];x.fillStyle=isPos?'#00e5ff':'#ff2d55';x.beginPath();x.arc(last.x,last.y,2.5,0,Math.PI*2);x.fill();
  },[trades]);
  return <canvas ref={ref} width={234} height={55} style={{display:'block',width:'100%'}}/>;
}

function MomentumCompass({jarvisState}) {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height,cx=W/2,cy=H/2+5,R=Math.min(W,H)/2-14;
    const ins=[
      {sym:'XAUUSD',dir:'long',conv:.75,col:'rgba(0,255,157,'},
      {sym:'US500', dir:'long',conv:.88,col:'rgba(0,255,157,'},
      {sym:'NAS100',dir:'long',conv:.72,col:'rgba(0,255,157,'},
      {sym:'GER40', dir:'neut',conv:.30,col:'rgba(120,170,210,'},
      {sym:'GBPUSD',dir:'short',conv:.55,col:'rgba(255,45,85,'},
      {sym:'EURUSD',dir:'neut',conv:.35,col:'rgba(120,170,210,'},
    ];
    let t=0,raf;
    const draw=()=>{
      x.clearRect(0,0,W,H);
      const bg=x.createRadialGradient(cx,cy,0,cx,cy,R);bg.addColorStop(0,'rgba(0,15,35,.6)');bg.addColorStop(1,'rgba(0,5,18,.9)');
      x.fillStyle=bg;x.beginPath();x.arc(cx,cy,R+10,0,Math.PI*2);x.fill();
      [.25,.5,.75,1].forEach(r=>{x.strokeStyle=`rgba(0,229,255,${r===1?.12:.05})`;x.lineWidth=.5;x.beginPath();x.arc(cx,cy,R*r,0,Math.PI*2);x.stroke();});
      x.strokeStyle='rgba(0,229,255,.08)';x.lineWidth=.5;
      [0,1,2,3].forEach(i=>{const a=i*Math.PI/2;x.beginPath();x.moveTo(cx,cy);x.lineTo(cx+R*Math.cos(a),cy+R*Math.sin(a));x.stroke();});
      ins.forEach((ins,i)=>{
        const bA=(i/6)*Math.PI*2-Math.PI/2;
        const pulse=ins.dir==='neut'?1:.96+.04*Math.sin(t*.06+i);
        const len=R*ins.conv*pulse,ex=cx+len*Math.cos(bA),ey=cy+len*Math.sin(bA);
        const alpha=.7+.2*Math.abs(Math.sin(t*.05+i));
        x.strokeStyle=`${ins.col}${alpha})`;x.lineWidth=ins.dir==='neut'?1.5:2.5;x.lineCap='round';
        if(ins.dir!=='neut'){x.shadowColor=`${ins.col}.5)`;x.shadowBlur=8;}
        x.beginPath();x.moveTo(cx,cy);x.lineTo(ex,ey);x.stroke();x.shadowBlur=0;
        if(ins.dir!=='neut'){const aw=5,aa=.5;x.fillStyle=`${ins.col}${alpha})`;x.beginPath();x.moveTo(ex,ey);x.lineTo(ex-aw*Math.cos(bA-aa),ey-aw*Math.sin(bA-aa));x.lineTo(ex-aw*Math.cos(bA+aa),ey-aw*Math.sin(bA+aa));x.closePath();x.fill();}
        const lr=R*ins.conv*pulse+14;x.fillStyle=`${ins.col}.8)`;x.font='7.5px monospace';x.textAlign='center';x.textBaseline='middle';x.fillText(ins.sym,cx+lr*Math.cos(bA),cy+lr*Math.sin(bA));
      });
      x.fillStyle='rgba(0,229,255,.9)';x.shadowColor='rgba(0,229,255,.7)';x.shadowBlur=8;x.beginPath();x.arc(cx,cy,3.5,0,Math.PI*2);x.fill();x.shadowBlur=0;
      t++;raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[]);
  return <canvas ref={ref} width={234} height={150} style={{display:'block',margin:'0 auto'}}/>;
}

function ADRBurnCurve({jarvisState}) {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current; if(!c) return;
    const x=c.getContext('2d'),W=c.width,H=c.height;
    const MINS=480;
    const rng=seed=>{let s=seed;return()=>{s=(s*1664525+1013904223)&0xffffffff;return(s>>>0)/4294967295;};};
    const r=rng(42);
    const avgLine=Array.from({length:MINS},(_,i)=>Math.min(100,20+i*(75/MINS)+Math.sin(i*.08)*3));
    const todayLine=Array.from({length:MINS},(_,i)=>Math.min(100,22+i*(85/MINS)+r()*8-4+Math.sin(i*.06)*4));
    const adrPct=jarvisState?.adr?.percentConsumed||68;
    const currentMin=Math.max(1,Math.min(MINS-1,Math.floor(MINS*(adrPct/100))));
    const px=i=>(i/(MINS-1))*W,py=v=>H-3-(v/100)*(H-8);
    x.clearRect(0,0,W,H);
    x.beginPath();
    for(let i=0;i<MINS;i++) i===0?x.moveTo(px(i),py(avgLine[i]+12)):x.lineTo(px(i),py(avgLine[i]+12));
    for(let i=MINS-1;i>=0;i--) x.lineTo(px(i),py(avgLine[i]-12));
    x.closePath();x.fillStyle='rgba(0,229,255,.06)';x.fill();
    x.beginPath();avgLine.forEach((v,i)=>i===0?x.moveTo(px(i),py(v)):x.lineTo(px(i),py(v)));
    x.strokeStyle='rgba(0,229,255,.25)';x.lineWidth=1;x.setLineDash([3,3]);x.stroke();x.setLineDash([]);
    const g=x.createLinearGradient(0,0,px(currentMin),0);g.addColorStop(0,'rgba(0,229,255,.6)');g.addColorStop(.7,'rgba(245,158,11,.8)');g.addColorStop(1,'rgba(245,158,11,.9)');
    x.beginPath();todayLine.slice(0,currentMin).forEach((v,i)=>i===0?x.moveTo(px(i),py(v)):x.lineTo(px(i),py(v)));
    x.strokeStyle=g;x.lineWidth=2;x.stroke();
    const cv=todayLine[currentMin-1];
    x.fillStyle='rgba(245,158,11,1)';x.shadowColor='rgba(245,158,11,.7)';x.shadowBlur=8;x.beginPath();x.arc(px(currentMin-1),py(cv),3.5,0,Math.PI*2);x.fill();x.shadowBlur=0;
  },[jarvisState]);
  const adrPct=jarvisState?.adr?.percentConsumed||68;
  return (
    <>
      <canvas ref={ref} width={234} height={64} style={{display:'block',width:'100%'}}/>
      <div style={{display:'flex',justifyContent:'space-between',padding:'2px 9px 5px',fontFamily:'var(--mono)',fontSize:7,color:'var(--dim)'}}>
        <span>Today <span style={{color:'var(--amb)'}}>{Math.round(adrPct)}%</span></span>
        <span>Avg band <span style={{color:'var(--ion)'}}>55%±12</span></span>
        <span style={{color:adrPct>65?'var(--pulse)':'var(--ion)'}}>{adrPct>65?'↑ Fast day':'→ Normal'}</span>
      </div>
    </>
  );
}

// ─── Panel components ─────────────────────────────────────────────────────────

function NYSpecialist({jarvisState}) {
  const [nyTime,setNyTime]=useState('--:--:--');
  const [session,setSession]=useState(null);
  const [prog,setProg]=useState(0);
  const [minsIn,setMinsIn]=useState(0);
  const [minsLeft,setMinsLeft]=useState(0);
  useEffect(()=>{
    const tick=()=>{
      const d=new Date(),ny=new Date(d.toLocaleString('en-US',{timeZone:'America/New_York'}));
      setNyTime(ny.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}));
      const utcH=d.getUTCHours()+d.getUTCMinutes()/60;
      const sess=UTC_SESSIONS.find(s=>utcH>=s.s&&utcH<s.e)||null;
      setSession(sess);
      if(sess){const el=utcH-sess.s,tot=sess.e-sess.s;setProg(el/tot*100);setMinsIn(Math.round(el*60));setMinsLeft(Math.round((tot-el)*60));}
      else{setProg(0);setMinsIn(0);setMinsLeft(0);}
    };
    tick();const id=setInterval(tick,1000);return()=>clearInterval(id);
  },[]);
  const kz=jarvisState?.killZone;
  const stage=prog<30?'EARLY':prog<70?'MID':'LATE';
  const activeTpls=jarvisState?.activeTemplates||Object.keys(TPLS_META).slice(0,4);
  return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">NY Specialist</span><span className="tag live">{session?.id||kz?.label||'OFF-SESSION'}</span></div>
      <div style={{textAlign:'center',padding:'5px 0 2px'}}>
        <div style={{fontFamily:'var(--mono)',fontSize:28,fontWeight:200,color:'var(--ion)',letterSpacing:3}}>{nyTime}</div>
        <div style={{fontSize:'6.5px',color:'var(--dim)',marginTop:1,letterSpacing:'.06em'}}>NEW YORK · ET</div>
      </div>
      <div style={{padding:'3px 9px 2px'}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
          <span style={{fontSize:'6.5px',color:'var(--dim)'}}>SESSION PROGRESS</span>
          <span style={{fontSize:7,color:'var(--pulse)',fontFamily:'var(--mono)',fontWeight:600}}>{stage}</span>
        </div>
        <div style={{height:4,background:'var(--b2)',borderRadius:3,overflow:'hidden',border:'1px solid rgba(0,229,255,.1)'}}>
          <div style={{height:'100%',background:'linear-gradient(90deg,var(--ion),var(--pulse))',borderRadius:3,width:`${prog}%`,transition:'width 1s linear'}}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:2}}>
          <span style={{fontSize:6,color:'var(--dim)'}}>{session?`${minsIn}m in`:'—'}</span>
          <span style={{fontSize:6,color:'var(--dim)'}}>{session?`${minsLeft}m left`:'—'}</span>
        </div>
      </div>
      <div style={{display:'flex',gap:4,padding:'3px 9px 4px'}}>
        <div className="nyStatBlock"><div className="nyStatV" style={{color:'var(--pulse)'}}>{session?session.wr+'%':'—'}</div><div className="nyStatL">NY WR</div></div>
        <div className="nyStatBlock"><div className="nyStatV" style={{color:'var(--amb)'}}>{jarvisState?.regime?.type==='trending'?'HIGH':'MED'}</div><div className="nyStatL">VOLUME</div></div>
        <div className="nyStatBlock"><div className="nyStatV" style={{color:'var(--ion)'}}>{jarvisState?.sigQual?.knnAvgR?fmtR(jarvisState.sigQual.knnAvgR):'2.1R'}</div><div className="nyStatL">AVG R</div></div>
      </div>
      <div style={{padding:'2px 9px 4px'}}>
        <div style={{fontSize:'6.5px',color:'var(--dim)',marginBottom:3,letterSpacing:'.04em'}}>ACTIVE · {session?.id||'—'}</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:3}}>
          {(Array.isArray(activeTpls)?activeTpls:[]).slice(0,5).map((t,i)=>(
            <span key={i} className={`nyChip ${i===2?'pulse':''}`}>{typeof t==='string'?tplLabel(t):t}</span>
          ))}
        </div>
      </div>
      <div style={{margin:'3px 9px 2px',borderTop:'1px solid var(--b2)',paddingTop:5}}>
        <div style={{fontSize:'6.5px',color:'var(--dim)',letterSpacing:'.06em',marginBottom:4}}>SESSION CONTEXT</div>
        <div style={{display:'flex',flexDirection:'column',gap:0}}>
          <div className="scRow"><span style={{fontSize:'7.5px',color:'var(--dim)'}}>Stage</span><span style={{fontFamily:'var(--mono)',fontSize:'7.5px',color:'var(--pulse)'}}>{stage} · {jarvisState?.regime?.type||'monitoring'}</span></div>
          <div className="scRow"><span style={{fontSize:'7.5px',color:'var(--dim)'}}>Volatility</span><span style={{fontFamily:'var(--mono)',fontSize:'7.5px',color:'var(--amb)'}}>{jarvisState?.regime?.type==='trending'?'HIGH · trending day':'NORMAL'}</span></div>
          <div className="scRow"><span style={{fontSize:'7.5px',color:'var(--dim)'}}>Kill Zone</span><span style={{fontFamily:'var(--mono)',fontSize:'7.5px',color:kz?.inKillZone?'var(--pulse)':'var(--dim)'}}>{kz?.inKillZone?kz.label+' ACTIVE':'INACTIVE'}</span></div>
        </div>
      </div>
    </div>
  );
}

function SignalPanel({jarvisState}) {
  const watchers=jarvisState?.watchers||{};
  const active=Object.entries(watchers).filter(([,w])=>w?.currentSetup||w?.direction);
  const [asset,w]=active[0]||[];
  if(!w) return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Live Signal</span></div>
      <div className="sigBig"><div className="sigDir" style={{color:'var(--dim)',fontFamily:'var(--mono)',fontSize:20,fontWeight:200}}>SCANNING<span className="sigSym">—</span></div><div className="sigSub">No active setups</div></div>
      <div className="knnWrap"><div className="knnLbl"><span>KNN Confidence</span><span style={{color:'var(--dim)'}}>—</span></div><div className="knnFill"><div className="knnFillI" style={{width:'0%'}}/></div></div>
    </div>
  );
  const dir=(w.direction||'long').toLowerCase();
  const template=w.currentSetup?.template||w.template||'—';
  const knnWR=w.knnWR||jarvisState?.sigQual?.knnWinRate||0;
  return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Live Signal</span><span className="tag live">ACTIVE</span></div>
      <div className="sigBig">
        <div className={`sigDir ${dir}`}>{dir==='long'?'LONG':'SHORT'}<span className="sigSym">{(asset||'').toUpperCase()}</span></div>
        <div className="sigSub">{tplLabel(template)} · {sessLabel(jarvisState?.killZone?.label)}</div>
      </div>
      <div className="sigGrid">
        <div className="sMeta"><div className="sMetaV" style={{color:'var(--pulse)'}}>{knnWR?pct(knnWR,0):'—'}</div><div className="sMetaL">KNN Match</div></div>
        <div className="sMeta"><div className="sMetaV">{w.target||'—'}</div><div className="sMetaL">Target</div></div>
        <div className="sMeta"><div className="sMetaV">{w.stop||'—'}</div><div className="sMetaL">Stop</div></div>
        <div className="sMeta"><div className="sMetaV" style={{color:'var(--pulse)'}}>{jarvisState?.sigQual?.knnAvgR?fmtR(jarvisState.sigQual.knnAvgR):'—'}</div><div className="sMetaL">Risk/Rew</div></div>
      </div>
      <div className="knnWrap">
        <div className="knnLbl"><span>KNN Confidence</span><span style={{color:'var(--pulse)'}}>{pct(knnWR,0)}</span></div>
        <div className="knnFill"><div className="knnFillI" style={{width:`${knnWR*100}%`}}/></div>
      </div>
    </div>
  );
}

function GatesPanel({jarvisState,rules}) {
  const kz=jarvisState?.killZone||{};
  const cb=jarvisState?.circuitBreakers||{};
  const gr=jarvisState?.gatingRules||{};
  const adr=jarvisState?.adr||{};
  const cvd=jarvisState?.cvd||{};
  const nb=jarvisState?.newsBlock||{};
  const regime=jarvisState?.regime||{};
  const gates=[
    {i:'🎯',n:'Kill Zone',   d:'Session window',  v:kz.inKillZone?(kz.label||'ACTIVE'):(kz.minutesUntilNext?`in ${kz.minutesUntilNext}m`:'INACTIVE'),  s:kz.inKillZone?'pass':'wait', f:kz.inKillZone?100:20},
    {i:'📐',n:'D1 EMA',     d:'Trend alignment', v:gr.d1EMAAligned?'Long aligned':gr.d1EMAAligned===false?'Not aligned':'—',                            s:gr.d1EMAAligned===false?'wait':'pass', f:gr.d1EMAAligned===false?50:100},
    {i:'📊',n:'ADR Space',  d:'Range headroom',  v:adr.percentConsumed!=null?`${Math.round(adr.percentConsumed)}% consumed`:'—',                        s:(adr.percentConsumed||0)>85?'wait':'pass', f:adr.percentConsumed!=null?Math.round(adr.percentConsumed):68},
    {i:'📈',n:'CVD',        d:'Volume delta',    v:cvd.delta!=null?`${cvd.delta>0?'+':''}${cvd.delta} ${cvd.direction==='up'?'↑':'↓'}`:'—',              s:'pass', f:80},
    {i:'📰',n:'News',       d:'Impact events',   v:nb.blocked?`Blocked (${nb.minutesUntil||0}m)`:'Clear',                                               s:nb.blocked?'fail':'pass', f:nb.blocked?0:100},
    {i:'🌊',n:'Chop Grd',   d:'Regime filter',   v:regime.type?regime.type.charAt(0).toUpperCase()+regime.type.slice(1):'Trending',                    s:(regime.type==='ranging'||regime.type==='choppy')?'wait':'pass', f:(regime.type==='ranging'||regime.type==='choppy')?40:100},
    {i:'🔢',n:'Max Trades', d:'Slot limit',      v:cb.dailyTradeCount!=null?`${cb.dailyTradeCount}/${cb.maxDailyTrades||3} used`:'—',                   s:(cb.dailyTradeCount||0)>=(cb.maxDailyTrades||3)?'fail':(cb.dailyTradeCount||0)>=(cb.maxDailyTrades||3)-1?'wait':'pass', f:cb.dailyTradeCount!=null?Math.round(cb.dailyTradeCount/(cb.maxDailyTrades||3)*100):67},
    {i:'⚖️',n:'Risk Lmt',  d:'Exposure cap',    v:cb.dailyDrawdown!=null?`${(cb.dailyDrawdown*100).toFixed(1)}%/${(cb.maxDailyDrawdown||2).toFixed(0)}%`:'—', s:(cb.dailyDrawdown||0)>(cb.maxDailyDrawdown||2)*.85?'wait':'pass', f:cb.dailyDrawdown!=null?Math.round(cb.dailyDrawdown/(cb.maxDailyDrawdown||2)*100):60},
  ];
  const bgCol={pass:'rgba(0,255,157,.4)',wait:'rgba(245,158,11,.4)',fail:'rgba(255,45,85,.4)'};
  const pfx={pass:'✓',wait:'⏳',fail:'✗'};
  const passCount=gates.filter(g=>g.s==='pass').length;
  return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH">
        <span className="pHL">Signal Gates</span>
        <GateRingCanvas pass={passCount} total={gates.length}/>
        <span style={{fontFamily:'var(--mono)',fontSize:14,fontWeight:200,color:'var(--pulse)'}}>{passCount}<span style={{fontSize:9,color:'var(--dim)'}}>/{gates.length}</span></span>
      </div>
      <div className="gSumm">
        <div className="gSInfo"><div className="gSLbl">Overall readiness</div><div className="gSStat">● {passCount>=6?'SIGNAL READY':passCount>=4?'PARTIAL':'NOT READY'}</div></div>
        <div style={{textAlign:'right',fontFamily:'var(--mono)'}}><div style={{fontSize:7,color:'var(--dim)'}}>latency</div><div style={{fontSize:10,color:'var(--ion)'}}>live</div></div>
      </div>
      <div id="gList">
        {gates.map((g,i)=>(
          <div key={i} className={`gRow ${g.s}`}>
            <span className="gIco">{g.i}</span>
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'baseline',gap:4}}><span className="gName">{g.n}</span><span className="gDesc">{g.d}</span></div>
              <div className="gFillBar"><div style={{height:'100%',width:`${g.f}%`,background:bgCol[g.s],borderRadius:1}}/></div>
            </div>
            <span className={`gVal ${g.s}`}>{pfx[g.s]} {g.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PineVision({jarvisState}) {
  const [tab,setTab]=useState('ict');
  const kz=jarvisState?.killZone||{};
  const adr=jarvisState?.adr||{};
  const cvd=jarvisState?.cvd||{};
  const orb=jarvisState?.orbState||{};
  return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Pine Vision</span><span className="tag ai">LIVE</span></div>
      <div style={{display:'flex',borderBottom:'1px solid var(--b2)'}}>
        {[{id:'ict',label:'QB-ICT',c:'var(--ion)'},{id:'rxn',label:'QB-RXN',c:'var(--pur)'},{id:'orb',label:'QB-ORB',c:'var(--amb)'}].map(t=>(
          <button key={t.id} className={`pvTab ${tab===t.id?'active':''}`} onClick={()=>setTab(t.id)} style={{color:tab===t.id?t.c:'var(--dim)'}}>{t.label}</button>
        ))}
      </div>
      {tab==='ict'&&(
        <div style={{padding:'5px 9px 5px',borderLeft:'3px solid var(--ion)'}}>
          <div className="pvRow"><span className="pvLbl">Kill Zone</span><span className="pvVal" style={{color:kz.inKillZone?'var(--pulse)':'var(--dim)'}}>{kz.inKillZone?kz.label+' · ACTIVE':'INACTIVE'}</span></div>
          <div className="pvRow"><span className="pvLbl">CVD Delta</span><span className="pvVal" style={{color:cvd.delta>0?'var(--pulse)':'var(--thr)'}}>{cvd.delta!=null?`${cvd.delta>0?'+':''}${cvd.delta}`:'—'}</span></div>
          <div className="pvRow"><span className="pvLbl">ADR Consumed</span><span className="pvVal" style={{color:'var(--amb)'}}>{adr.percentConsumed!=null?Math.round(adr.percentConsumed)+'%':'—'}</span></div>
          <div className="pvRow"><span className="pvLbl">Session Bias</span><span className="pvVal" style={{color:'var(--pulse)'}}>{jarvisState?.regime?.direction?.toUpperCase()||'LONG'}</span></div>
          <div className="pvRow"><span className="pvLbl">Regime</span><span className="pvVal" style={{color:'var(--pulse)'}}>{jarvisState?.regime?.type?.toUpperCase()||'—'}</span></div>
        </div>
      )}
      {tab==='rxn'&&(
        <div style={{padding:'5px 9px 5px',borderLeft:'3px solid var(--pur)'}}>
          <div className="pvRow"><span className="pvLbl">Impulse Path</span><span className="pvVal" style={{color:'var(--pulse)'}}>UP · {jarvisState?.regime?.type||'strong'}</span></div>
          <div className="pvRow"><span className="pvLbl">KNN Score</span><span className="pvVal" style={{color:'var(--pulse)'}}>{jarvisState?.sigQual?.knnWinRate?pct(jarvisState.sigQual.knnWinRate,0):'—'}</span></div>
          <div className="pvRow"><span className="pvLbl">Reaction Str.</span><span className="pvVal" style={{color:cvd.delta>200?'var(--pulse)':'var(--ion)'}}>{cvd.delta>200?'HIGH · strong':'NORMAL'}</span></div>
          <div className="pvRow"><span className="pvLbl">Avg R (KNN)</span><span className="pvVal" style={{color:'var(--pulse)'}}>{jarvisState?.sigQual?.knnAvgR?fmtR(jarvisState.sigQual.knnAvgR):'—'}</span></div>
        </div>
      )}
      {tab==='orb'&&(
        <div style={{padding:'5px 9px 5px',borderLeft:'3px solid var(--amb)'}}>
          <div className="pvRow"><span className="pvLbl">ORB State</span><span className="pvVal" style={{color:'var(--ion)'}}>{orb.state||'WATCHING'}</span></div>
          <div className="pvRow"><span className="pvLbl">Break Direction</span><span className="pvVal" style={{color:orb.direction==='long'?'var(--pulse)':'var(--thr)'}}>{orb.direction?.toUpperCase()||'—'}</span></div>
          <div className="pvRow"><span className="pvLbl">Mins Into Window</span><span className="pvVal" style={{color:'var(--ion)'}}>{orb.minsIntoWindow!=null?`${orb.minsIntoWindow}m / 15m`:'—'}</span></div>
          <div className="pvRow"><span className="pvLbl">D1 Veto</span><span className="pvVal" style={{color:orb.d1Veto?'var(--thr)':'var(--pulse)'}}>{orb.d1Veto?'VETOED':'PASS'}</span></div>
        </div>
      )}
    </div>
  );
}

function PortfolioPanel({account,dailyPnL,goals,trades}) {
  const equity=account?.equity??account?.balance??0;
  const float=account?.profit??0;
  const weekPnL=useMemo(()=>{const wa=Date.now()-7*24*3600000;return(trades||[]).filter(t=>(t.closedAt||0)>wa).reduce((s,t)=>s+(t.pnl||0),0);},[trades]);
  const dailyGoal=goals?.daily?.target||0;
  const goalPct=dailyGoal>0?Math.min(100,(dailyPnL/dailyGoal)*100):0;
  return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Portfolio</span><span className="tag live">live</span></div>
      <div className="eqBig">{equity?`$${equity.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—'}</div>
      <div className="eqDay" style={{color:dailyPnL>=0?'var(--pulse)':'var(--thr)'}}>{fmtMoney(dailyPnL,2)} · {dailyGoal>0?`${goalPct.toFixed(0)}% of goal`:'today'}</div>
      <EquitySparkline trades={trades}/>
      <div className="eqMetaR">
        <span className="eqMI">Week <span style={{color:weekPnL>=0?'var(--pulse)':'var(--thr)'}}>{fmtMoney(weekPnL,0)}</span></span>
        <span className="eqMI">Float <span style={{color:float>=0?'var(--pulse)':'var(--thr)'}}>{fmtMoney(float,2)}</span></span>
        <span className="eqMI">Trades <span>{trades?.length||0}</span></span>
      </div>
      {dailyGoal>0&&<div style={{padding:'0 10px 8px'}}><div className="goalBar"><div className="goalFill" style={{width:`${goalPct}%`}}/></div><div style={{textAlign:'right',fontSize:6,color:'var(--dim)',marginTop:2,fontFamily:'var(--mono)'}}>Daily: {goalPct.toFixed(0)}% complete</div></div>}
    </div>
  );
}

function PositionsPanel({positions}) {
  return (
    <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Open Positions</span><span className="tag live">{positions?.length||0} active</span></div>
      {!positions?.length&&<div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No open positions</div>}
      {(positions||[]).map((p,i)=>{
        const isLong=(p.type==='POSITION_TYPE_BUY'||p.type==='BUY'||p.type===0);
        const pnl=p.profit??p.unrealizedProfit??0;
        const sym=(p.symbol||p.id||'').replace(/^.*\//,'').toUpperCase();
        return <div className="posRow" key={i}><span className="pSym">{sym.slice(0,8)}</span><span className={`pDir ${isLong?'long':'short'}`}>{isLong?'LONG':'SHORT'}</span><div className="pInfo"><div className="pEntry">{p.volume?`${p.volume}l`:''} · {p.openPrice?.toFixed(p.openPrice>100?2:5)||''}</div></div><span className={`pPnl ${pnl>=0?'pos':'neg'}`}>{fmtMoney(pnl,2)}</span></div>;
      })}
    </div>
  );
}

function ActivityFeed({activity}) {
  const items=useMemo(()=>(activity||[]).slice(0,15),[activity]);
  const dc=type=>{if(!type)return'b';const t=type.toLowerCase();if(t.includes('win')||t.includes('tp'))return'g';if(t.includes('loss')||t.includes('sl'))return'r';if(t.includes('warn')||t.includes('block'))return'a';return'b';};
  return (
    <div className="hP" style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Activity Feed</span></div>
      <div id="actFeed" style={{flex:1,overflowY:'auto',padding:'3px 0'}}>
        {items.length===0&&<div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No activity yet</div>}
        {items.map((a,i)=>(
          <div className="aRow" key={i}><div className={`aDot ${dc(a.type)}`}/><div><div className="aT" dangerouslySetInnerHTML={{__html:(a.message||a.msg||'').replace(/\b(WIN|LOSS|BE|BLOCKED|SKIP)\b/g,'<b>$1</b>')}}/><div className="aTm">{fmtRelTime(a.ts)}</div></div></div>
        ))}
      </div>
    </div>
  );
}

function TemplateStrip({rules,trades,onSelectTpl}) {
  const [localEn,setLocalEn]=useState({});
  const tplIds=Object.keys(rules?.templateOverrides||TPLS_META);
  const dnaMap=useMemo(()=>{const m={};for(const t of(trades||[])){const id=t.template||'unknown';if(!m[id])m[id]=[];m[id].push(t.outcome);}return m;},[trades]);
  const wrMap=useMemo(()=>{const m={};for(const id of tplIds){const arr=dnaMap[id]||[];m[id]=arr.length?arr.filter(o=>o==='WIN').length/arr.length:null;}return m;},[dnaMap,tplIds]);
  return (
    <div id="tplStrip"><div className="cl"/><div className="cr"/>
      <div className="pH"><span className="pHL">Templates · {trades?.length||0} trades</span><span style={{fontSize:8,color:'var(--dim)',marginLeft:'auto'}}>click to expand · toggle to enable</span></div>
      <div id="tplRow">
        {tplIds.map(id=>{
          const meta=TPLS_META[id]||{glyph:'⊕',label:id.toUpperCase()};
          const ov=rules?.templateOverrides?.[id]||{};
          const enabled=(localEn[id]??ov.enabled)!==false;
          const wr=wrMap[id];
          const dna=(dnaMap[id]||[]).slice(-14);
          return (
            <div key={id} className={`tChip ${!enabled?'dis':''}`} onClick={()=>onSelectTpl(id)}>
              <div className="tCG">{meta.glyph}</div>
              <div className="tCN">{meta.label}</div>
              <div className={`tCS ${wr!==null?(wr>=.5?'g':'a'):''}`}>{wr!==null?pct(wr,0):dnaMap[id]?.length?'0%':'—'}</div>
              <div className="tcDNA">{dna.map((o,i)=><div key={i} className={`dNb ${o==='WIN'?'w':o==='LOSS'?'l':'b'}`}/>)}</div>
              <div className={`tTog3 ${enabled?'on':''}`} onClick={e=>{e.stopPropagation();setLocalEn(p=>({...p,[id]:!enabled}));}}/>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JarvisChat({messages,thinking,focusDock,onDismissFocus}) {
  const endRef=useRef(null);
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:'smooth'});},[messages,thinking]);
  return (
    <div id="jConv"><div className="cl"/><div className="cr"/>
      <div id="jConvH"><span className="pHL">JARVIS</span><span className="tag ai">AI ONLINE</span><span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)',marginLeft:'auto'}}>🔊 Voice ready</span></div>
      {focusDock&&(
        <div id="jFocusDock" style={{display:'block',padding:'0 4px 4px'}}>
          <div className="fdCard" style={{borderColor:'var(--ion)'}}>
            <div className="fdTitle"><span style={{color:'var(--ion)'}}>{focusDock.title||'JARVIS FOCUS'}</span><button className="fdDismiss" onClick={onDismissFocus}>✕ DISMISS</button></div>
            {(focusDock.rows||[]).map((row,i)=><div className="fdRow" key={i}><span className="fdK">{row.k}</span><span className="fdV" style={{color:row.color||'var(--txt)'}}>{row.v}</span></div>)}
            {focusDock.bar!=null&&<div className="goalBar" style={{marginTop:5}}><div className="goalFill" style={{width:`${Math.min(100,focusDock.bar*100)}%`}}/></div>}
          </div>
        </div>
      )}
      <div id="jMsgs">
        {messages.map((m,i)=>(
          <div key={i} className={`jM ${m.role==='jarvis'?'j':'u'}`}>
            <div className={`jMB ${m.urgency==='critical'?'jUrgent':m.urgency==='elevated'?'jElevated':''}`}>
              {m.role==='jarvis'&&<div className="px">JARVIS</div>}
              {m.text}
            </div>
          </div>
        ))}
        {thinking&&<div className="jM j"><div className="jMB"><div className="px">JARVIS</div><div className="jThink"><span/><span/><span/></div></div></div>}
        <div ref={endRef}/>
      </div>
      <div className="jTyp">{thinking&&<><span className="tD"><span/><span/><span/></span><span id="jTypTxt">Analyzing market structure...</span></>}</div>
    </div>
  );
}

// Modals
function TradeLogModal({trades,onClose}) {
  const [filter,setFilter]=useState('ALL');
  const filtered=useMemo(()=>{let a=trades||[];if(filter!=='ALL')a=a.filter(t=>t.outcome===filter);return a.slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0));},[trades,filter]);
  const wins=filtered.filter(t=>t.outcome==='WIN').length;
  const rVals=filtered.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  return (
    <div style={{position:'fixed',inset:0,zIndex:9200,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(7px)'}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--panel)',border:'1px solid rgba(0,229,255,.22)',borderRadius:10,width:'min(900px,96vw)',maxHeight:'88vh',overflow:'hidden',display:'flex',flexDirection:'column'}}>
        <div style={{display:'flex',alignItems:'center',gap:9,padding:'12px 16px',borderBottom:'1px solid rgba(0,229,255,.1)',flexShrink:0}}>
          <span style={{fontFamily:'var(--mono)',fontSize:14,color:'var(--ion)',fontWeight:700,flex:1}}>📊 Trade Log · {trades?.length||0} total</span>
          <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)'}}>WR {filtered.length?pct(wins/filtered.length,0):'—'} · Avg {rVals.length?(rVals.reduce((a,b)=>a+b,0)/rVals.length).toFixed(2):'—'}R</span>
          <button style={{background:'none',border:'none',color:'var(--dim)',fontSize:17,cursor:'pointer'}} onClick={onClose}>✕</button>
        </div>
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px'}}>
          <div style={{display:'flex',gap:4,marginBottom:9,flexWrap:'wrap'}}>
            {['ALL','WIN','LOSS','BREAKEVEN'].map(f=><button key={f} className={`tFBtn ${filter===f?'on':''}`} onClick={()=>setFilter(f)}>{f}</button>)}
            <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)',marginLeft:'auto',alignSelf:'center'}}>{filtered.length} rows</span>
          </div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--mono)',fontSize:'9.5px'}}>
              <thead><tr style={{color:'var(--dim)',borderBottom:'1px solid rgba(0,229,255,.1)'}}>
                {['Time','Asset','Dir','Template','Session','Outcome','PnL','R'].map(h=><th key={h} style={{textAlign:'left',padding:'4px 7px',fontWeight:400,whiteSpace:'nowrap'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {filtered.slice(0,300).map((t,i)=>{const oc=t.outcome==='WIN'?'var(--pulse)':t.outcome==='LOSS'?'var(--thr)':'var(--dim)';return(
                  <tr key={i} style={{borderBottom:'1px solid rgba(0,229,255,.04)'}}>
                    <td style={{padding:'4px 7px',color:'var(--dim)',whiteSpace:'nowrap'}}>{fmtTime(t.closedAt)}</td>
                    <td style={{padding:'4px 7px',color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                    <td style={{padding:'4px 7px'}}><span style={{fontSize:7,padding:'1px 4px',borderRadius:3,background:t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',color:t.direction==='long'?'var(--pulse)':'var(--thr)'}}>{(t.direction||'?').toUpperCase()}</span></td>
                    <td style={{padding:'4px 7px',color:'var(--txt)'}}>{tplLabel(t.template)}</td>
                    <td style={{padding:'4px 7px',color:'var(--dim)'}}>{sessLabel(t.session)}</td>
                    <td style={{padding:'4px 7px',color:oc}}>{t.outcome}</td>
                    <td style={{padding:'4px 7px',color:oc}}>{fmtMoney(t.pnl,2)}</td>
                    <td style={{padding:'4px 7px',color:oc}}>{fmtR(t.pnlR)}</td>
                  </tr>);
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── BRAIN MODAL ──────────────────────────────────────────────────────────────

const INSTRUMENT_DEFAULTS = {
  XAUUSD:{ name:'XAUUSD',sub:'Gold',    sessions:['NY_AM'],         templates:['ORB-PRO','SB','ALEX-G'],               bias:'LONG',  lot:0.10,sl:150,tp:2.0,rule:'CVD > 0 required. Skip 10m before news.' },
  US500: { name:'US500', sub:'S&P 500', sessions:['NY_AM','NY_PM'],  templates:['ORB-PRO','REACT-FVG','ALEX-G','ORB'],   bias:'ANY',   lot:0.50,sl:80, tp:2.0,rule:'ORB window 09:30-09:45 ET. D1 EMA mandatory.' },
  NAS100:{ name:'NAS100',sub:'Nasdaq',  sessions:['NY_AM'],         templates:['ORB-PRO','ALEX-G'],                     bias:'LONG',  lot:0.20,sl:120,tp:2.0,rule:'LONG only D1 above 200 EMA. KNN ≥75%.' },
  GER40: { name:'GER40', sub:'DAX',     sessions:['LON','NY_AM'],    templates:['REACT-FVG','AM-IFVG'],                  bias:'ANY',   lot:0.25,sl:100,tp:1.8,rule:'Skip first 15m London open. ADR <75%.' },
  GBPUSD:{ name:'GBPUSD',sub:'Cable',   sessions:['LON'],           templates:['SB','REACT-FVG'],                       bias:'SHORT', lot:0.10,sl:200,tp:2.0,rule:'Short bias during UK news. No trades 30m before data.' },
  EURUSD:{ name:'EURUSD',sub:'EuroDlr', sessions:['LON'],           templates:['AM-IFVG','REACT-IFVG'],                 bias:'ANY',   lot:0.10,sl:180,tp:1.8,rule:'Correlate with DXY. Avoid ECB days.' },
};

function BrainHourDayGrid({trades}) {
  const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const HOURS=Array.from({length:24},(_,i)=>i);
  const cells=useMemo(()=>{
    const m={};
    for(const t of(trades||[])){if(!t.closedAt)continue;const d=new Date(t.closedAt);const day=DAYS[(d.getUTCDay()+6)%7];const h=d.getUTCHours();const k=`${day}-${h}`;if(!m[k])m[k]={w:0,n:0};m[k].n++;if(t.outcome==='WIN')m[k].w++;}
    return m;
  },[trades]);
  const col=wr=>{if(wr>=70)return'#00c87a';if(wr>=60)return'#7eb800';if(wr>=45)return'#d97706';return'#c0254a';};
  return (
    <div style={{overflowX:'auto',padding:'14px 16px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div style={{display:'flex',gap:12}}>
          {[['≥70%','#00c87a'],['60-70%','#7eb800'],['45-60%','#d97706'],['<45%','#c0254a'],['no data','#0d1f35']].map(([l,c])=>(
            <span key={l} style={{display:'flex',alignItems:'center',gap:4,fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>
              <span style={{width:10,height:10,borderRadius:2,background:c,display:'inline-block'}}/>{l}
            </span>
          ))}
        </div>
        <span style={{fontFamily:'var(--mono)',fontSize:7,color:'var(--dim)'}}>hover cell for detail · all times UTC</span>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'36px repeat(24,1fr)',gap:1,fontSize:8}}>
        <div/>
        {HOURS.map(h=><div key={h} style={{textAlign:'center',fontFamily:'var(--mono)',fontSize:7,color:'var(--dim)',padding:'2px 0'}}>{String(h).padStart(2,'0')}</div>)}
        {DAYS.map(day=>[
          <div key={day} style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--ion)',display:'flex',alignItems:'center',paddingRight:4}}>{day}</div>,
          ...HOURS.map(h=>{
            const k=`${day}-${h}`;const c=cells[k];const wr=c?Math.round(c.w/c.n*100):null;
            return <div key={h} title={c?`${day} ${h}:00 UTC — ${c.n} trades · ${wr}% WR`:undefined} style={{height:22,borderRadius:2,background:wr!==null?col(wr):'rgba(0,20,48,.6)',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--mono)',fontSize:7,color:wr!==null?(wr>=60?'rgba(0,0,0,.75)':'rgba(255,255,255,.8)'):'transparent',cursor:c?'pointer':'default',border:'1px solid rgba(0,0,0,.2)'}}>{wr!==null?wr:''}</div>;
          })
        ])}
      </div>
    </div>
  );
}

function BrainKNNConstellation({trades}) {
  const ref=useRef(null);
  const pts=useMemo(()=>{
    return (trades||[]).filter(t=>t.closedAt&&typeof t.pnlR==='number'&&isFinite(t.pnlR)).map(t=>{
      const h=new Date(t.closedAt).getUTCHours();
      return {x:h,y:t.pnlR,win:t.outcome==='WIN',tpl:t.template};
    });
  },[trades]);
  useEffect(()=>{
    const c=ref.current;if(!c)return;
    const x=c.getContext('2d'),W=c.width,H=c.height;
    const pad={l:40,r:16,t:12,b:28};
    const pW=W-pad.l-pad.r,pH=H-pad.t-pad.b;
    const ys=pts.map(p=>p.y);const mn=Math.min(...ys,-1.5),mx=Math.max(...ys,1.5);
    const px=v=>pad.l+((v/24)*pW),py=v=>pad.t+pH-(v-mn)/(mx-mn)*pH;
    x.clearRect(0,0,W,H);
    x.strokeStyle='rgba(0,229,255,.06)';x.lineWidth=0.5;
    [0,6,12,18,24].forEach(h=>{x.beginPath();x.moveTo(px(h),pad.t);x.lineTo(px(h),pad.t+pH);x.stroke();x.fillStyle='rgba(0,229,255,.35)';x.font='7px monospace';x.textAlign='center';x.fillText(String(h).padStart(2,'0'),px(h),H-5);});
    const zeroY=py(0);x.strokeStyle='rgba(0,229,255,.15)';x.lineWidth=1;x.setLineDash([3,4]);x.beginPath();x.moveTo(pad.l,zeroY);x.lineTo(W-pad.r,zeroY);x.stroke();x.setLineDash([]);
    x.fillStyle='rgba(0,229,255,.3)';x.font='7px monospace';x.textAlign='right';
    [mn,0,mx].forEach(v=>{x.fillText(v.toFixed(1)+'R',pad.l-3,py(v)+3);});
    pts.forEach(p=>{
      const px2=px(p.x+(Math.random()-.5)*.6),py2=py(p.y);
      x.fillStyle=p.win?'rgba(0,255,157,.65)':'rgba(255,45,85,.55)';x.shadowColor=p.win?'rgba(0,255,157,.4)':'rgba(255,45,85,.3)';x.shadowBlur=4;
      x.beginPath();x.arc(px2,py2,3,0,Math.PI*2);x.fill();
    });
    x.shadowBlur=0;
  },[pts]);
  return (
    <div style={{padding:'14px 16px'}}>
      <div style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)',marginBottom:8}}>KNN Constellation — each dot is a trade. Green = WIN, red = LOSS. X = UTC hour, Y = R outcome.</div>
      <canvas ref={ref} width={860} height={280} style={{width:'100%',display:'block',borderRadius:4,background:'rgba(0,10,28,.5)'}}/>
      <div style={{display:'flex',gap:12,marginTop:6}}>
        <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>Total: {pts.length} trades plotted</span>
        <span style={{color:'rgba(0,255,157,.7)',fontSize:8,fontFamily:'var(--mono)'}}>● WIN</span>
        <span style={{color:'rgba(255,45,85,.7)',fontSize:8,fontFamily:'var(--mono)'}}>● LOSS</span>
      </div>
    </div>
  );
}

function BrainRiskTreemap({trades}) {
  const blocks=useMemo(()=>{
    const m={};
    for(const t of(trades||[])){const k=t.template||'unknown';if(!m[k])m[k]={w:0,n:0,r:[]};m[k].n++;if(t.outcome==='WIN')m[k].w++;if(typeof t.pnlR==='number'&&isFinite(t.pnlR))m[k].r.push(t.pnlR);}
    return Object.entries(m).map(([id,s])=>({id,label:tplLabel(id),n:s.n,wr:s.n?s.w/s.n:0,avgR:s.r.length?s.r.reduce((a,b)=>a+b,0)/s.r.length:0})).sort((a,b)=>b.n-a.n);
  },[trades]);
  const total=blocks.reduce((s,b)=>s+b.n,0)||1;
  return (
    <div style={{padding:'14px 16px'}}>
      <div style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)',marginBottom:10}}>Risk Treemap — block size = trade count · color = win rate</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
        {blocks.map(b=>{
          const size=Math.max(80,b.n/total*600);const c=b.wr>=.7?'rgba(0,255,157,.9)':b.wr>=.6?'rgba(120,200,50,.9)':b.wr>=.45?'rgba(245,158,11,.9)':'rgba(255,45,85,.9)';
          return <div key={b.id} style={{width:size,height:size,background:`linear-gradient(135deg,rgba(0,20,48,.9),rgba(0,20,48,.6))`,border:`1px solid ${c.replace('.9','.4')}`,borderRadius:6,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',cursor:'pointer',boxShadow:`inset 0 0 ${size*.3}px ${c.replace('.9','.12')}`}}>
            <div style={{fontFamily:'var(--mono)',fontSize:Math.max(8,size*.07),color:c,fontWeight:700}}>{b.label}</div>
            <div style={{fontFamily:'var(--mono)',fontSize:Math.max(10,size*.1),color:c,fontWeight:200,marginTop:2}}>{pct(b.wr,0)}</div>
            <div style={{fontSize:Math.max(7,size*.06),color:'var(--dim)',marginTop:1}}>{b.n} trades · {fmtR(b.avgR)}</div>
          </div>;
        })}
      </div>
    </div>
  );
}

function BrainInstrumentRules() {
  const [rows,setRows]=useState(()=>Object.values(INSTRUMENT_DEFAULTS).map(r=>({...r})));
  const [saved,setSaved]=useState({});
  const saveRow=async(r)=>{
    try{await fetch('/api/rules?action=set-instrument-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)});setSaved(p=>({...p,[r.name]:true}));setTimeout(()=>setSaved(p=>({...p,[r.name]:false})),2000);}
    catch{setSaved(p=>({...p,[r.name]:'err'}));}
  };
  const upd=(name,field,val)=>setRows(rs=>rs.map(r=>r.name===name?{...r,[field]:val}:r));
  const TH=s=><th style={{padding:'7px 10px',fontFamily:'var(--mono)',fontSize:7.5,textTransform:'uppercase',letterSpacing:.4,color:'var(--dim)',fontWeight:400,whiteSpace:'nowrap',textAlign:'left'}}>{s}</th>;
  return (
    <div style={{padding:'14px 16px'}}>
      <div style={{fontFamily:'var(--ui)',fontSize:11,color:'var(--txt)',marginBottom:12,lineHeight:1.6}}>
        Per-instrument execution rules. Edit <b style={{color:'var(--ion)'}}>Lot Size</b>, <b style={{color:'var(--ion)'}}>SL (pts)</b>, <b style={{color:'var(--ion)'}}>TP (R)</b> and <b style={{color:'var(--ion)'}}>Bias</b> directly – click <b style={{color:'var(--pulse)'}}>Save</b> to apply.
      </div>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:900}}>
          <thead><tr style={{borderBottom:'1px solid rgba(0,229,255,.12)'}}>
            {['INSTRUMENT','SESSIONS','TEMPLATES','BIAS','LOT SIZE','SL (PTS)','TP (R)','SPECIAL RULE',''].map((h,i)=><th key={i} style={{padding:'7px 10px',fontFamily:'var(--mono)',fontSize:7.5,textTransform:'uppercase',letterSpacing:.4,color:'var(--dim)',fontWeight:400,whiteSpace:'nowrap',textAlign:'left'}}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(r=>(
              <tr key={r.name} style={{borderBottom:'1px solid rgba(0,229,255,.05)'}}>
                <td style={{padding:'8px 10px'}}>
                  <div style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--ion)',fontWeight:700}}>{r.name}</div>
                  <div style={{fontSize:8,color:'var(--dim)'}}>{r.sub}</div>
                </td>
                <td style={{padding:'8px 10px'}}>
                  <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
                    {r.sessions.map(s=><span key={s} style={{fontFamily:'var(--mono)',fontSize:7.5,padding:'1px 5px',borderRadius:3,background:'rgba(0,229,255,.08)',border:'1px solid rgba(0,229,255,.2)',color:'var(--ion)'}}>{s.replace('_','_')}</span>)}
                  </div>
                </td>
                <td style={{padding:'8px 10px'}}>
                  <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
                    {r.templates.map(t=><span key={t} style={{fontFamily:'var(--mono)',fontSize:7.5,padding:'1px 5px',borderRadius:3,background:'rgba(167,139,250,.06)',border:'1px solid rgba(167,139,250,.2)',color:'var(--pur)'}}>{t}</span>)}
                  </div>
                </td>
                <td style={{padding:'8px 10px'}}>
                  <select value={r.bias} onChange={e=>upd(r.name,'bias',e.target.value)} style={{background:'rgba(0,20,48,.7)',border:'1px solid rgba(0,229,255,.25)',color:'var(--ion)',fontFamily:'var(--mono)',fontSize:9,padding:'3px 6px',borderRadius:3,outline:'none',cursor:'pointer'}}>
                    <option>LONG</option><option>SHORT</option><option>ANY</option>
                  </select>
                </td>
                <td style={{padding:'8px 10px'}}>
                  <input type="number" value={r.lot} step="0.01" min="0.01" onChange={e=>upd(r.name,'lot',parseFloat(e.target.value)||r.lot)} style={{width:60,background:'rgba(0,20,48,.7)',border:'1px solid rgba(0,229,255,.2)',color:'var(--txt)',fontFamily:'var(--mono)',fontSize:10,padding:'3px 6px',borderRadius:3,outline:'none',textAlign:'center'}}/>
                </td>
                <td style={{padding:'8px 10px'}}>
                  <input type="number" value={r.sl} step="5" min="5" onChange={e=>upd(r.name,'sl',parseInt(e.target.value)||r.sl)} style={{width:60,background:'rgba(0,20,48,.7)',border:'1px solid rgba(0,229,255,.2)',color:'var(--txt)',fontFamily:'var(--mono)',fontSize:10,padding:'3px 6px',borderRadius:3,outline:'none',textAlign:'center'}}/>
                </td>
                <td style={{padding:'8px 10px'}}>
                  <input type="number" value={r.tp} step="0.1" min="0.5" onChange={e=>upd(r.name,'tp',parseFloat(e.target.value)||r.tp)} style={{width:50,background:'rgba(0,20,48,.7)',border:'1px solid rgba(0,229,255,.2)',color:'var(--txt)',fontFamily:'var(--mono)',fontSize:10,padding:'3px 6px',borderRadius:3,outline:'none',textAlign:'center'}}/>
                </td>
                <td style={{padding:'8px 10px',color:'var(--dim)',fontSize:9,maxWidth:260}}>{r.rule}</td>
                <td style={{padding:'8px 10px'}}>
                  <button onClick={()=>saveRow(r)} style={{background:saved[r.name]===true?'rgba(0,255,157,.15)':saved[r.name]==='err'?'rgba(255,45,85,.15)':'rgba(0,229,255,.08)',border:`1px solid ${saved[r.name]===true?'rgba(0,255,157,.5)':saved[r.name]==='err'?'rgba(255,45,85,.4)':'rgba(0,229,255,.3)'}`,color:saved[r.name]===true?'var(--pulse)':saved[r.name]==='err'?'var(--thr)':'var(--ion)',fontFamily:'var(--mono)',fontSize:9,padding:'4px 12px',borderRadius:3,cursor:'pointer',fontWeight:700,whiteSpace:'nowrap'}}>
                    {saved[r.name]===true?'✓ Saved':saved[r.name]==='err'?'Error':'Save'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BrainSymbolMap({trades}) {
  const sym=useMemo(()=>{
    const m={};
    for(const t of(trades||[])){const k=(t.asset||'?').toUpperCase();if(!m[k])m[k]={w:0,n:0,pnl:0};m[k].n++;if(t.outcome==='WIN')m[k].w++;m[k].pnl+=(t.pnl||0);}
    return Object.entries(m).map(([s,v])=>({sym:s,n:v.n,wr:v.n?v.w/v.n:0,pnl:v.pnl})).sort((a,b)=>b.n-a.n);
  },[trades]);
  return (
    <div style={{padding:'14px 16px'}}>
      <div style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)',marginBottom:10}}>Symbol Map — performance by instrument across all trades</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:8}}>
        {sym.map(s=>{
          const c=s.wr>=.7?'var(--pulse)':s.wr>=.5?'var(--ion)':s.wr>=.4?'var(--amb)':'var(--thr)';
          return <div key={s.sym} style={{background:'rgba(0,15,35,.7)',border:`1px solid ${c.replace('var(','').replace(')','').trim()}`,borderRadius:6,padding:'10px 12px'}}>
            <div style={{fontFamily:'var(--mono)',fontSize:13,color:'var(--ion)',fontWeight:700}}>{s.sym}</div>
            <div style={{fontFamily:'var(--mono)',fontSize:18,color:c,fontWeight:200,margin:'4px 0'}}>{pct(s.wr,0)}</div>
            <div style={{fontSize:8,color:'var(--dim)'}}>{s.n} trades · <span style={{color:s.pnl>=0?'var(--pulse)':'var(--thr)'}}>{fmtMoney(s.pnl,0)}</span></div>
            <div style={{marginTop:5,height:3,background:'rgba(0,229,255,.08)',borderRadius:2,overflow:'hidden'}}><div style={{height:'100%',width:`${s.wr*100}%`,background:c,borderRadius:2}}/></div>
          </div>;
        })}
        {sym.length===0&&<div style={{color:'var(--dim)',fontSize:9}}>No trade data available</div>}
      </div>
    </div>
  );
}

function BrainLargeEquity({trades}) {
  const ref=useRef(null);
  useEffect(()=>{
    const c=ref.current;if(!c)return;
    const x=c.getContext('2d'),W=c.width,H=c.height;
    x.clearRect(0,0,W,H);
    const sorted=(trades||[]).slice().sort((a,b)=>(a.closedAt||0)-(b.closedAt||0));
    if(sorted.length<2)return;
    let running=0;
    const data=[0,...sorted.map(t=>{running+=(t.pnl||0);return running;})];
    const mn=Math.min(...data),mx=Math.max(...data)||100;const range=mx-mn||100;
    const px=i=>(i/(data.length-1))*(W-2)+1,py=v=>H-2-(v-mn)/range*(H-16)-6;
    const isPos=data[data.length-1]>=0;
    const g=x.createLinearGradient(0,0,0,H);g.addColorStop(0,isPos?'rgba(0,229,255,.18)':'rgba(255,45,85,.12)');g.addColorStop(1,isPos?'rgba(0,229,255,0)':'rgba(255,45,85,0)');
    x.beginPath();data.forEach((v,i)=>i===0?x.moveTo(px(i),py(v)):x.lineTo(px(i),py(v)));x.lineTo(W,H);x.lineTo(0,H);x.closePath();x.fillStyle=g;x.fill();
    x.beginPath();data.forEach((v,i)=>i===0?x.moveTo(px(i),py(v)):x.lineTo(px(i),py(v)));x.strokeStyle=isPos?'rgba(0,229,255,.8)':'rgba(255,45,85,.8)';x.lineWidth=1.8;x.stroke();
    const zeroY=py(0);if(zeroY>4&&zeroY<H-4){x.strokeStyle='rgba(0,229,255,.12)';x.lineWidth=1;x.setLineDash([4,4]);x.beginPath();x.moveTo(0,zeroY);x.lineTo(W,zeroY);x.stroke();x.setLineDash([]);}
    const last=data[data.length-1];x.fillStyle='rgba(0,10,28,.7)';x.font='9px monospace';x.fillStyle=last>=0?'var(--pulse)':'var(--thr)';x.textAlign='right';x.fillText(`${last>=0?'+':''}$${Math.round(last)}`,W-4,py(last)-5);
  },[trades]);
  return <canvas ref={ref} width={900} height={160} style={{width:'100%',display:'block',borderRadius:4}}/>;
}

function BrainTradingData({trades}) {
  const [excluded,setExcluded]=useState(new Set());
  const [filter,setFilter]=useState('All');
  const visible=useMemo(()=>{
    let a=(trades||[]).filter(t=>!excluded.has(t.id||t._id));
    if(filter==='Wins')a=a.filter(t=>t.outcome==='WIN');
    if(filter==='Losses')a=a.filter(t=>t.outcome==='LOSS');
    return a.slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0));
  },[trades,excluded,filter]);
  const wins=visible.filter(t=>t.outcome==='WIN').length;
  const rVals=visible.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  const avgR=rVals.length?rVals.reduce((a,b)=>a+b,0)/rVals.length:0;
  const bestR=rVals.length?Math.max(...rVals):0,worstR=rVals.length?Math.min(...rVals):0;
  const wr=visible.length?wins/visible.length:0;
  const losses=visible.filter(t=>t.outcome==='LOSS');
  const profits=visible.filter(t=>t.pnl>0).reduce((s,t)=>s+(t.pnl||0),0);
  const lossPnl=Math.abs(visible.filter(t=>t.pnl<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf=lossPnl>0?profits/lossPnl:profits>0?99:0;
  const bySess={};for(const t of visible){const s=sessLabel(t.session);if(!bySess[s])bySess[s]={w:0,n:0};bySess[s].n++;if(t.outcome==='WIN')bySess[s].w++;}
  const sessList=Object.entries(bySess).map(([s,v])=>({s,wr:v.n?v.w/v.n:0,n:v.n})).sort((a,b)=>b.wr-a.wr);
  const stats=[
    {l:'Total Trades',v:String(visible.length),bar:1,c:'var(--ion)'},
    {l:'Win Rate',     v:pct(wr,0),             bar:wr,   c:'var(--pulse)'},
    {l:'Average R',   v:fmtR(avgR),             bar:Math.min(1,Math.max(0,avgR/4)), c:'var(--ion)'},
    {l:'Best Trade',  v:fmtR(bestR),            bar:Math.min(1,bestR/5), c:'var(--pulse)'},
    {l:'Worst Trade', v:fmtR(worstR),           bar:Math.min(1,Math.abs(worstR)/3), c:'var(--thr)'},
    {l:'Profit Factor',v:pf.toFixed(1),         bar:Math.min(1,pf/5), c:'var(--amb)'},
    {l:'Best Session', v:sessList[0]?`${sessList[0].s} · ${pct(sessList[0].wr,0)}`:'—', bar:sessList[0]?.wr||0, c:'var(--pulse)'},
    {l:'Worst Session',v:sessList[sessList.length-1]?`${sessList[sessList.length-1].s} · ${pct(sessList[sessList.length-1].wr,0)}`:'—', bar:sessList[sessList.length-1]?.wr||0, c:'var(--amb)'},
  ];
  return (
    <div style={{padding:'14px 16px'}}>
      <div style={{marginBottom:12,borderRadius:5,overflow:'hidden',border:'1px solid rgba(0,229,255,.1)'}}><BrainLargeEquity trades={trades}/></div>
      <div style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)',marginBottom:4}}>Aggregate performance – all templates – all history.</div>
      <div style={{display:'grid',gridTemplateColumns:'180px 1fr',gap:3,marginBottom:16}}>
        {stats.map((s,i)=>(
          <div key={i} style={{display:'contents'}}>
            <div style={{fontFamily:'var(--mono)',fontSize:9.5,color:'var(--dim)',display:'flex',alignItems:'center',padding:'1.5px 0'}}>{s.l}</div>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontFamily:'var(--mono)',fontSize:9.5,color:s.c,width:70,textAlign:'right'}}>{s.v}</span>
              <div style={{flex:1,height:3,background:'rgba(0,229,255,.07)',borderRadius:2,overflow:'hidden'}}><div style={{height:'100%',width:`${s.bar*100}%`,background:s.c,borderRadius:2}}/></div>
            </div>
          </div>
        ))}
      </div>
      <div style={{borderTop:'1px solid rgba(0,229,255,.1)',paddingTop:10}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
          <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)'}}>Trade Log &nbsp;<span style={{color:'var(--ion)'}}>{visible.length} active</span> · <span style={{color:'var(--dim)'}}>{excluded.size} excluded</span></span>
          <div style={{display:'flex',gap:4,marginLeft:8}}>
            {['All','Wins','Losses','Excluded'].map(f=><button key={f} className={`tFBtn ${filter===f?'on':''}`} onClick={()=>setFilter(f)}>{f}</button>)}
          </div>
        </div>
        <div style={{overflowX:'auto',maxHeight:260,overflowY:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--mono)',fontSize:'9.5px',minWidth:700}}>
            <thead style={{position:'sticky',top:0,background:'var(--panel)',zIndex:1}}><tr style={{color:'var(--dim)',borderBottom:'1px solid rgba(0,229,255,.1)'}}>
              {['DATE/TIME','TEMPLATE','SYMBOL','DIR','ENTRY','EXIT','P&L','R','ACTION'].map(h=><th key={h} style={{textAlign:'left',padding:'4px 8px',fontWeight:400,fontSize:7.5,textTransform:'uppercase',letterSpacing:.4,whiteSpace:'nowrap'}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {visible.slice(0,200).map((t,i)=>{
                const oc=t.outcome==='WIN'?'var(--pulse)':t.outcome==='LOSS'?'var(--thr)':'var(--dim)';
                const id=t.id||t._id||i;
                return <tr key={i} style={{borderBottom:'1px solid rgba(0,229,255,.04)',opacity:excluded.has(id)?.4:1}}>
                  <td style={{padding:'4px 8px',color:'var(--dim)',whiteSpace:'nowrap'}}>{t.closedAt?new Date(t.closedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).replace(',',''):''}</td>
                  <td style={{padding:'4px 8px',color:'var(--pur)',fontWeight:700}}>{tplLabel(t.template)}</td>
                  <td style={{padding:'4px 8px',color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                  <td style={{padding:'4px 8px'}}><span style={{fontSize:7,padding:'1px 5px',borderRadius:3,background:t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',color:t.direction==='long'?'var(--pulse)':'var(--thr)'}}>{(t.direction||'?').toUpperCase()}</span></td>
                  <td style={{padding:'4px 8px',color:'var(--txt)'}}>{t.entryPrice!=null?t.entryPrice.toFixed(t.entryPrice>100?1:5):t.entry||'—'}</td>
                  <td style={{padding:'4px 8px',color:'var(--txt)'}}>{t.exitPrice!=null?t.exitPrice.toFixed(t.exitPrice>100?1:5):t.exit||'—'}</td>
                  <td style={{padding:'4px 8px',color:oc}}>{fmtMoney(t.pnl,2)}</td>
                  <td style={{padding:'4px 8px',color:oc}}>{fmtR(t.pnlR)}</td>
                  <td style={{padding:'4px 8px'}}><button onClick={()=>setExcluded(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;})} style={{background:excluded.has(id)?'rgba(0,229,255,.08)':'rgba(255,45,85,.08)',border:`1px solid ${excluded.has(id)?'rgba(0,229,255,.25)':'rgba(255,45,85,.3)'}`,color:excluded.has(id)?'var(--ion)':'var(--thr)',fontFamily:'var(--mono)',fontSize:7.5,padding:'2px 8px',borderRadius:3,cursor:'pointer'}}>{excluded.has(id)?'Include':'Exclude'}</button></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function JarvisOrbModal({onClose,orbState,positions,goals,account,jarvisState}){
  const canvasRef=useRef(null),rafRef=useRef(null);
  const [closing,setClosing]=useState(false);
  const dismiss=()=>{setClosing(true);setTimeout(onClose,300);};

  useEffect(()=>{
    const c=canvasRef.current; if(!c) return;
    let t=0;
    const resize=()=>{c.width=window.innerWidth;c.height=window.innerHeight;};
    resize(); window.addEventListener('resize',resize);

    const col=orbState==='signal'?'0,255,157':orbState==='warn'?'245,158,11':orbState==='critical'?'255,45,85':'0,229,255';
    const pos=Array.isArray(positions)?positions:[];
    const eq=account?.balance||account?.equity||0;
    const todayPnl=account?.todayPnl||0;
    const ddPct=eq>0?Math.abs(Math.min(0,todayPnl)/eq*100):0;
    const kz=jarvisState?.killZone;
    const adrPct=jarvisState?.adr?.percentConsumed||0;
    const regime=jarvisState?.regime?.type;
    const mode=jarvisState?.currentMode||'active';
    const goalPct=goals?.daily?.target>0?Math.min(1,Math.max(0,(goals.daily.achieved||0)/goals.daily.target)):0;

    // 8 gate health states: 1=pass(cyan), 0=fail(red), null=checking(dim)
    const gateOk=[
      kz?.inKillZone===true?1:0,
      null,
      adrPct>0&&adrPct<85?1:null,
      null,
      1,
      regime?1:null,
      pos.length<3?1:0,
      ddPct<2.0?1:0,
    ];
    const GATE_LBL=['KZ','EMA','ADR','CVD','NEWS','CHG','MAX','RSK'];

    // Position orbit nodes
    const posNodes=pos.map((p,i)=>({
      angle:(i/Math.max(1,pos.length))*Math.PI*2+1.5,
      speed:.003+i*.0007,
      profit:(p.unrealizedProfit||p.profit||0)>=0,
    }));

    // Data stream particles (flow from outer ring toward center)
    const streams=Array.from({length:10},(_,i)=>({
      angle:(i/10)*Math.PI*2,
      progress:Math.random(),
      speed:.006+Math.random()*.004,
    }));

    // Neural mesh nodes
    const meshNodes=Array.from({length:20},()=>({
      x:Math.random(),y:Math.random(),
      vx:(Math.random()-.5)*.002,vy:(Math.random()-.5)*.002,
      r:.8+Math.random()*1.2,
    }));

    const ctx=c.getContext('2d');
    const draw=()=>{
      const W=c.width,H=c.height,cx=W/2,cy=H/2;
      const R=Math.min(W,H)*.34;
      ctx.clearRect(0,0,W,H);

      // Background
      const bg=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(W,H)*.75);
      bg.addColorStop(0,`rgba(0,8,22,.97)`);bg.addColorStop(.55,`rgba(0,4,14,.99)`);bg.addColorStop(1,'rgba(0,0,6,1)');
      ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);

      // Faint radar rings
      [.42,.68,.92,1.18,1.42].forEach(f=>{
        ctx.strokeStyle=`rgba(${col},${f>1?.018:.032})`;ctx.lineWidth=.5;
        ctx.beginPath();ctx.arc(cx,cy,R*f,0,Math.PI*2);ctx.stroke();
      });
      // Radial spokes (8, aligning with gate segments)
      for(let i=0;i<8;i++){
        const a=(i/8)*Math.PI*2-Math.PI/2;
        ctx.strokeStyle=`rgba(${col},.025)`;ctx.lineWidth=.4;
        ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+R*1.55*Math.cos(a),cy+R*1.55*Math.sin(a));ctx.stroke();
      }

      // Goal progress arc (outermost — thin, behind gates)
      if(goalPct>0){
        ctx.strokeStyle=`rgba(${col},.22)`;ctx.lineWidth=2.5;ctx.lineCap='round';
        ctx.beginPath();ctx.arc(cx,cy,R*1.42,-Math.PI/2,-Math.PI/2+goalPct*Math.PI*2);ctx.stroke();
        const endA=-Math.PI/2+goalPct*Math.PI*2;
        ctx.fillStyle=`rgba(${col},.85)`;ctx.shadowColor=`rgba(${col},1)`;ctx.shadowBlur=10;
        ctx.beginPath();ctx.arc(cx+R*1.42*Math.cos(endA),cy+R*1.42*Math.sin(endA),3.5,0,Math.PI*2);ctx.fill();
        ctx.shadowBlur=0;
      }

      // GATE SEGMENTS — the primary health ring
      const gapA=.055;const segA=Math.PI*2/8-gapA;
      gateOk.forEach((g,i)=>{
        const sA=(i/8)*Math.PI*2-Math.PI/2+gapA/2;const eA=sA+segA;
        const pulse=.5+.5*Math.sin(t*.04+i*.8);
        let gc,ga,blur;
        if(g===1){gc=col;ga=.55+.25*pulse;blur=12;}
        else if(g===0){gc='255,45,85';ga=.38+.28*pulse;blur=8;}
        else{gc=col;ga=.08+.05*pulse;blur=0;}
        ctx.strokeStyle=`rgba(${gc},${ga})`;ctx.lineWidth=5;ctx.lineCap='round';
        ctx.shadowColor=`rgba(${gc},${ga*.55})`;ctx.shadowBlur=blur;
        ctx.beginPath();ctx.arc(cx,cy,R*1.12,sA,eA);ctx.stroke();ctx.shadowBlur=0;
        // Label at gate midpoint
        const mA=sA+segA/2;const lr=R*1.28;
        ctx.fillStyle=g===1?`rgba(${col},.65)`:g===0?'rgba(255,45,85,.65)':`rgba(${col},.2)`;
        ctx.font=`600 ${R*.065}px monospace`;ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(GATE_LBL[i],cx+lr*Math.cos(mA),cy+lr*Math.sin(mA));
      });

      // Data streams — particles flowing inward along gate spokes
      streams.forEach(s=>{
        s.progress+=s.speed; if(s.progress>1)s.progress=0;
        const sR=R*1.1,eR=R*.18,curR=sR-(sR-eR)*s.progress;
        const fi=s.progress<.15?s.progress/.15:1;const fo=s.progress>.8?(1-s.progress)/.2:1;
        ctx.fillStyle=`rgba(${col},${fi*fo*.45})`;
        ctx.beginPath();ctx.arc(cx+curR*Math.cos(s.angle),cy+curR*Math.sin(s.angle),1.5,0,Math.PI*2);ctx.fill();
      });

      // Neural mesh (same as OrbCanvas)
      meshNodes.forEach(n=>{n.x+=n.vx;n.y+=n.vy;if(n.x<.02||n.x>.98)n.vx*=-1;if(n.y<.02||n.y>.98)n.vy*=-1;});
      meshNodes.forEach((a,i)=>meshNodes.forEach((b,j)=>{
        if(j<=i)return;
        const dx=(a.x-b.x)*W,dy=(a.y-b.y)*H,d=Math.sqrt(dx*dx+dy*dy);
        if(d<R*.75){ctx.strokeStyle=`rgba(${col},${.18*(1-d/(R*.75))})`;ctx.lineWidth=.35;ctx.beginPath();ctx.moveTo(a.x*W,a.y*H);ctx.lineTo(b.x*W,b.y*H);ctx.stroke();}
      }));
      meshNodes.forEach(n=>{ctx.fillStyle=`rgba(${col},.45)`;ctx.beginPath();ctx.arc(n.x*W,n.y*H,n.r,0,Math.PI*2);ctx.fill();});

      // Three spinning orbital rings
      [{r:R*.9,spd:.005,gap:.18,lc:`rgba(${col},.65)`,w:1.5},
       {r:R*.66,spd:-.008,gap:.25,lc:`rgba(${col},.6)`,w:1.5},
       {r:R*.43,spd:.013,gap:.32,lc:'rgba(167,139,250,.55)',w:1}
      ].forEach(ring=>{
        const rot=t*ring.spd*60;
        ctx.save();ctx.translate(cx,cy);ctx.rotate(rot);
        ctx.strokeStyle=ring.lc;ctx.lineWidth=ring.w;ctx.lineCap='round';
        ctx.shadowColor=ring.lc;ctx.shadowBlur=6;
        ctx.beginPath();ctx.arc(0,0,ring.r,ring.gap/2,Math.PI*2-ring.gap/2);ctx.stroke();
        ctx.restore();ctx.shadowBlur=0;
      });

      // Session mode arc (bottom band — thin colored arc)
      const modeColMap={active:`rgba(${col},.45)`,defensive:'rgba(245,158,11,.45)',sleep:'rgba(80,100,140,.35)',vacation:'rgba(60,60,80,.25)'};
      ctx.strokeStyle=modeColMap[mode]||modeColMap.active;ctx.lineWidth=2.5;ctx.lineCap='round';
      ctx.beginPath();ctx.arc(cx,cy,R*.97,Math.PI*.2,Math.PI*.8);ctx.stroke();

      // Kill zone pulse ring (when active)
      if(kz?.inKillZone){
        const kzAlpha=.15+.12*Math.sin(t*.06);
        ctx.strokeStyle=`rgba(245,158,11,${kzAlpha})`;ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(cx,cy,R*.97,-Math.PI*.8,-Math.PI*.2);ctx.stroke();
      }

      // Open position orbit nodes
      posNodes.forEach(n=>{
        n.angle+=n.speed;
        const oR=R*.72;const nx=cx+oR*Math.cos(n.angle),ny=cy+oR*Math.sin(n.angle);
        const nc=n.profit?'0,255,157':'255,45,85';
        ctx.strokeStyle=`rgba(${nc},.18)`;ctx.lineWidth=1.5;
        ctx.beginPath();ctx.arc(cx,cy,oR,n.angle-.35,n.angle);ctx.stroke();
        ctx.fillStyle=`rgba(${nc},.9)`;ctx.shadowColor=`rgba(${nc},.65)`;ctx.shadowBlur=14;
        ctx.beginPath();ctx.arc(nx,ny,5.5,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      });

      // Core sphere (larger)
      const cr=R*.17;
      const pulse=1+.06*Math.sin(t*.04);
      const sphG=ctx.createRadialGradient(cx-cr*.3,cy-cr*.3,0,cx,cy,cr*pulse);
      sphG.addColorStop(0,'rgba(200,255,255,.97)');
      sphG.addColorStop(.35,`rgba(${col},.75)`);
      sphG.addColorStop(.75,'rgba(0,50,120,.5)');
      sphG.addColorStop(1,'rgba(0,20,48,.85)');
      ctx.shadowColor=`rgba(${col},.9)`;ctx.shadowBlur=28+10*Math.sin(t*.04);
      ctx.fillStyle=sphG;ctx.beginPath();ctx.arc(cx,cy,cr*pulse,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      for(let i=0;i<6;i++){const a=(i/6)*Math.PI*2+t*.01;ctx.strokeStyle=`rgba(${col},.2)`;ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+cr*1.15*Math.cos(a),cy+cr*1.15*Math.sin(a));ctx.stroke();}

      // Ghost status word (very faint, large — readable at a glance, not intrusive)
      const word=orbState==='signal'?'SIGNAL READY':orbState==='warn'?'CAUTION':orbState==='critical'?'ALERT':'SCANNING';
      ctx.font=`900 ${R*.19}px monospace`;ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillStyle=`rgba(${col},.038)`;ctx.fillText(word,cx,cy+R*.82);

      t++;rafRef.current=requestAnimationFrame(draw);
    };
    draw();
    return()=>{window.removeEventListener('resize',resize);cancelAnimationFrame(rafRef.current);};
  },[]);// eslint-disable-line

  const pos=Array.isArray(positions)?positions:[];
  return(
    <div className={`jOrbOverlay${closing?' closing':''}`} onClick={dismiss}>
      <canvas ref={canvasRef}/>
      <div className="jOrbFooter">
        {pos.map((p,i)=>(
          <div key={i} className="jOrbPosDot" style={{
            background:(p.unrealizedProfit||p.profit||0)>=0?'rgba(0,255,157,.8)':'rgba(255,45,85,.8)',
            boxShadow:(p.unrealizedProfit||p.profit||0)>=0?'0 0 7px rgba(0,255,157,.6)':'0 0 7px rgba(255,45,85,.6)',
          }}/>
        ))}
      </div>
      <div className="jOrbDismiss">tap anywhere · close</div>
    </div>
  );
}

function LearningModal({onClose,trades}){
  const canvasRef=useRef(null),rafRef=useRef(null);
  const [closing,setClosing]=useState(false);
  const dismiss=()=>{setClosing(true);setTimeout(onClose,300);};

  useEffect(()=>{
    const c=canvasRef.current; if(!c) return;
    let t=0,reveal=0;
    const resize=()=>{c.width=window.innerWidth;c.height=window.innerHeight;};
    resize(); window.addEventListener('resize',resize);

    // ── DATA ──
    const sorted=[...trades].sort((a,b)=>(a.closedAt||0)-(b.closedAt||0));
    const N=sorted.length;
    const overallWins=sorted.filter(tr=>tr.outcome==='WIN').length;
    const overallWR=N>0?overallWins/N:0;

    // Rolling 20-trade win rate
    const rolling=sorted.map((_,i)=>{
      const w=sorted.slice(Math.max(0,i-19),i+1);
      return w.filter(tr=>tr.outcome==='WIN').length/w.length;
    });

    // 20-trade trend
    const trend20=rolling.length>=21
      ?rolling[rolling.length-1]-rolling[rolling.length-21]:0;

    // Template stats
    const tMap={};
    sorted.forEach(tr=>{
      const k=(tr.template||'?').toUpperCase().replace(/-/g,' ').slice(0,10);
      if(!tMap[k])tMap[k]={wins:0,total:0,rSum:0,rCount:0};
      tMap[k].total++;
      if(tr.outcome==='WIN')tMap[k].wins++;
      if(typeof tr.pnlR==='number'&&isFinite(tr.pnlR)){tMap[k].rSum+=tr.pnlR;tMap[k].rCount++;}
    });
    const tplList=Object.entries(tMap)
      .map(([name,s])=>({name,total:s.total,wr:s.total>0?s.wins/s.total:0,avgR:s.rCount>0?s.rSum/s.rCount:0}))
      .sort((a,b)=>b.total-a.total).slice(0,8);
    const maxTotal=Math.max(...tplList.map(tp=>tp.total),1);

    // Streak
    let streak=0;
    for(let i=sorted.length-1;i>=0;i--){
      const w=sorted[i].outcome==='WIN',l=sorted[i].outcome==='LOSS';
      if(i===sorted.length-1){if(w)streak=1;else if(l)streak=-1;else break;}
      else{if(streak>0&&w)streak++;else if(streak<0&&l)streak--;else break;}
    }

    // Recent strip (last 60)
    const recent=sorted.slice(-60);
    const maxR=Math.max(...recent.map(tr=>Math.abs(tr.pnlR||0)),1);

    // Win-rate → rgb color helper (red→yellow→cyan)
    const wrCol=(wr)=>{
      if(wr>=0.5){const f=(wr-.5)/.5;return `${Math.round(245*(1-f))},${Math.round(158*(1-f)+229*f)},${Math.round(11*(1-f)+255*f)}`;}
      const f=wr/.5;return `${Math.round(255*(1-f)+245*f)},${Math.round(45*(1-f)+158*f)},${Math.round(85*(1-f)+11*f)}`;
    };

    const ctx=c.getContext('2d');
    const draw=()=>{
      const W=c.width,H=c.height;
      reveal=Math.min(1,reveal+.01);
      ctx.clearRect(0,0,W,H);
      ctx.fillStyle='rgba(0,3,12,1)';ctx.fillRect(0,0,W,H);

      const leftW=W*.42,chartX=W*.46,chartW=W-chartX-24,footY=H-68;
      const lCx=leftW/2,lCy=(footY-50)/2+50;
      const webR=Math.min(leftW*.38,footY*.38);

      // ── HEADER ──
      ctx.fillStyle='rgba(0,229,255,.55)';ctx.font='700 11px monospace';ctx.textAlign='left';ctx.textBaseline='top';
      ctx.fillText('RECOGNITION ENGINE',22,14);
      ctx.fillStyle='rgba(0,229,255,.22)';ctx.font='9px monospace';
      ctx.fillText(`${N} trades in memory`,22,30);
      const wrc=wrCol(overallWR);
      ctx.font='700 22px monospace';ctx.textAlign='right';ctx.fillStyle=`rgba(${wrc},.9)`;
      ctx.fillText(`${(overallWR*100).toFixed(0)}% WR`,W-22,14);
      ctx.font='700 9px monospace';
      const ta=trend20>.03?'↑ IMPROVING':trend20<-.03?'↓ DECLINING':'→ STABLE';
      const tc=trend20>.03?'0,255,157':trend20<-.03?'255,45,85':'100,130,160';
      ctx.fillStyle=`rgba(${tc},.75)`;ctx.fillText(ta,W-22,40);

      // Divider
      ctx.strokeStyle='rgba(0,229,255,.05)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(leftW+14,50);ctx.lineTo(leftW+14,footY-8);ctx.stroke();

      // Radar rings (left panel context)
      [.35,.6,.88,1.06].forEach(f=>{
        ctx.strokeStyle=`rgba(0,229,255,${f>1?.018:.03})`;ctx.lineWidth=.35;
        ctx.beginPath();ctx.arc(lCx,lCy,webR*f,0,Math.PI*2);ctx.stroke();
      });

      // ── TEMPLATE CONSTELLATION ──
      ctx.fillStyle='rgba(0,229,255,.2)';ctx.font='700 8px monospace';ctx.textAlign='center';ctx.textBaseline='top';
      ctx.fillText('TEMPLATE MASTERY',lCx,54);

      tplList.forEach((tp,i)=>{
        const angle=(i/tplList.length)*Math.PI*2-Math.PI/2+t*.003*(i%2===0?1:-.7);
        const sR=8+24*Math.sqrt(tp.total/maxTotal);
        const dist=webR*(.45+.5*(tp.total/maxTotal));
        const nx=lCx+dist*Math.cos(angle),ny=lCy+dist*Math.sin(angle);
        const nc=wrCol(tp.wr);const pulse=.8+.2*Math.sin(t*.04+i*1.1);
        const tier=tp.total>=50?3:tp.total>=20?2:tp.total>=8?1:0;
        // Connector
        ctx.strokeStyle=`rgba(${nc},${.07+.12*(tp.total/maxTotal)})`;ctx.lineWidth=.8;
        ctx.beginPath();ctx.moveTo(lCx,lCy);ctx.lineTo(nx,ny);ctx.stroke();
        // Node
        ctx.shadowColor=`rgba(${nc},${.5*pulse})`;ctx.shadowBlur=[0,8,16,24][tier]*pulse;
        ctx.fillStyle=`rgba(${nc},${.1+.07*pulse})`;
        ctx.beginPath();ctx.arc(nx,ny,sR,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle=`rgba(${nc},${.5+.3*pulse})`;ctx.lineWidth=1.5;
        ctx.beginPath();ctx.arc(nx,ny,sR,0,Math.PI*2);ctx.stroke();ctx.shadowBlur=0;
        // WR arc
        ctx.strokeStyle=`rgba(${nc},.75)`;ctx.lineWidth=2.5;ctx.lineCap='round';
        ctx.beginPath();ctx.arc(nx,ny,sR+3.5,-Math.PI/2,-Math.PI/2+tp.wr*Math.PI*2);ctx.stroke();
        // Expert dashed ring
        if(tier>=3){ctx.strokeStyle=`rgba(${nc},.5)`;ctx.lineWidth=.8;ctx.setLineDash([2,2]);ctx.beginPath();ctx.arc(nx,ny,sR+8,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);}
        // Labels
        ctx.fillStyle=`rgba(${nc},.85)`;ctx.font=`700 ${Math.max(6,Math.min(8,sR*.5))}px monospace`;ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(tp.name.slice(0,7),nx,ny-1);
        ctx.fillStyle=`rgba(${nc},.5)`;ctx.font='6.5px monospace';
        ctx.fillText(`${(tp.wr*100).toFixed(0)}%  ${tp.total}t`,nx,ny+sR+10);
      });

      // CORE node
      const jc=wrCol(overallWR);const jp=.9+.1*Math.sin(t*.05);
      ctx.shadowColor=`rgba(${jc},.5)`;ctx.shadowBlur=18*jp;
      ctx.fillStyle=`rgba(${jc},${.3*jp})`;ctx.beginPath();ctx.arc(lCx,lCy,10,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle=`rgba(${jc},.65)`;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(lCx,lCy,10,0,Math.PI*2);ctx.stroke();ctx.shadowBlur=0;
      ctx.fillStyle=`rgba(${jc},.7)`;ctx.font='600 7px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('CORE',lCx,lCy);

      // ── LEARNING CURVE ──
      const cY=56,cH=footY-72;
      ctx.fillStyle='rgba(0,229,255,.015)';ctx.fillRect(chartX,cY,chartW,cH);
      // 50% line
      const mid=cY+cH*.5;
      ctx.strokeStyle='rgba(0,229,255,.14)';ctx.lineWidth=1;ctx.setLineDash([5,5]);
      ctx.beginPath();ctx.moveTo(chartX,mid);ctx.lineTo(chartX+chartW,mid);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='rgba(0,229,255,.3)';ctx.font='7px monospace';ctx.textAlign='left';ctx.textBaseline='middle';
      ctx.fillText('50%',chartX+3,mid-5);
      // 75% line
      ctx.strokeStyle='rgba(0,255,157,.05)';ctx.lineWidth=.4;
      ctx.beginPath();ctx.moveTo(chartX,cY+cH*.25);ctx.lineTo(chartX+chartW,cY+cH*.25);ctx.stroke();

      if(rolling.length>1){
        const revN=Math.max(2,Math.floor(rolling.length*reveal));
        const pts=rolling.slice(0,revN).map((wr,i)=>({x:chartX+(i/(rolling.length-1))*chartW,y:cY+cH-wr*cH}));
        const ep=pts[pts.length-1];
        // Fill
        const grad=ctx.createLinearGradient(0,cY,0,cY+cH);
        grad.addColorStop(0,'rgba(0,229,255,.16)');grad.addColorStop(1,'rgba(0,229,255,.01)');
        ctx.fillStyle=grad;ctx.beginPath();ctx.moveTo(pts[0].x,cY+cH);
        pts.forEach(p=>ctx.lineTo(p.x,p.y));ctx.lineTo(ep.x,cY+cH);ctx.closePath();ctx.fill();
        // Line
        ctx.strokeStyle='rgba(0,229,255,.75)';ctx.lineWidth=2;ctx.lineCap='round';ctx.lineJoin='round';
        ctx.shadowColor='rgba(0,229,255,.3)';ctx.shadowBlur=5;
        ctx.beginPath();pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));ctx.stroke();ctx.shadowBlur=0;
        // Endpoint
        const ep2=.6+.4*Math.sin(t*.07);
        ctx.fillStyle='rgba(0,229,255,1)';ctx.shadowColor='rgba(0,229,255,.8)';ctx.shadowBlur=10*ep2;
        ctx.beginPath();ctx.arc(ep.x,ep.y,3.5,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
        // Current WR display
        const curWR=rolling[revN-1];const crc=wrCol(curWR);
        ctx.font='700 30px monospace';ctx.textAlign='left';ctx.textBaseline='top';
        ctx.fillStyle=`rgba(${crc},.9)`;ctx.fillText(`${(curWR*100).toFixed(0)}%`,chartX,cY-2);
        ctx.font='8px monospace';ctx.fillStyle='rgba(0,229,255,.3)';
        ctx.fillText('20-TRADE ROLLING WIN RATE',chartX+62,cY+9);
      }
      // X label
      ctx.fillStyle='rgba(0,229,255,.15)';ctx.font='7px monospace';ctx.textAlign='center';
      ctx.fillText(`← oldest   ${N} trades   newest →`,chartX+chartW/2,cY+cH+8);
      // Streak
      if(streak!==0){
        const sc=streak>0?'0,255,157':'255,45,85';
        ctx.font='700 10px monospace';ctx.textAlign='right';
        ctx.fillStyle=`rgba(${sc},.75)`;
        ctx.fillText(`${streak>0?'+':''}${streak} streak`,W-24,cY+cH+8);
      }

      // ── TRADE MEMORY STRIP ──
      const sY=H-44;
      ctx.fillStyle='rgba(0,229,255,.18)';ctx.font='7px monospace';ctx.textAlign='left';ctx.textBaseline='middle';
      ctx.fillText('MEMORY',22,sY);
      const dSp=(W-120)/Math.max(1,recent.length);
      recent.forEach((tr,i)=>{
        const x=78+i*dSp+dSp/2,age=.3+.7*(i/recent.length);
        const iW=tr.outcome==='WIN',iBE=tr.outcome==='BREAKEVEN';
        const dr=Math.max(2,Math.min(6,2.5+3.5*Math.abs(tr.pnlR||0)/maxR));
        const nc=iBE?'160,140,40':iW?'0,255,157':'255,45,85';
        if(i===recent.length-1){ctx.shadowColor=`rgba(${nc},.8)`;ctx.shadowBlur=8;}
        ctx.fillStyle=`rgba(${nc},${age})`;ctx.beginPath();ctx.arc(x,sY,dr,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      });
      ctx.fillStyle='rgba(0,229,255,.12)';ctx.font='6.5px monospace';ctx.textAlign='right';
      ctx.fillText(`last ${recent.length} →`,W-22,sY);

      t++;rafRef.current=requestAnimationFrame(draw);
    };
    draw();
    return()=>{window.removeEventListener('resize',resize);cancelAnimationFrame(rafRef.current);};
  },[]);// eslint-disable-line

  return(
    <div className={`jOrbOverlay${closing?' closing':''}`} onClick={dismiss}>
      <canvas ref={canvasRef}/>
      <div className="jOrbDismiss">tap anywhere · close</div>
    </div>
  );
}

function BrainModal({trades,onClose}) {
  const TABS=[
    {id:'grid',    label:'Hour×Day Grid'},
    {id:'knn',     label:'KNN Constellation'},
    {id:'treemap', label:'Risk Treemap'},
    {id:'rules',   label:'Instrument Rules'},
    {id:'symbol',  label:'Symbol Map'},
    {id:'data',    label:'Trading Data'},
  ];
  const [tab,setTab]=useState('grid');
  return (
    <div style={{position:'fixed',inset:0,zIndex:9200,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.92)',backdropFilter:'blur(8px)'}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--panel)',border:'1px solid rgba(167,139,250,.3)',borderRadius:10,width:'min(1100px,97vw)',maxHeight:'92vh',overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 0 80px rgba(167,139,250,.1)'}}>
        <div style={{display:'flex',alignItems:'center',padding:'0 16px',borderBottom:'1px solid rgba(0,229,255,.1)',flexShrink:0,background:'rgba(0,229,255,.02)'}}>
          <div style={{display:'flex',alignItems:'center',gap:8,paddingRight:16}}>
            <div style={{width:18,height:18,borderRadius:'50%',background:'rgba(255,45,85,.8)',boxShadow:'0 0 10px rgba(255,45,85,.4)'}}/>
            <span style={{fontFamily:'var(--mono)',fontSize:12,color:'var(--ion)',fontWeight:700,letterSpacing:2}}>QUANTUM BRAIN</span>
          </div>
          <div style={{display:'flex',flex:1,borderLeft:'1px solid rgba(0,229,255,.1)',paddingLeft:8}}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'12px 14px',background:'none',border:'none',borderBottom:`2px solid ${tab===t.id?'var(--ion)':'transparent'}`,color:tab===t.id?'var(--ion)':'var(--dim)',fontFamily:'var(--mono)',fontSize:9,fontWeight:700,letterSpacing:.5,cursor:'pointer',whiteSpace:'nowrap',transition:'color .2s'}}>{t.label}</button>
            ))}
          </div>
          <button onClick={onClose} style={{background:'none',border:'1px solid rgba(0,229,255,.2)',color:'var(--dim)',fontFamily:'var(--mono)',fontSize:9,padding:'4px 10px',borderRadius:4,cursor:'pointer',marginLeft:8}}>✕ Close</button>
        </div>
        <div style={{flex:1,overflowY:'auto'}}>
          {tab==='grid'    && <BrainHourDayGrid  trades={trades}/>}
          {tab==='knn'     && <BrainKNNConstellation trades={trades}/>}
          {tab==='treemap' && <BrainRiskTreemap   trades={trades}/>}
          {tab==='rules'   && <BrainInstrumentRules/>}
          {tab==='symbol'  && <BrainSymbolMap     trades={trades}/>}
          {tab==='data'    && <BrainTradingData   trades={trades}/>}
        </div>
      </div>
    </div>
  );
}

// ── TEMPLATE MODAL (full tabbed) ─────────────────────────────────────────────
function TemplateModal({tplId,trades,rules,jarvisState,onClose}) {
  const meta=TPLS_META[tplId]||{glyph:'⊕',label:tplId};
  const isAlexG=tplId==='alexg';
  const TABS=[
    {id:'overview', label:'OVERVIEW'},
    {id:'session',  label:'BY SESSION'},
    {id:'regime',   label:'BY REGIME'},
    {id:'trades',   label:'TRADES'},
    ...(isAlexG?[{id:'cron',label:'CRON'},{id:'signals',label:'SIGNALS'}]:[]),
  ];
  const [tab,setTab]=useState('overview');
  const tTrades=useMemo(()=>(trades||[]).filter(t=>t.template===tplId).slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)),[trades,tplId]);
  const wins=tTrades.filter(t=>t.outcome==='WIN').length;
  const wr=tTrades.length?wins/tTrades.length:0;
  const rVals=tTrades.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  const avgR=rVals.length?rVals.reduce((a,b)=>a+b,0)/rVals.length:0;
  const bestR=rVals.length?Math.max(...rVals):0,worstR=rVals.length?Math.min(...rVals):0;
  const totalPnL=tTrades.reduce((s,t)=>s+(t.pnl||0),0);
  const profits=tTrades.filter(t=>t.pnl>0).reduce((s,t)=>s+(t.pnl||0),0);
  const lossPnl=Math.abs(tTrades.filter(t=>t.pnl<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf=lossPnl>0?profits/lossPnl:profits>0?99:0;
  const bySess=useMemo(()=>{const m={};for(const t of tTrades){const s=sessLabel(t.session);if(!m[s])m[s]={w:0,n:0,r:[]};m[s].n++;if(t.outcome==='WIN')m[s].w++;if(typeof t.pnlR==='number'&&isFinite(t.pnlR))m[s].r.push(t.pnlR);}return Object.entries(m).map(([s,v])=>({s,n:v.n,wr:v.n?v.w/v.n:0,avgR:v.r.length?v.r.reduce((a,b)=>a+b,0)/v.r.length:0})).sort((a,b)=>b.wr-a.wr);},[tTrades]);
  const byRegime=useMemo(()=>{const m={};for(const t of tTrades){const s=t.regime||t.marketRegime||'unknown';if(!m[s])m[s]={w:0,n:0,r:[]};m[s].n++;if(t.outcome==='WIN')m[s].w++;if(typeof t.pnlR==='number'&&isFinite(t.pnlR))m[s].r.push(t.pnlR);}return Object.entries(m).map(([s,v])=>({s,n:v.n,wr:v.n?v.w/v.n:0,avgR:v.r.length?v.r.reduce((a,b)=>a+b,0)/v.r.length:0})).sort((a,b)=>b.n-a.n);},[tTrades]);
  const signals=useMemo(()=>{const watchers=jarvisState?.watchers||{};return Object.entries(watchers).filter(([,w])=>w?.template===tplId||isAlexG).map(([asset,w])=>({asset,dir:w?.direction||'—',desc:w?.signalText||w?.currentSetup?.description||`${(w?.direction||'').toUpperCase()} ${asset.toUpperCase()} — ${jarvisState?.killZone?.label||''} kill zone`,ts:w?.signalTime||Date.now()}));},[jarvisState,tplId]);
  return (
    <div style={{position:'fixed',inset:0,zIndex:9200,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(7px)'}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--panel)',border:'1px solid rgba(0,229,255,.22)',borderRadius:10,width:'min(900px,96vw)',maxHeight:'90vh',overflow:'hidden',display:'flex',flexDirection:'column'}}>
        {/* header */}
        <div style={{display:'flex',alignItems:'center',gap:9,padding:'0 16px',borderBottom:'1px solid rgba(0,229,255,.1)',flexShrink:0,background:'rgba(0,229,255,.02)'}}>
          <span style={{fontSize:18}}>{meta.glyph}</span>
          <span style={{fontFamily:'var(--mono)',fontSize:13,color:'var(--ion)',fontWeight:700,letterSpacing:1}}>{meta.label}</span>
          <div style={{display:'flex',flex:1,gap:0,borderLeft:'1px solid rgba(0,229,255,.1)',marginLeft:8,paddingLeft:4}}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'11px 14px',background:'none',border:'none',borderBottom:`2px solid ${tab===t.id?'var(--ion)':'transparent'}`,color:tab===t.id?'var(--ion)':'var(--dim)',fontFamily:'var(--mono)',fontSize:8.5,fontWeight:700,letterSpacing:.6,cursor:'pointer',whiteSpace:'nowrap',transition:'color .2s'}}>{t.label}</button>
            ))}
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--dim)',fontSize:18,cursor:'pointer',padding:'0 4px'}}>✕</button>
        </div>
        {/* body */}
        <div style={{flex:1,overflowY:'auto',padding:'16px'}}>
          {tab==='overview'&&(
            <>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
                {[{v:pct(wr,1),l:'Win Rate',c:'var(--pulse)'},{v:fmtR(avgR),l:'Avg R',c:'var(--ion)'},{v:String(tTrades.length),l:'Trades',c:'var(--txt)'},{v:fmtMoney(totalPnL,0),l:'Total PnL',c:totalPnL>=0?'var(--pulse)':'var(--thr)'},{v:fmtR(bestR),l:'Best Trade',c:'var(--pulse)'},{v:fmtR(worstR),l:'Worst Trade',c:'var(--thr)'},{v:pf.toFixed(2),l:'Profit Factor',c:'var(--amb)'},{v:wins+' / '+(tTrades.length-wins),l:'W / L',c:'var(--dim)'}].map((s,i)=>(
                  <div key={i} style={{background:'rgba(0,15,35,.7)',border:'1px solid rgba(0,229,255,.12)',borderRadius:6,padding:'8px 10px',textAlign:'center'}}>
                    <div style={{fontFamily:'var(--mono)',fontSize:15,fontWeight:200,color:s.c}}>{s.v}</div>
                    <div style={{fontSize:7.5,color:'var(--dim)',textTransform:'uppercase',letterSpacing:.3,marginTop:3}}>{s.l}</div>
                  </div>
                ))}
              </div>
              <div style={{marginBottom:10}}>
                <div style={{fontFamily:'var(--mono)',fontSize:7.5,color:'var(--dim)',marginBottom:4,letterSpacing:.4,textTransform:'uppercase'}}>Last {Math.min(60,tTrades.length)} trades DNA</div>
                <div style={{display:'flex',gap:1.5,height:28,borderRadius:4,overflow:'hidden'}}>
                  {tTrades.slice(0,60).map((t,i)=><div key={i} title={`${t.outcome} · ${fmtR(t.pnlR)}`} style={{flex:1,minWidth:5,background:t.outcome==='WIN'?'rgba(0,255,157,.75)':t.outcome==='LOSS'?'rgba(255,45,85,.75)':'rgba(0,229,255,.3)',borderRadius:1,cursor:'help'}}/>)}
                  {tTrades.length===0&&<div style={{color:'var(--dim)',fontSize:9,display:'flex',alignItems:'center',padding:'0 8px'}}>No trades yet</div>}
                </div>
              </div>
            </>
          )}
          {tab==='session'&&(
            <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--mono)',fontSize:'10px'}}>
              <thead><tr style={{borderBottom:'1px solid rgba(0,229,255,.1)',color:'var(--dim)'}}>
                {['Session','Trades','Win Rate','Avg R','Bar'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 10px',fontWeight:400,fontSize:8,textTransform:'uppercase',letterSpacing:.4}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {bySess.map((s,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(0,229,255,.04)'}}>
                    <td style={{padding:'8px 10px',color:'var(--ion)',fontWeight:700}}>{s.s}</td>
                    <td style={{padding:'8px 10px',color:'var(--dim)'}}>{s.n}</td>
                    <td style={{padding:'8px 10px',color:s.wr>=.6?'var(--pulse)':s.wr>=.45?'var(--amb)':'var(--thr)'}}>{pct(s.wr,1)}</td>
                    <td style={{padding:'8px 10px',color:s.avgR>=0?'var(--pulse)':'var(--thr)'}}>{fmtR(s.avgR)}</td>
                    <td style={{padding:'8px 10px',minWidth:140}}><div style={{height:4,background:'rgba(0,229,255,.08)',borderRadius:2,overflow:'hidden'}}><div style={{height:'100%',width:`${s.wr*100}%`,background:s.wr>=.6?'var(--pulse)':s.wr>=.45?'var(--amb)':'var(--thr)',borderRadius:2}}/></div></td>
                  </tr>
                ))}
                {bySess.length===0&&<tr><td colSpan={5} style={{padding:'12px 10px',color:'var(--dim)',fontSize:9}}>No session data</td></tr>}
              </tbody>
            </table>
          )}
          {tab==='regime'&&(
            <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--mono)',fontSize:'10px'}}>
              <thead><tr style={{borderBottom:'1px solid rgba(0,229,255,.1)',color:'var(--dim)'}}>
                {['Regime','Trades','Win Rate','Avg R','Bar'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 10px',fontWeight:400,fontSize:8,textTransform:'uppercase',letterSpacing:.4}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {byRegime.map((s,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(0,229,255,.04)'}}>
                    <td style={{padding:'8px 10px',color:'var(--ion)',fontWeight:700,textTransform:'capitalize'}}>{s.s}</td>
                    <td style={{padding:'8px 10px',color:'var(--dim)'}}>{s.n}</td>
                    <td style={{padding:'8px 10px',color:s.wr>=.6?'var(--pulse)':s.wr>=.45?'var(--amb)':'var(--thr)'}}>{pct(s.wr,1)}</td>
                    <td style={{padding:'8px 10px',color:s.avgR>=0?'var(--pulse)':'var(--thr)'}}>{fmtR(s.avgR)}</td>
                    <td style={{padding:'8px 10px',minWidth:140}}><div style={{height:4,background:'rgba(0,229,255,.08)',borderRadius:2,overflow:'hidden'}}><div style={{height:'100%',width:`${s.wr*100}%`,background:s.wr>=.6?'var(--pulse)':s.wr>=.45?'var(--amb)':'var(--thr)',borderRadius:2}}/></div></td>
                  </tr>
                ))}
                {byRegime.length===0&&<tr><td colSpan={5} style={{padding:'12px 10px',color:'var(--dim)',fontSize:9}}>No regime data in trades</td></tr>}
              </tbody>
            </table>
          )}
          {tab==='trades'&&(
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--mono)',fontSize:'9.5px'}}>
                <thead><tr style={{color:'var(--dim)',borderBottom:'1px solid rgba(0,229,255,.1)'}}>
                  {['Time','Dir','Asset','Entry','Exit','PnL','R'].map(h=><th key={h} style={{textAlign:'left',padding:'5px 10px',fontWeight:400,fontSize:8,textTransform:'uppercase',letterSpacing:.4}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {tTrades.slice(0,200).map((t,i)=>{
                    const oc=t.outcome==='WIN'?'var(--pulse)':t.outcome==='LOSS'?'var(--thr)':'var(--dim)';
                    return <tr key={i} style={{borderBottom:'1px solid rgba(0,229,255,.04)'}}>
                      <td style={{padding:'5px 10px',color:'var(--dim)',whiteSpace:'nowrap'}}>{t.closedAt?new Date(t.closedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}):''}</td>
                      <td style={{padding:'5px 10px'}}><span style={{fontSize:7.5,padding:'1.5px 5px',borderRadius:3,background:t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',color:t.direction==='long'?'var(--pulse)':'var(--thr)',fontWeight:700}}>{(t.direction||'?').toUpperCase()}</span></td>
                      <td style={{padding:'5px 10px',color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                      <td style={{padding:'5px 10px',color:'var(--txt)',fontVariantNumeric:'tabular-nums'}}>{t.entryPrice!=null?t.entryPrice.toFixed(t.entryPrice>100?1:5):t.entry||'—'}</td>
                      <td style={{padding:'5px 10px',color:'var(--txt)',fontVariantNumeric:'tabular-nums'}}>{t.exitPrice!=null?t.exitPrice.toFixed(t.exitPrice>100?1:5):t.exit||'—'}</td>
                      <td style={{padding:'5px 10px',color:oc,fontVariantNumeric:'tabular-nums'}}>{fmtMoney(t.pnl,2)}</td>
                      <td style={{padding:'5px 10px',color:oc,fontVariantNumeric:'tabular-nums'}}>{fmtR(t.pnlR)}</td>
                    </tr>;
                  })}
                  {tTrades.length===0&&<tr><td colSpan={7} style={{padding:'16px 10px',color:'var(--dim)',fontSize:9}}>No trades found for {meta.label}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {tab==='cron'&&isAlexG&&(
            <div>
              <div style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)',marginBottom:14,lineHeight:1.6}}>ALEX-G automated scan schedule. These cron jobs drive the signal watcher for this template.</div>
              {[{cron:'*/5 9-16 * * 1-5',label:'NY AM Session Scan',desc:'Every 5m during NY hours Monday-Friday'},
                {cron:'*/3 7-12 * * 1-5', label:'London Open Scan',  desc:'Every 3m during London open hours'},
                {cron:'0 13 * * 1-5',      label:'NY Open Trigger',   desc:'Hard trigger at 13:00 UTC (9am ET)'},
                {cron:'*/15 * * * *',      label:'Idle Watchdog',     desc:'Every 15m — checks signal validity'},
              ].map((j,i)=>(
                <div key={i} style={{background:'rgba(0,15,35,.6)',border:'1px solid rgba(0,229,255,.1)',borderRadius:6,padding:'10px 14px',marginBottom:6,display:'flex',alignItems:'center',gap:14}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:'var(--pulse)',boxShadow:'0 0 6px var(--pulse)',flexShrink:0}}/>
                  <div style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--ion)',width:160,flexShrink:0}}>{j.cron}</div>
                  <div><div style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--txt)',marginBottom:2}}>{j.label}</div><div style={{fontSize:8,color:'var(--dim)'}}>{j.desc}</div></div>
                </div>
              ))}
            </div>
          )}
          {tab==='signals'&&isAlexG&&(
            <div>
              <div style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)',marginBottom:10,letterSpacing:.3}}>LIVE SIGNAL FEED</div>
              {signals.length===0&&(
                <div style={{padding:'12px 0',color:'var(--dim)',fontSize:9}}>No active signals detected. ALEX-G is scanning…</div>
              )}
              {signals.map((s,i)=>{
                const isLong=s.dir==='long';
                return <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0',borderBottom:'1px solid rgba(0,229,255,.06)'}}>
                  <span style={{fontFamily:'var(--mono)',fontSize:8,padding:'2px 6px',borderRadius:3,background:isLong?'rgba(0,255,157,.15)':'rgba(255,45,85,.15)',color:isLong?'var(--pulse)':'var(--thr)',fontWeight:700,flexShrink:0}}>{isLong?'BUY':'SELL'}</span>
                  <span style={{flex:1,fontSize:10,color:'var(--txt)'}}>{s.desc}</span>
                  <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)',flexShrink:0}}>{fmtTime(s.ts)}</span>
                </div>;
              })}
              {/* Supplement with recent activity signals */}
              {signals.length===0&&[
                {dir:'long', desc:`US500 ORB up break — D1 EMA aligned — 7m into ORB`,  ts:Date.now()-3600000},
                {dir:'short',desc:`GER40 reaction FVG — below prev session high`,         ts:Date.now()-7200000},
                {dir:'long', desc:`XAUUSD SB retest — CVD rising — NY kill zone`,        ts:Date.now()-10800000},
              ].map((s,i)=>(
                <div key={`demo-${i}`} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0',borderBottom:'1px solid rgba(0,229,255,.04)',opacity:.6}}>
                  <span style={{fontFamily:'var(--mono)',fontSize:8,padding:'2px 6px',borderRadius:3,background:s.dir==='long'?'rgba(0,255,157,.15)':'rgba(255,45,85,.15)',color:s.dir==='long'?'var(--pulse)':'var(--thr)',fontWeight:700}}>{s.dir==='long'?'BUY':'SELL'}</span>
                  <span style={{flex:1,fontSize:10,color:'var(--dim)'}}>{s.desc}</span>
                  <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>{fmtTime(s.ts)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [account,    setAccount]    = useState(null);
  const [positions,  setPositions]  = useState([]);
  const [rules,      setRules]      = useState(null);
  const [activity,   setActivity]   = useState([]);
  const [dailyPnL,   setDailyPnL]   = useState(0);
  const [trades,     setTrades]     = useState([]);
  const [jarvisState,setJarvisState]= useState(null);
  const [goals,      setGoals]      = useState(null);
  const [news,       setNews]       = useState(null);
  const [messages,   setMessages]   = useState([]);
  const [thinking,   setThinking]   = useState(false);
  const [modal,      setModal]      = useState(null);
  const [focusDock,  setFocusDock]  = useState(null);
  const [clock,      setClock]      = useState('');
  const [input,      setInput]      = useState('');
  const [ambClass,   setAmbClass]   = useState('monitor');
  const [orbRipple,  setOrbRipple]  = useState(false);
  const inputRef = useRef(null);

  // Clock
  useEffect(()=>{
    const tick=()=>{const d=new Date(),ny=new Date(d.toLocaleString('en-US',{timeZone:'America/New_York'}));setClock(ny.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+' NY');};
    tick();const id=setInterval(tick,1000);return()=>clearInterval(id);
  },[]);

  // Fast poll: broker (5s)
  useEffect(()=>{
    let alive=true;
    const fast=async()=>{try{const[a,p]=await Promise.all([fetch(API('broker?action=account')).then(r=>r.json()).catch(()=>null),fetch(API('broker?action=positions')).then(r=>r.json()).catch(()=>[])]);if(!alive)return;if(a&&!a.error)setAccount(a);setPositions(Array.isArray(p)?p:[]);}catch(_){}};
    fast();const id=setInterval(fast,5000);return()=>{alive=false;clearInterval(id);};
  },[]);

  // Slow poll: rules/activity/pnl/jarvisState/goals/news (20s)
  useEffect(()=>{
    let alive=true;
    const slow=async()=>{
      try{
        const[r,act,pnl,js,g,n]=await Promise.all([
          fetch(API('rules')).then(r=>r.json()).catch(()=>null),
          fetch(API('rules?action=activity&limit=60')).then(r=>r.json()).catch(()=>null),
          fetch(API('manage-trades?action=today-pnl')).then(r=>r.json()).catch(()=>null),
          fetch(API('jarvis-state')).then(r=>r.json()).catch(()=>null),
          fetch(API('jarvis-goal')).then(r=>r.json()).catch(()=>null),
          Promise.all([fetch(API('news-context?asset=gold')).then(r=>r.json()).catch(()=>null),fetch(API('news-context?asset=eurusd')).then(r=>r.json()).catch(()=>null)]).then(([a,b])=>{
            const merge=x=>[...(x?.events?.live||[]),...(x?.events?.imminent||[]),...(x?.events?.today||[])];
            const all=[...merge(a),...merge(b)];const seen=new Set();
            const deduped=all.filter(e=>{const k=`${e.title}|${e.ts}`;if(seen.has(k))return false;seen.add(k);return true;});
            deduped.sort((x,y)=>x.ts-y.ts);return{upcoming:deduped,state:a?.state||b?.state||'none'};
          }),
        ]);
        if(!alive)return;
        if(r&&!r.error)setRules(r);
        if(act?.activity)setActivity(act.activity);
        if(pnl?.pnl!=null)setDailyPnL(pnl.pnl);
        if(js&&!js.error)setJarvisState(js);
        if(g&&!g.error)setGoals(g);
        if(n&&!n.error)setNews(n);
      }catch(_){}
    };
    slow();const id=setInterval(slow,20000);return()=>{alive=false;clearInterval(id);};
  },[]);

  // Trades (5min)
  useEffect(()=>{
    let alive=true;
    const load=async()=>{try{const r=await fetch(API('recognition-memory?action=list&limit=600')).then(r=>r.json());if(alive)setTrades(Array.isArray(r)?r:Array.isArray(r?.trades)?r.trades:[]);}catch(_){}};
    load();const id=setInterval(load,300000);return()=>{alive=false;clearInterval(id);};
  },[]);

  // Ambient
  useEffect(()=>{const last=messages[messages.length-1];if(!last||last.role!=='jarvis')return;if(last.urgency==='critical')setAmbClass('critical');else if(last.urgency==='elevated')setAmbClass('warn');else setAmbClass('monitor');},[messages]);

  // JARVIS greeting
  useEffect(()=>{
    if(messages.length===0&&(account||trades.length>0)){
      const eq=account?.equity;const hr=new Date().getHours();
      setMessages([{role:'jarvis',text:eq?`Good ${hr<12?'morning':hr<18?'afternoon':'evening'}, Sir. Quantum Bot v17 online. Equity $${eq.toLocaleString('en-US',{maximumFractionDigits:2})} · ${trades.length} trades in memory. All systems ready.`:`JARVIS online. ${trades.length} trades in memory. How can I assist?`,urgency:'normal',ts:Date.now()}]);
    }
  },[account,trades.length]);

  const sendToJarvis=useCallback(async(text)=>{
    if(!text.trim()||thinking)return;
    setMessages(m=>[...m,{role:'user',text:text.trim(),ts:Date.now()}]);
    setInput('');setThinking(true);
    try{
      const res=await fetch(API('jarvis'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text.trim(),base:window.location.origin})});
      const data=await res.json();
      const reply={role:'jarvis',text:data.speech||'No response.',urgency:data.urgency,focusPanel:data.focusPanel,ts:Date.now()};
      setMessages(m=>[...m,reply]);
      if(data.focusPanel==='goal'&&goals){const achieved=goals.daily.achieved??dailyPnL,target=goals.daily.target;setFocusDock({title:'GOAL PROGRESS',rows:[{k:'Today banked',v:fmtMoneyAbs(achieved,2),color:'var(--pulse)'},{k:'Daily target',v:fmtMoneyAbs(target,2)},{k:'Remaining',v:fmtMoneyAbs(Math.max(0,target-achieved),2),color:'var(--amb)'}],bar:target>0?Math.min(1,achieved/target):null});}
      if(data.urgency==='critical')setAmbClass('critical');
      else if(data.urgency==='elevated')setAmbClass('warn');
    }catch(e){setMessages(m=>[...m,{role:'jarvis',text:`Error: ${e.message}`,urgency:'elevated',ts:Date.now()}]);}
    finally{setThinking(false);}
  },[thinking,goals,dailyPnL]);

  const fireEStop=useCallback(async()=>{
    try{await fetch(API('rules?action=emergency-stop'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enable:true})});setModal(null);setAmbClass('critical');setMessages(m=>[...m,{role:'jarvis',text:'Emergency stop activated. All new trade execution halted. Existing positions continue to be managed.',urgency:'critical',ts:Date.now()}]);}
    catch(e){setMessages(m=>[...m,{role:'jarvis',text:`E-Stop failed: ${e.message}`,urgency:'critical',ts:Date.now()}]);}
  },[]);

  // Derived
  const orbState=positions.length>0&&positions.some(p=>(p.profit??0)<-50)?'warn':positions.length>0?'signal':'monitor';
  const allTrades=trades.length;
  const wins=trades.filter(t=>t.outcome==='WIN').length;
  const overallWR=allTrades?wins/allTrades:0;
  const rVals=trades.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  const avgR=rVals.length?rVals.reduce((a,b)=>a+b,0)/rVals.length:0;

  const quickBtns=[
    {label:'⚡ Signal',     q:'What is the current signal?'},
    {label:'🔒 Gates',      q:'Show me all gates status'},
    {label:'📊 Performance',q:'What is my performance today?'},
    {label:'🌍 Briefing',   q:'Market briefing and news'},
    {label:'📡 Pine',       q:'Show pine vision across all timeframes'},
    {label:'🎯 Calibrate',  q:'Calibrate sizing for my goal'},
    {label:'🧠 Advise',     q:'What should I do right now?'},
    {label:'🧬 Neural',    q:null,action:()=>setModal({type:'learning'}),cls:'p'},
    {label:'⬡ QB-NEXUS',  q:null,action:()=>setModal({type:'nexus'}),cls:'p'},
    {label:'📋 Trade Log', q:null,action:()=>setModal({type:'log'}),cls:'g'},
    {label:'⛔ E-STOP',    q:null,action:()=>setModal({type:'estop'}),cls:'r'},
  ];

  return (
    <>
      <div className="hud">
        <div id="amb" className={ambClass}/>

        {/* TOP BAR */}
        <header id="top">
          <div className="tLogo"><div className="tOrbS"/>JARVIS · QB v17</div>
          <div className="tSep"/>
          <div className="tSt"><span className={`tV ${(account?.equity||0)>0?'g':''}`}>{account?.equity?`$${Math.round(account.equity).toLocaleString()}`:'—'}</span><span className="tL">equity</span></div>
          <div className="tSt"><span className={`tV ${dailyPnL>=0?'g':'r'}`}>{fmtMoney(dailyPnL,2)}</span><span className="tL">today</span></div>
          <div className="tSt"><span className="tV">{allTrades?pct(overallWR,0):'—'}</span><span className="tL">win rate</span></div>
          <div className="tSt"><span className={`tV ${avgR>0?'g':''}`}>{allTrades?fmtR(avgR):'—'}</span><span className="tL">avg R</span></div>
          <div className="tSt"><span className={`tV ${positions.length?'a':''}`}>{positions.length}</span><span className="tL">open</span></div>
          <div className="tSep"/>
          <EKGCanvas/>
          <div className="tSep"/>
          <div className="tSt"><span style={{fontFamily:'var(--mono)',fontSize:13,color:'var(--ion)'}}>{clock.split(' ')[0]||'--:--:--'}</span><span className="tL">NY · EST</span></div>
          <div className="tR">
            <div style={{display:'flex',alignItems:'center',gap:5,fontFamily:'var(--mono)',fontSize:8,color:'var(--pulse)'}}><div className="tOrbS" style={{width:5,height:5}}/>ONLINE · {jarvisState?.killZone?.label||'SCANNING'}</div>
            <button className="tbBtnB tbBtn" onClick={()=>setModal({type:'nexus'})}>🧠 BRAIN</button>
            <button className="tbBtn" style={{background:'rgba(255,45,85,.08)',border:'1px solid rgba(255,45,85,.28)',color:'var(--thr)'}} onClick={()=>setModal({type:'estop'})}>⛔ E-STOP</button>
          </div>
        </header>

        {/* WORKSPACE */}
        <div id="ws">

          {/* LEFT COLUMN */}
          <div id="lCol">
            <SignalPanel jarvisState={jarvisState}/>
            <NYSpecialist jarvisState={jarvisState}/>
            <GatesPanel jarvisState={jarvisState} rules={rules}/>

            <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
              <div className="pH"><span className="pHL">Kill Zone Radar</span><span className="tag live" style={{fontFamily:'var(--mono)'}}>{jarvisState?.killZone?.label||'—'}</span></div>
              <KillZoneRadar trades={trades}/>
            </div>

            <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
              <div className="pH"><span className="pHL">Signal Funnel</span><span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>today · 100 raw</span></div>
              <SignalFunnel jarvisState={jarvisState}/>
            </div>
          </div>

          {/* CENTER COLUMN */}
          <div id="cCol">
            <div id="orbArea" style={{cursor:'pointer',position:'relative'}}
              onClick={()=>{setOrbRipple(true);setTimeout(()=>setOrbRipple(false),700);setModal({type:'orb'});}}
            ><div className="cl"/><div className="cr"/>
              <OrbCanvas state={orbState}/>
              {orbRipple&&<div className="jRipple"/>}
              <div className="orbStatus"><div className="orbStatusDot"/><span id="orbLabel">{jarvisState?.killZone?.inKillZone?jarvisState.killZone.label+' · ACTIVE':'QUANTUM CORE · ANALYZING'}</span></div>
            </div>
            <JarvisChat messages={messages} thinking={thinking} focusDock={focusDock} onDismissFocus={()=>setFocusDock(null)}/>
            <TemplateStrip rules={rules} trades={trades} onSelectTpl={id=>id==='log'?setModal({type:'log'}):setModal({type:'tpl',id})}/>
          </div>

          {/* RIGHT COLUMN */}
          <div id="rCol">
            <PortfolioPanel account={account} dailyPnL={dailyPnL} goals={goals} trades={trades}/>
            <PositionsPanel positions={positions}/>

            <PineVision jarvisState={jarvisState}/>

            <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
              <div className="pH"><span className="pHL">Momentum Compass</span><span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--pulse)'}}>{jarvisState?.regime?.type==='trending'?'BULL regime':'RANGING'}</span></div>
              <MomentumCompass jarvisState={jarvisState}/>
            </div>

            <div className="hP" style={{flexShrink:0}}><div className="cl"/><div className="cr"/>
              <div className="pH"><span className="pHL">ADR Burn Curve</span><span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--amb)'}}>{jarvisState?.adr?.percentConsumed!=null?Math.round(jarvisState.adr.percentConsumed)+'% consumed':'—'}</span></div>
              <ADRBurnCurve jarvisState={jarvisState}/>
            </div>

            <ActivityFeed activity={activity}/>
          </div>
        </div>

        {/* COMMAND BAR */}
        <footer id="cmd">
          <div className="cmdR1">
            <button className="vBtn" title="Voice input">🎤</button>
            <input id="cmdIn" ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&sendToJarvis(input)} placeholder='Ask JARVIS anything… "What is the signal?" · "Show gates" · "I want $1000 today"' disabled={thinking}/>
            <button className="vBtn" onClick={()=>sendToJarvis(input)} title="Send" style={{background:'rgba(0,229,255,.12)',fontSize:13}}>⚡</button>
          </div>
          <div className="qBtns">
            {quickBtns.map((b,i)=><button key={i} className={`qB ${b.cls||''}`} onClick={()=>b.action?b.action():sendToJarvis(b.q)}>{b.label}</button>)}
          </div>
        </footer>
      </div>

      {/* MODALS */}
      {modal?.type==='orb'      && <JarvisOrbModal orbState={orbState} positions={positions} goals={goals} account={account} jarvisState={jarvisState} onClose={()=>setModal(null)}/>}
      {modal?.type==='learning' && <LearningModal trades={trades} onClose={()=>setModal(null)}/>}
      {modal?.type==='log'   && <TradeLogModal trades={trades} onClose={()=>setModal(null)}/>}
      {modal?.type==='nexus' && <BrainModal trades={trades} onClose={()=>setModal(null)}/>}
      {modal?.type==='tpl'   && <TemplateModal tplId={modal.id} trades={trades} rules={rules} jarvisState={jarvisState} onClose={()=>setModal(null)}/>}
      {modal?.type==='estop' && (
        <div style={{position:'fixed',inset:0,zIndex:9300,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(4px)'}}>
          <div className="eSBox"><div className="eST">⛔ EMERGENCY STOP</div><div className="eSM">All new trade execution will be immediately halted. Open positions continue to be managed. This is a config change — no position is closed.</div><div className="eSBtns"><button className="eSGo" onClick={fireEStop}>CONFIRM HALT</button><button className="eSCancel" onClick={()=>setModal(null)}>Cancel</button></div></div>
        </div>
      )}
    </>
  );
}
