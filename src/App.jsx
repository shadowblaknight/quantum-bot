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

function NexusModal({trades,onClose}) {
  const nexus=useMemo(()=>computeNexus(trades),[trades]);
  if(!nexus) return (
    <div style={{position:'fixed',inset:0,zIndex:9200,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(7px)'}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--panel)',border:'1px solid rgba(167,139,250,.4)',borderRadius:10,padding:24,textAlign:'center',maxWidth:400}}><div style={{color:'var(--pur)',fontFamily:'var(--mono)',fontSize:14,fontWeight:800,marginBottom:8}}>⬡ QB-NEXUS</div><div style={{color:'var(--dim)',fontSize:10}}>Need ≥ 10 closed trades</div><button className="nexClose" style={{marginTop:16}} onClick={onClose}>Close</button></div>
    </div>
  );
  const realWR=pct(nexus.nexusWR,1),baseWR=pct(nexus.overallWR,1),lift=((nexus.nexusWR-nexus.overallWR)*100).toFixed(1);
  return (
    <div style={{position:'fixed',inset:0,zIndex:9200,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(6px)'}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--panel)',border:'1px solid rgba(167,139,250,.45)',borderRadius:10,width:'min(680px,94%)',padding:26,boxShadow:'0 0 60px rgba(167,139,250,.12)',maxHeight:'88vh',overflowY:'auto'}}>
        <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:4}}><div style={{fontFamily:'var(--mono)',fontSize:17,color:'var(--pur)',fontWeight:800,letterSpacing:'1.5px',flex:1}}>⬡ QB-NEXUS · Real Analysis</div><button style={{background:'none',border:'none',color:'var(--dim)',fontSize:17,cursor:'pointer'}} onClick={onClose}>✕</button></div>
        <div style={{fontSize:10,color:'var(--dim)',marginBottom:16,lineHeight:1.5}}>{nexus.total} trades analysed across all templates.</div>
        <div className="nexGrid">
          <div className="nexCard"><div className="nexCT">Nexus WR</div><div className="nexCV" style={{color:'var(--pulse)'}}>{realWR}</div><div className="nexCL">vs {baseWR} ({lift}pp lift)</div></div>
          <div className="nexCard"><div className="nexCT">Nexus Avg R</div><div className="nexCV" style={{color:'var(--ion)'}}>{fmtR(nexus.nexusAvgR)}</div><div className="nexCL">vs {fmtR(nexus.overallAvgR)} overall</div></div>
          <div className="nexCard"><div className="nexCT">Confidence</div><div className="nexCV" style={{color:'var(--pur)'}}>{nexus.confidence}</div><div className="nexCL">{nexus.nexusSample} qualifying trades</div></div>
        </div>
        <div className="nexRec"><b>⬡ QB-NEXUS</b> optimal conditions from real data:<br/>{nexus.bestTpl&&<><b>Best template:</b> {tplLabel(nexus.bestTpl.id)} ({pct(nexus.bestTpl.wr,1)} WR, {nexus.bestTpl.total} trades)<br/></>}{nexus.bestSess&&<><b>Best session:</b> {sessLabel(nexus.bestSess.id)} ({pct(nexus.bestSess.wr,1)} WR, {nexus.bestSess.total} trades)<br/></>}<b>No-news filter applied</b> · {nexus.nexusSample} qualifying trades · {realWR} WR · {fmtR(nexus.nexusAvgR)} avg R</div>
        <div className="nexBtns"><button className="nexGen" onClick={onClose}>⬡ APPLY NEXUS</button><button className="nexClose" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function TemplateModal({tplId,trades,rules,onClose}) {
  const meta=TPLS_META[tplId]||{glyph:'⊕',label:tplId};
  const tTrades=useMemo(()=>(trades||[]).filter(t=>t.template===tplId),[trades,tplId]);
  const wins=tTrades.filter(t=>t.outcome==='WIN').length;
  const wr=tTrades.length?wins/tTrades.length:0;
  const rVals=tTrades.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  const avgR=rVals.length?rVals.reduce((a,b)=>a+b,0)/rVals.length:0;
  const recent=tTrades.slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,50);
  return (
    <div style={{position:'fixed',inset:0,zIndex:9200,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(7px)'}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--panel)',border:'1px solid rgba(0,229,255,.22)',borderRadius:10,width:'min(800px,96vw)',maxHeight:'88vh',overflow:'hidden',display:'flex',flexDirection:'column'}}>
        <div style={{display:'flex',alignItems:'center',gap:9,padding:'12px 16px',borderBottom:'1px solid rgba(0,229,255,.1)',flexShrink:0}}><span style={{fontSize:20}}>{meta.glyph}</span><span style={{fontFamily:'var(--mono)',fontSize:14,color:'var(--ion)',fontWeight:700,flex:1}}>{meta.label}</span><button style={{background:'none',border:'none',color:'var(--dim)',fontSize:17,cursor:'pointer'}} onClick={onClose}>✕</button></div>
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px'}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:7,marginBottom:12}}>
            {[{v:pct(wr,1),l:'Win Rate',c:'var(--pulse)'},{v:fmtR(avgR),l:'Avg R',c:'var(--ion)'},{v:tTrades.length,l:'Trades',c:'var(--txt)'}].map((s,i)=>(
              <div key={i} style={{background:'rgba(0,20,48,.5)',border:'1px solid var(--b)',borderRadius:5,padding:7,textAlign:'center'}}><div style={{fontFamily:'var(--mono)',fontSize:14,fontWeight:200,color:s.c}}>{s.v}</div><div style={{fontSize:7.5,color:'var(--dim)',textTransform:'uppercase',letterSpacing:.3,marginTop:2}}>{s.l}</div></div>
            ))}
          </div>
          <div style={{display:'flex',gap:1.5,margin:'10px 0',overflow:'hidden',height:24,borderRadius:4}}>
            {tTrades.slice(-60).map((t,i)=><div key={i} style={{flex:1,minWidth:4,background:t.outcome==='WIN'?'rgba(0,255,157,.7)':t.outcome==='LOSS'?'rgba(255,45,85,.7)':'rgba(0,229,255,.25)',borderRadius:1}}/>)}
            {tTrades.length===0&&<div style={{color:'var(--dim)',fontSize:9,padding:'4px 0'}}>No trade data</div>}
          </div>
          <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--mono)',fontSize:'9.5px'}}><thead><tr style={{color:'var(--dim)',borderBottom:'1px solid rgba(0,229,255,.1)'}}>{['Time','Asset','Dir','Session','Outcome','PnL','R'].map(h=><th key={h} style={{textAlign:'left',padding:'4px 7px',fontWeight:400}}>{h}</th>)}</tr></thead>
          <tbody>{recent.map((t,i)=>{const oc=t.outcome==='WIN'?'var(--pulse)':t.outcome==='LOSS'?'var(--thr)':'var(--dim)';return<tr key={i} style={{borderBottom:'1px solid rgba(0,229,255,.04)'}}><td style={{padding:'4px 7px',color:'var(--dim)'}}>{fmtTime(t.closedAt)}</td><td style={{padding:'4px 7px',color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td><td style={{padding:'4px 7px'}}><span style={{fontSize:7,padding:'1px 4px',borderRadius:3,background:t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',color:t.direction==='long'?'var(--pulse)':'var(--thr)'}}>{(t.direction||'?').toUpperCase()}</span></td><td style={{padding:'4px 7px',color:'var(--dim)'}}>{sessLabel(t.session)}</td><td style={{padding:'4px 7px',color:oc}}>{t.outcome}</td><td style={{padding:'4px 7px',color:oc}}>{fmtMoney(t.pnl,2)}</td><td style={{padding:'4px 7px',color:oc}}>{fmtR(t.pnlR)}</td></tr>;})}
          </tbody></table></div>
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
    {label:'⬡ QB-NEXUS',   q:null,action:()=>setModal({type:'nexus'}),cls:'p'},
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
            <div id="orbArea"><div className="cl"/><div className="cr"/>
              <OrbCanvas state={orbState}/>
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
      {modal?.type==='log'   && <TradeLogModal trades={trades} onClose={()=>setModal(null)}/>}
      {modal?.type==='nexus' && <NexusModal trades={trades} onClose={()=>setModal(null)}/>}
      {modal?.type==='tpl'   && <TemplateModal tplId={modal.id} trades={trades} rules={rules} onClose={()=>setModal(null)}/>}
      {modal?.type==='estop' && (
        <div style={{position:'fixed',inset:0,zIndex:9300,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,11,24,.9)',backdropFilter:'blur(4px)'}}>
          <div className="eSBox"><div className="eST">⛔ EMERGENCY STOP</div><div className="eSM">All new trade execution will be immediately halted. Open positions continue to be managed. This is a config change — no position is closed.</div><div className="eSBtns"><button className="eSGo" onClick={fireEStop}>CONFIRM HALT</button><button className="eSCancel" onClick={()=>setModal(null)}>Cancel</button></div></div>
        </div>
      )}
    </>
  );
}
