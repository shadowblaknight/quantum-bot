/* eslint-disable */
import { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';

// ── Constants ────────────────────────────────────────────────────────────────
const GATE_API = '/api/gating-rules';
const INSTRUMENTS = ['gold','nas100','us500','btc'];
const IL = { gold:'GOLD', nas100:'NAS100', us500:'US500', btc:'BTC' };
const FORCED = new Set(['reaction-ifvg|*|gold']);
const SOFF = new Set([
  'orb|*|btc','orb|*|nas100','reaction|*|gold','reaction|*|us500','reaction|*|nas100',
  'reaction-fvg|*|gold','reaction-fvg|*|us500','reaction-fvg|*|nas100',
  'reaction-ifvg|*|us500','reaction-ifvg|*|nas100','orb-pro|*|gold'
]);
const GATE_GROUPS = [
  { name:'QB GOLD', color:'#D4A017', templates:[
    {id:'gold-fvg',sub:'FVG London/NY'},{id:'gold-judas',sub:'Asian Sweep'},
    {id:'gold-sb',sub:'SB 15-16'},{id:'gold-reaction',sub:'Psych'}]},
  { name:'QB ICT', color:'#0EA5E9', templates:[
    {id:'judas-swing',sub:'Sweep'},{id:'silver-bullet',sub:'15-16'},{id:'am-ifvg',sub:'AM IFVG'}]},
  { name:'QB REACT', color:'#8B5CF6', templates:[
    {id:'reaction',sub:'Coil'},{id:'reaction-fvg',sub:'FVG'},{id:'reaction-ifvg',sub:'IFVG'}]},
  { name:'QB ORB', color:'#22C55E', templates:[
    {id:'orb',sub:'ORB'},{id:'orb-pro',sub:'ORB Pro'}]},
];
const VERTS = [[0,1,0],[1,0,.3],[.3,0,1],[-1,0,.3],[-.3,0,-1],[.3,0,-1],[0,-1,0]];
const EDGES = [[0,1],[0,2],[0,3],[0,4],[0,5],[1,2],[2,3],[3,4],[4,5],[5,1],[6,1],[6,2],[6,3],[6,4],[6,5]];
const rng = (a,b) => a + Math.random()*(b-a);
const KW=290, KH=160;
const KNN_WINS = Array.from({length:10},()=>({x:rng(15,KW-55),y:rng(12,KH-12),a:rng(0,Math.PI*2)}));
const KNN_LOSS = Array.from({length:2},()=>({x:rng(KW*.55,KW-15),y:rng(KH*.5,KH-12),a:rng(0,Math.PI*2)}));
const KNN_TOD = {x:KW/2,y:KH/2};
const KNN_NEAR = [...KNN_WINS].sort((a,b)=>(a.x-KNN_TOD.x)**2+(a.y-KNN_TOD.y)**2-(b.x-KNN_TOD.x)**2-(b.y-KNN_TOD.y)**2).slice(0,5);
const RAD_AX = ['HTF Bias','Session','Pattern','News','Volume','ML Score'];
const RAD_SC = [87,75,90,70,62,87];
const ADR14  = 28; // 14-day average daily range for gold in points

// ADR zone thresholds (research-based)
const ADR_ZONES = [
  {min:250, label:'OUTLIER 250%+', col:'#EF4444', short:'OUTLIER',
   guide:'Stop fighting momentum. Only look for structural exhaustion at 250-300%+'},
  {min:150, label:'NEWS EXTENSION', col:'#F59E0B', short:'NEWS EXT',
   guide:'Ignore 14-day ADR. Use largest single expansion bar of prev month as ceiling'},
  {min:90,  label:'EXHAUSTION ZONE', col:'#F59E0B', short:'EXHAUST',
   guide:'Standard ceiling. Look for liquidity grabs then reversal — no blind entries'},
  {min:75,  label:'HIGH PROB ZONE', col:'#22C55E', short:'HIGH PROB',
   guide:'Pull TP to 75% ADR on quiet days. Reliable conservative target zone'},
  {min:0,   label:'BUILDING', col:'#0EA5E9', short:'BUILDING',
   guide:'Day range in progress. Full targets valid. Monitor for session momentum'},
];

// ── Data helpers ─────────────────────────────────────────────────────────────
function buildCalData(trades) {
  const now = new Date();
  const byDay = {};
  trades.forEach(t => {
    if(!t.closedAt) return;
    const d = new Date(t.closedAt);
    if(d.getUTCFullYear()!==now.getUTCFullYear()||d.getUTCMonth()!==now.getUTCMonth()) return;
    const day = d.getUTCDate();
    byDay[day] = (byDay[day]||0) + (t.netPnl||0);
  });
  return Object.entries(byDay).map(([d,p])=>({d:parseInt(d),p:Math.round(p)})).sort((a,b)=>a.d-b.d);
}

function buildWeekData(trades) {
  const now = new Date();
  const dow0 = now.getUTCDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((dow0+6)%7));
  monday.setUTCHours(0,0,0,0);
  const byDow={0:0,1:0,2:0,3:0,4:0};
  trades.forEach(t => {
    if(!t.closedAt) return;
    const d = new Date(t.closedAt);
    if(d<monday) return;
    const dow=(d.getUTCDay()+6)%7;
    if(dow<5) byDow[dow]+=(t.netPnl||0);
  });
  return ['Mon','Tue','Wed','Thu','Fri'].map((d,i)=>({d,p:Math.round(byDow[i])}));
}

function buildEqFromLedger(trades, template, n=30) {
  const filtered = trades
    .filter(t=>!template||(t.template||'').includes(template.split('-')[1]||template))
    .sort((a,b)=>new Date(a.closedAt)-new Date(b.closedAt))
    .slice(-n);
  if(filtered.length<2) return null;
  let cum=0; const pts=[0];
  filtered.forEach(t=>{cum+=(t.netPnl||0); pts.push(Math.round(cum));});
  return pts;
}

function fmtPx(p) { return p!=null ? p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,' ') : '--'; }
function fmtPnl(v,decimals=0) {
  if(v==null) return '--';
  return (v>=0?'+':'-')+'$'+Math.abs(v).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g,',');
}
function fmtPct(v,decimals=1) { return v!=null ? (v*100).toFixed(decimals)+'%' : '--'; }

// ── Canvas helpers ────────────────────────────────────────────────────────────
function drawEQ(canvas, data, col, fill) {
  if(!canvas||!data?.length) return;
  canvas.width=canvas.offsetWidth||canvas.width; canvas.height=canvas.offsetHeight||canvas.height;
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  const mn=Math.min(...data),mx=Math.max(...data),rg=mx-mn||1;
  const pts=data.map((v,i)=>[i/(data.length-1)*W,H-4-((v-mn)/rg)*(H-8)]);
  ctx.fillStyle='#0C0C1A';ctx.fillRect(0,0,W,H);
  ctx.beginPath();ctx.moveTo(pts[0][0],H);pts.forEach(p=>ctx.lineTo(p[0],p[1]));
  ctx.lineTo(pts[pts.length-1][0],H);ctx.closePath();ctx.fillStyle=fill;ctx.fill();
  ctx.beginPath();pts.forEach((p,i)=>i===0?ctx.moveTo(p[0],p[1]):ctx.lineTo(p[0],p[1]));
  ctx.strokeStyle=col;ctx.lineWidth=2;ctx.stroke();
  const ep=pts[pts.length-1];
  ctx.beginPath();ctx.arc(ep[0],ep[1],3,0,Math.PI*2);
  ctx.fillStyle=col;ctx.shadowColor=col;ctx.shadowBlur=6;ctx.fill();ctx.shadowBlur=0;
}

function drawCalCanvas(canvas, days) {
  if(!canvas) return;
  canvas.width=canvas.parentElement?.offsetWidth||500; canvas.height=160;
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  const data = days?.length ? days : [{d:1,p:0}];
  const maxP=Math.max(...data.map(d=>Math.abs(d.p)),200);
  const bw=Math.floor((W-40)/data.length)-3,midY=H/2;
  ctx.fillStyle='#07070F';ctx.fillRect(0,0,W,H);
  const todayD=new Date().getUTCDate();
  let prog=0;
  const frame=()=>{
    ctx.fillStyle='#07070F';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(26,26,46,.8)';ctx.lineWidth=1;ctx.setLineDash([2,4]);
    ctx.beginPath();ctx.moveTo(20,midY);ctx.lineTo(W-10,midY);ctx.stroke();ctx.setLineDash([]);
    data.forEach((day,i)=>{
      const x=22+i*(bw+3),ph=Math.min(1,prog);
      const barH=((Math.abs(day.p)/maxP)*(midY-14))*ph;
      if(barH<1){ctx.fillStyle='rgba(64,64,80,.3)';ctx.fillRect(x,midY-1,bw,2);} else {
        const isToday=day.d===todayD;
        const col=day.p>0?(isToday?'rgba(212,160,23,.9)':'rgba(34,197,94,.75)'):'rgba(239,68,68,.7)';
        const y=day.p>0?midY-barH:midY;
        ctx.fillStyle=col;
        if(isToday){ctx.shadowColor='#D4A017';ctx.shadowBlur=8;}
        ctx.fillRect(x,y,bw,barH);ctx.shadowBlur=0;
        if(ph>.8){
          ctx.fillStyle=isToday?'#D4A017':day.p>0?'rgba(34,197,94,.9)':'rgba(239,68,68,.9)';
          ctx.font=`${isToday?'800':'700'} 8px system-ui`;ctx.textAlign='center';
          const label=(day.p>0?'+':'')+Math.round(day.p*ph/100)*100;
          ctx.fillText(label,x+bw/2,day.p>0?midY-barH-3:midY+barH+11);
        }
        ctx.fillStyle=isToday?'#D4A017':'rgba(96,96,128,.7)';
        ctx.font=`${isToday?'800':'600'} 8px system-ui`;ctx.textAlign='center';
        ctx.fillText(day.d,x+bw/2,H-3);
      }
    });
    ctx.textAlign='left';prog=Math.min(1,prog+.04);
    if(prog<1) requestAnimationFrame(frame);
  };
  frame();
}

function drawDXYCanvas(canvas) {
  if(!canvas) return;
  canvas.width=canvas.parentElement?.offsetWidth||300; canvas.height=160;
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  const hist=[[-0.4,0.38],[-0.2,0.22],[0.1,-0.09],[0.3,-0.28],[0.5,-0.44],[-0.3,0.31],[0.0,0.05],[-0.5,0.48],[0.2,-0.19],[0.4,-0.35],[-0.1,0.08],[0.3,-0.25],[0.6,-0.52],[-0.2,0.18],[0.1,-0.07],[-0.4,0.39],[0.5,-0.46],[-0.3,0.29],[0.2,-0.17],[0.32,-0.07]];
  const today=hist[hist.length-1];
  const px=v=>(v+0.7)/1.4*(W-30)+15,py=v=>(-(v-0.6)/1.2)*(H-30)+15;
  ctx.fillStyle='#07070F';ctx.fillRect(0,0,W,H);
  const cy0=py(0),cx0=px(0);
  ctx.strokeStyle='rgba(40,40,64,.9)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(15,cy0);ctx.lineTo(W-10,cy0);ctx.stroke();
  ctx.beginPath();ctx.moveTo(cx0,10);ctx.lineTo(cx0,H-10);ctx.stroke();
  ctx.fillStyle='rgba(64,64,96,.7)';ctx.font='700 7px system-ui';ctx.textAlign='center';
  ctx.fillText('DXY %',W/2,H-2);
  ctx.save();ctx.translate(8,H/2);ctx.rotate(-Math.PI/2);ctx.fillText('Gold %',0,0);ctx.restore();
  ctx.textAlign='left';
  ctx.strokeStyle='rgba(139,92,246,.3)';ctx.lineWidth=1.5;ctx.setLineDash([3,5]);
  ctx.beginPath();ctx.moveTo(px(-0.7),py(0.7*0.92));ctx.lineTo(px(0.7),py(-0.7*0.92));ctx.stroke();ctx.setLineDash([]);
  hist.slice(0,-1).forEach(([dx,gx])=>{
    ctx.fillStyle=gx>0?'rgba(34,197,94,.55)':'rgba(239,68,68,.55)';
    ctx.beginPath();ctx.arc(px(dx),py(gx),3.5,0,Math.PI*2);ctx.fill();
  });
  ctx.fillStyle='rgba(212,160,23,.15)';ctx.beginPath();ctx.arc(px(today[0]),py(today[1]),10,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#D4A017';ctx.shadowColor='#D4A017';ctx.shadowBlur=8;
  ctx.beginPath();ctx.arc(px(today[0]),py(today[1]),5,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
  ctx.fillStyle='#D4A017';ctx.font='700 8px system-ui';ctx.textAlign='center';
  ctx.fillText('TODAY',px(today[0]),py(today[1])-10);ctx.textAlign='left';
  ctx.fillStyle='rgba(139,92,246,.8)';ctx.font='700 8px system-ui';ctx.fillText('r = -0.82',W-54,14);
}

function drawHeatCanvas(canvas) {
  if(!canvas) return;
  canvas.width=canvas.parentElement?.offsetWidth||800; canvas.height=80;
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  const WR48=[42,40,38,36,35,34,33,32,34,36,38,40,42,41,39,37,68,76,84,89,87,85,82,78,72,66,58,52,48,44,42,40,70,76,83,88,90,87,82,76,75,69,62,55,50,46,43,40,38,36,34,32];
  const n=new Date(),nowCell=Math.floor((n.getUTCHours()*60+n.getUTCMinutes())/30);
  const cw=W/48,ch=H-10;
  ctx.fillStyle='#07070F';ctx.fillRect(0,0,W,H);
  WR48.forEach((wr,i)=>{
    const x=i*cw;let r,g,b;
    if(wr<50){const t=(wr-28)/22;r=239;g=Math.round(68+t*90);b=68;}
    else if(wr<75){const t=(wr-50)/25;r=Math.round(245-t*211);g=Math.round(158+t*39);b=Math.round(11+t*83);}
    else{r=34;g=197;b=94;}
    if(wr>80){ctx.shadowColor='rgba(34,197,94,.5)';ctx.shadowBlur=4;}
    ctx.fillStyle=`rgba(${r},${g},${b},.78)`;ctx.fillRect(x+1,2,cw-2,ch-2);ctx.shadowBlur=0;
    if(i===nowCell){ctx.strokeStyle='#D4A017';ctx.lineWidth=2;ctx.strokeRect(x+1,2,cw-2,ch-2);}
    if(wr>82||i===nowCell){ctx.fillStyle='rgba(0,0,0,.75)';ctx.font='700 6px system-ui';ctx.textAlign='center';ctx.fillText(wr+'%',x+cw/2,2+ch/2+3);}
  });
  ctx.fillStyle='rgba(34,197,94,.15)';ctx.fillRect(16*cw,H-9,8*cw,8);
  ctx.fillStyle='rgba(14,165,233,.15)';ctx.fillRect(26*cw,H-9,10*cw,8);
  ctx.fillStyle='rgba(212,160,23,.8)';ctx.font='700 6px system-ui';ctx.textAlign='center';
  ctx.fillText('LDN KZ',20*cw,H-2);ctx.fillText('NY SB',31*cw,H-2);ctx.textAlign='left';
}

function drawWeekCanvas(canvas, days) {
  if(!canvas) return;
  canvas.width=canvas.parentElement?.offsetWidth||500; canvas.height=70;
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  const data=days?.length?days:['Mon','Tue','Wed','Thu','Fri'].map(d=>({d,p:0}));
  const maxP=Math.max(...data.map(d=>Math.abs(d.p)),200);
  const bw=Math.floor((W-40)/data.length)-8;
  ctx.fillStyle='#07070F';ctx.fillRect(0,0,W,H);
  let prog=0;
  const frame=()=>{
    ctx.fillStyle='#07070F';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(26,26,46,.9)';ctx.lineWidth=1;ctx.setLineDash([2,4]);
    ctx.beginPath();ctx.moveTo(10,H/2-5);ctx.lineTo(W-10,H/2-5);ctx.stroke();ctx.setLineDash([]);
    data.forEach((day,i)=>{
      const x=16+i*(bw+8),ph=Math.min(1,prog);
      const barH=(Math.abs(day.p)/maxP)*(H/2-12)*ph;
      if(barH>0){
        const y=day.p>0?H/2-5-barH:H/2-5;
        ctx.fillStyle=day.p>0?'rgba(34,197,94,.7)':'rgba(239,68,68,.5)';
        ctx.fillRect(x,y,bw,Math.max(barH,1));
        if(day.p!==0&&ph>.7){
          ctx.fillStyle=day.p>0?'rgba(34,197,94,.85)':'rgba(239,68,68,.85)';
          ctx.font='700 8px system-ui';ctx.textAlign='center';
          ctx.fillText((day.p>0?'+':'')+Math.round(day.p*ph),x+bw/2,y+(day.p>0?-3:barH+10));
        }
      }
      ctx.fillStyle=day.p!==0?'rgba(34,197,94,.8)':'rgba(64,64,80,.6)';
      ctx.font='700 7px system-ui';ctx.textAlign='center';ctx.fillText(day.d,x+bw/2,H-2);
    });
    ctx.textAlign='left';prog=Math.min(1,prog+.05);
    if(prog<1) requestAnimationFrame(frame);
  };
  frame();
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  // ── UI state ───────────────────────────────────────────────────────────────
  const [utcTime, setUtcTime]       = useState('--:--:--');
  const [pnl, setPnl]               = useState(0);
  const [lot, setLot]               = useState(10);
  const [curRR, setCurRR]           = useState(1);
  const [dayGoalInput, setDayGoalInput] = useState(1400);
  const [wkGoalInput, setWkGoalInput]   = useState(6500);
  const [dayPct, setDayPct]         = useState(0);
  const [wkPct, setWkPct]           = useState(0);
  const [dayGoalDisp, setDayGoalDisp]   = useState('$1,400');
  const [wkGoalDisp, setWkGoalDisp]     = useState('$6,500');
  const [jFilter, setJFilter]       = useState('all');
  const [deletedIds, setDeletedIds] = useState(new Set());
  const [tplEnabled, setTplEnabled] = useState({G:true,I:true,R:true});
  const [gRules, setGRules]         = useState({});
  const [gSession, setGSession]     = useState('*');
  const [gLive, setGLive]           = useState(false);
  const [gStatusCls, setGStatusCls] = useState('wa');
  const [gStatusTxt, setGStatusTxt] = useState('⬤ Preview');
  const [toast, setToast]           = useState(null);

  // ── API data state ─────────────────────────────────────────────────────────
  const [quote, setQuote]       = useState(null);   // /api/quotes?asset=gold
  const [acct, setAcct]         = useState(null);   // /api/dashboard-feed?action=summary
  const [openPos, setOpenPos]   = useState(null);   // /api/dashboard-feed?action=positions
  const [ledger, setLedger]     = useState([]);     // /api/ledger?action=list
  const [tplPerf, setTplPerf]   = useState(null);   // /api/template-performance?days=30

  // ── Derived from real data (with fallbacks) ────────────────────────────────
  const realPrice    = quote?.price ?? null;
  const realChange   = quote?.change ?? null;
  const realHigh     = quote?.high ?? null;
  const realLow      = quote?.low ?? null;
  const todayPnL     = acct?.account?.todaysPnL ?? pnl;
  const accountBal   = acct?.account?.balance ?? 10000;
  const todayPnLPct  = acct?.account?.todaysPnLPct ?? null;

  // Ledger-derived
  const calDays  = ledger.length ? buildCalData(ledger) : [];
  const weekDays = ledger.length ? buildWeekData(ledger) : [];
  const weekPnL  = weekDays.reduce((s,d)=>s+(d.p||0),0);
  const mtdPnL   = calDays.reduce((s,d)=>s+(d.p||0),0);

  // Template perf helpers
  const perfFor    = t => tplPerf?.byTemplate?.[t] ?? null;
  const wrStr      = t => { const p=perfFor(t); return p?.winRate!=null ? (p.winRate*100).toFixed(1)+'%' : '--'; };
  const avgRStr    = t => { const p=perfFor(t); return p?.avgR!=null ? p.avgR.toFixed(2)+'R' : '--'; };
  const pfStr      = t => { const p=perfFor(t); return p?.profitFactor!=null ? p.profitFactor.toFixed(2) : '--'; };
  const tplSample  = t => { const p=perfFor(t); return p?.sample ?? ledger.filter(x=>x.template===t).length; };
  const tplNetPnL  = t => {
    const trades=ledger.filter(x=>x.template===t);
    const net=trades.reduce((s,x)=>s+(x.netPnl||0),0);
    return trades.length ? fmtPnl(net) : '--';
  };

  // Overall stats
  const ov          = tplPerf?.overall;
  const ovWR        = ov?.winRate!=null ? (ov.winRate*100).toFixed(1)+'%' : '--';
  const ovAvgR      = ov?.avgR!=null ? ov.avgR.toFixed(2)+'R' : '--';
  const ovPF        = ov?.profitFactor!=null ? ov.profitFactor.toFixed(2) : '--';
  const ovTrades    = ov?.sample ?? tplPerf?.totalTrades ?? 0;
  const ovWins      = ov?.wins ?? 0;

  // Streak (consecutive wins from ledger, most recent first)
  const streak = (() => {
    const sorted=[...ledger].sort((a,b)=>new Date(b.closedAt)-new Date(a.closedAt));
    let s=0; for(const t of sorted){ if(t.outcome==='WIN') s++; else break; } return s;
  })();

  // Equity curve data (real if available, fallback to static)
  const EQ_G_FB=[0,1.2,.8,2.1,1.8,3.4,2.9,4.2,3.8,5.1,4.7,6.3,5.8,7.2,6.9,8.4,8.1,9.6,9.2,10.8];
  const EQ_I_FB=[0,.8,.4,1.6,1.2,2.3,3.1,2.7,4.2,3.8,5.1,4.6,5.9,5.3,6.8,6.1,7.5,6.9,8.3,7.8];
  const EQ_R_FB=[0,.6,.2,1.1,.8,1.8,1.4,2.5,2.1,3.2,2.8,3.9,3.5,4.6,4.1,5.2,4.8,5.9,5.4,6.5];

  // Journal rows from ledger (+ delete tracking)
  const journalRows = (() => {
    if(!ledger.length) return [];
    const now = new Date();
    return ledger.slice(0,40)
      .filter(t=>!deletedIds.has(t.id))
      .map((t,i)=>{
        const cd = t.closedAt ? new Date(t.closedAt) : null;
        const isToday = cd&&cd.getUTCDate()===now.getUTCDate()&&cd.getUTCMonth()===now.getUTCMonth();
        return {
          id:   t.id||i,
          time: isToday&&cd ? cd.toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}) : '',
          date: !isToday&&cd ? cd.toLocaleDateString('en',{month:'short',day:'numeric',timeZone:'UTC'}) : '',
          tpl:  t.template||'unknown',
          dir:  t.direction||'--',
          tier: t.htfTier||(t.pnlR>1.5?'A':t.pnlR>0?'B':'C'),
          entry:t.actualEntry?.toFixed(2)||'--',
          sl:   t.slPrice?.toFixed(2)||'--',
          tp1:  t.exitPrice?.toFixed(2)||'--',
          rr:   t.pnlR!=null?t.pnlR.toFixed(1)+'R':'--',
          pnl:  fmtPnl(t.netPnl),
          type: (t.holdTimeMinutes||0)>120?'day':'scalp',
          status:t.outcome||(t.netPnl>0?'WIN':t.netPnl<0?'LOSS':'BREAKEVEN'),
        };
      });
  })();
  const displayJournal = jFilter==='all' ? journalRows : journalRows.filter(r=>r.type===jFilter);

  // Computed risk values
  const lotVal      = Math.max(0.1, Math.round(lot/10*10)/10);
  const riskDol     = lotVal * 10 * 8.6;
  const riskPct     = riskDol / accountBal * 100;
  const tp1val      = riskDol * curRR;
  const tp2val      = riskDol * curRR * 2;
  const lotZone     = lotVal<=1?'SAFE':lotVal<=3?'STD':'HIGH';
  const lotZoneCol  = lotVal<=1?'var(--bu)':lotVal<=3?'var(--wa)':'var(--be)';

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const bgRef   = useRef(null);
  const waveRef = useRef(null);
  const crRef   = useRef(null);
  const knnRef  = useRef(null);
  const radRef  = useRef(null);
  const calRef  = useRef(null);
  const dxyRef  = useRef(null);
  const htRef   = useRef(null);
  const eqGRef  = useRef(null);
  const eqIRef  = useRef(null);
  const eqRRef  = useRef(null);
  const weekRef = useRef(null);

  // ── Animation / mutable refs ───────────────────────────────────────────────
  const bgtRef      = useRef(0);
  const waveHRef    = useRef([]);
  const wtRef       = useRef(0);
  const cryRef      = useRef(0);
  const kntRef      = useRef(0);
  const rdtRef      = useRef(0);
  const pnlRef      = useRef(0);
  const waveBaseRef = useRef(3341.5);   // updated by quote fetch
  const waveHiRef   = useRef(3358.2);
  const waveLoRef   = useRef(3318.4);
  const toastTimerRef  = useRef(null);
  const gLiveRef    = useRef(false);
  const gRulesRef   = useRef({});
  const gSessionRef = useRef('*');

  useEffect(()=>{gRulesRef.current=gRules;},[gRules]);
  useEffect(()=>{gLiveRef.current=gLive;},[gLive]);
  useEffect(()=>{gSessionRef.current=gSession;},[gSession]);

  // ── Clock ──────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const tick=()=>{
      const n=new Date();
      setUtcTime([n.getUTCHours(),n.getUTCMinutes(),n.getUTCSeconds()].map(x=>String(x).padStart(2,'0')).join(':'));
    };
    tick(); const id=setInterval(tick,1000); return()=>clearInterval(id);
  },[]);

  // ── P&L live animation (tiny noise around real value) ─────────────────────
  useEffect(()=>{
    const id=setInterval(()=>{
      pnlRef.current+=(Math.random()-.5)*1.2;
      setPnl(pnlRef.current);
    },800);
    return()=>clearInterval(id);
  },[]);

  // ── Aurora BG ─────────────────────────────────────────────────────────────
  useEffect(()=>{
    const c=bgRef.current; if(!c) return;
    const ctx=c.getContext('2d');
    const resize=()=>{c.width=window.innerWidth;c.height=window.innerHeight;};
    resize(); window.addEventListener('resize',resize);
    let raf;
    const draw=()=>{
      const W=c.width,H=c.height; ctx.clearRect(0,0,W,H);
      const t=bgtRef.current*.0022;
      [[W*.2+Math.sin(t)*W*.07,H*.35+Math.cos(t*.7)*H*.06,[212,160,23]],
       [W*.82+Math.cos(t*.6)*W*.06,H*.6+Math.sin(t*.8)*H*.05,[139,92,246]],
       [W*.5+Math.sin(t*.5)*W*.05,H*.12+Math.cos(t)*H*.04,[14,165,233]]
      ].forEach(([x,y,rgb])=>{
        const g=ctx.createRadialGradient(x,y,0,x,y,W*.26);
        g.addColorStop(0,`rgba(${rgb},.04)`);g.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
      });
      bgtRef.current++; raf=requestAnimationFrame(draw);
    };
    draw();
    return()=>{window.removeEventListener('resize',resize);cancelAnimationFrame(raf);};
  },[]);

  // ── EKG Wave ──────────────────────────────────────────────────────────────
  useEffect(()=>{
    const c=waveRef.current; if(!c) return;
    const ctx=c.getContext('2d');
    const resize=()=>{c.width=c.parentElement?.offsetWidth||800;c.height=108;};
    resize(); window.addEventListener('resize',resize);
    let raf;
    const map=(v,hi,lo)=>108-(v-lo+5)/(hi-lo+10)*(108-16)-8;
    const draw=()=>{
      const W=c.width,H=108;
      const BASE=waveBaseRef.current,HI=waveHiRef.current,LO=waveLoRef.current;
      const wH=waveHRef.current;
      const px=BASE+Math.sin(wtRef.current*.04)*((HI-LO)*.15)+Math.sin(wtRef.current*.13)*((HI-LO)*.08)+Math.sin(wtRef.current*.27)*((HI-LO)*.04)+(Math.random()-.5)*.15;
      wH.push(px); if(wH.length>W) wH.shift();
      ctx.fillStyle='rgba(7,7,15,.92)';ctx.fillRect(0,0,W,H);
      [[HI,'rgba(239,68,68,.25)'],[LO,'rgba(34,197,94,.25)'],[(HI+LO)/2,'rgba(212,160,23,.12)']].forEach(([v,col])=>{
        ctx.strokeStyle=col;ctx.setLineDash([3,5]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,map(v,HI,LO));ctx.lineTo(W,map(v,HI,LO));ctx.stroke();
      });
      ctx.setLineDash([]);
      [[HI,'rgba(239,68,68,.8)','H '+HI.toFixed(2),true],[LO,'rgba(34,197,94,.8)','L '+LO.toFixed(2),false]].forEach(([v,col,lbl,above])=>{
        ctx.fillStyle=col;ctx.font='700 8px system-ui';ctx.fillText(lbl,4,map(v,HI,LO)+(above?-4:11));
      });
      if(wH.length>100){
        [Math.floor(wH.length*.25),Math.floor(wH.length*.55)].forEach((xi,i)=>{
          const v=wH[xi],y=map(v,HI,LO);
          ctx.fillStyle=i===0?'rgba(239,68,68,.7)':'rgba(34,197,94,.7)';
          ctx.beginPath();ctx.arc(xi,y,4,0,Math.PI*2);ctx.fill();
          ctx.strokeStyle=i===0?'rgba(239,68,68,.4)':'rgba(34,197,94,.4)';ctx.lineWidth=1;ctx.setLineDash([2,4]);
          ctx.beginPath();ctx.moveTo(xi,0);ctx.lineTo(xi,H);ctx.stroke();ctx.setLineDash([]);
          ctx.fillStyle=i===0?'rgba(239,68,68,.7)':'rgba(34,197,94,.7)';ctx.font='700 8px system-ui';ctx.fillText(i===0?'HH':'BOS',xi+4,y-4);
        });
      }
      ctx.beginPath();wH.forEach((v,i)=>{const y=map(v,HI,LO);i===0?ctx.moveTo(i,y):ctx.lineTo(i,y);});
      ctx.strokeStyle='#D4A017';ctx.lineWidth=1.5;ctx.stroke();
      ctx.save();ctx.beginPath();wH.forEach((v,i)=>{const y=map(v,HI,LO);i===0?ctx.moveTo(i,y):ctx.lineTo(i,y);});
      ctx.lineTo(wH.length-1,H);ctx.lineTo(0,H);ctx.closePath();
      const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba(212,160,23,.12)');g.addColorStop(1,'rgba(212,160,23,0)');
      ctx.fillStyle=g;ctx.fill();ctx.restore();
      if(wH.length>1){
        const lx=wH.length-1,ly=map(wH[lx],HI,LO);
        ctx.beginPath();ctx.arc(lx,ly,3.5,0,Math.PI*2);
        ctx.fillStyle='#D4A017';ctx.shadowColor='#D4A017';ctx.shadowBlur=10;ctx.fill();ctx.shadowBlur=0;
      }
      wtRef.current++; raf=requestAnimationFrame(draw);
    };
    draw();
    return()=>{window.removeEventListener('resize',resize);cancelAnimationFrame(raf);};
  },[]);

  // ── 3D Crystal ────────────────────────────────────────────────────────────
  useEffect(()=>{
    const c=crRef.current; if(!c) return;
    const ctx=c.getContext('2d');
    const p3=(vx,vy,vz,rx,ry)=>{const x1=vx*Math.cos(ry)-vz*Math.sin(ry),z1=vx*Math.sin(ry)+vz*Math.cos(ry);const y2=vy*Math.cos(rx)-z1*Math.sin(rx),z2=vy*Math.sin(rx)+z1*Math.cos(rx);const s=4/(4+z2+2);return[x1*s*50+78,y2*s*50+74,z2];};
    let raf;
    const draw=()=>{
      ctx.clearRect(0,0,156,148);cryRef.current+=.006;
      const pts=VERTS.map(v=>p3(v[0],v[1],v[2],.3,cryRef.current));
      EDGES.forEach(([a,b])=>{const dz=(pts[a][2]+pts[b][2])/2,al=Math.max(.04,Math.min(.82,(dz+2)/4));ctx.beginPath();ctx.moveTo(pts[a][0],pts[a][1]);ctx.lineTo(pts[b][0],pts[b][1]);ctx.strokeStyle=`rgba(212,160,23,${al})`;ctx.lineWidth=1.2;ctx.stroke();});
      const g=ctx.createRadialGradient(78,74,8,78,74,60);g.addColorStop(0,'rgba(34,197,94,.06)');g.addColorStop(1,'rgba(34,197,94,0)');ctx.fillStyle=g;ctx.fillRect(0,0,156,148);
      raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[]);

  // ── KNN ───────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const c=knnRef.current; if(!c) return;
    const ctx=c.getContext('2d'); let raf;
    const draw=()=>{
      ctx.clearRect(0,0,KW,KH);ctx.fillStyle='#0C0C1A';ctx.fillRect(0,0,KW,KH);kntRef.current++;
      KNN_NEAR.forEach(p=>{
        const pr=(Math.sin(kntRef.current*.03+p.a)+1)/2;
        ctx.strokeStyle=`rgba(34,197,94,${.08+pr*.2})`;ctx.lineWidth=1;ctx.setLineDash([2,4]);
        ctx.beginPath();ctx.moveTo(KNN_TOD.x,KNN_TOD.y);ctx.lineTo(p.x,p.y);ctx.stroke();
        const ax=KNN_TOD.x+(p.x-KNN_TOD.x)*pr,ay=KNN_TOD.y+(p.y-KNN_TOD.y)*pr;
        ctx.setLineDash([]);ctx.fillStyle='rgba(34,197,94,.75)';ctx.beginPath();ctx.arc(ax,ay,2,0,Math.PI*2);ctx.fill();
      });
      ctx.setLineDash([]);
      KNN_WINS.forEach(p=>{const fy=p.y+Math.sin(kntRef.current*.02+p.a)*2;ctx.fillStyle='rgba(34,197,94,.7)';ctx.beginPath();ctx.arc(p.x,fy,3.5,0,Math.PI*2);ctx.fill();});
      KNN_LOSS.forEach(p=>{ctx.fillStyle='rgba(239,68,68,.7)';ctx.beginPath();ctx.arc(p.x,p.y,3.5,0,Math.PI*2);ctx.fill();});
      const pl=2+Math.sin(kntRef.current*.06)*1.5;
      ctx.fillStyle='rgba(212,160,23,.12)';ctx.beginPath();ctx.arc(KNN_TOD.x,KNN_TOD.y,pl+5,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#D4A017';ctx.shadowColor='#D4A017';ctx.shadowBlur=12;ctx.beginPath();ctx.arc(KNN_TOD.x,KNN_TOD.y,pl,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      ctx.strokeStyle='rgba(34,197,94,.06)';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(KNN_TOD.x,KNN_TOD.y,70,0,Math.PI*2);ctx.stroke();
      raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[]);

  // ── Radar ─────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const c=radRef.current; if(!c) return;
    const ctx=c.getContext('2d'); rdtRef.current=0; let raf;
    const draw=()=>{
      const RW=c.width||290,RH=c.height||140;
      ctx.clearRect(0,0,RW,RH);ctx.fillStyle='#0C0C1A';ctx.fillRect(0,0,RW,RH);rdtRef.current++;
      const cx=RW/2,cy=RH/2+2,R=Math.min(RW,RH)/2-18,n=RAD_AX.length;
      const ang=i=>-Math.PI/2+i*Math.PI*2/n;
      [.25,.5,.75,1].forEach(f=>{ctx.beginPath();for(let i=0;i<n;i++){const a=ang(i);i===0?ctx.moveTo(cx+R*f*Math.cos(a),cy+R*f*Math.sin(a)):ctx.lineTo(cx+R*f*Math.cos(a),cy+R*f*Math.sin(a));}ctx.closePath();ctx.strokeStyle='rgba(26,26,46,.9)';ctx.lineWidth=1;ctx.stroke();});
      for(let i=0;i<n;i++){ctx.strokeStyle='rgba(26,26,46,.9)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+R*Math.cos(ang(i)),cy+R*Math.sin(ang(i)));ctx.stroke();}
      const am=Math.min(1,rdtRef.current/55);
      ctx.beginPath();
      for(let i=0;i<n;i++){const a=ang(i),s=RAD_SC[i]/100*am;i===0?ctx.moveTo(cx+R*s*Math.cos(a),cy+R*s*Math.sin(a)):ctx.lineTo(cx+R*s*Math.cos(a),cy+R*s*Math.sin(a));}
      ctx.closePath();
      const grd=ctx.createRadialGradient(cx,cy,0,cx,cy,R);grd.addColorStop(0,'rgba(212,160,23,.18)');grd.addColorStop(1,'rgba(34,197,94,.04)');
      ctx.fillStyle=grd;ctx.fill();ctx.strokeStyle='rgba(212,160,23,.7)';ctx.lineWidth=1.5;ctx.stroke();
      for(let i=0;i<n;i++){const a=ang(i),s=RAD_SC[i]/100*am,x=cx+R*s*Math.cos(a),y=cy+R*s*Math.sin(a);ctx.fillStyle='#D4A017';ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();const lx=cx+(R+13)*Math.cos(ang(i)),ly=cy+(R+13)*Math.sin(ang(i));ctx.fillStyle='rgba(96,96,140,.9)';ctx.font='700 7px system-ui';ctx.textAlign='center';ctx.fillText(RAD_AX[i].split(' ')[0],lx,ly);}
      ctx.textAlign='left';
      if(rdtRef.current<80) raf=requestAnimationFrame(draw);
    };
    draw(); return()=>cancelAnimationFrame(raf);
  },[]);

  // ── Static canvases on mount ───────────────────────────────────────────────
  useEffect(()=>{
    const t1=setTimeout(()=>drawDXYCanvas(dxyRef.current),100);
    const t2=setTimeout(()=>drawHeatCanvas(htRef.current),120);
    const t3=setTimeout(()=>drawEQ(eqGRef.current,EQ_G_FB,'#D4A017','rgba(212,160,23,.12)'),140);
    const t4=setTimeout(()=>drawEQ(eqIRef.current,EQ_I_FB,'#22C55E','rgba(34,197,94,.1)'),160);
    const t5=setTimeout(()=>drawEQ(eqRRef.current,EQ_R_FB,'#0EA5E9','rgba(14,165,233,.09)'),180);
    const t6=setTimeout(()=>drawCalCanvas(calRef.current,[]),200);
    const t7=setTimeout(()=>drawWeekCanvas(weekRef.current,[]),220);
    return()=>[t1,t2,t3,t4,t5,t6,t7].forEach(clearTimeout);
  },[]);

  // ── Redraw data canvases when real data arrives ────────────────────────────
  useEffect(()=>{
    if(!ledger.length) return;
    drawCalCanvas(calRef.current, buildCalData(ledger));
    drawWeekCanvas(weekRef.current, buildWeekData(ledger));
    const eqG=buildEqFromLedger(ledger,'gold',30)||EQ_G_FB;
    const eqI=buildEqFromLedger(ledger,'judas',30)||EQ_I_FB;
    const eqR=buildEqFromLedger(ledger,'reaction',30)||EQ_R_FB;
    setTimeout(()=>drawEQ(eqGRef.current,eqG,'#D4A017','rgba(212,160,23,.12)'),50);
    setTimeout(()=>drawEQ(eqIRef.current,eqI,'#22C55E','rgba(34,197,94,.1)'),70);
    setTimeout(()=>drawEQ(eqRRef.current,eqR,'#0EA5E9','rgba(14,165,233,.09)'),90);
  },[ledger]);

  // ── API: Gold quotes (every 60s) ───────────────────────────────────────────
  useEffect(()=>{
    const fetch_ = async()=>{
      try {
        const r=await fetch('/api/quotes?asset=gold&limit=60');
        const d=await r.json();
        if(d.price){
          setQuote(d);
          waveBaseRef.current=d.price;
          if(d.high) waveHiRef.current=d.high;
          if(d.low)  waveLoRef.current=d.low;
        }
      } catch {}
    };
    fetch_(); const id=setInterval(fetch_,60000); return()=>clearInterval(id);
  },[]);

  // ── API: Account summary (every 30s) ──────────────────────────────────────
  useEffect(()=>{
    const fetch_=async()=>{
      try {
        const r=await fetch('/api/dashboard-feed?action=summary');
        const d=await r.json();
        if(d.ok){
          setAcct(d);
          pnlRef.current=d.account.todaysPnL;
          setPnl(d.account.todaysPnL);
        }
      } catch {}
    };
    fetch_(); const id=setInterval(fetch_,30000); return()=>clearInterval(id);
  },[]);

  // ── API: Open positions (every 20s) ───────────────────────────────────────
  useEffect(()=>{
    const fetch_=async()=>{
      try {
        const r=await fetch('/api/dashboard-feed?action=positions');
        const d=await r.json();
        if(d.ok){
          const gold=d.positions?.find(p=>p.symbol?.toUpperCase().includes('XAU')||p.symbol?.toLowerCase().includes('gold'));
          setOpenPos(gold||d.positions?.[0]||null);
        }
      } catch {}
    };
    fetch_(); const id=setInterval(fetch_,20000); return()=>clearInterval(id);
  },[]);

  // ── API: Ledger (on mount + every 5min) ────────────────────────────────────
  useEffect(()=>{
    const fetch_=async()=>{
      try {
        const r=await fetch('/api/ledger?action=list&limit=100');
        const d=await r.json();
        if(d.trades?.length) setLedger(d.trades);
      } catch {}
    };
    fetch_(); const id=setInterval(fetch_,300000); return()=>clearInterval(id);
  },[]);

  // ── API: Template performance (on mount) ──────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        const r=await fetch('/api/template-performance?days=30');
        const d=await r.json();
        if(d.byTemplate) setTplPerf(d);
      } catch {}
    })();
  },[]);

  // ── Goal rings ─────────────────────────────────────────────────────────────
  const setGoal = useCallback((type)=>{
    if(type==='day'){
      const g=parseFloat(dayGoalInput)||1400;
      const p=Math.min(100,Math.round(todayPnL/g*100));
      setDayPct(p); setDayGoalDisp('$'+Number(g).toLocaleString());
    } else {
      const g=parseFloat(wkGoalInput)||6500;
      const p=Math.min(100,Math.round(weekPnL/g*100));
      setWkPct(p); setWkGoalDisp('$'+Number(g).toLocaleString());
    }
  },[dayGoalInput,wkGoalInput,todayPnL,weekPnL]);

  // Auto-refresh goal rings when real P&L changes
  useEffect(()=>{
    if(!acct) return;
    const dayG=parseFloat(dayGoalInput)||1400;
    const wkG=parseFloat(wkGoalInput)||6500;
    setDayPct(Math.min(100,Math.round(todayPnL/dayG*100)));
    setWkPct(Math.min(100,Math.round(weekPnL/wkG*100)));
  },[todayPnL,weekPnL,acct]);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const showToast=useCallback((msg,err=false)=>{
    setToast({msg,err}); clearTimeout(toastTimerRef.current);
    toastTimerRef.current=setTimeout(()=>setToast(null),2600);
  },[]);

  // ── Gating ────────────────────────────────────────────────────────────────
  const gKey=(t,s,i)=>`${t}|${s}|${i}`;
  const gIsOn=(tmpl,inst)=>{
    const rules=gRulesRef.current,sess=gSessionRef.current;
    const k1=gKey(tmpl,sess,inst),k2=gKey(tmpl,'*',inst);
    return k1 in rules?rules[k1]:k2 in rules?rules[k2]:!SOFF.has(gKey(tmpl,'*',inst));
  };
  const gIsForced=(tmpl,inst)=>FORCED.has(gKey(tmpl,'*',inst));

  const gLoad=useCallback(async()=>{
    try {
      const r=await fetch(GATE_API,{cache:'no-store'});
      const d=await r.json();
      if(d.ok){
        const nr={};
        Object.entries(d.rules).forEach(([k,v])=>{if(k.split('|').length===3)nr[k]=v.on;});
        setGRules(nr);setGLive(true);setGStatusCls('ok');setGStatusTxt('⬤ Live');
      } else throw 0;
    } catch {
      const seed={};SOFF.forEach(k=>seed[k]=false);FORCED.forEach(k=>seed[k]=true);
      setGRules(seed);setGLive(false);setGStatusCls('wa');setGStatusTxt('⬤ Preview');
    }
  },[]);

  const gToggle=useCallback(async(tmpl,inst)=>{
    const on=gIsOn(tmpl,inst),next=!on;
    if(gIsForced(tmpl,inst)&&!next){showToast('Force-enabled — cannot disable',true);return;}
    const k=gKey(tmpl,gSessionRef.current,inst);
    setGRules(prev=>({...prev,[k]:next}));
    if(gLiveRef.current){
      try {
        const r=await fetch(GATE_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template:tmpl,session:gSessionRef.current,instrument:inst,on:next})});
        const d=await r.json();
        if(d.ok) showToast(`${tmpl}/${inst} → ${next?'ON':'OFF'}`);
        else{setGRules(prev=>({...prev,[k]:on}));showToast('API error',true);}
      } catch{setGRules(prev=>({...prev,[k]:on}));showToast('API unreachable',true);}
    } else showToast(`${tmpl}/${inst} → ${next?'ON':'OFF'} (preview)`);
  },[showToast]);

  useEffect(()=>{gLoad();},[gLoad]);

  // ── Display values ─────────────────────────────────────────────────────────
  const dayOffset = Math.round(251-(251*dayPct/100));
  const wkOffset  = Math.round(251-(251*wkPct/100));
  const dispPrice = realPrice!=null ? fmtPx(realPrice) : '-- ---.--';
  const dispChange = realChange!=null
    ? `${realChange>=0?'▲':'▼'} ${Math.abs(realChange).toFixed(2)}%`
    : '▼ -0.07%';
  const dispBid = realPrice!=null ? (realPrice-.12).toFixed(2) : '--';
  const dispAsk = realPrice!=null ? (realPrice+.12).toFixed(2) : '--';

  // ── ADR computation ────────────────────────────────────────────────────────
  const adrRange = realHigh && realLow ? realHigh - realLow : null;
  const adrPct   = adrRange != null ? Math.round(adrRange / ADR14 * 100) : null;
  const adrTier  = ADR_ZONES.find(z => (adrPct ?? 0) >= z.min) ?? ADR_ZONES[ADR_ZONES.length-1];
  // Bar maps 0-300% ADR to 0-100% bar width so zones stay visible at extremes
  const adrBarW  = adrPct != null ? Math.min(100, adrPct / 300 * 100) : 0;
  // Zone marker positions as % of bar (each threshold / 300)
  const ADR_MARKS = [{v:75,lbl:'75%'},{v:90,lbl:'90%'},{v:100,lbl:'100%',bold:true},{v:150,lbl:'150%'},{v:200,lbl:'200%'}];

  // Open position display values
  const posDir    = openPos?.direction || null;
  const posEntry  = openPos?.openPrice?.toFixed(2) || '--';
  const posSL     = openPos?.stopLoss?.toFixed(2) || '--';
  const posTP     = openPos?.takeProfit?.toFixed(2) || '--';
  const posProfit = openPos?.profit ?? null;
  const posLot    = openPos?.volume ?? '--';
  const posTpl    = openPos?.template || '--';

  // ─────────────────────────── JSX ────────────────────────────────────────
  return (
    <>
      <canvas ref={bgRef} id="bgC"/>
      <div className="pg">

        {/* ─── HEADER ─────────────────────────────────────────────────── */}
        <header className="hdr">
          <div className="hr1">
            <div className="hbrand">QB Gold Beast</div>
            <span className="hpx m">{dispPrice}</span>
            <span className="hpxch" style={{color:realChange>=0?'var(--bu)':'var(--be)'}}>{dispChange}</span>
            <div style={{marginLeft:8,font:'600 8px/1 system-ui',color:'var(--t3)'}}>
              BID <span className="m" style={{color:'var(--t)'}}>{dispBid}</span> · ASK <span className="m" style={{color:'var(--t)'}}>{dispAsk}</span>
            </div>
            <div className="hdiv"/>
            <div className="hbias-row">
              <div className="hbias short"><div className="hbl">H1</div><div className="hbv">SHORT</div></div>
              <div className="hbias long"><div className="hbl">H4</div><div className="hbv">LONG</div></div>
              <div className="hbias long"><div className="hbl">D</div><div className="hbv">LONG</div></div>
            </div>
            <div className="hdiv"/>
            <div className="hkpis">
              <div className="hkpi"><div className="hkl">Today P&L</div><div className="hkv" style={{color:todayPnL>=0?'var(--bu)':'var(--be)'}}>{fmtPnl(todayPnL)}</div></div>
              <div className="hkpi"><div className="hkl">Streak</div><div className="hkv" style={{color:'var(--g)'}}>{streak>0?streak+' days':'--'}</div></div>
              <div className="hkpi"><div className="hkl">WN Rate</div><div className="hkv" style={{color:'var(--bu)'}}>{ovWR}</div></div>
              <div className="hkpi"><div className="hkl">ATR(14)</div><div className="hkv m">{realHigh&&realLow?(realHigh-realLow).toFixed(1):'--'}</div></div>
            </div>
            <div className="hsess" style={{marginLeft:'auto'}}>
              <div className="hsb"><div className="hsd" style={{background:'var(--in)'}}/>Asian LOCKED</div>
              <div className="hsb act"><div className="hsd"/>London · <span className="m">{utcTime}</span></div>
              <div className="hsb wa"><div className="hsd" style={{animationDelay:'.4s'}}/>NY · open</div>
              <div style={{marginLeft:6,display:'flex',alignItems:'center',gap:5,padding:'4px 10px',font:'700 8px/1 system-ui',letterSpacing:'.08em',textTransform:'uppercase',color:'var(--bu)',border:'1px solid rgba(34,197,94,.3)',background:'rgba(34,197,94,.07)'}}>
                <div className="hsd"/>ACTIVE
              </div>
            </div>
          </div>
          <div className="hr2">
            <div className="adr-wrap">
              <div className="adr-label">ADR<br/><span style={{fontSize:6,fontWeight:600,color:'var(--t3)',textTransform:'none',letterSpacing:0}}>14d</span></div>
              <div style={{flex:1,display:'flex',flexDirection:'column',gap:0}}>
                <div className="adr-bar" style={{position:'relative',overflow:'visible'}}>
                  <div className="adr-fill" style={{width:adrBarW+'%',background:adrTier.col,transition:'width .8s ease'}}/>
                  {ADR_MARKS.map(m=>(
                    <div key={m.lbl} style={{position:'absolute',left:(m.v/300*100)+'%',top:0,bottom:0,width:m.bold?2:1,background:m.bold?'rgba(212,160,23,.85)':'rgba(80,80,110,.7)',zIndex:2}}/>
                  ))}
                </div>
                <div style={{position:'relative',height:11}}>
                  {ADR_MARKS.map(m=>(
                    <span key={m.lbl} style={{position:'absolute',left:(m.v/300*100)+'%',transform:'translateX(-50%)',font:`${m.bold?800:600} 5.5px/1 system-ui`,color:m.bold?'var(--g)':'rgba(70,70,100,.9)',whiteSpace:'nowrap',top:2}}>{m.lbl}</span>
                  ))}
                </div>
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2,minWidth:68}}>
                <div className="adr-pct" style={{color:adrTier.col}}>{adrPct!=null?adrPct+'%':'--'}</div>
                <div style={{font:'700 6px/1 system-ui',letterSpacing:'.07em',textTransform:'uppercase',color:adrTier.col,whiteSpace:'nowrap'}}>{adrTier.short}</div>
              </div>
            </div>
            <div className="adr-guide">{adrTier.guide}</div>
            <div className="hinfo">
              <div className="hi g"><strong>H</strong> {realHigh?.toFixed(2)||'--'} · <strong>L</strong> {realLow?.toFixed(2)||'--'} · <strong>Range</strong> <span style={{color:adrTier.col}}>{adrRange?.toFixed(1)||'--'}pts ({adrPct!=null?adrPct+'%':'--'} ADR)</span></div>
              <div className="hi bu"><strong>MTD P&L</strong> {fmtPnl(mtdPnL)}</div>
              <div className="hi wa"><strong>Week P&L</strong> {fmtPnl(weekPnL)}</div>
              <div className="hi g"><strong>Win Rate</strong> {ovWR} · <strong>Avg R</strong> {ovAvgR}</div>
              <div className="hi ml"><strong>CVD</strong> Rising · <span className="m">{utcTime}</span></div>
              <div className="hi"><strong>Trades</strong> {ovTrades} ({ovWins} wins)</div>
              <div className="hi g"><strong>Profit Factor</strong> {ovPF}</div>
              <div className="hi g"><strong>Streak</strong> {streak>0?streak+' wins in a row':'--'}</div>
            </div>
          </div>
          <div className="ticker-wrap"><div className="ticker">
            {[['u','XAUUSD',dispPrice],['n','WR',ovWR],['n','AvgR',ovAvgR],['n','PF',ovPF],['n','Trades',String(ovTrades)],['u','MTD P&L',fmtPnl(mtdPnL)],['u','Week P&L',fmtPnl(weekPnL)],['u','Streak',streak>0?streak+' days':'--'],['u','Today',fmtPnl(todayPnL)],
              ['u','XAUUSD',dispPrice],['n','WR',ovWR],['n','AvgR',ovAvgR],['n','PF',ovPF],['n','Trades',String(ovTrades)],['u','MTD P&L',fmtPnl(mtdPnL)],['u','Week P&L',fmtPnl(weekPnL)],['u','Streak',streak>0?streak+' days':'--'],['u','Today',fmtPnl(todayPnL)]
            ].map(([cls,lbl,val],i)=>(
              <span key={i} className={`ti ${cls}`}>{lbl}<span className="tv">{val}</span></span>
            ))}
          </div></div>
        </header>

        {/* ─── DIRECTIVE ──────────────────────────────────────────────── */}
        <div className={`dir ${openPos?'hold':'no-pos'}`}>
          <div className="dir-state">{openPos?`▶ ${posDir} POSITION OPEN`:'◼ NO POSITION'}</div>
          <div className="dir-text">
            {openPos
              ? <>{posTpl} {posDir} · Entry {posEntry} · SL {posSL} · Float <strong style={{color:posProfit>=0?'var(--bu)':'var(--be)'}}>{fmtPnl(posProfit)}</strong></>
              : <>No open gold position. Watching for signal.</>
            }
          </div>
          {openPos&&<div className="dir-pill">Lot {posLot}</div>}
        </div>

        {/* ─── EKG HERO ───────────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Price · EKG · Market Structure</div><div className="scl"/>
          <div style={{font:'600 8px/1 system-ui',color:'var(--t3)'}}>
            H <span style={{color:'var(--be)'}}>{realHigh?.toFixed(2)||'--'}</span> · L <span style={{color:'var(--bu)'}}>{realLow?.toFixed(2)||'--'}</span>
          </div>
        </div>
        <div style={{padding:'0 14px 8px'}}>
          <div className="wave-panel">
            <div className="wave-ov">
              <div><div className="wol">High</div><div className="wov m" style={{color:'var(--be)'}}>{realHigh?.toFixed(2)||'--'}</div></div>
              <div><div className="wol">Low</div><div className="wov m" style={{color:'var(--bu)'}}>{realLow?.toFixed(2)||'--'}</div></div>
              <div><div className="wol">Change</div><div className="wov m" style={{color:realChange>=0?'var(--bu)':'var(--be)'}}>{dispChange}</div></div>
              <div><div className="wol">Session</div><div className="wov m" style={{color:'var(--in)'}}>{acct?.session||'--'}</div></div>
            </div>
            <div className="wave-px m">{dispPrice}</div>
            <canvas ref={waveRef}/>
          </div>
        </div>

        {/* ─── OPEN POSITION + RISK ────────────────────────────────────── */}
        <div className="sec"><div className="scn">Open Position</div><div className="scl"/></div>
        <div className="g2" style={{gridTemplateColumns:'1fr 1fr'}}>
          <div className="p">
            <div className="pt">Trade Details{openPos&&<span className={`ptb ${posDir==='SHORT'?'be':'bu'}`}>{posDir} {posDir==='SHORT'?'▼':'▲'}</span>}</div>
            {openPos ? (
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                <div className="pos-info">
                  <div className="pi"><span className="pil">Template</span><span className="piv" style={{color:'var(--g)'}}>{posTpl}</span></div>
                  <div className="pi"><span className="pil">Lot</span><span className="piv">{posLot}</span></div>
                  <div className="pi"><span className="pil">Entry</span><span className="piv m">{fmtPx(openPos.openPrice)}</span></div>
                  <div className="pi"><span className="pil">Stop</span><span className="piv m" style={{color:'var(--be)'}}>{fmtPx(openPos.stopLoss)}</span></div>
                  <div className="pi"><span className="pil">TP</span><span className="piv m" style={{color:'var(--bu)'}}>{fmtPx(openPos.takeProfit)}</span></div>
                  <div className="pi"><span className="pil">Current</span><span className="piv m">{fmtPx(openPos.currentPrice)}</span></div>
                  <div className="pi"><span className="pil">Swap</span><span className="piv" style={{color:'var(--t3)'}}>{openPos.swap!=null?fmtPnl(openPos.swap):'--'}</span></div>
                  <div className="pi"><span className="pil">Commission</span><span className="piv" style={{color:'var(--t3)'}}>{openPos.commission!=null?fmtPnl(openPos.commission):'--'}</span></div>
                </div>
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}}>
                  <div style={{font:'600 8px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)'}}>Live Float</div>
                  <div className="pnl-big" style={{color:pnl>=0?'var(--bu)':'var(--be)'}}>{pnl>=0?'+':''}{Math.abs(pnl).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g,',')} $</div>
                  <div className="pnl-sub">Acct: ${(accountBal/1000).toFixed(1)}k</div>
                  <div className="pos-btns" style={{width:'100%'}}>
                    <button className="pb wa">⇒ BE</button>
                    <button className="pb in">50%</button>
                    <button className="pb be">✕ Close</button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:120,color:'var(--t3)',font:'600 12px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase'}}>
                NO OPEN POSITION
              </div>
            )}
          </div>

          {/* Risk Command */}
          <div className="p">
            <div className="pt">Risk Command · Drawdown Shield</div>
            <div className="rdd-grid">
              <div className="rdd-tile"><div className="rdl">Today P&L</div><div className="rdv" style={{color:todayPnL>=0?'var(--bu)':'var(--be)'}}>{fmtPnl(todayPnL)}</div><div className="rdbar"><div className="rdf" style={{width:Math.min(100,Math.abs(todayPnL)/accountBal*100*20)+'%',background:todayPnL>=0?'var(--bu)':'var(--be)'}}/></div></div>
              <div className="rdd-tile"><div className="rdl">Account</div><div className="rdv m">${accountBal.toLocaleString()}</div></div>
              <div className="rdd-tile"><div className="rdl">Week P&L</div><div className="rdv" style={{color:weekPnL>=0?'var(--bu)':'var(--be)'}}>{fmtPnl(weekPnL)}</div></div>
              <div className="rdd-tile"><div className="rdl">Max Allow</div><div className="rdv">${(accountBal*.04).toFixed(0)} · 4%</div></div>
            </div>
            <div className="shield ok">🛡 SHIELD ACTIVE · Full size permitted</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:3}}>
              <span style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)'}}>Lot Size</span>
              <div style={{display:'flex',alignItems:'baseline',gap:4}}>
                <span className="m" style={{fontSize:18,fontWeight:900}}>{lotVal.toFixed(1)}</span>
                <span style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:lotZoneCol}}>{lotZone}</span>
              </div>
            </div>
            <input type="range" className="lsl" min={1} max={100} value={lot} onChange={e=>setLot(Number(e.target.value))}/>
            <div className="rrstats">
              <div className="rrstat"><div className="rrl">Risk $</div><div className="rrv" style={{color:'var(--wa)'}}>${riskDol.toFixed(0)}</div></div>
              <div className="rrstat"><div className="rrl">Risk %</div><div className="rrv" style={{color:riskPct<1?'var(--bu)':riskPct<2?'var(--wa)':'var(--be)'}}>{riskPct.toFixed(2)}%</div></div>
              <div className="rrstat"><div className="rrl">TP1</div><div className="rrv" style={{color:'var(--bu)'}}>+${tp1val.toFixed(0)}</div></div>
              <div className="rrstat"><div className="rrl">TP2</div><div className="rrv" style={{color:'var(--bu)'}}>+${tp2val.toFixed(0)}</div></div>
            </div>
            <div className="rrbts">
              {[1,1.5,2,2.5,3,4].map(r=>(
                <button key={r} className={`rrb${curRR===r?' a':''}`} onClick={()=>setCurRR(r)}>1:{r}</button>
              ))}
            </div>
            <div className="smart-lot">
              <div className="sl-lbl">Smart Lot Suggestion</div>
              <div style={{font:'600 9px/1.4 system-ui',color:'var(--t2)',marginTop:4}}>
                Based on {ovTrades} real trades · Win rate {ovWR} · Avg R {ovAvgR}<br/>
                Profit factor {ovPF} · Streak {streak>0?streak+' wins':'--'}
              </div>
            </div>
          </div>
        </div>

        {/* ─── COMMAND CENTER ─────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Command Center · Crystal · KNN · Radar</div><div className="scl"/></div>
        <div className="g3" style={{gridTemplateColumns:'1fr 1.2fr 1fr'}}>
          <div className="p">
            <div className="pt">3D Probability Crystal<span className="ptb bu">87/100</span></div>
            <div className="crys-wrap">
              <canvas ref={crRef} width={156} height={148}/>
              <div style={{textAlign:'center'}}>
                <div style={{font:'700 7px/1 system-ui',letterSpacing:'.15em',textTransform:'uppercase',color:'var(--t3)'}}>Today Score</div>
                <div className="cscore">87</div>
                <div style={{font:'800 11px/1 system-ui',textTransform:'uppercase',letterSpacing:'.04em',color:'var(--bu)',marginTop:2}}>TRADE TODAY ✓</div>
              </div>
              <div className="cfactors">
                {[['HTF 3/3','var(--bu)',100,'+30'],['Session KZ','var(--wa)',80,'+20'],['Win Rate '+ovWR,'var(--bu)',60,'+15'],['Avg R '+ovAvgR,'var(--bu)',60,'+15'],['Streak '+streak,'var(--in)',40,'+10'],['PF '+ovPF,'var(--g)',28,'+7']].map(([lbl,col,w,v])=>(
                  <div key={lbl} className="cf">
                    <div className="cfl">{lbl}</div>
                    <div className="cfb"><div className="cfbf" style={{background:col,width:`${w}%`}}/></div>
                    <div className="cfv" style={{color:v.startsWith('-')?'var(--be)':'var(--bu)'}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p">
            <div className="pt">KNN Pattern Cluster<span className="ptb ml">{ovTrades} trades · {ovWR}</span></div>
            <canvas ref={knnRef} width={290} height={160} style={{display:'block',width:'100%'}}/>
            <div style={{display:'flex',gap:10,marginTop:5,paddingTop:5,borderTop:'1px solid var(--b)'}}>
              <div style={{display:'flex',alignItems:'center',gap:4,font:'600 8px/1 system-ui',color:'var(--t2)'}}><div style={{width:6,height:6,borderRadius:'50%',background:'var(--bu)'}}/> WIN({ovWins})</div>
              <div style={{display:'flex',alignItems:'center',gap:4,font:'600 8px/1 system-ui',color:'var(--t2)'}}><div style={{width:6,height:6,borderRadius:'50%',background:'var(--be)'}}/> LOSS({ovTrades-ovWins})</div>
              <div style={{marginLeft:'auto',font:'600 8px/1 system-ui',color:'var(--t3)'}}>WN: <span style={{color:'var(--bu)',fontWeight:800}}>{ovWR}</span></div>
            </div>
            <div style={{marginTop:8,borderTop:'1px solid var(--b)',paddingTop:8}}>
              <div className="pt" style={{border:'none',marginBottom:5,paddingBottom:0}}>Signal Radar · 6-Factor</div>
              <canvas ref={radRef} width={290} height={140} style={{display:'block',width:'100%'}}/>
            </div>
          </div>

          <div className="p">
            <div className="pt">Signal Gates · Pine Vision</div>
            {[
              {id:'A',tpl:'gold-fvg',status:'wa',statusTxt:'● WATCHING',nodes:['HTF','KZ','ADR','FVG'],waiting:'Retest'},
              {id:'B',tpl:'gold-judas',status:'fi',statusTxt:'✓ FIRED',nodes:['HTF','Asian','Sweep','Close','Entry'],waiting:null},
              {id:'C',tpl:'gold-sb',status:'wt',statusTxt:'○ WAIT 15:00',nodes:['HTF'],waiting:null,inactive:['KZ','FVG','Entry']},
              {id:'D',tpl:'reaction-ifvg',status:'wa',statusTxt:'● WATCHING',nodes:['HTF','Zone'],waiting:'IFVG',inactive:['Entry']},
            ].map(g=>(
              <div key={g.id} className="grow">
                <div className="ghdr">
                  <span className="gid">{g.id}</span>
                  <span className="gtpl">{g.tpl}</span>
                  <span className={`gst ${g.status}`}>{g.statusTxt}</span>
                </div>
                <div className="gpipe">
                  {g.nodes.map((n,i)=>(
                    <span key={n}>
                      {i>0&&<div className="gl p"/>}
                      <div className="gnode"><div className="gd p">✓</div><div className="gn">{n}</div></div>
                    </span>
                  ))}
                  {g.waiting&&<span><div className="gl g"/><div className="gnode"><div className="gd w">⏳</div><div className="gn">{g.waiting}</div></div></span>}
                  {(g.inactive||[]).map(n=>(
                    <span key={n}><div className="gl"/><div className="gnode"><div className="gd s">—</div><div className="gn">{n}</div></div></span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ─── TEMPLATE BATTLE ────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Template Battle · Real Statistics (30d)</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div className="tpl-grid">
            {[
              {key:'G',col:'var(--g)',grp:'QB GOLD',name:'Gold Specialist',tpl:'gold-fvg',ref:eqGRef},
              {key:'I',col:'var(--bu)',grp:'QB ICT',name:'ICT Specialist',tpl:'judas-swing',ref:eqIRef},
              {key:'R',col:'var(--in)',grp:'QB REACT',name:'Reaction IFVG',tpl:'reaction-ifvg',ref:eqRRef},
            ].map(t=>{
              const p=perfFor(t.tpl);
              const wr=p?.winRate!=null?(p.winRate*100).toFixed(1)+'%':'--';
              const avgR=p?.avgR!=null?p.avgR.toFixed(2)+'R':'--';
              const pf=p?.profitFactor!=null?p.profitFactor.toFixed(2):'--';
              const sample=tplSample(t.tpl);
              const netPnl=tplNetPnL(t.tpl);
              const maxDD=ledger.filter(x=>x.template===t.tpl&&x.netPnl<0).reduce((s,x)=>s+x.netPnl,0);
              const best=ledger.filter(x=>x.template===t.tpl).reduce((mx,x)=>Math.max(mx,x.netPnl||0),0);
              return (
                <div key={t.key} className="tcard" style={{borderTopColor:t.col}}>
                  <div className="tc-hdr">
                    <div>
                      <div style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)'}}>{t.grp}</div>
                      <div className="tc-name" style={{color:t.col}}>{t.name}</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div className="tc-wr" style={{color:t.col}}>{wr}</div>
                      <div style={{font:'700 7px/1 system-ui',color:'var(--t3)'}}>WIN RATE</div>
                    </div>
                  </div>
                  <canvas ref={t.ref} width={300} height={55} style={{width:'100%',background:'var(--s2)',border:'1px solid var(--b)',display:'block',marginBottom:5}}/>
                  <div className="tc-stats">
                    {[['Avg RR',avgR,'bu'],['30d P&L',netPnl,'bu'],['Trades',String(sample),''],['Profit F.',pf,'bu'],['Best',best>0?'+$'+Math.round(best):'--','bu'],['Max DD',maxDD<0?'-$'+Math.round(-maxDD):'--','be']].map(([lbl,val,col])=>(
                      <div key={lbl} className="tcs">
                        <div className="tcsl">{lbl}</div>
                        <div className="tcsv" style={col?{color:`var(--${col})`}:{}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div className="tc-bar"><div style={{width:p?.winRate?p.winRate*100+'%':'40%',height:3,background:t.col,opacity:.5}}/></div>
                  <button className={`tc-toggle${tplEnabled[t.key]?' on':' off'}`} onClick={()=>setTplEnabled(prev=>({...prev,[t.key]:!prev[t.key]}))}>
                    {tplEnabled[t.key]?'ENABLED — CLICK TO DISABLE':'DISABLED — CLICK TO ENABLE'}
                  </button>
                </div>
              );
            })}
          </div>
        </div></div>

        {/* ─── CALENDAR + DXY ─────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Monthly P&L · DXY Correlation</div><div className="scl"/></div>
        <div className="g2" style={{gridTemplateColumns:'2fr 1fr'}}>
          <div className="p">
            <div className="pt">
              {new Date().toLocaleString('en',{month:'long',year:'numeric'})} · P&L by Day
              <span className="ptb bu">{fmtPnl(mtdPnL)} MTD</span>
            </div>
            <div className="cal-wrap"><canvas ref={calRef}/></div>
          </div>
          <div className="p">
            <div className="pt">DXY vs Gold · 20-Day<span className="ptb" style={{color:'var(--wa)',borderColor:'rgba(245,158,11,.3)'}}>HEADWIND</span></div>
            <canvas ref={dxyRef} style={{display:'block',width:'100%',height:160}}/>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:5,marginTop:6}}>
              <div className="rrstat"><div className="rrl">Correlation</div><div className="rrv m">-0.82</div></div>
              <div className="rrstat"><div className="rrl">Signal</div><div className="rrv" style={{color:'var(--wa)'}}>HEADWIND</div></div>
            </div>
          </div>
        </div>

        {/* ─── HEATMAP ────────────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Gold Win Rate · Time of Day Heatmap</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div className="pt">30-Min Win Rate · 24h · Based on {ovTrades} real trades<span className="ptb bu">{ovWR} Overall</span></div>
          <canvas ref={htRef} style={{display:'block',width:'100%',height:80}}/>
          <div style={{display:'flex',justifyContent:'space-between',font:'600 7px/1 system-ui',color:'var(--t3)',marginTop:3}}>
            <span>00:00</span><span>06:00</span><span style={{color:'var(--g)'}}>08:00 LDN</span><span>12:00</span><span style={{color:'var(--in)'}}>15:00 NY SB</span><span>20:00</span><span>24:00</span>
          </div>
        </div></div>

        {/* ─── JOURNAL ────────────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Trade Journal · Real Ledger</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:8}}>
            {['all','scalp','day'].map(f=>(
              <button key={f} className={`jftab${jFilter===f?' a':''}`} onClick={()=>setJFilter(f)}>
                {f.charAt(0).toUpperCase()+f.slice(1)}
              </button>
            ))}
            <span style={{marginLeft:8,font:'600 8px/1 system-ui',color:'var(--t3)'}}>{displayJournal.length} trades{!ledger.length&&' (loading...)'}</span>
            <span style={{marginLeft:'auto',padding:'3px 8px',font:'700 7px/1 system-ui',letterSpacing:'.06em',color:'var(--bu)',border:'1px solid rgba(34,197,94,.3)',background:'rgba(34,197,94,.07)'}}>{ovWR} Active</span>
          </div>
          <div style={{overflowX:'auto'}}>
            {displayJournal.length>0 ? (
              <table className="jtbl">
                <thead><tr><th>Time</th><th>Template</th><th>Dir</th><th>Tier</th><th>Entry</th><th>SL</th><th>TP</th><th>RR</th><th>P&L</th><th>Type</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  {displayJournal.map(row=>(
                    <tr key={row.id}>
                      <td className="m">{row.time||<span style={{color:'var(--t3)'}}>{row.date}</span>}</td>
                      <td style={{color:'var(--g)',fontWeight:700}}>{row.tpl}</td>
                      <td style={{color:row.dir==='SHORT'?'var(--be)':'var(--bu)',fontWeight:700}}>{row.dir}</td>
                      <td><span style={{font:'700 7px/1 system-ui',color:row.tier==='A'?'var(--g)':'var(--t3)',padding:'2px 4px',border:`1px solid ${row.tier==='A'?'rgba(212,160,23,.4)':'var(--b2)'}`}}>{row.tier}</span></td>
                      <td className="m">{row.entry}</td>
                      <td className="m" style={{color:'var(--be)'}}>{row.sl}</td>
                      <td className="m" style={{color:'var(--bu)'}}>{row.tp1}</td>
                      <td className="m" style={{color:'var(--ml)'}}>{row.rr}</td>
                      <td className="m" style={{color:row.pnl.startsWith('+')?'var(--wa)':'var(--be)'}}>{row.pnl}</td>
                      <td><span className={`ttag ${row.type==='scalp'?'sc':'dy'}`}>{row.type.charAt(0).toUpperCase()+row.type.slice(1)}</span></td>
                      <td style={{color:row.status==='WIN'?'var(--bu)':row.status==='LOSS'?'var(--be)':'var(--wa)'}}>{row.status}</td>
                      <td><button className="delbtn" onClick={()=>setDeletedIds(prev=>{const n=new Set(prev);n.add(row.id);return n;})}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{textAlign:'center',padding:'24px 0',color:'var(--t3)',font:'600 11px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase'}}>
                {ledger.length===0?'Loading ledger data...':'No trades match filter'}
              </div>
            )}
          </div>
        </div></div>

        {/* ─── PERFORMANCE + GOALS ────────────────────────────────────── */}
        <div className="sec"><div className="scn">Performance Statistics · Goals</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div className="perf-kpis">
            <div className="kpi-tile" style={{borderTopColor:'var(--bu)'}}><div className="kpi-lbl">Win Rate</div><div className="kpi-val" style={{color:'var(--bu)'}}>{ovWR}</div><div className="kpi-sub">{ovWins} of {ovTrades} trades</div></div>
            <div className="kpi-tile" style={{borderTopColor:'var(--g)'}}><div className="kpi-lbl">Avg RR</div><div className="kpi-val" style={{color:'var(--g)'}}>{ovAvgR}</div><div className="kpi-sub">Streak: {streak>0?streak+' days':'--'}</div></div>
            <div className="kpi-tile" style={{borderTopColor:'var(--ml)'}}><div className="kpi-lbl">Profit Factor</div><div className="kpi-val" style={{color:'var(--ml)'}}>{ovPF}</div><div className="kpi-sub">30-day period</div></div>
            <div className="kpi-tile" style={{borderTopColor:'var(--wa)'}}><div className="kpi-lbl">MTD P&L</div><div className="kpi-val" style={{color:mtdPnL>=0?'var(--bu)':'var(--be)'}}>{fmtPnl(mtdPnL)}</div><div className="kpi-sub">Week: {fmtPnl(weekPnL)}</div></div>
          </div>
          <div style={{marginBottom:8}}>
            <div style={{font:'700 7px/1 system-ui',letterSpacing:'.14em',textTransform:'uppercase',color:'var(--t3)',marginBottom:5}}>This Week · Daily P&L</div>
            <canvas ref={weekRef} height={70} style={{display:'block',width:'100%'}}/>
          </div>
          <div className="goals-row">
            <div className="goal-card">
              <div className="goal-lbl">Goal of Day</div>
              <svg className="goal-svg" width={100} height={100} viewBox="0 0 100 100">
                <circle cx={50} cy={50} r={40} fill="none" stroke="var(--b2)" strokeWidth={7}/>
                <circle cx={50} cy={50} r={40} fill="none" stroke="var(--bu)" strokeWidth={7}
                  strokeLinecap="round" strokeDasharray={251} strokeDashoffset={dayOffset}
                  transform="rotate(-90 50 50)" style={{transition:'stroke-dashoffset .8s ease'}}/>
                <text x={50} y={46} textAnchor="middle" fill="var(--bu)" fontFamily="var(--mo)" fontSize={14} fontWeight={900}>{dayPct}%</text>
                <text x={50} y={59} textAnchor="middle" fill="var(--t3)" fontFamily="system-ui" fontSize={7} fontWeight={700}>OF GOAL</text>
              </svg>
              <div style={{font:'700 9px/1 system-ui',color:'var(--t2)',textAlign:'center'}}>
                <span className="m" style={{color:'var(--bu)'}}>{fmtPnl(todayPnL)}</span> / <span className="m">{dayGoalDisp}</span>
              </div>
              <div className="goal-input-row">
                <span className="goal-label">Daily $</span>
                <input className="goal-inp" type="number" value={dayGoalInput} onChange={e=>setDayGoalInput(e.target.value)}/>
                <button className="goal-set" onClick={()=>setGoal('day')}>SET</button>
              </div>
            </div>
            <div className="goal-card">
              <div className="goal-lbl">Goal of Week</div>
              <svg className="goal-svg" width={100} height={100} viewBox="0 0 100 100">
                <circle cx={50} cy={50} r={40} fill="none" stroke="var(--b2)" strokeWidth={7}/>
                <circle cx={50} cy={50} r={40} fill="none" stroke="var(--g)" strokeWidth={7}
                  strokeLinecap="round" strokeDasharray={251} strokeDashoffset={wkOffset}
                  transform="rotate(-90 50 50)" style={{transition:'stroke-dashoffset .8s ease'}}/>
                <text x={50} y={46} textAnchor="middle" fill="var(--g)" fontFamily="var(--mo)" fontSize={14} fontWeight={900}>{wkPct}%</text>
                <text x={50} y={59} textAnchor="middle" fill="var(--t3)" fontFamily="system-ui" fontSize={7} fontWeight={700}>OF GOAL</text>
              </svg>
              <div style={{font:'700 9px/1 system-ui',color:'var(--t2)',textAlign:'center'}}>
                <span className="m" style={{color:'var(--g)'}}>{fmtPnl(weekPnL)}</span> / <span className="m">{wkGoalDisp}</span>
              </div>
              <div className="goal-input-row">
                <span className="goal-label">Weekly $</span>
                <input className="goal-inp" type="number" value={wkGoalInput} onChange={e=>setWkGoalInput(e.target.value)}/>
                <button className="goal-set" onClick={()=>setGoal('week')}>SET</button>
              </div>
            </div>
          </div>
        </div></div>

        {/* ─── SIGNAL GATING ──────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Signal Gating Control</div><div className="scl"/></div>
        <div className="gate-panel"><div className="gate-wrap">
          <div className="gate-toolbar">
            <span style={{font:'700 7px/1 system-ui',letterSpacing:'.14em',textTransform:'uppercase',color:'var(--t3)'}}>Session:</span>
            {[['*','All'],['LONDON','London'],['NY_AM','NY AM'],['NY_PM','NY PM']].map(([sess,lbl])=>(
              <button key={sess} className={`gtab${gSession===sess?' a':''}`} onClick={()=>setGSession(sess)}>{lbl}</button>
            ))}
            <button onClick={gLoad} style={{padding:'3px 8px',font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--in)',border:'1px solid rgba(14,165,233,.3)',background:'transparent',cursor:'pointer'}}>↺ Refresh</button>
            <div className={`gate-status ${gStatusCls}`}>{gStatusTxt}</div>
          </div>
          <div>
            {GATE_GROUPS.map(grp=>(
              <div key={grp.name} className="gate-grp">
                <div className="gate-grp-hdr">
                  <div className="gate-grp-dot" style={{background:grp.color}}/>
                  <span className="gate-grp-name">{grp.name}</span>
                </div>
                {grp.templates.map(tmpl=>(
                  <div key={tmpl.id} className="gate-row">
                    <div className="gate-tpl">
                      <div>{tmpl.id}</div>
                      <div className="gate-tpl-sub">{tmpl.sub}</div>
                    </div>
                    <div className="gate-insts">
                      {INSTRUMENTS.map(inst=>{
                        const on=gIsOn(tmpl.id,inst),forced=gIsForced(tmpl.id,inst);
                        return (
                          <button key={inst} className={`gtog ${on?'on':'off'}${forced?' force':''}`}
                            onClick={()=>gToggle(tmpl.id,inst)} title={`${tmpl.id}/${inst}`}>
                            {IL[inst]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="gate-sess-label">{gSession==='*'?'ALL':gSession}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div></div>

        <div style={{textAlign:'center',font:'600 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)',padding:'10px 0'}}>
          QB GOLD BEAST v19 · Live data: price, P&L, positions, journal, performance
        </div>
      </div>

      {toast&&<div className={`gate-toast ${toast.err?'err':'ok'}`}>{toast.msg}</div>}
    </>
  );
}
