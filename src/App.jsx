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
const INITIAL_JOURNAL = [
  {id:1,time:'08:14',date:'',tpl:'gold-judas',dir:'SHORT',tier:'A',entry:'3358.20',sl:'3366.80',tp1:'3349.60',rr:'2.1R',pnl:'+$843 ●',type:'day',status:'OPEN'},
  {id:2,time:'07:42',date:'',tpl:'gold-fvg',dir:'LONG',tier:'A',entry:'3318.40',sl:'3311.20',tp1:'3327.60',rr:'1.3R',pnl:'+$186',type:'scalp',status:'WIN'},
  {id:3,time:'',date:'Aug 11',tpl:'reaction-ifvg',dir:'SHORT',tier:'A',entry:'3361.50',sl:'3368.00',tp1:'3347.00',rr:'2.0R',pnl:'+$292',type:'day',status:'WIN'},
  {id:4,time:'',date:'Aug 11',tpl:'gold-fvg',dir:'LONG',tier:'B',entry:'3300.00',sl:'3292.00',tp1:'3316.00',rr:'2.0R',pnl:'-$120',type:'scalp',status:'LOSS'},
  {id:5,time:'',date:'Aug 09',tpl:'orb',dir:'LONG',tier:'C',entry:'3288.50',sl:'3283.00',tp1:'3299.00',rr:'1.9R',pnl:'-$55',type:'noise',status:'LOSS'},
];
const EQ_G = [0,1.2,.8,2.1,1.8,3.4,2.9,4.2,3.8,5.1,4.7,6.3,5.8,7.2,6.9,8.4,8.1,9.6,9.2,10.8,10.4,11.9,11.5,13.1,12.7,14.2,13.8,15.4,16.9,18.4];
const EQ_I = [0,.8,.4,1.6,1.2,2.3,3.1,2.7,4.2,3.8,5.1,4.6,5.9,5.3,6.8,6.1,7.5,6.9,8.3,7.8,9.2,8.6,10.1,9.4,10.8,10.2,11.5,10.9,12.1,12.1];
const EQ_R = [0,.6,.2,1.1,.8,1.8,1.4,2.5,2.1,3.2,2.8,3.9,3.5,4.6,4.1,5.2,4.8,5.9,5.4,6.5,6,7.1,6.6,7.7,7.2,8.1,7.6,8.5,8,8.7];
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

// ── Canvas draw helpers ───────────────────────────────────────────────────────
function drawEQ(canvas, data, col, fill) {
  if(!canvas) return;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const mn = Math.min(...data), mx = Math.max(...data), rg = mx-mn||1;
  const pts = data.map((v,i)=>[i/(data.length-1)*W, H-4-((v-mn)/rg)*(H-8)]);
  ctx.fillStyle='#0C0C1A'; ctx.fillRect(0,0,W,H);
  ctx.beginPath(); ctx.moveTo(pts[0][0],H); pts.forEach(p=>ctx.lineTo(p[0],p[1]));
  ctx.lineTo(pts[pts.length-1][0],H); ctx.closePath(); ctx.fillStyle=fill; ctx.fill();
  ctx.beginPath(); pts.forEach((p,i)=>i===0?ctx.moveTo(p[0],p[1]):ctx.lineTo(p[0],p[1]));
  ctx.strokeStyle=col; ctx.lineWidth=2; ctx.stroke();
  const ep=pts[pts.length-1];
  ctx.beginPath(); ctx.arc(ep[0],ep[1],3,0,Math.PI*2);
  ctx.fillStyle=col; ctx.shadowColor=col; ctx.shadowBlur=6; ctx.fill(); ctx.shadowBlur=0;
}

function drawCalCanvas(canvas) {
  if(!canvas) return;
  canvas.width = canvas.parentElement?.offsetWidth || 500;
  canvas.height = 160;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const days=[{d:1,p:420},{d:4,p:680},{d:5,p:-120},{d:6,p:890},{d:7,p:1240},{d:8,p:-80},{d:11,p:843},{d:12,p:186}];
  const maxP=1240, bw=Math.floor((W-40)/days.length)-3, midY=H/2;
  ctx.fillStyle='#07070F'; ctx.fillRect(0,0,W,H);
  let prog=0;
  const frame = () => {
    ctx.fillStyle='#07070F'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(26,26,46,.8)'; ctx.lineWidth=1; ctx.setLineDash([2,4]);
    ctx.beginPath(); ctx.moveTo(20,midY); ctx.lineTo(W-10,midY); ctx.stroke();
    ctx.setLineDash([]);
    const weeks={1:'W1',4:'W2',11:'W3'};
    days.forEach((day,i)=>{
      const x=22+i*(bw+3), ph=Math.min(1,prog);
      const barH=((Math.abs(day.p)/maxP)*(midY-14))*ph;
      const isToday=day.d===12;
      const col=day.p>0?(isToday?'rgba(212,160,23,.9)':'rgba(34,197,94,.75)'):'rgba(239,68,68,.7)';
      const y=day.p>0?midY-barH:midY;
      ctx.fillStyle=col;
      if(isToday){ctx.shadowColor='#D4A017';ctx.shadowBlur=8;}
      ctx.fillRect(x,y,bw,barH); ctx.shadowBlur=0;
      if(ph>.8){
        ctx.fillStyle=isToday?'#D4A017':day.p>0?'rgba(34,197,94,.9)':'rgba(239,68,68,.9)';
        ctx.font=`${isToday?'800':'700'} 8px system-ui`; ctx.textAlign='center';
        const label=(day.p>0?'+':'')+Math.round(day.p*ph/100)*100;
        ctx.fillText(label,x+bw/2,day.p>0?midY-barH-3:midY+barH+11);
      }
      ctx.fillStyle=isToday?'#D4A017':'rgba(96,96,128,.7)';
      ctx.font=`${isToday?'800':'600'} 8px system-ui`; ctx.textAlign='center';
      ctx.fillText(day.d,x+bw/2,H-3);
      if(weeks[day.d]){ctx.fillStyle='rgba(64,64,96,.8)';ctx.font='700 7px system-ui';ctx.fillText(weeks[day.d],x+bw/2,12);}
    });
    if(prog>.3){
      ctx.beginPath(); ctx.strokeStyle='rgba(212,160,23,.4)'; ctx.lineWidth=1.5; ctx.setLineDash([3,4]);
      let running=0;
      days.forEach((day,i)=>{running+=day.p*prog;const x=22+i*(bw+3)+bw/2;const ly=midY-(running/4059)*(midY-14);i===0?ctx.moveTo(x,ly):ctx.lineTo(x,ly);});
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.textAlign='left';
    prog=Math.min(1,prog+.04);
    if(prog<1) requestAnimationFrame(frame);
  };
  frame();
}

function drawDXYCanvas(canvas) {
  if(!canvas) return;
  canvas.width = canvas.parentElement?.offsetWidth || 300;
  canvas.height = 160;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const hist=[[-0.4,0.38],[-0.2,0.22],[0.1,-0.09],[0.3,-0.28],[0.5,-0.44],[-0.3,0.31],[0.0,0.05],[-0.5,0.48],[0.2,-0.19],[0.4,-0.35],[-0.1,0.08],[0.3,-0.25],[0.6,-0.52],[-0.2,0.18],[0.1,-0.07],[-0.4,0.39],[0.5,-0.46],[-0.3,0.29],[0.2,-0.17],[0.32,-0.07]];
  const today=hist[hist.length-1];
  const px=v=>(v+0.7)/(1.4)*(W-30)+15;
  const py=v=>(-(v-0.6)/(1.2))*(H-30)+15;
  ctx.fillStyle='#07070F'; ctx.fillRect(0,0,W,H);
  const cx0=px(0),cy0=py(0);
  ctx.strokeStyle='rgba(40,40,64,.9)'; ctx.lineWidth=1; ctx.setLineDash([]);
  ctx.beginPath();ctx.moveTo(15,cy0);ctx.lineTo(W-10,cy0);ctx.stroke();
  ctx.beginPath();ctx.moveTo(cx0,10);ctx.lineTo(cx0,H-10);ctx.stroke();
  ctx.fillStyle='rgba(64,64,96,.7)';ctx.font='700 7px system-ui';ctx.textAlign='center';
  ctx.fillText('DXY %',W/2,H-2);
  ctx.save();ctx.translate(8,H/2);ctx.rotate(-Math.PI/2);ctx.fillText('Gold %',0,0);ctx.restore();
  ctx.textAlign='left';
  ctx.strokeStyle='rgba(139,92,246,.3)';ctx.lineWidth=1.5;ctx.setLineDash([3,5]);
  ctx.beginPath();ctx.moveTo(px(-0.7),py(-0.7*-0.92));ctx.lineTo(px(0.7),py(0.7*-0.92));ctx.stroke();ctx.setLineDash([]);
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
  canvas.width = canvas.parentElement?.offsetWidth || 800;
  canvas.height = 80;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const WR48=[42,40,38,36,35,34,33,32,34,36,38,40,42,41,39,37,68,76,84,89,87,85,82,78,72,66,58,52,48,44,42,40,70,76,83,88,90,87,82,76,75,69,62,55,50,46,43,40,38,36,34,32];
  const nowCell=Math.floor((9*60+52)/30);
  const cw=W/48, ch=H-10;
  ctx.fillStyle='#07070F'; ctx.fillRect(0,0,W,H);
  WR48.forEach((wr,i)=>{
    const x=i*cw;
    let r,g,b;
    if(wr<50){const t=(wr-28)/22;r=239;g=Math.round(68+t*90);b=68;}
    else if(wr<75){const t=(wr-50)/25;r=Math.round(245-t*211);g=Math.round(158+t*39);b=Math.round(11+t*83);}
    else{r=34;g=197;b=94;}
    if(wr>80){ctx.shadowColor=`rgba(34,197,94,.5)`;ctx.shadowBlur=4;}
    ctx.fillStyle=`rgba(${r},${g},${b},.78)`;ctx.fillRect(x+1,2,cw-2,ch-2);ctx.shadowBlur=0;
    if(i===nowCell){ctx.strokeStyle='#D4A017';ctx.lineWidth=2;ctx.strokeRect(x+1,2,cw-2,ch-2);}
    if(wr>82||i===nowCell){ctx.fillStyle='rgba(0,0,0,.75)';ctx.font='700 6px system-ui';ctx.textAlign='center';ctx.fillText(wr+'%',x+cw/2,2+ch/2+3);}
  });
  ctx.fillStyle='rgba(34,197,94,.15)';ctx.fillRect(16*cw,H-9,8*cw,8);
  ctx.fillStyle='rgba(14,165,233,.15)';ctx.fillRect(26*cw,H-9,10*cw,8);
  ctx.fillStyle='rgba(212,160,23,.8)';ctx.font='700 6px system-ui';ctx.textAlign='center';
  ctx.fillText('LDN KZ',20*cw,H-2);ctx.fillText('NY SB',31*cw,H-2);ctx.textAlign='left';
}

function drawWeekCanvas(canvas) {
  if(!canvas) return;
  canvas.width = canvas.parentElement?.offsetWidth || 500;
  canvas.height = 70;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const days=[{d:'Mon',p:843},{d:'Tue',p:186},{d:'Wed',p:0},{d:'Thu',p:0},{d:'Fri',p:0}];
  const maxP=1200, bw=Math.floor((W-40)/days.length)-8;
  ctx.fillStyle='#07070F'; ctx.fillRect(0,0,W,H);
  let prog=0;
  const frame=()=>{
    ctx.fillStyle='#07070F'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(26,26,46,.9)';ctx.lineWidth=1;ctx.setLineDash([2,4]);
    ctx.beginPath();ctx.moveTo(10,H/2-5);ctx.lineTo(W-10,H/2-5);ctx.stroke();ctx.setLineDash([]);
    days.forEach((day,i)=>{
      const x=16+i*(bw+8), ph=Math.min(1,prog);
      const barH=(Math.abs(day.p)/maxP)*(H/2-12)*ph;
      if(barH>0){
        const y=day.p>0?H/2-5-barH:H/2-5;
        ctx.fillStyle=day.p>0?'rgba(34,197,94,.7)':'rgba(64,64,80,.4)';
        ctx.fillRect(x,y,bw,Math.max(barH,1));
        if(day.p>0&&ph>.7){ctx.fillStyle='rgba(34,197,94,.85)';ctx.font='700 8px system-ui';ctx.textAlign='center';ctx.fillText('+'+(day.p*ph|0),x+bw/2,y-3);}
      }
      ctx.fillStyle=day.p>0?'rgba(34,197,94,.8)':'rgba(64,64,80,.6)';
      ctx.font='700 7px system-ui';ctx.textAlign='center';ctx.fillText(day.d,x+bw/2,H-2);
    });
    ctx.textAlign='left'; prog=Math.min(1,prog+.05);
    if(prog<1) requestAnimationFrame(frame);
  };
  frame();
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [utcTime, setUtcTime] = useState('--:--:--');
  const [wavePx, setWavePx] = useState('3 341.50');
  const [pnl, setPnl] = useState(843);
  const [lot, setLot] = useState(10);
  const [curRR, setCurRR] = useState(1);
  const [dayGoalInput, setDayGoalInput] = useState(1400);
  const [wkGoalInput, setWkGoalInput] = useState(6500);
  const [dayPct, setDayPct] = useState(74);
  const [wkPct, setWkPct] = useState(62);
  const [dayGoalDisp, setDayGoalDisp] = useState('$1,400');
  const [wkGoalDisp, setWkGoalDisp] = useState('$6,500');
  const [jFilter, setJFilter] = useState('all');
  const [journal, setJournal] = useState(INITIAL_JOURNAL);
  const [tplEnabled, setTplEnabled] = useState({G:true,I:true,R:true});
  const [gRules, setGRules] = useState({});
  const [gSession, setGSession] = useState('*');
  const [gLive, setGLive] = useState(false);
  const [gStatusCls, setGStatusCls] = useState('wa');
  const [gStatusTxt, setGStatusTxt] = useState('⬤ Preview');
  const [toast, setToast] = useState(null);

  // ── Computed risk values ───────────────────────────────────────────────────
  const lotVal = Math.max(0.1, Math.round(lot/10*10)/10);
  const riskDol = lotVal * 10 * 8.6;
  const riskPct = riskDol / 10000 * 100;
  const tp1 = riskDol * curRR;
  const tp2 = riskDol * curRR * 2;
  const lotZone = lotVal <= 1 ? 'SAFE' : lotVal <= 3 ? 'STD' : 'HIGH';
  const lotZoneColor = lotVal <= 1 ? 'var(--bu)' : lotVal <= 3 ? 'var(--wa)' : 'var(--be)';

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

  // ── Mutable animation refs (not React state) ───────────────────────────────
  const bgtRef   = useRef(0);
  const waveHRef = useRef([]);
  const wtRef    = useRef(0);
  const cryRef   = useRef(0);
  const kntRef   = useRef(0);
  const rdtRef   = useRef(0);
  const pnlRef   = useRef(843);
  const toastTimerRef = useRef(null);
  const gLiveRef     = useRef(false);
  const gRulesRef    = useRef({});
  const gSessionRef  = useRef('*');

  useEffect(() => { gRulesRef.current = gRules; }, [gRules]);
  useEffect(() => { gLiveRef.current = gLive; }, [gLive]);
  useEffect(() => { gSessionRef.current = gSession; }, [gSession]);

  // ── Clock ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      setUtcTime([n.getUTCHours(),n.getUTCMinutes(),n.getUTCSeconds()].map(x=>String(x).padStart(2,'0')).join(':'));
    };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, []);

  // ── P&L live float ─────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      pnlRef.current += (Math.random() - .42) * 2.5;
      setPnl(pnlRef.current);
    }, 800);
    return () => clearInterval(id);
  }, []);

  // ── Aurora BG ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = bgRef.current; if(!c) return;
    const ctx = c.getContext('2d');
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize(); window.addEventListener('resize', resize);
    let raf;
    const draw = () => {
      const W=c.width, H=c.height; ctx.clearRect(0,0,W,H);
      const t=bgtRef.current*.0022;
      [[W*.2+Math.sin(t)*W*.07,H*.35+Math.cos(t*.7)*H*.06,[212,160,23]],
       [W*.82+Math.cos(t*.6)*W*.06,H*.6+Math.sin(t*.8)*H*.05,[139,92,246]],
       [W*.5+Math.sin(t*.5)*W*.05,H*.12+Math.cos(t)*H*.04,[14,165,233]]
      ].forEach(([x,y,rgb]) => {
        const g=ctx.createRadialGradient(x,y,0,x,y,W*.26);
        g.addColorStop(0,`rgba(${rgb},.04)`); g.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
      });
      bgtRef.current++; raf=requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(raf); };
  }, []);

  // ── EKG Wave ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = waveRef.current; if(!c) return;
    const ctx = c.getContext('2d');
    const BASE=3341.5, HI=3358.2, LO=3318.4;
    const resize = () => { c.width=c.parentElement?.offsetWidth||800; c.height=108; };
    resize(); window.addEventListener('resize', resize);
    let raf;
    const map = v => 108-(v-LO+5)/(HI-LO+10)*(108-16)-8;
    const draw = () => {
      const W=c.width, H=108;
      const wH=waveHRef.current;
      const px=BASE+Math.sin(wtRef.current*.04)*3.2+Math.sin(wtRef.current*.13)*1.8+Math.sin(wtRef.current*.27)*.9+(Math.random()-.5)*.3;
      wH.push(px); if(wH.length>W) wH.shift();
      ctx.fillStyle='rgba(7,7,15,.92)'; ctx.fillRect(0,0,W,H);
      [[HI,'rgba(239,68,68,.25)'],[LO,'rgba(34,197,94,.25)'],[3350,'rgba(212,160,23,.15)']].forEach(([v,col])=>{
        ctx.strokeStyle=col;ctx.setLineDash([3,5]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,map(v));ctx.lineTo(W,map(v));ctx.stroke();
      });
      ctx.setLineDash([]);
      [[HI,'rgba(239,68,68,.8)','HH 3358.20',true],[LO,'rgba(34,197,94,.8)','HL 3318.40',false],[3350,'rgba(212,160,23,.6)','PSYCH 3350',true]].forEach(([v,col,lbl,above])=>{
        ctx.fillStyle=col;ctx.font='700 8px system-ui';ctx.fillText(lbl,4,map(v)+(above?-4:11));
      });
      if(wH.length>100){
        [Math.floor(wH.length*.25),Math.floor(wH.length*.55)].forEach((xi,i)=>{
          const v=wH[xi],y=map(v);
          ctx.fillStyle=i===0?'rgba(239,68,68,.7)':'rgba(34,197,94,.7)';
          ctx.beginPath();ctx.arc(xi,y,4,0,Math.PI*2);ctx.fill();
          ctx.strokeStyle=i===0?'rgba(239,68,68,.4)':'rgba(34,197,94,.4)';ctx.lineWidth=1;ctx.setLineDash([2,4]);
          ctx.beginPath();ctx.moveTo(xi,0);ctx.lineTo(xi,H);ctx.stroke();ctx.setLineDash([]);
          ctx.fillStyle=i===0?'rgba(239,68,68,.7)':'rgba(34,197,94,.7)';ctx.font='700 8px system-ui';ctx.fillText(i===0?'HH':'BOS',xi+4,y-4);
        });
      }
      ctx.beginPath();wH.forEach((v,i)=>{const y=map(v);i===0?ctx.moveTo(i,y):ctx.lineTo(i,y);});
      ctx.strokeStyle='#D4A017';ctx.lineWidth=1.5;ctx.stroke();
      ctx.save();ctx.beginPath();wH.forEach((v,i)=>{const y=map(v);i===0?ctx.moveTo(i,y):ctx.lineTo(i,y);});
      ctx.lineTo(wH.length-1,H);ctx.lineTo(0,H);ctx.closePath();
      const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba(212,160,23,.12)');g.addColorStop(1,'rgba(212,160,23,0)');
      ctx.fillStyle=g;ctx.fill();ctx.restore();
      if(wH.length>1){
        const lx=wH.length-1,ly=map(wH[lx]);
        ctx.beginPath();ctx.arc(lx,ly,3.5,0,Math.PI*2);
        ctx.fillStyle='#D4A017';ctx.shadowColor='#D4A017';ctx.shadowBlur=10;ctx.fill();ctx.shadowBlur=0;
        setWavePx(wH[lx].toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,' '));
      }
      wtRef.current++; raf=requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(raf); };
  }, []);

  // ── 3D Crystal ────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = crRef.current; if(!c) return;
    const ctx = c.getContext('2d');
    const p3=(vx,vy,vz,rx,ry)=>{const x1=vx*Math.cos(ry)-vz*Math.sin(ry),z1=vx*Math.sin(ry)+vz*Math.cos(ry);const y2=vy*Math.cos(rx)-z1*Math.sin(rx),z2=vy*Math.sin(rx)+z1*Math.cos(rx);const s=4/(4+z2+2);return[x1*s*50+78,y2*s*50+74,z2];};
    let raf;
    const draw = () => {
      ctx.clearRect(0,0,156,148); cryRef.current+=.006;
      const pts=VERTS.map(v=>p3(v[0],v[1],v[2],.3,cryRef.current));
      EDGES.forEach(([a,b])=>{const dz=(pts[a][2]+pts[b][2])/2,al=Math.max(.04,Math.min(.82,(dz+2)/4));ctx.beginPath();ctx.moveTo(pts[a][0],pts[a][1]);ctx.lineTo(pts[b][0],pts[b][1]);ctx.strokeStyle=`rgba(212,160,23,${al})`;ctx.lineWidth=1.2;ctx.stroke();});
      const g=ctx.createRadialGradient(78,74,8,78,74,60);g.addColorStop(0,'rgba(34,197,94,.06)');g.addColorStop(1,'rgba(34,197,94,0)');ctx.fillStyle=g;ctx.fillRect(0,0,156,148);
      raf=requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(raf);
  }, []);

  // ── KNN ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = knnRef.current; if(!c) return;
    const ctx = c.getContext('2d');
    let raf;
    const draw = () => {
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
      ctx.fillStyle='rgba(74,74,96,.6)';ctx.font='700 8px system-ui';ctx.fillText('Pattern Cluster · 12 matches',5,13);
      raf=requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(raf);
  }, []);

  // ── Radar ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = radRef.current; if(!c) return;
    const ctx = c.getContext('2d');
    rdtRef.current = 0;
    let raf;
    const draw = () => {
      const RW=c.width||290, RH=c.height||140;
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
    draw(); return () => cancelAnimationFrame(raf);
  }, []);

  // ── Static canvases (drawn once after mount) ───────────────────────────────
  useEffect(() => {
    const t1=setTimeout(()=>drawEQ(eqGRef.current,EQ_G,'#D4A017','rgba(212,160,23,.12)'),100);
    const t2=setTimeout(()=>drawEQ(eqIRef.current,EQ_I,'#22C55E','rgba(34,197,94,.1)'),120);
    const t3=setTimeout(()=>drawEQ(eqRRef.current,EQ_R,'#0EA5E9','rgba(14,165,233,.09)'),140);
    const t4=setTimeout(()=>drawCalCanvas(calRef.current),200);
    const t5=setTimeout(()=>drawDXYCanvas(dxyRef.current),220);
    const t6=setTimeout(()=>drawHeatCanvas(htRef.current),240);
    const t7=setTimeout(()=>drawWeekCanvas(weekRef.current),260);
    return () => [t1,t2,t3,t4,t5,t6,t7].forEach(clearTimeout);
  }, []);

  // ── Goal ring helper ───────────────────────────────────────────────────────
  const setGoal = useCallback((type) => {
    const dayPnl=1029, wkPnl=4059;
    if(type==='day'){
      const g=parseFloat(dayGoalInput)||1400;
      const p=Math.min(100,Math.round(dayPnl/g*100));
      setDayPct(p); setDayGoalDisp('$'+Number(g).toLocaleString());
    } else {
      const g=parseFloat(wkGoalInput)||6500;
      const p=Math.min(100,Math.round(wkPnl/g*100));
      setWkPct(p); setWkGoalDisp('$'+Number(g).toLocaleString());
    }
  }, [dayGoalInput, wkGoalInput]);

  // ── Journal delete ─────────────────────────────────────────────────────────
  const deleteJournalRow = useCallback((id) => {
    setJournal(prev => prev.filter(r => r.id !== id));
  }, []);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const showToast = useCallback((msg, err=false) => {
    setToast({msg,err});
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // ── Gating helpers ────────────────────────────────────────────────────────
  const gKey = (t,s,i) => `${t}|${s}|${i}`;
  const gIsOn = (tmpl, inst) => {
    const rules=gRulesRef.current, sess=gSessionRef.current;
    const k1=gKey(tmpl,sess,inst), k2=gKey(tmpl,'*',inst);
    return k1 in rules ? rules[k1] : k2 in rules ? rules[k2] : !SOFF.has(gKey(tmpl,'*',inst));
  };
  const gIsForced = (tmpl, inst) => FORCED.has(gKey(tmpl,'*',inst));

  const gLoad = useCallback(async () => {
    try {
      const r=await fetch(GATE_API,{cache:'no-store'});
      const d=await r.json();
      if(d.ok){
        const newRules={};
        Object.entries(d.rules).forEach(([k,v])=>{ if(k.split('|').length===3) newRules[k]=v.on; });
        setGRules(newRules); setGLive(true); setGStatusCls('ok'); setGStatusTxt('⬤ Live');
      } else throw 0;
    } catch {
      const seed={};
      SOFF.forEach(k=>seed[k]=false);
      FORCED.forEach(k=>seed[k]=true);
      setGRules(seed); setGLive(false); setGStatusCls('wa'); setGStatusTxt('⬤ Preview');
    }
  }, []);

  const gToggle = useCallback(async (tmpl, inst) => {
    const currentOn=gIsOn(tmpl, inst);
    const nextOn=!currentOn;
    if(gIsForced(tmpl,inst) && !nextOn){ showToast('Force-enabled — cannot disable',true); return; }
    const k=gKey(tmpl,gSessionRef.current,inst);
    setGRules(prev=>({...prev,[k]:nextOn}));
    if(gLiveRef.current){
      try {
        const r=await fetch(GATE_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template:tmpl,session:gSessionRef.current,instrument:inst,on:nextOn})});
        const d=await r.json();
        if(d.ok) showToast(`${tmpl}/${inst} → ${nextOn?'ON':'OFF'}`);
        else { setGRules(prev=>({...prev,[k]:currentOn})); showToast('API error',true); }
      } catch { setGRules(prev=>({...prev,[k]:currentOn})); showToast('API unreachable',true); }
    } else showToast(`${tmpl}/${inst} → ${nextOn?'ON':'OFF'} (preview)`);
  }, [showToast]);

  useEffect(() => { gLoad(); }, [gLoad]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const filteredJournal = jFilter==='all' ? journal : journal.filter(r=>r.type===jFilter);
  const dayOffset = Math.round(251-(251*dayPct/100));
  const wkOffset  = Math.round(251-(251*wkPct/100));

  // ═══════════════════════════════ JSX ═════════════════════════════════════
  return (
    <>
      <canvas ref={bgRef} id="bgC" />
      <div className="pg">

        {/* ─── HEADER ─────────────────────────────────────────────────── */}
        <header className="hdr">
          <div className="hr1">
            <div className="hbrand">QB Gold Beast</div>
            <span className="hpx m">3 341.50</span>
            <span className="hpxch" style={{color:'var(--be)'}}>▼ −2.30 (−0.07%)</span>
            <div style={{marginLeft:8,font:'600 8px/1 system-ui',color:'var(--t3)'}}>
              BID <span className="m" style={{color:'var(--t)'}}>3341.38</span> · ASK <span className="m" style={{color:'var(--t)'}}>3341.62</span>
            </div>
            <div className="hdiv"/>
            <div className="hbias-row">
              <div className="hbias short"><div className="hbl">H1</div><div className="hbv">SHORT</div></div>
              <div className="hbias long"><div className="hbl">H4</div><div className="hbv">LONG</div></div>
              <div className="hbias long"><div className="hbl">D</div><div className="hbv">LONG</div></div>
            </div>
            <div className="hdiv"/>
            <div className="hkpis">
              <div className="hkpi"><div className="hkl">Today P&L</div><div className="hkv" style={{color:'var(--bu)'}}>+$1,029</div></div>
              <div className="hkpi"><div className="hkl">Streak</div><div className="hkv" style={{color:'var(--g)'}}>7 days</div></div>
              <div className="hkpi"><div className="hkl">WN Rate</div><div className="hkv" style={{color:'var(--bu)'}}>81.8%</div></div>
              <div className="hkpi"><div className="hkl">ATR(14)</div><div className="hkv m">42.30</div></div>
            </div>
            <div className="hsess" style={{marginLeft:'auto'}}>
              <div className="hsb"><div className="hsd" style={{background:'var(--in)'}}/>Asian LOCKED</div>
              <div className="hsb act"><div className="hsd"/>London · <span className="m">38:00</span></div>
              <div className="hsb wa"><div className="hsd" style={{animationDelay:'.4s'}}/>NY · <span className="m">3h 08m</span></div>
              <div style={{marginLeft:6,display:'flex',alignItems:'center',gap:5,padding:'4px 10px',font:'700 8px/1 system-ui',letterSpacing:'.08em',textTransform:'uppercase',color:'var(--bu)',border:'1px solid rgba(34,197,94,.3)',background:'rgba(34,197,94,.07)'}}>
                <div className="hsd"/>ACTIVE
              </div>
            </div>
          </div>
          <div className="hr2">
            <div className="adr-wrap">
              <div className="adr-label">ADR</div>
              <div className="adr-bar"><div className="adr-fill"/></div>
              <div className="adr-pct">67%</div>
            </div>
            <div className="hinfo">
              <div className="hi g"><strong>Asian</strong> 3318–3358 · LOCKED</div>
              <div className="hi g"><strong>Judas</strong> FIRED 08:14 SHORT</div>
              <div className="hi bu"><strong>BOS</strong> HH→HL confirmed</div>
              <div className="hi wa"><strong>LBMA</strong> Fix 10:30 UTC</div>
              <div className="hi be"><strong>CPI</strong> 14:00 UTC · Reduce size 13:45</div>
              <div className="hi ml"><strong>CVD</strong> Rising · <span className="m">{utcTime}</span></div>
              <div className="hi"><strong>FVGs</strong> 4 live</div>
              <div className="hi g"><strong>Psych</strong> 3350 · 3300 · 3400</div>
            </div>
          </div>
          <div className="ticker-wrap"><div className="ticker">
            {[['u','XAUUSD','3341.50 ▲'],['n','ATR14','42.3'],['d','ADR','67%'],['u','Bias','H1SHORT/H4LONG/DLONG'],['n','FVGs','4 live'],['n','KNN','87% conf'],['u','Judas','FIRED ✓ 08:14'],['u','Float','+$843 ●'],['n','LBMA','10:30 UTC'],['u','Streak','7 days'],['u','WN','81.8%'],['n','DXY','+0.32% HEADWIND'],
              ['u','XAUUSD','3341.50 ▲'],['n','ATR14','42.3'],['d','ADR','67%'],['u','Bias','H1SHORT/H4LONG/DLONG'],['n','FVGs','4 live'],['n','KNN','87% conf'],['u','Judas','FIRED ✓ 08:14'],['u','Float','+$843 ●'],['n','LBMA','10:30 UTC'],['u','Streak','7 days'],['u','WN','81.8%'],['n','DXY','+0.32% HEADWIND']
            ].map(([cls,lbl,val],i)=>(
              <span key={i} className={`ti ${cls}`}>{lbl}<span className="tv">{val}</span></span>
            ))}
          </div></div>
        </header>

        {/* ─── DIRECTIVE ──────────────────────────────────────────────── */}
        <div className="dir hold">
          <div className="dir-state">▶ HOLD POSITION</div>
          <div className="dir-text">Judas SHORT active · <strong>LBMA Fix in 38m</strong> — hold through fix, amplifies direction · Float +$843 · TP1 3349.60 approaching</div>
          <div className="dir-pill">⚠ CPI 14:00 → reduce 13:45</div>
        </div>

        {/* ─── EKG HERO ───────────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Price · EKG · Market Structure</div><div className="scl"/>
          <div style={{font:'600 8px/1 system-ui',color:'var(--t3)'}}>Asian <span style={{color:'var(--be)'}}>HH 3358</span> · <span style={{color:'var(--bu)'}}>HL 3318</span> · Psych <span style={{color:'var(--g)'}}>3350</span></div>
        </div>
        <div style={{padding:'0 14px 8px'}}>
          <div className="wave-panel">
            <div className="wave-ov">
              <div><div className="wol">Asian Hi</div><div className="wov m" style={{color:'var(--be)'}}>3358.20</div></div>
              <div><div className="wol">Asian Lo</div><div className="wov m" style={{color:'var(--bu)'}}>3318.40</div></div>
              <div><div className="wol">SB 15:00</div><div className="wov m" style={{color:'var(--in)'}}>Next 5h</div></div>
              <div><div className="wol">BOS</div><div className="wov m" style={{color:'var(--bu)'}}>HH→HL ✓</div></div>
            </div>
            <div className="wave-px m">{wavePx}</div>
            <canvas ref={waveRef}/>
          </div>
        </div>

        {/* ─── OPEN POSITION + RISK/DD ────────────────────────────────── */}
        <div className="sec"><div className="scn">Open Position</div><div className="scl"/></div>
        <div className="g2" style={{gridTemplateColumns:'1fr 1fr'}}>
          <div className="p">
            <div className="pt">Trade Details<span className="ptb be">SHORT ▼</span></div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div className="pos-info">
                <div className="pi"><span className="pil">Template</span><span className="piv" style={{color:'var(--g)'}}>gold-judas</span></div>
                <div className="pi"><span className="pil">Tier</span><span className="piv" style={{color:'var(--g)'}}>A</span></div>
                <div className="pi"><span className="pil">Lot</span><span className="piv">1.0</span></div>
                <div className="pi"><span className="pil">Entry</span><span className="piv m">3 358.20</span></div>
                <div className="pi"><span className="pil">Stop</span><span className="piv m" style={{color:'var(--be)'}}>3 366.80</span></div>
                <div className="pi"><span className="pil">TP1</span><span className="piv m" style={{color:'var(--bu)'}}>3 349.60</span></div>
                <div className="pi"><span className="pil">TP2</span><span className="piv m" style={{color:'var(--bu)'}}>3 341.00</span></div>
                <div className="pi"><span className="pil">In trade</span><span className="piv" style={{color:'var(--wa)'}}>1h 38m</span></div>
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}}>
                <div style={{font:'600 8px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)'}}>Live Float</div>
                <div className="pnl-big" style={{color:pnl>=0?'var(--bu)':'var(--be)'}}>{pnl>=0?'+':''}{Math.abs(pnl).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g,',')} $</div>
                <div className="pnl-sub">+1.67R · +0.84% acct</div>
                <div className="prog-track" style={{width:'100%'}}><div className="prog-fill" style={{width:'64%'}}/></div>
                <div style={{display:'flex',justifyContent:'space-between',width:'100%',font:'600 7px/1 system-ui',color:'var(--t3)'}}>
                  <span>SL</span><span style={{color:'var(--bu)'}}>64% to TP1</span><span>TP2</span>
                </div>
                <div className="pos-btns" style={{width:'100%'}}>
                  <button className="pb wa">⇒ BE</button>
                  <button className="pb in">50%</button>
                  <button className="pb be">✕ Close</button>
                </div>
              </div>
            </div>
          </div>

          {/* Risk Command + DD Shield */}
          <div className="p">
            <div className="pt">Risk Command · Drawdown Shield</div>
            <div className="rdd-grid">
              <div className="rdd-tile"><div className="rdl">Today P&L</div><div className="rdv" style={{color:'var(--bu)'}}>+$1,029</div><div className="rdbar"><div className="rdf" style={{width:'69%',background:'var(--bu)'}}/></div></div>
              <div className="rdd-tile"><div className="rdl">Drawdown</div><div className="rdv" style={{color:'var(--bu)'}}>$0</div><div className="rdbar"><div className="rdf" style={{width:'0%',background:'var(--be)'}}/></div></div>
              <div className="rdd-tile"><div className="rdl">Max Allow</div><div className="rdv">$400 · 4%</div></div>
              <div className="rdd-tile"><div className="rdl">Account</div><div className="rdv m">$10,000</div></div>
            </div>
            <div className="shield ok">🛡 SHIELD ACTIVE · Full size permitted</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:3}}>
              <span style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)'}}>Lot Size</span>
              <div style={{display:'flex',alignItems:'baseline',gap:4}}>
                <span className="m" style={{fontSize:18,fontWeight:900}}>{lotVal.toFixed(1)}</span>
                <span style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:lotZoneColor}}>{lotZone}</span>
              </div>
            </div>
            <input type="range" className="lsl" min={1} max={100} value={lot} onChange={e=>setLot(Number(e.target.value))}/>
            <div className="rrstats">
              <div className="rrstat"><div className="rrl">Risk $</div><div className="rrv" style={{color:'var(--wa)'}}>${riskDol.toFixed(0)}</div></div>
              <div className="rrstat"><div className="rrl">Risk %</div><div className="rrv" style={{color:riskPct<1?'var(--bu)':riskPct<2?'var(--wa)':'var(--be)'}}>{riskPct.toFixed(2)}%</div></div>
              <div className="rrstat"><div className="rrl">TP1</div><div className="rrv" style={{color:'var(--bu)'}}>+${tp1.toFixed(0)}</div></div>
              <div className="rrstat"><div className="rrl">TP2</div><div className="rrv" style={{color:'var(--bu)'}}>+${tp2.toFixed(0)}</div></div>
            </div>
            <div className="rrbts">
              {[1,1.5,2,2.5,3,4].map(r=>(
                <button key={r} className={`rrb${curRR===r?' a':''}`} onClick={()=>setCurRR(r)}>1:{r}</button>
              ))}
            </div>
            <div className="smart-lot">
              <div className="sl-lbl">ML Smart Lot</div>
              <div style={{display:'flex',alignItems:'baseline',gap:6}}><div className="sl-num">0.8</div><div style={{font:'700 8px/1 system-ui',color:'var(--t3)'}}>SUGGESTED</div></div>
              <div className="slr">7-day streak → +10%</div>
              <div className="slr">ADR 67% → cap size</div>
              <div className="slr">CPI 14:00 → −15% size</div>
              <button style={{width:'100%',marginTop:5,padding:4,font:'700 7px/1 system-ui',letterSpacing:'.08em',textTransform:'uppercase',color:'var(--ml)',border:'1px solid rgba(139,92,246,.3)',background:'transparent',cursor:'pointer'}}
                onClick={()=>setLot(8)}>Apply 0.8 lot</button>
            </div>
          </div>
        </div>

        {/* ─── COMMAND CENTER ─────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Command Center · Crystal · KNN · Radar</div><div className="scl"/></div>
        <div className="g3" style={{gridTemplateColumns:'1fr 1.2fr 1fr'}}>

          {/* Crystal */}
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
                {[['HTF 3/3','var(--bu)',100,'+30'],['Session KZ','var(--wa)',80,'+20'],['News Clear','var(--bu)',60,'+15'],['Asian Range','var(--bu)',60,'+15'],['CVD Confirm','var(--in)',40,'+10'],['ADR 67%','var(--be)',28,'-8']].map(([lbl,col,w,v])=>(
                  <div key={lbl} className="cf">
                    <div className="cfl">{lbl}</div>
                    <div className="cfb"><div className="cfbf" style={{background:col,width:`${w}%`}}/></div>
                    <div className="cfv" style={{color:v.startsWith('-')?'var(--be)':'var(--bu)'}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* KNN + Radar */}
          <div className="p">
            <div className="pt">KNN Pattern Cluster<span className="ptb ml">10/12 WINS · 83.3%</span></div>
            <canvas ref={knnRef} width={290} height={160} style={{display:'block',width:'100%'}}/>
            <div style={{display:'flex',gap:10,marginTop:5,paddingTop:5,borderTop:'1px solid var(--b)'}}>
              <div style={{display:'flex',alignItems:'center',gap:4,font:'600 8px/1 system-ui',color:'var(--t2)'}}><div style={{width:6,height:6,borderRadius:'50%',background:'var(--bu)'}}/> WIN(10)</div>
              <div style={{display:'flex',alignItems:'center',gap:4,font:'600 8px/1 system-ui',color:'var(--t2)'}}><div style={{width:6,height:6,borderRadius:'50%',background:'var(--be)'}}/> LOSS(2)</div>
              <div style={{display:'flex',alignItems:'center',gap:4,font:'600 8px/1 system-ui',color:'var(--t2)'}}><div style={{width:6,height:6,borderRadius:'50%',background:'var(--g)',boxShadow:'0 0 4px var(--g)'}}/> TODAY</div>
              <div style={{marginLeft:'auto',font:'600 8px/1 system-ui',color:'var(--t3)'}}>Cluster WN: <span style={{color:'var(--bu)',fontWeight:800}}>83.3%</span></div>
            </div>
            <div style={{marginTop:8,borderTop:'1px solid var(--b)',paddingTop:8}}>
              <div className="pt" style={{border:'none',marginBottom:5,paddingBottom:0}}>Signal Radar · 6-Factor</div>
              <canvas ref={radRef} width={290} height={140} style={{display:'block',width:'100%'}}/>
            </div>
          </div>

          {/* Signal Gates Pine Vision */}
          <div className="p">
            <div className="pt">Signal Gates · Pine Vision</div>
            {[
              {id:'A',tpl:'gold-fvg',status:'wa',statusTxt:'● WATCHING',nodes:['HTF','KZ','ADR','FVG'],waiting:'Retest'},
              {id:'B',tpl:'gold-judas',status:'fi',statusTxt:'✓ FIRED 08:14',nodes:['HTF','Asian','Sweep','Close','Entry'],waiting:null},
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
        <div className="sec"><div className="scn">Template Battle · Advanced Statistics</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div className="tpl-grid">
            {[
              {key:'G',col:'var(--g)',grp:'QB GOLD · CHAMPION',name:'Gold Specialist',wr:'81.8%',ref:eqGRef,stats:[['Avg RR','2.1R','bu'],['30d P&L','+$4,210','bu'],['Trades','44',''],['Profit F.','3.8','bu'],['Best','+$840','bu'],['Max DD','-$420','be']],barW:100},
              {key:'I',col:'var(--bu)',grp:'QB ICT',name:'ICT Specialist',wr:'78.2%',ref:eqIRef,stats:[['Avg RR','1.8R','bu'],['30d P&L','+$3,180','bu'],['Trades','51',''],['Profit F.','2.9','bu'],['Best','+$640','bu'],['Max DD','-$380','be']],barW:76},
              {key:'R',col:'var(--in)',grp:'QB REACT',name:'Reaction IFVG',wr:'73.1%',ref:eqRRef,stats:[['Avg RR','1.6R','bu'],['30d P&L','+$1,740','bu'],['Trades','26',''],['Profit F.','2.1','bu'],['Best','+$420','bu'],['Max DD','-$210','be']],barW:57},
            ].map(t=>(
              <div key={t.key} className="tcard" style={{borderTopColor:t.col}}>
                <div className="tc-hdr">
                  <div>
                    <div style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--t3)'}}>{t.grp}</div>
                    <div className="tc-name" style={{color:t.col}}>{t.name}</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div className="tc-wr" style={{color:t.col}}>{t.wr}</div>
                    <div style={{font:'700 7px/1 system-ui',color:'var(--t3)'}}>WIN RATE</div>
                  </div>
                </div>
                <canvas ref={t.ref} width={300} height={55} style={{width:'100%',background:'var(--s2)',border:'1px solid var(--b)',display:'block',marginBottom:5}}/>
                <div className="tc-stats">
                  {t.stats.map(([lbl,val,col])=>(
                    <div key={lbl} className="tcs">
                      <div className="tcsl">{lbl}</div>
                      <div className="tcsv" style={col?{color:`var(--${col})`}:{}}>{val}</div>
                    </div>
                  ))}
                </div>
                <div className="tc-bar"><div style={{width:`${t.barW}%`,height:3,background:t.col,opacity:.5}}/></div>
                <button className={`tc-toggle${tplEnabled[t.key]?' on':' off'}`} onClick={()=>setTplEnabled(prev=>({...prev,[t.key]:!prev[t.key]}))}>
                  {tplEnabled[t.key]?'ENABLED — CLICK TO DISABLE':'DISABLED — CLICK TO ENABLE'}
                </button>
              </div>
            ))}
          </div>
        </div></div>

        {/* ─── CALENDAR + DXY ─────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Monthly P&L · DXY Correlation</div><div className="scl"/></div>
        <div className="g2" style={{gridTemplateColumns:'2fr 1fr'}}>
          <div className="p">
            <div className="pt">August 2026 · P&L by Day<span className="ptb bu">+$4,059 MTD</span></div>
            <div className="cal-wrap"><canvas ref={calRef}/></div>
          </div>
          <div className="p">
            <div className="pt">DXY vs Gold · 20-Day Scatter<span className="ptb" style={{color:'var(--wa)',borderColor:'rgba(245,158,11,.3)'}}>DXY +0.32% HEADWIND</span></div>
            <canvas ref={dxyRef} style={{display:'block',width:'100%',height:160}}/>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:5,marginTop:6}}>
              <div className="rrstat"><div className="rrl">Correlation</div><div className="rrv m">-0.82</div></div>
              <div className="rrstat"><div className="rrl">Today</div><div className="rrv" style={{color:'var(--wa)'}}>HEADWIND</div></div>
              <div className="rrstat"><div className="rrl">DXY Δ</div><div className="rrv m" style={{color:'var(--be)'}}>+0.32%</div></div>
              <div className="rrstat"><div className="rrl">Gold Δ</div><div className="rrv m" style={{color:'var(--be)'}}>-0.07%</div></div>
            </div>
          </div>
        </div>

        {/* ─── HEATMAP ────────────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Gold Win Rate · Time of Day Heatmap</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div className="pt">30-Min Bar Win Rate · 24h · London KZ + NY SB highlighted<span className="ptb bu">NOW: 88% WR</span></div>
          <canvas ref={htRef} style={{display:'block',width:'100%',height:80}}/>
          <div style={{display:'flex',justifyContent:'space-between',font:'600 7px/1 system-ui',color:'var(--t3)',marginTop:3}}>
            <span>00:00</span><span>04:00</span><span style={{color:'var(--g)'}}>08:00 ← LDN</span><span>12:00</span><span style={{color:'var(--in)'}}>16:00 SB →</span><span>20:00</span><span>24:00</span>
          </div>
        </div></div>

        {/* ─── INTEL + NEWS ───────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Gold Intelligence · EOD · News</div><div className="scl"/></div>
        <div className="g3" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div className="p" style={{borderTop:'2px solid var(--ml)'}}>
            <div className="pt" style={{color:'var(--ml)'}}>KNN Matches<span className="ptb ml">83.3% WN</span></div>
            <div style={{display:'flex',flexDirection:'column',gap:3}}>
              {[['#1','Judas + LBMA Confluence','87.5%'],['#2','All-HTF Long + Asian Locked','82.1%'],['#3','London KZ + FVG BOS','88.9%']].map(([n,lbl,wr])=>(
                <div key={n} style={{display:'flex',alignItems:'center',gap:6,padding:'5px 6px',background:'var(--s2)',border:'1px solid var(--b)'}}>
                  <div style={{font:'700 7px/1 system-ui',color:'var(--t3)',width:14}}>{n}</div>
                  <div style={{font:'600 9px/1.2 system-ui',flex:1}}>{lbl}</div>
                  <div style={{fontFamily:'var(--mo)',fontSize:10,fontWeight:800,color:'var(--bu)'}}>{wr}</div>
                </div>
              ))}
              <div style={{padding:'6px 8px',background:'rgba(139,92,246,.07)',border:'1px solid rgba(139,92,246,.2)',marginTop:4}}>
                <div style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:'var(--ml)',marginBottom:2}}>ML Verdict</div>
                <div style={{font:'600 9px/1.4 system-ui',color:'var(--t2)'}}>Proceed at full size. Strongest edge: <strong style={{color:'var(--g)'}}>Judas+LBMA</strong></div>
              </div>
            </div>
          </div>
          <div className="p" style={{borderTop:'2px solid var(--g)'}}>
            <div className="pt" style={{color:'var(--g)'}}>EOD Research</div>
            <div style={{display:'flex',flexDirection:'column',gap:5}}>
              {[['bu','EOD Target','London continuation to 3328–3320. TP2 likely before NY close.'],['g','LBMA Fix 10:30','Amplifies London direction. SHORT bias → hold.'],['ml','CPI 14:00','±$15 spike. Reduce size 13:45.'],['bu','Weekly Outlook','H4 uptrend intact. Key support 3290/3300. ML: BULLISH']].map(([col,ttl,txt])=>(
                <div key={ttl} style={{padding:'6px 8px',background:'var(--s2)',border:'1px solid var(--b)',borderLeft:`3px solid var(--${col})`}}>
                  <div style={{font:'700 7px/1 system-ui',letterSpacing:'.1em',textTransform:'uppercase',color:`var(--${col})`,marginBottom:2}}>{ttl}</div>
                  <div style={{font:'600 9px/1.4 system-ui',color:'var(--t2)'}}>{txt}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="p" style={{borderTop:'2px solid var(--bu)'}}>
            <div className="pt" style={{color:'var(--bu)'}}>News Adaptation</div>
            {[['bu','08:30','NFP 177K vs 180K','USD miss, gold reactive bullish confirmed.','BULL'],['wa','10:30','LBMA AM Fix','Elevated vol, amplifies direction ±0.4%.','WATCH'],['be','14:00','US CPI YoY','HIGH impact. Avoid entries 13:45–14:15.','RISK'],['bu','15:00','NY Silver Bullet','Opens. 86.7% WN historically.','SETUP']].map(([col,t,h,txt,tag])=>(
              <div key={t} className="ns">
                <div className="nsb" style={{background:`var(--${col})`}}/>
                <div className="nst m">{t}</div>
                <div className="nsx"><strong>{h}</strong> — {txt}</div>
                <div className={`nss ${col}`}>{tag}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ─── JOURNAL ────────────────────────────────────────────────── */}
        <div className="sec"><div className="scn">Trade Journal</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:8}}>
            {['all','scalp','day','noise'].map(f=>(
              <button key={f} className={`jftab${jFilter===f?' a':''}`} onClick={()=>setJFilter(f)}>
                {f.charAt(0).toUpperCase()+f.slice(1)}
              </button>
            ))}
            <span style={{marginLeft:8,font:'600 8px/1 system-ui',color:'var(--t3)'}}>{filteredJournal.length} trades</span>
            <span style={{marginLeft:'auto',padding:'3px 8px',font:'700 7px/1 system-ui',letterSpacing:'.06em',color:'var(--bu)',border:'1px solid rgba(34,197,94,.3)',background:'rgba(34,197,94,.07)'}}>81.8% WN Active</span>
          </div>
          <div style={{overflowX:'auto'}}>
            <table className="jtbl">
              <thead><tr><th>Time</th><th>Template</th><th>Dir</th><th>Tier</th><th>Entry</th><th>SL</th><th>TP1</th><th>RR</th><th>P&L</th><th>Type</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {filteredJournal.map(row=>(
                  <tr key={row.id} style={row.type==='noise'?{opacity:.45}:{}}>
                    <td className="m">{row.time || <span style={{color:'var(--t3)'}}>{row.date}</span>}</td>
                    <td style={{color:'var(--g)',fontWeight:700}}>{row.tpl}</td>
                    <td style={{color:row.dir==='SHORT'?'var(--be)':'var(--bu)',fontWeight:700}}>{row.dir}</td>
                    <td><span style={{font:'700 7px/1 system-ui',color:row.tier==='A'?'var(--g)':'var(--t3)',padding:'2px 4px',border:`1px solid ${row.tier==='A'?'rgba(212,160,23,.4)':'var(--b2)'}`}}>{row.tier}</span></td>
                    <td className="m">{row.entry}</td>
                    <td className="m" style={{color:'var(--be)'}}>{row.sl}</td>
                    <td className="m" style={{color:'var(--bu)'}}>{row.tp1}</td>
                    <td className="m" style={{color:'var(--ml)'}}>{row.rr}</td>
                    <td className="m" style={{color:row.pnl.startsWith('+')?'var(--wa)':'var(--be)'}}>{row.pnl}</td>
                    <td><span className={`ttag ${row.type==='scalp'?'sc':row.type==='day'?'dy':'no'}`}>{row.type.charAt(0).toUpperCase()+row.type.slice(1)}</span></td>
                    <td style={{color:row.status==='WIN'?'var(--bu)':row.status==='LOSS'?'var(--be)':'var(--wa)'}}>{row.status}</td>
                    <td><button className="delbtn" onClick={()=>deleteJournalRow(row.id)}>✕ Noise</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div></div>

        {/* ─── PERFORMANCE + GOALS ────────────────────────────────────── */}
        <div className="sec"><div className="scn">Performance Statistics · Goals</div><div className="scl"/></div>
        <div style={{padding:'0 14px 8px'}}><div className="p">
          <div className="perf-kpis">
            <div className="kpi-tile" style={{borderTopColor:'var(--bu)'}}><div className="kpi-lbl">Win Rate</div><div className="kpi-val" style={{color:'var(--bu)'}}>81.8%</div><div className="kpi-sub">44 of 54 trades</div></div>
            <div className="kpi-tile" style={{borderTopColor:'var(--g)'}}><div className="kpi-lbl">Avg RR</div><div className="kpi-val" style={{color:'var(--g)'}}>2.1R</div><div className="kpi-sub">Streak: 7 days</div></div>
            <div className="kpi-tile" style={{borderTopColor:'var(--ml)'}}><div className="kpi-lbl">Profit Factor</div><div className="kpi-val" style={{color:'var(--ml)'}}>3.8</div><div className="kpi-sub">30-day period</div></div>
            <div className="kpi-tile" style={{borderTopColor:'var(--wa)'}}><div className="kpi-lbl">Max Drawdown</div><div className="kpi-val" style={{color:'var(--wa)'}}>4.2%</div><div className="kpi-sub">$420 peak DD</div></div>
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
                <span className="m" style={{color:'var(--bu)'}}>+$1,029</span> / <span className="m">{dayGoalDisp}</span>
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
                <span className="m" style={{color:'var(--g)'}}>+$4,059</span> / <span className="m">{wkGoalDisp}</span>
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
                        const on=gIsOn(tmpl.id, inst);
                        const forced=gIsForced(tmpl.id, inst);
                        return (
                          <button key={inst}
                            className={`gtog ${on?'on':'off'}${forced?' force':''}`}
                            onClick={()=>gToggle(tmpl.id, inst)}
                            title={`${tmpl.id}/${inst}`}>
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
          QB GOLD BEAST v19 · All data simulated for preview
        </div>
      </div>

      {toast && <div className={`gate-toast ${toast.err?'err':'ok'}`}>{toast.msg}</div>}
    </>
  );
}
