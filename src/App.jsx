import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const INSTRUMENTS = [
  { id:"GBPUSD",  label:"GBP/USD",  type:"FOREX",     color:"#60a5fa", pip:4 },
  { id:"BTCUSDT", label:"BTC/USDT", type:"CRYPTO",    color:"#fb923c", pip:0 },
  { id:"XAUUSD",  label:"XAU/USD",  type:"COMMODITY", color:"#d4a843", pip:2 },
];

const getMarketStatus=()=>{const now=new Date(),d=now.getUTCDay(),t=now.getUTCHours()+now.getUTCMinutes()/60;const c={open:true,session:"24/7"};let f={open:false,session:"WEEKEND"};if(d>=1&&d<=4)f={open:true,session:t<8?"ASIA":t<16?"LONDON":"NEW YORK"};else if(d===5&&t<22)f={open:true,session:t<16?"LONDON":"NEW YORK"};else if(d===0&&t>=22)f={open:true,session:"SYDNEY"};return{GBPUSD:f,BTCUSDT:c,XAUUSD:f.open?{open:true,session:"COMEX"}:{open:false,session:"WEEKEND"}};};
const isNearClose=()=>{const n=new Date();return n.getUTCDay()===5&&(n.getUTCHours()+n.getUTCMinutes()/60)>=21.5;};
const getSessionInfo=()=>{const now=new Date(),t=now.getUTCHours()+now.getUTCMinutes()/60,d=now.getUTCDay();if(d===6||(d===0&&t<22))return{session:"WEEKEND",isLondon:false,isNY:false,isOverlap:false,tradingAllowed:false,utcTime:t};const sun=d===0&&t>=22,lon=t>=8&&t<16,ny=t>=13&&t<21,ov=t>=13&&t<16;let s="OFF";if(sun)s="SYDNEY";else if(ov)s="OVERLAP";else if(ny)s="NEW YORK";else if(lon)s="LONDON";else s="ASIAN";return{session:s,isLondon:lon,isNY:ny,isOverlap:ov,isSundayReopen:sun,tradingAllowed:lon||ny||sun,utcTime:t};};
const getConsecLosses=(t=[])=>{let s=0;for(let i=t.length-1;i>=0;i--){if(Number(t[i]?.profit||0)<0)s++;else break;}return s;};
const getTodayPnl=(t=[])=>{const n=new Date();return t.reduce((s,x)=>{const d=new Date(x.time||x.closeTime||"");return d.toDateString()===n.toDateString()?s+Number(x.profit||0):s;},0);};
const fmtPrice=(id,p)=>p!=null?(id==="BTCUSDT"?p.toLocaleString("en",{maximumFractionDigits:0}):p.toFixed(id==="GBPUSD"?4:2)):"—";

// BUY/SELL display fix — MetaAPI deal type is inverted from position direction
const displaySide=(type)=>type==='BUY'?'SELL':'BUY';
const sideColor=(type)=>type==='BUY'?'#f23645':'#089981';

/* ─── CSS ──────────────────────────────────────────────────────────────── */
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --nav:#1a2744;
  --nav2:#1e2d52;
  --nav3:#243361;
  --bg:#f0f2f7;
  --card:#ffffff;
  --card2:#f8f9fc;
  --border:#e2e6ef;
  --border2:#d0d6e8;
  --text:#1a2038;
  --text2:#4a5578;
  --text3:#8892aa;
  --G:#0ea56b; --R:#e8334a; --B:#3b6cf0; --Au:#c9882a; --Au2:#e5a830;
  --sans:'Inter',sans-serif;
  --mono:'JetBrains Mono',monospace;
}
html,body,#root{height:100%;overflow:hidden;background:var(--bg);}
body{color:var(--text);font-family:var(--sans);font-size:12px;}
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:#c8cedf;border-radius:4px;}

/* NAV */
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;color:rgba(255,255,255,0.5);font-size:12px;font-weight:500;border-left:3px solid transparent;transition:all 0.15s;white-space:nowrap;border-radius:0 6px 6px 0;margin:1px 8px 1px 0;}
.nav-item:hover{color:rgba(255,255,255,0.85);background:rgba(255,255,255,0.06);}
.nav-item.active{color:#fff;border-left-color:#60a5fa;background:rgba(96,165,250,0.12);}
.nav-icon{width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:14px;opacity:0.8;}

/* CARD */
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;position:relative;}
.card-sm{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}

/* TOP BAR */
.top-kpi{display:flex;align-items:center;gap:6px;padding:0 20px;height:100%;border-right:1px solid rgba(255,255,255,0.08);}

/* BADGE */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:0.04em;}
.badge-buy{background:#e8f5f0;color:#0ea56b;}
.badge-sell{background:#fdecea;color:#e8334a;}
.badge-wait{background:#f0f2f8;color:#8892aa;}
.badge-long{background:#e8f5f0;color:#0ea56b;}
.badge-short{background:#fdecea;color:#e8334a;}

/* TABLE */
.tbl-head{font-size:10px;font-weight:600;color:var(--text3);letter-spacing:0.06em;text-transform:uppercase;padding:8px 0 10px;border-bottom:2px solid var(--border);}
.tbl-row{display:grid;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:12px;}
.tbl-row:hover{background:#f8f9fd;}

/* PROGRESS */
.prog{height:6px;background:#e8ecf5;border-radius:3px;overflow:hidden;}
.prog-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#3b6cf0,#0ea56b);transition:width 0.8s ease;}

/* SECTION TITLE */
.stitle{font-size:11px;font-weight:600;color:var(--text3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px;}

/* NOTIF */
.notif{position:fixed;top:16px;right:16px;z-index:9999;background:white;border:1px solid var(--border2);border-radius:10px;padding:12px 16px;min-width:280px;box-shadow:0 8px 32px rgba(0,0,0,0.12);animation:slideIn 0.2s ease;cursor:pointer;}
@keyframes slideIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}

/* SESSION PILLS */
.sess-pill{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 16px;display:flex;flex-direction:column;gap:4px;}

/* LIVE DOT */
.ldot{width:7px;height:7px;border-radius:50%;display:inline-block;}
.ldot.on{background:#0ea56b;box-shadow:0 0 0 2px rgba(14,165,107,0.2);animation:lpulse 2s ease infinite;}
.ldot.off{background:#cbd2e0;}
@keyframes lpulse{0%,100%{opacity:1}50%{opacity:0.4}}

/* ORB on intelligence page */
.orb-wrap{position:relative;width:160px;height:160px;}
.orb-body{position:absolute;inset:0;border-radius:50%;background:linear-gradient(135deg,#1e3a6e 0%,#0f1e3a 60%,#070e1c 100%);box-shadow:0 0 0 1px rgba(59,130,246,0.2),0 8px 40px rgba(59,130,246,0.15);}
.orb-ring{position:absolute;border-radius:50%;border:1px solid transparent;}
.orb-r1{inset:-12px;border-color:rgba(59,130,246,0.15) transparent rgba(14,165,107,0.1) transparent;animation:spin 9s linear infinite;}
.orb-r2{inset:-22px;border-color:transparent rgba(212,168,67,0.08) transparent rgba(59,130,246,0.06);animation:spin 16s linear infinite reverse;}
@keyframes spin{to{transform:rotate(360deg)}}
.orb-scan{position:absolute;inset:0;border-radius:50%;overflow:hidden;}
.orb-scan::after{content:'';position:absolute;width:100%;height:2px;background:linear-gradient(90deg,transparent,rgba(96,165,250,0.3),transparent);animation:scan 4s linear infinite;}
@keyframes scan{0%{top:-5%}100%{top:105%}}
.orb-inner{position:absolute;inset:0;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}

/* EQUITY SVG */
.eq-tooltip{position:absolute;background:white;border:1px solid var(--border2);padding:5px 9px;border-radius:6px;font-size:10px;pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.1);}

/* Ticker hover */
.ticker-row{padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s;border-left:3px solid transparent;}
.ticker-row:hover{background:#f5f7fc;}
.ticker-row.sel{background:#eff3fd;border-left-color:var(--B);}

/* scroll */
.scroll{overflow-y:auto;scrollbar-width:thin;scrollbar-color:#c8cedf transparent;}
`;

/* ─── EQUITY CHART ──────────────────────────────────────────────────── */
function EquityChart({data,w=700,h=140}){
  const [hover,setHover]=useState(null);
  if(!data||data.length<3)return(
    <div style={{height:h,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--text3)",fontSize:11}}>Accumulating data…</div>
  );
  const vals=data.map(d=>d.val);
  const min=Math.min(...vals),max=Math.max(...vals),rng=max-min||1;
  const pad={t:10,r:10,b:24,l:52};
  const W=w-pad.l-pad.r,H=h-pad.t-pad.b;
  const px=(i)=>pad.l+(i/(data.length-1))*W;
  const py=(v)=>pad.t+(1-(v-min)/rng)*H;
  const pts=data.map((d,i)=>({x:px(i),y:py(d.val),val:d.val,date:d.date}));
  const line=pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area=line+` L${pts[pts.length-1].x},${py(min)} L${pts[0].x},${py(min)} Z`;
  const isUp=vals[vals.length-1]>=vals[0];
  const c=isUp?"#0ea56b":"#e8334a";
  const yL=[0,0.5,1].map(f=>({y:pad.t+H*(1-f),v:`$${(min+rng*f).toFixed(0)}`}));
  const last=pts[pts.length-1];
  return(
    <div style={{position:"relative"}} onMouseLeave={()=>setHover(null)}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet"
        onMouseMove={e=>{const rect=e.currentTarget.getBoundingClientRect();const rx=(e.clientX-rect.left)/rect.width*w;setHover(pts.reduce((a,b)=>Math.abs(b.x-rx)<Math.abs(a.x-rx)?b:a));}}>
        <defs>
          <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity="0.15"/>
            <stop offset="100%" stopColor={c} stopOpacity="0.01"/>
          </linearGradient>
        </defs>
        {yL.map((yl,i)=>(
          <g key={i}>
            <line x1={pad.l} y1={yl.y} x2={pad.l+W} y2={yl.y} stroke="#e2e6ef" strokeDasharray="3 4"/>
            <text x={pad.l-6} y={yl.y+3.5} textAnchor="end" fontSize="9" fill="#8892aa" fontFamily="JetBrains Mono">{yl.v}</text>
          </g>
        ))}
        <path d={area} fill="url(#eg)"/>
        <path d={line} fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx={last.x} cy={last.y} r="4" fill={c}/>
        <circle cx={last.x} cy={last.y} r="7" fill={c} opacity="0.15"/>
        {hover&&<>
          <line x1={hover.x} y1={pad.t} x2={hover.x} y2={pad.t+H} stroke="#3b6cf0" strokeOpacity="0.3" strokeDasharray="3 3"/>
          <circle cx={hover.x} cy={hover.y} r="4" fill={c} stroke="white" strokeWidth="2"/>
        </>}
      </svg>
      {hover&&<div className="eq-tooltip" style={{top:8,left:`${Math.min(hover.x/w*100,72)}%`}}>
        <span style={{color:"#3b6cf0",fontWeight:600}}>${hover.val.toFixed(2)}</span>
        {hover.date&&<span style={{color:"var(--text3)",marginLeft:6,fontSize:9}}>{new Date(hover.date).toLocaleDateString()}</span>}
      </div>}
    </div>
  );
}

/* ─── DRAWDOWN CHART ────────────────────────────────────────────────── */
function DrawdownChart({data,w=700,h=60}){
  if(!data||data.length<3)return null;
  const vals=data.map(d=>d.val);
  let peak=vals[0],dds=vals.map(v=>{if(v>peak)peak=v;return peak>0?((peak-v)/peak)*100:0;});
  const maxDD=Math.max(...dds)||1;
  const pad={t:4,r:10,b:18,l:52};
  const W=w-pad.l-pad.r,H=h-pad.t-pad.b;
  const pts=dds.map((d,i)=>({x:pad.l+(i/(dds.length-1))*W,y:pad.t+(d/maxDD)*H}));
  const line=pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area=`M${pts[0].x},${pad.t} `+pts.map(p=>`L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")+` L${pts[pts.length-1].x},${pad.t} Z`;
  return(
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#e8334a" stopOpacity="0.2"/><stop offset="100%" stopColor="#e8334a" stopOpacity="0.01"/></linearGradient></defs>
      <line x1={pad.l} y1={pad.t+H} x2={pad.l+W} y2={pad.t+H} stroke="#e2e6ef"/>
      <text x={pad.l-6} y={pad.t+H+3} textAnchor="end" fontSize="9" fill="#8892aa" fontFamily="JetBrains Mono">{maxDD.toFixed(1)}%</text>
      <path d={area} fill="url(#dg)"/>
      <path d={line} fill="none" stroke="#e8334a" strokeWidth="1.5" opacity="0.7" strokeLinecap="round"/>
    </svg>
  );
}

/* ─── SESSION RING ──────────────────────────────────────────────────── */
function SessionRing({label,wr,trades,pnl,color,active}){
  const r=28,circ=2*Math.PI*r,arc=(wr/100)*circ;
  return(
    <div className="sess-pill" style={{borderTop:`3px solid ${active?color:"var(--border)"}`,position:"relative"}}>
      {active&&<span style={{position:"absolute",top:10,right:10,fontSize:9,fontWeight:600,color,background:`${color}15`,padding:"1px 7px",borderRadius:10}}>{active?"LIVE":""}</span>}
      <div style={{display:"flex",gap:12,alignItems:"center"}}>
        <div style={{position:"relative",width:64,height:64,flexShrink:0}}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r={r} fill="none" stroke="#e8ecf5" strokeWidth="4"/>
            <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="4"
              strokeDasharray={`${arc.toFixed(2)} ${(circ-arc).toFixed(2)}`}
              strokeLinecap="round" transform="rotate(-90 32 32)"
              style={{transition:"stroke-dasharray 1.2s ease"}}/>
          </svg>
          <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontSize:13,fontWeight:700,color,lineHeight:1}}>{wr}%</span>
          </div>
        </div>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:"var(--text3)",letterSpacing:"0.06em",marginBottom:4}}>{label.replace(/_/g," ")}</div>
          <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>{trades} trades</div>
          <div style={{fontSize:12,fontWeight:600,color:pnl>=0?"var(--G)":"var(--R)",marginTop:1}}>{pnl>=0?"+":""}${pnl.toFixed(0)}</div>
        </div>
      </div>
    </div>
  );
}

/* ─── TP CHAIN ──────────────────────────────────────────────────────── */
function TPChain({tp1,tp2,tp3,be}){
  const rows=[["TP1 Hit Rate",tp1,"#e5a830"],["TP2 after TP1",tp2,"#3b6cf0"],["TP3 after TP2",tp3,"#0ea56b"]];
  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {rows.map(([l,v,c])=>(
        <div key={l} style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:120,fontSize:11,color:"var(--text2)",flexShrink:0}}>{l}</div>
          <div style={{flex:1,height:8,background:"#e8ecf5",borderRadius:4,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${v}%`,background:c,borderRadius:4,transition:"width 1s ease"}}/>
          </div>
          <div style={{width:36,fontSize:13,fontWeight:700,color:c,textAlign:"right"}}>{v}%</div>
        </div>
      ))}
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <div style={{width:120,fontSize:11,color:"var(--text2)",flexShrink:0}}>Breakeven Saves</div>
        <div style={{flex:1,height:8,background:"#e8ecf5",borderRadius:4,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${be}%`,background:"#8892aa",borderRadius:4}}/>
        </div>
        <div style={{width:36,fontSize:13,fontWeight:700,color:"#8892aa",textAlign:"right"}}>{be}%</div>
      </div>
    </div>
  );
}

/* ─── AI ORB ────────────────────────────────────────────────────────── */
function AIOrb({decision,confidence,status,reason}){
  const color=status==='thinking'?"#e5a830":decision==='LONG'?"#0ea56b":decision==='SHORT'?"#e8334a":"#8892aa";
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
      <div className="orb-wrap">
        <div className="orb-body"/>
        <div className="orb-ring orb-r1"/>
        <div className="orb-ring orb-r2"/>
        <div className="orb-scan"/>
        <div className="orb-inner">
          <div style={{fontSize:22,fontWeight:700,color,lineHeight:1}}>{status==='thinking'?"···":decision||"WAIT"}</div>
          <div style={{fontSize:8,color:"rgba(255,255,255,0.35)",letterSpacing:"0.18em",marginTop:3}}>XAU / USD</div>
          {confidence!=null&&<div style={{fontSize:14,fontWeight:700,color,marginTop:4}}>{confidence}%</div>}
          <div style={{fontSize:7,color:"rgba(255,255,255,0.25)",letterSpacing:"0.18em",marginTop:2}}>AI BRAIN V5</div>
        </div>
      </div>
      {reason&&<p style={{maxWidth:220,textAlign:"center",fontSize:10,color:"var(--text3)",lineHeight:1.6,fontStyle:"italic"}}>"{reason}"</p>}
    </div>
  );
}

/* ─── MAIN ──────────────────────────────────────────────────────────── */
export default function TradingBotLive(){
  const [prices,setPrices]=useState({GBPUSD:null,BTCUSDT:null,XAUUSD:null});
  const [prevPrices,setPrevPrices]=useState({GBPUSD:null,BTCUSDT:null,XAUUSD:null});
  const [brokerCandles,setBrokerCandles]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [m5C,setM5C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [m15C,setM15C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [h1C,setH1C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [h4C,setH4C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [d1C,setD1C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [wkC,setWkC]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [openPositions,setOpenPositions]=useState([]);
  const [closedTrades,setClosedTrades]=useState([]);
  const [news,setNews]=useState([]);
  const [calEvents,setCalEvents]=useState([]);
  const [eventAlert,setEventAlert]=useState(null);
  const [accountBalance,setAccountBalance]=useState(null);
  const [marketStatus,setMarketStatus]=useState(getMarketStatus());
  const [sessionInfo,setSessionInfo]=useState(getSessionInfo());
  const [log,setLog]=useState([]);
  const [learnedStats,setLearnedStats]=useState({});
  const [tradeReports,setTradeReports]=useState({reports:[],analytics:{}});
  const [notifs,setNotifs]=useState([]);
  const [selected,setSelected]=useState("XAUUSD");
  const [page,setPage]=useState("overview");
  const [equityCurve,setEquityCurve]=useState([]);
  const [aiDecisions,setAiDecisions]=useState({});
  const [prevDecisions,setPrevDecisions]=useState({});
  const [aiStatus,setAiStatus]=useState({});
  const lastTradeRef=useRef({});
  const pendingRef=useRef({});
  const logRef=useRef(null);
  const prevPosRef=useRef([]);
  const lastAIRef=useRef({});

  useEffect(()=>{if(!notifs.length)return;const t=setTimeout(()=>setNotifs(p=>p.slice(1)),7000);return()=>clearTimeout(t);},[notifs]);

  useEffect(()=>{
    if(!closedTrades.length)return;
    let eq=accountBalance||10000;
    setEquityCurve([...closedTrades].reverse().map(t=>{eq+=(t.profit||0);return{val:parseFloat(eq.toFixed(2)),date:t.time||t.closeTime};}));
  },[closedTrades,accountBalance]);

  const maxDD=useMemo(()=>{let peak=0,dd=0;equityCurve.forEach(p=>{if(p.val>peak)peak=p.val;const d=peak>0?((peak-p.val)/peak)*100:0;if(d>dd)dd=d;});return dd.toFixed(1);},[equityCurve]);

  const addLog=useCallback((msg,type="info")=>{const now=new Date(),time=`${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;setLog(p=>[...p.slice(-80),{time,msg,type}]);},[]);
  const fetchPos=useCallback(async()=>{try{const r=await fetch("/api/positions");if(r.ok){const d=await r.json();setOpenPositions(d.positions||[]);}}catch(e){}},[]);
  const fetchHist=useCallback(async()=>{try{const r=await fetch("/api/history");if(r.ok){const d=await r.json();setClosedTrades(d.deals||[]);}}catch(e){}},[]);
  const fetchLearn=useCallback(async()=>{try{const r=await fetch("/api/trades?learn=true");if(r.ok){const d=await r.json();setLearnedStats(d.stats||{});}}catch(e){}},[]);
  const fetchReports=useCallback(async()=>{try{const r=await fetch("/api/manage-trades");if(r.ok){const d=await r.json();setTradeReports(d);}}catch(e){}},[]);

  useEffect(()=>{const f=async()=>{try{const r=await fetch("/api/account");if(!r.ok)return;const d=await r.json();const b=Number(d.balance??d.equity??d.accountBalance);if(Number.isFinite(b)&&b>0)setAccountBalance(b);}catch(e){}};f();const i=setInterval(f,30000);return()=>clearInterval(i);},[]);

  useEffect(()=>{
    const sm={BTCUSDT:"BTCUSD",XAUUSD:"XAUUSD.s",GBPUSD:"GBPUSD"};
    const fc=async(id)=>{const sym=sm[id];try{const r=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=M1&limit=200`);const d=await r.json();if(d.candles?.length>=50){setBrokerCandles(p=>({...p,[id]:d.candles}));const lc=d.candles[d.candles.length-1].close;if(Number.isFinite(lc))setPrices(p=>{setPrevPrices(pp=>({...pp,[id]:p[id]}));return{...p,[id]:lc};});}try{const r2=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=M5&limit=50`);const d2=await r2.json();if(d2.candles?.length>=10)setM5C(p=>({...p,[id]:d2.candles}));}catch(e){}try{const r3=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=M15&limit=100`);const d3=await r3.json();if(d3.candles?.length>=20)setM15C(p=>({...p,[id]:d3.candles}));}catch(e){}try{const r4=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=H1&limit=48`);const d4=await r4.json();if(d4.candles?.length>=20)setH1C(p=>({...p,[id]:d4.candles}));}catch(e){}try{const r5=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=H4&limit=100`);const d5=await r5.json();if(d5.candles?.length>=20)setH4C(p=>({...p,[id]:d5.candles}));}catch(e){}try{const r6=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=D1&limit=30`);const d6=await r6.json();if(d6.candles?.length>=10)setD1C(p=>({...p,[id]:d6.candles}));}catch(e){}try{const r7=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=W1&limit=12`);const d7=await r7.json();if(d7.candles?.length>=4)setWkC(p=>({...p,[id]:d7.candles}));}catch(e){}}catch(e){setPrices(p=>({...p,[id]:null}));}};
    const fp=async(id)=>{try{const r=await fetch(`/api/broker-price?symbol=${sm[id]}`);const d=await r.json();if(Number.isFinite(d.price))setPrices(p=>{setPrevPrices(pp=>({...pp,[id]:p[id]}));return{...p,[id]:d.price};});}catch(e){}};
    INSTRUMENTS.forEach(i=>fc(i.id));const pi=INSTRUMENTS.map(i=>setInterval(()=>fp(i.id),5000));const ci=INSTRUMENTS.map(i=>setInterval(()=>fc(i.id),60000));
    addLog("Quantum V5 — online","success");
    return()=>{pi.forEach(clearInterval);ci.forEach(clearInterval);};
  },[addLog]);

  useEffect(()=>{const i=setInterval(()=>{setMarketStatus(getMarketStatus());setSessionInfo(getSessionInfo());},60000);return()=>clearInterval(i);},[]);
  useEffect(()=>{const f=async()=>{try{const r=await fetch("/api/news");const d=await r.json();if(d.articles)setNews(d.articles);}catch(e){}};f();const i=setInterval(f,300000);return()=>clearInterval(i);},[]);
  useEffect(()=>{const f=async()=>{try{const r=await fetch("/api/calendar");const d=await r.json();if(d.source==="unavailable"||!Array.isArray(d.events)){setEventAlert({name:"Calendar unavailable",date:null});return;}setCalEvents(d.events);const now=Date.now();setEventAlert(d.events.find(ev=>{const t=new Date(ev.date).getTime();return t>now&&t<now+30*60*1000;})||null);}catch(e){setEventAlert({name:"Calendar error",date:null});}};f();const i=setInterval(f,300000);return()=>clearInterval(i);},[]);
  useEffect(()=>{fetchPos();fetchHist();const i=setInterval(()=>{fetchPos();fetchHist();},30000);return()=>clearInterval(i);},[fetchPos,fetchHist]);
  useEffect(()=>{fetchLearn();const i=setInterval(fetchLearn,300000);return()=>clearInterval(i);},[fetchLearn]);
  useEffect(()=>{fetchReports();const i=setInterval(fetchReports,30000);return()=>clearInterval(i);},[fetchReports]);

  const recordResult=useCallback(async(position,dec,session)=>{if(!position||!dec)return;const pips=position.profit||0,won=pips>0;const payload={instrument:position.symbol?.replace('.s','').replace('.S','')||'UNKNOWN',direction:position.type==='POSITION_TYPE_BUY'?'LONG':'SHORT',won,pips,rr:parseFloat((Math.abs(pips)/Math.max(1,Math.abs(pips))).toFixed(2)),session,grade:dec.confidence>=80?'A':dec.confidence>=65?'B':'C',confluenceScore:dec.confidence,regime:'AI_DECISION'};try{await fetch('/api/trades?learn=true',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});addLog(`${payload.instrument} ${won?'WIN':'LOSS'} ${pips>=0?'+':''}${pips.toFixed(2)}`,won?'success':'warn');setPrevDecisions(p=>{const ex=[...(p[payload.instrument]||[])];const last=ex[ex.length-1];if(last&&!last.outcome)ex[ex.length-1]={...last,outcome:won?'WIN':'LOSS',pnl:pips};return{...p,[payload.instrument]:ex};});fetchLearn();}catch(e){}},[addLog,fetchLearn]);

  useEffect(()=>{const prev=prevPosRef.current,cur=openPositions;prev.filter(p=>!cur.find(c=>(c.id||c.positionId)===(p.id||p.positionId))).forEach(cp=>{const raw=(cp.symbol||'').toUpperCase();const id=raw.startsWith('BTCUSD')?'BTCUSDT':raw.startsWith('XAUUSD')?'XAUUSD':raw.startsWith('GBPUSD')?'GBPUSD':null;if(id&&aiDecisions[id])recordResult(cp,aiDecisions[id],getSessionInfo().session);});prevPosRef.current=cur;},[openPositions,aiDecisions,recordResult]);

  const manageTrades=useCallback(async()=>{if(!openPositions.length)return;const managed=openPositions.map(pos=>{const raw=(pos.symbol||'').toUpperCase();const id=raw.startsWith('BTCUSD')?'BTCUSDT':raw.startsWith('XAUUSD')?'XAUUSD':raw.startsWith('GBPUSD')?'GBPUSD':null;const dec=id?aiDecisions[id]:null;return{id:pos.id||pos.positionId,symbol:pos.symbol,openPrice:pos.openPrice,currentPrice:pos.currentPrice,stopLoss:pos.stopLoss,volume:pos.volume,direction:pos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT',tp1:dec?.takeProfit1??null,tp2:dec?.takeProfit2??null,tp3:dec?.takeProfit3??null,breakeven:pos.openPrice,atr:null};}).filter(p=>p.id&&p.tp1);if(!managed.length)return;try{const r=await fetch('/api/manage-trades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({positions:managed})});const d=await r.json();if(d.managed?.length>0){d.managed.forEach(m=>m.actions.forEach(a=>{if(a.type==='PARTIAL_CLOSE_TP1')addLog(`TP1 ${m.symbol} +$${a.pnl?.toFixed(2)}`,'success');if(a.type==='PARTIAL_CLOSE_TP2')addLog(`TP2 ${m.symbol} +$${a.pnl?.toFixed(2)}`,'success');if(a.type==='FULL_CLOSE_TP3')addLog(`TP3 COMPLETE ${m.symbol} +$${a.pnl?.toFixed(2)}`,'success');if(a.type==='SL_TO_BREAKEVEN')addLog(`BE lock ${m.symbol}`,'info');if(['PARTIAL_CLOSE_TP1','PARTIAL_CLOSE_TP2','FULL_CLOSE_TP3'].includes(a.type)){setNotifs(p=>[...p.slice(-3),{id:Date.now(),symbol:m.symbol,type:a.type,price:a.price,pnl:a.pnl,time:new Date().toLocaleTimeString()}]);fetchReports();}}));setTimeout(fetchPos,1500);setTimeout(fetchHist,3000);}}catch(e){}},[openPositions,aiDecisions,addLog,fetchPos,fetchHist,fetchReports]);
  useEffect(()=>{if(!openPositions.length)return;const i=setInterval(manageTrades,30000);manageTrades();return()=>clearInterval(i);},[openPositions,manageTrades]);

  const runAIBrain=useCallback(async(inst)=>{
    const candles=brokerCandles[inst.id];if(!candles||candles.length<50||!prices[inst.id]||!accountBalance)return;
    const now=Date.now(),last=lastAIRef.current[inst.id]||0;if(now-last<600000)return;
    lastAIRef.current[inst.id]=now;setAiStatus(p=>({...p,[inst.id]:'thinking'}));
    const session=getSessionInfo();
    const sumC=(c,label,lb=5)=>{if(!c||!c.length)return`${label}:no data`;const sl=c.slice(-lb),dir=sl[sl.length-1].close>sl[0].close?'↑':'↓';const chg=((sl[sl.length-1].close-sl[0].close)/sl[0].close*100).toFixed(3);const hi=Math.max(...sl.map(x=>x.high)).toFixed(inst.id==='BTCUSDT'?0:2);const lo=Math.min(...sl.map(x=>x.low)).toFixed(inst.id==='BTCUSDT'?0:2);const open=sl[0].close.toFixed(inst.id==='BTCUSDT'?0:2),close=sl[sl.length-1].close.toFixed(inst.id==='BTCUSDT'?0:2);return`${label}(${lb}): ${dir}${chg}% start:${open} now:${close} H:${hi} L:${lo}`;};
    const cls=candles.map(c=>c.close);
    const highs=candles.map(c=>c.high);
    const lows=candles.map(c=>c.low);

    // ── RSI(14) ──
    const rsi14=(()=>{if(cls.length<15)return 50;const ch=cls.slice(1).map((p,i)=>p-cls[i]);let g=0,l=0;for(let i=0;i<14;i++){if(ch[i]>0)g+=ch[i];else l-=ch[i];}g/=14;l/=14;for(let i=14;i<ch.length;i++){g=(g*13+Math.max(ch[i],0))/14;l=(l*13+Math.max(-ch[i],0))/14;}return l===0?100:100-(100/(1+g/l));})();

    // ── EMAs ──
    const calcEma=(src,period)=>{if(src.length<period)return null;const k=2/(period+1);let e=src.slice(0,period).reduce((a,b)=>a+b,0)/period;for(let i=period;i<src.length;i++)e=src[i]*k+e*(1-k);return e;};
    const ema21=calcEma(cls,21);
    const ema50=calcEma(cls,50);
    const ema200=calcEma(cls,Math.min(200,cls.length));

    // ── ATR(14) — critical for Gold SL sizing ──
    const atr14=(()=>{if(candles.length<15)return null;const trs=candles.slice(1).map((c,i)=>{const prev=candles[i];return Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close));});let atr=trs.slice(0,14).reduce((a,b)=>a+b,0)/14;for(let i=14;i<trs.length;i++)atr=(atr*13+trs[i])/14;return atr;})();

    // ── MACD(12,26,9) ──
    const macd=(()=>{const fast=calcEma(cls,12),slow=calcEma(cls,26);if(!fast||!slow)return null;const line=fast-slow;const signals=[];const macdSeries=[];for(let i=25;i<cls.length;i++){const f=calcEma(cls.slice(0,i+1),12),s=calcEma(cls.slice(0,i+1),26);if(f&&s)macdSeries.push(f-s);}const signal=calcEma(macdSeries,9);const histogram=signal?macdSeries[macdSeries.length-1]-signal:null;return{line:line.toFixed(3),signal:signal?.toFixed(3)||null,histogram:histogram?.toFixed(3)||null,bullish:histogram!=null&&histogram>0};})();

    // ── Bollinger Bands(20,2) ──
    const bbands=(()=>{if(cls.length<20)return null;const slice=cls.slice(-20);const mean=slice.reduce((a,b)=>a+b,0)/20;const std=Math.sqrt(slice.reduce((s,v)=>s+Math.pow(v-mean,2),0)/20);const upper=mean+2*std,lower=mean-2*std;const pct=((prices[inst.id]-lower)/(upper-lower)*100);return{upper:upper.toFixed(2),mid:mean.toFixed(2),lower:lower.toFixed(2),width:((upper-lower)/mean*100).toFixed(2),pct:pct.toFixed(1),squeeze:(upper-lower)/mean<0.005};})();

    // ── Fibonacci levels from H4 swing ──
    const fib=(()=>{const h4=h4C[inst.id]||[];if(h4.length<10)return null;const recent=h4.slice(-20);const swingH=Math.max(...recent.map(c=>c.high));const swingL=Math.min(...recent.map(c=>c.low));const rng=swingH-swingL;const p=prices[inst.id];const levels={fib236:(swingH-rng*0.236).toFixed(2),fib382:(swingH-rng*0.382).toFixed(2),fib500:(swingH-rng*0.500).toFixed(2),fib618:(swingH-rng*0.618).toFixed(2),fib786:(swingH-rng*0.786).toFixed(2),swingH:swingH.toFixed(2),swingL:swingL.toFixed(2)};const nearestFib=Object.entries(levels).reduce((a,[k,v])=>Math.abs(parseFloat(v)-p)<Math.abs(parseFloat(a[1])-p)?[k,v]:a,['none','0']);return{...levels,nearest:nearestFib[0],nearestDist:Math.abs(parseFloat(nearestFib[1])-p).toFixed(2)};})();

    // ── SMC: Break of Structure + Order Blocks ──
    const smc=(()=>{const h1=h1C[inst.id]||[];if(h1.length<10)return null;const recent=h1.slice(-20);// BOS: higher high or lower low
    let bos='NONE',choch='NONE';
    const prevH=Math.max(...recent.slice(0,-3).map(c=>c.high));
    const prevL=Math.min(...recent.slice(0,-3).map(c=>c.low));
    const lastH=Math.max(...recent.slice(-3).map(c=>c.high));
    const lastL=Math.min(...recent.slice(-3).map(c=>c.low));
    if(lastH>prevH)bos='BULLISH_BOS';
    else if(lastL<prevL)bos='BEARISH_BOS';
    // Order block: last bearish candle before bullish move or vice versa
    let obLevel=null,obType=null;
    for(let i=recent.length-4;i>=1;i--){const c=recent[i],next=recent[i+1];if(c.close<c.open&&next.close>next.open&&next.close>c.high){obLevel=((c.high+c.low)/2).toFixed(2);obType='BULLISH_OB';break;}if(c.close>c.open&&next.close<next.open&&next.close<c.low){obLevel=((c.high+c.low)/2).toFixed(2);obType='BEARISH_OB';break;}}
    // FVG: gap between candle i-1 high and candle i+1 low
    let fvg=null;
    for(let i=recent.length-3;i>=1;i--){const gap=recent[i+1].low-recent[i-1].high;if(gap>0.5){fvg={type:'BULLISH_FVG',top:recent[i+1].low.toFixed(2),bottom:recent[i-1].high.toFixed(2)};break;}const gap2=recent[i-1].low-recent[i+1].high;if(gap2>0.5){fvg={type:'BEARISH_FVG',top:recent[i-1].low.toFixed(2),bottom:recent[i+1].high.toFixed(2)};break;}}
    return{bos,orderBlock:obLevel?{level:obLevel,type:obType}:null,fvg};})();

    // ── Equilibrium zone from H4 ──
    const h4=h4C[inst.id]||[];
    const eq=(()=>{if(h4.length<10)return null;const r=h4.slice(-20),hi=Math.max(...r.map(c=>c.high)),lo=Math.min(...r.map(c=>c.low)),pos=((prices[inst.id]-lo)/(hi-lo))*100;return{position:Math.round(pos),zone:pos>62.5?'PREMIUM':pos<37.5?'DISCOUNT':'EQUILIBRIUM'};})();

    // ── Weekly bias ──
    const weeklyBias=(()=>{const wk=wkC[inst.id]||[];if(wk.length<3)return'UNKNOWN';const last=wk[wk.length-1],prev=wk[wk.length-2];return last.close>prev.close?'BULLISH':'BEARISH';})();

    // ── Support / Resistance from M15 round numbers ──
    const roundLevels=(()=>{const p=prices[inst.id];if(!p)return[];const base=Math.round(p/10)*10;return[-30,-20,-10,0,10,20,30].map(o=>(base+o).toFixed(0));})();

    const todayPnl=getTodayPnl(closedTrades),lossStreak=getConsecLosses(closedTrades);
    const todayT=closedTrades.filter(t=>{const d=new Date(t.time||t.closeTime||'');return d.toDateString()===new Date().toDateString();});
    const wr=closedTrades.length>0?((closedTrades.filter(t=>t.profit>0).length/closedTrades.length)*100).toFixed(1):0;
    const ws=(()=>{let s=0;for(let i=closedTrades.length-1;i>=0;i--){if(Number(closedTrades[i]?.profit||0)>0)s++;else break;}return s;})();
    const tl=todayT.filter(t=>t.type==='BUY'),ts=todayT.filter(t=>t.type==='SELL');

    const snap={
      symbol:inst.id, price:prices[inst.id],
      // ── 7 Timeframes ──
      candles_weekly: sumC(wkC[inst.id],'W1',8),
      candles_d1:     sumC(d1C[inst.id],'D1',10),
      candles_h4:     sumC(h4C[inst.id],'H4',20),
      candles_h1:     sumC(h1C[inst.id],'H1',24),
      candles_m15:    sumC(m15C[inst.id],'M15',10),
      candles_m5:     sumC(m5C[inst.id],'M5',10),
      candles_m1:     sumC(candles,'M1',10),
      // ── Indicators ──
      rsi14:          rsi14?.toFixed(1),
      ema21:          ema21?.toFixed(2),
      ema50:          ema50?.toFixed(2),
      ema200:         ema200?.toFixed(2),
      price_vs_ema21: ema21?(prices[inst.id]>ema21?'ABOVE':'BELOW'):'UNKNOWN',
      price_vs_ema50: ema50?(prices[inst.id]>ema50?'ABOVE':'BELOW'):'UNKNOWN',
      ema_alignment:  (ema21&&ema50&&ema200)?(ema21>ema50&&ema50>ema200?'BULLISH_STACK':ema21<ema50&&ema50<ema200?'BEARISH_STACK':'MIXED'):'UNKNOWN',
      atr14:          atr14?.toFixed(2),
      atr_sl_guide:   atr14?`SL = 1.5×ATR = ${(atr14*1.5).toFixed(2)} pips | TP1 = 2×ATR = ${(atr14*2).toFixed(2)} | TP3 = 4×ATR = ${(atr14*4).toFixed(2)}`:null,
      macd:           macd?`line:${macd.line} signal:${macd.signal} hist:${macd.histogram} (${macd.bullish?'BULLISH':'BEARISH'})`:null,
      bbands:         bbands?`U:${bbands.upper} M:${bbands.mid} L:${bbands.lower} W:${bbands.width}% pos:${bbands.pct}%${bbands.squeeze?' SQUEEZE':''}`:null,
      bb_position:    bbands?.pct,
      // ── Fibonacci ──
      fib_levels:     fib?`SwH:${fib.swingH} 23.6%:${fib.fib236} 38.2%:${fib.fib382} 50%:${fib.fib500} 61.8%:${fib.fib618} 78.6%:${fib.fib786} SwL:${fib.swingL}`:null,
      fib_nearest:    fib?`nearest level: ${fib.nearest} (${fib.nearestDist} pips away)`:null,
      // ── SMC ──
      smc_bos:        smc?.bos,
      smc_order_block:smc?.orderBlock?`${smc.orderBlock.type} @ ${smc.orderBlock.level}`:null,
      smc_fvg:        smc?.fvg?`${smc.fvg.type} ${smc.fvg.bottom}–${smc.fvg.top}`:null,
      // ── Structure ──
      equilibrium_zone:     eq?.zone,
      equilibrium_position: eq?.position,
      weekly_bias:    weeklyBias,
      round_levels:   roundLevels.join(', '),
      // ── Session & Context ──
      session:session.session, session_allowed:session.tradingAllowed,
      news:news.slice(0,3), calendar_events:calEvents.slice(0,3),
      open_positions:openPositions.map(p=>({symbol:p.symbol,type:p.type,profit:p.profit})),
      account_balance:accountBalance,
      today_pnl:todayPnl?.toFixed(2), today_trades:todayT.length,
      loss_streak:lossStreak, win_streak:ws, overall_win_rate:wr,
      today_long_results:`${tl.filter(t=>(t.profit||0)>0).length}W/${tl.filter(t=>(t.profit||0)<=0).length}L (${tl.length} longs)`,
      today_short_results:`${ts.filter(t=>(t.profit||0)>0).length}W/${ts.filter(t=>(t.profit||0)<=0).length}L (${ts.length} shorts)`,
    };
    try{const r=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketSnapshot:snap,instrument:inst.id,previousDecisions:prevDecisions[inst.id]||[]})});const dec=await r.json();if(dec.decision){setAiDecisions(p=>({...p,[inst.id]:dec}));setAiStatus(p=>({...p,[inst.id]:dec.decision}));addLog(`${inst.label} → ${dec.decision} ${dec.confidence||0}% — ${dec.reason||''}`,dec.decision==='WAIT'?'info':'signal');if(dec.decision!=='WAIT'&&dec.confidence>=55){const n=Date.now();if(lastTradeRef.current[inst.id]&&(n-lastTradeRef.current[inst.id])<300000)return;if(pendingRef.current[inst.id])return;const evTs=eventAlert?.date?new Date(eventAlert.date).getTime():0;if(evTs>n&&evTs<n+30*60*1000){addLog(`Blocked: ${eventAlert.name}`,"warn");return;}if(isNearClose()&&inst.type!=="CRYPTO"){addLog("Blocked: near close","warn");return;}if(!marketStatus[inst.id]?.open&&inst.type!=="CRYPTO")return;const ao=openPositions.some(p=>{const raw=(p.symbol||"").toUpperCase();const norm=raw==="XAUUSD.S"?"XAUUSD":raw.startsWith("BTCUSD")?"BTCUSD":raw.startsWith("GBPUSD")?"GBPUSD":raw.startsWith("XAUUSD")?"XAUUSD":raw;return norm===(inst.id==="BTCUSDT"?"BTCUSD":inst.id);});if(ao){addLog(`${inst.label}: already open`,"warn");return;}if(openPositions.length>=3){addLog("Max 3 positions","warn");return;}if(!dec.stopLoss||!dec.takeProfit3){addLog(`No SL/TP`,"warn");return;}if(!Number.isFinite(accountBalance)||accountBalance<=0)return;if(getTodayPnl(closedTrades)<=-(accountBalance*0.05)){addLog("Daily limit","error");return;}const vol=dec.volume||0.08;pendingRef.current[inst.id]=true;addLog(`EXECUTE ${inst.label} ${dec.decision} ${vol}L`,"signal");setPrevDecisions(p=>({...p,[inst.id]:[...(p[inst.id]||[]).slice(-4),{decision:dec.decision,price:prices[inst.id],reason:dec.reason,time:new Date().toISOString(),outcome:null,pnl:null}]}));fetch("/api/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({instrument:inst.id,direction:dec.decision,entry:prices[inst.id],stopLoss:dec.stopLoss,takeProfit:dec.takeProfit3,volume:vol})}).then(r=>r.json()).then(d=>{pendingRef.current[inst.id]=false;if(d.success){lastTradeRef.current[inst.id]=Date.now();addLog(`LIVE ${inst.label} ${dec.decision} ${vol}L`,"success");setTimeout(fetchPos,2000);setTimeout(fetchHist,3000);}else{addLog(`FAILED: ${d.error||"unknown"}`,"error");lastTradeRef.current[inst.id]=Date.now();}}).catch(e=>{pendingRef.current[inst.id]=false;addLog(`ERR: ${e.message}`,"error");});}}}catch(e){setAiStatus(p=>({...p,[inst.id]:'error'}));addLog(`Brain error: ${e.message}`,"error");}
  },[brokerCandles,prices,m5C,m15C,h1C,h4C,d1C,wkC,accountBalance,closedTrades,openPositions,news,calEvents,eventAlert,marketStatus,prevDecisions,addLog,fetchPos,fetchHist]);

  useEffect(()=>{const run=()=>{const s=getSessionInfo();if(!s.isLondon&&!s.isNY)return;const g=INSTRUMENTS.find(i=>i.id==='XAUUSD');if(g&&brokerCandles['XAUUSD']?.length>=50)runAIBrain(g);};const t=setTimeout(run,3000),i=setInterval(run,600000);return()=>{clearTimeout(t);clearInterval(i);};},[runAIBrain,brokerCandles]);
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);

  // Computed
  const delta=(id)=>prices[id]&&prevPrices[id]?prices[id]-prevPrices[id]:null;
  const wins=closedTrades.filter(t=>t.profit>0).length;
  const totalPnl=closedTrades.reduce((a,t)=>a+(t.profit||0),0);
  const wr=closedTrades.length>0?((wins/closedTrades.length)*100).toFixed(1):"0.0";
  const todayPnl=getTodayPnl(closedTrades);
  const now_=new Date();
  const timeStr=`${now_.getUTCHours().toString().padStart(2,"0")}:${now_.getUTCMinutes().toString().padStart(2,"0")} UTC`;
  const goldAI=aiDecisions['XAUUSD']||{};
  const goldStatus=aiStatus['XAUUSD'];
  const an=tradeReports.analytics||{};
  const sess=an.sessions||{};
  const nowTs=Date.now(),evTs=eventAlert?.date?new Date(eventAlert.date).getTime():0;
  const showBanner=!!eventAlert&&(!evTs||(evTs>nowTs&&evTs<nowTs+30*60*1000));

  const getTPData=(pos)=>{const raw=(pos.symbol||'').toUpperCase();const id=raw.startsWith('BTCUSD')?'BTCUSDT':raw.startsWith('XAUUSD')?'XAUUSD':raw.startsWith('GBPUSD')?'GBPUSD':null;const dec=id?aiDecisions[id]:null;if(!dec||!pos.openPrice)return null;const dir=pos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT';const tp3=dec.takeProfit3,entry=pos.openPrice,curr=pos.currentPrice||pos.openPrice;const range=Math.abs((tp3||entry)-entry)||1;const progress=Math.min(100,Math.max(0,(Math.abs(curr-entry)/range)*100));return{dir,entry,curr,sl:dec.stopLoss||pos.stopLoss,tp1:dec.takeProfit1,tp2:dec.takeProfit2,tp3,progress,tp1Hit:dec.takeProfit1?(dir==='LONG'?curr>=dec.takeProfit1:curr<=dec.takeProfit1):false,tp2Hit:dec.takeProfit2?(dir==='LONG'?curr>=dec.takeProfit2:curr<=dec.takeProfit2):false,tp3Hit:tp3?(dir==='LONG'?curr>=tp3:curr<=tp3):false};};

  const SC={LONDON:"#3b82f6",NEW_YORK:"#0ea56b",LONDON_NY_OVERLAP:"#c9882a",OVERLAP:"#c9882a"};
  const sc=(s)=>SC[s]||"#8892aa";

  const thisWeekPnl=closedTrades.filter(t=>{const d=new Date(t.time||t.closeTime||'');const now=new Date();const wStart=new Date(now);wStart.setDate(now.getDate()-now.getDay());return d>=wStart;}).reduce((s,t)=>s+(t.profit||0),0);
  const thisMonthPnl=closedTrades.filter(t=>{const d=new Date(t.time||t.closeTime||'');const now=new Date();return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}).reduce((s,t)=>s+(t.profit||0),0);

  const NAV=[
    {id:"overview",icon:"⊞",label:"Live Trade"},
    {id:"sessions",icon:"◎",label:"Session Stats"},
    {id:"reports",icon:"▤",label:"Reports"},
    {id:"journal",icon:"≡",label:"Journal"},
    {id:"brain",icon:"◉",label:"Brain"},
  ];

  const pnlColor=(v)=>v>=0?"#0ea56b":"#e8334a";
  const pnlStr=(v)=>`${v>=0?"+":""}$${v.toFixed(2)}`;

  /* ─── RENDER ───────────────────────────────────────────────────────── */
  return(
    <>
      <style>{CSS}</style>

      {/* Notifications */}
      <div style={{position:"fixed",top:16,right:16,zIndex:9999,display:"flex",flexDirection:"column",gap:8}}>
        {notifs.map(n=>(
          <div key={n.id} className="notif" onClick={()=>setNotifs(p=>p.filter(x=>x.id!==n.id))}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:"3px",borderRadius:"10px 10px 0 0",background:n.type==='FULL_CLOSE_TP3'?"var(--G)":n.type==='PARTIAL_CLOSE_TP2'?"var(--B)":"var(--Au)"}}/>
            <div style={{fontWeight:600,fontSize:12,color:"var(--text)",marginBottom:3}}>{n.type==='PARTIAL_CLOSE_TP1'?"🎯 TP1 Hit — 50% Secured":n.type==='PARTIAL_CLOSE_TP2'?"🎯 TP2 Hit — 30% Secured":"🏆 TP3 — Trade Complete"}</div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--text2)"}}>
              <span>{n.symbol} @ {n.price?.toFixed(2)}</span>
              <span style={{fontWeight:700,color:"var(--G)"}}>+${n.pnl?.toFixed(2)}</span>
            </div>
            <div style={{fontSize:10,color:"var(--text3)",marginTop:2}}>{n.time} · tap to dismiss</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",height:"100vh",overflow:"hidden"}}>

        {/* ══ SIDEBAR ══ */}
        <div style={{width:200,background:"var(--nav)",display:"flex",flexDirection:"column",flexShrink:0}}>
          {/* Logo */}
          <div style={{padding:"22px 20px 18px",borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
            <div style={{fontSize:17,fontWeight:700,color:"#fff",letterSpacing:"0.02em"}}>QuantumBot AI</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",letterSpacing:"0.1em",marginTop:2}}>GOLD · V5</div>
          </div>
          {/* Nav */}
          <nav style={{flex:1,padding:"10px 0",overflowY:"auto"}}>
            {NAV.map(n=>(
              <div key={n.id} className={`nav-item${page===n.id?" active":""}`} onClick={()=>setPage(n.id)}>
                <span className="nav-icon">{n.icon}</span>
                <span>{n.label}</span>
              </div>
            ))}
          </nav>
          {/* Instrument tickers */}
          <div style={{borderTop:"1px solid rgba(255,255,255,0.07)"}}>
            {INSTRUMENTS.map(inst=>{const ai=aiDecisions[inst.id],st=aiStatus[inst.id],d=delta(inst.id);return(
              <div key={inst.id} className={`ticker-row${selected===inst.id?" sel":""}`} onClick={()=>setSelected(inst.id)} style={{padding:"9px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                  <span style={{fontSize:10,fontWeight:600,color:selected===inst.id?"#60a5fa":inst.color}}>{inst.label}</span>
                  <span style={{fontSize:9,color:st==='thinking'?"#e5a830":st==='LONG'?"#0ea56b":st==='SHORT'?"#e8334a":"rgba(255,255,255,0.25)"}}>{st==='thinking'?"···":st||"—"}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                  <span style={{fontSize:13,fontWeight:600,color:"#fff"}}>{fmtPrice(inst.id,prices[inst.id])}</span>
                  {d!=null&&<span style={{fontSize:9,color:d>=0?"#0ea56b":"#e8334a"}}>{d>=0?"▲":"▼"}{Math.abs(d).toFixed(inst.id==="GBPUSD"?4:2)}</span>}
                </div>
                {ai?.decision&&ai.decision!=='WAIT'&&<span className={`badge badge-${ai.decision.toLowerCase()}`} style={{marginTop:3,fontSize:9}}>{ai.decision}</span>}
              </div>
            );})}
          </div>
          {/* Bottom session */}
          <div style={{padding:"10px 16px",borderTop:"1px solid rgba(255,255,255,0.07)",display:"flex",alignItems:"center",gap:8}}>
            <span className={`ldot ${sessionInfo.tradingAllowed?"on":"off"}`}/>
            <span style={{fontSize:10,color:"rgba(255,255,255,0.45)",letterSpacing:"0.08em"}}>{sessionInfo.session}</span>
            <span style={{marginLeft:"auto",fontSize:10,color:"rgba(255,255,255,0.3)"}}>{timeStr}</span>
          </div>
        </div>

        {/* ══ MAIN ══ */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>

          {/* Top bar */}
          <div style={{background:"var(--nav2)",height:52,display:"flex",alignItems:"center",flexShrink:0,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
            {[
              {l:"CURRENT BALANCE",v:accountBalance!=null?`$${accountBalance.toFixed(2)}`:"—",c:"#fff"},
              {l:"OPEN TRADES",v:openPositions.length,c:"#fff"},
              {l:"TODAY P&L",v:pnlStr(todayPnl),c:pnlColor(todayPnl),pct:null},
              {l:"WIN RATE",v:`${wr}%`,c:parseFloat(wr)>=55?"#0ea56b":"#e5a830"},
              {l:"DRAWDOWN",v:`${maxDD}%`,c:parseFloat(maxDD)>10?"#e8334a":"rgba(255,255,255,0.4)"},
              {l:"SESSION",v:sessionInfo.session,c:"#60a5fa"},
            ].map(({l,v,c})=>(
              <div key={l} className="top-kpi">
                <div style={{display:"flex",flexDirection:"column",gap:1}}>
                  <span style={{fontSize:8,color:"rgba(255,255,255,0.35)",letterSpacing:"0.12em"}}>{l}</span>
                  <span style={{fontSize:13,fontWeight:700,color:c}}>{v}</span>
                </div>
              </div>
            ))}
            {showBanner&&<div style={{marginLeft:"auto",marginRight:20,fontSize:11,color:"#e5a830",fontWeight:600}}>⚠ {eventAlert.name}</div>}
          </div>

          {/* Page content */}
          <div style={{flex:1,overflow:"auto",padding:20,background:"var(--bg)"}} className="scroll">

            {/* ══════ OVERVIEW / LIVE TRADE ══════ */}
            {page==="overview"&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 380px",gap:16,alignItems:"start"}}>

                {/* LEFT COLUMN */}
                <div style={{display:"flex",flexDirection:"column",gap:14}}>

                  {/* Overview KPIs */}
                  <div className="card">
                    <div className="stitle">Overview</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                      {[
                        {l:"Today's PnL",v:pnlStr(todayPnl),c:pnlColor(todayPnl),sub:`${todayPnl>=0?"+":""}{${((todayPnl/Math.max(accountBalance||10000,1))*100).toFixed(1)}%}`},
                        {l:"This Week",v:pnlStr(thisWeekPnl),c:pnlColor(thisWeekPnl),sub:null},
                        {l:"This Month",v:pnlStr(thisMonthPnl),c:pnlColor(thisMonthPnl),sub:null},
                      ].map(({l,v,c,sub})=>(
                        <div key={l} className="card-sm" style={{background:"#f4f6fb"}}>
                          <div style={{fontSize:10,fontWeight:600,color:"var(--text3)",marginBottom:5}}>{l}</div>
                          <div style={{fontSize:20,fontWeight:700,color:c,lineHeight:1}}>{v}</div>
                          {sub&&<div style={{fontSize:10,color:c,marginTop:2,opacity:0.8}}>{sub}</div>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Session Performance */}
                  <div className="card">
                    <div className="stitle">Session Performance</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                      {['LONDON','NEW_YORK','OVERLAP'].map(s=>{
                        const sd=sess[s==='OVERLAP'?'LONDON_NY_OVERLAP':s]||{};
                        const active=sessionInfo.session===s||(s==='OVERLAP'&&sessionInfo.session==='LONDON_NY_OVERLAP');
                        const color=sc(s);
                        return(
                          <div key={s} style={{background:"#f4f6fb",borderRadius:8,padding:"12px 14px",borderTop:`3px solid ${active?color:"var(--border)"}`,position:"relative"}}>
                            {active&&<span style={{position:"absolute",top:8,right:8,fontSize:9,fontWeight:600,color,background:`${color}15`,padding:"1px 6px",borderRadius:8}}>LIVE</span>}
                            <div style={{fontSize:11,fontWeight:600,color:"var(--text3)",marginBottom:6}}>{s.replace(/_/g," ")}</div>
                            <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                              <span style={{fontSize:16,fontWeight:700,color:"var(--text)"}}>{sd.trades||0} Trades</span>
                              <span style={{fontSize:14,fontWeight:700,color:sd.winRate>=55?"var(--G)":"var(--Au)"}}>{sd.winRate||0}%</span>
                            </div>
                            <div style={{fontSize:12,fontWeight:600,color:pnlColor(sd.pnl||0),marginTop:2}}>{pnlStr(sd.pnl||0)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* TP Flow */}
                  <div className="card">
                    <div className="stitle">TP Flow</div>
                    <TPChain tp1={an.tp1Pct||0} tp2={an.tp2Pct||0} tp3={an.tp3Pct||0} be={an.bePct||0}/>
                  </div>

                  {/* Equity Curve */}
                  <div className="card">
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                      <div className="stitle" style={{marginBottom:0}}>Equity Curve</div>
                      <div style={{display:"flex",gap:16}}>
                        {[["Max DD",`${maxDD}%`,"#e8334a"],["Peak","$"+(equityCurve.length?Math.max(...equityCurve.map(e=>e.val)).toFixed(0):"—"),"#0ea56b"],["Now","$"+(equityCurve.length?equityCurve[equityCurve.length-1].val.toFixed(0):"—"),"var(--text)"]].map(([k,v,c])=>(
                          <div key={k} style={{textAlign:"right"}}>
                            <div style={{fontSize:9,color:"var(--text3)"}}>{k}</div>
                            <div style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <EquityChart data={equityCurve} w={800} h={130}/>
                    <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid var(--border)"}}>
                      <div style={{fontSize:9,fontWeight:600,color:"var(--text3)",letterSpacing:"0.06em",marginBottom:4}}>DRAWDOWN</div>
                      <DrawdownChart data={equityCurve} w={800} h={54}/>
                    </div>
                  </div>

                  {/* Reports table */}
                  <div className="card">
                    <div className="stitle">Reports</div>
                    <div className="tbl-head tbl-row" style={{gridTemplateColumns:"100px 60px 80px 90px"}}>
                      <span>Symbol</span><span>Type</span><span>Result</span><span>Date</span>
                    </div>
                    {closedTrades.length===0?<div style={{color:"var(--text3)",padding:"16px 0",fontSize:11,textAlign:"center"}}>No trades yet</div>
                      :closedTrades.slice(0,6).map((t,i)=>(
                        <div key={i} className="tbl-row" style={{gridTemplateColumns:"100px 60px 80px 90px"}}>
                          <span style={{fontWeight:600,color:"var(--text)"}}>{(t.symbol||'').replace('.s','')}</span>
                          <span>
                            <span className={`badge badge-${displaySide(t.type).toLowerCase()}`}>{displaySide(t.type)}</span>
                          </span>
                          <span style={{fontWeight:700,color:pnlColor(t.profit||0)}}>{pnlStr(t.profit||0)}</span>
                          <span style={{color:"var(--text3)",fontSize:10}}>{t.time?new Date(t.time).toLocaleDateString():"—"}</span>
                        </div>
                      ))
                    }
                  </div>
                </div>

                {/* RIGHT COLUMN — Live Gold Trade */}
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  <div className="card">
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                      <div>
                        <div className="stitle" style={{marginBottom:2}}>Live Gold Trade</div>
                        <div style={{fontSize:16,fontWeight:700,color:"var(--text)"}}>GOLD/USD</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:20,fontWeight:700,color:"var(--Au)"}}>{prices.XAUUSD?`$${prices.XAUUSD.toFixed(2)}`:"—"}</div>
                        {delta('XAUUSD')!=null&&<div style={{fontSize:11,color:delta('XAUUSD')>=0?"var(--G)":"var(--R)",fontWeight:600}}>{delta('XAUUSD')>=0?"▲":"▼"} {Math.abs(delta('XAUUSD')).toFixed(2)}</div>}
                      </div>
                    </div>

                    {/* AI decision */}
                    <div style={{background:goldAI.decision==='LONG'?"#f0faf5":goldAI.decision==='SHORT'?"#fef2f3":"#f4f6fb",borderRadius:8,padding:"12px 14px",marginBottom:14}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <div>
                          <div style={{fontSize:10,color:"var(--text3)",marginBottom:2}}>AI DECISION</div>
                          <div style={{fontSize:22,fontWeight:800,color:goldStatus==='thinking'?"#e5a830":goldAI.decision==='LONG'?"var(--G)":goldAI.decision==='SHORT'?"var(--R)":"var(--text3)",lineHeight:1}}>{goldStatus==='thinking'?"···":goldAI.decision||"WAIT"}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:10,color:"var(--text3)",marginBottom:2}}>CONFIDENCE</div>
                          <div style={{fontSize:22,fontWeight:800,color:goldAI.confidence>=75?"var(--G)":"#e5a830"}}>{goldAI.confidence||0}%</div>
                        </div>
                      </div>
                      {goldAI.reason&&<div style={{fontSize:10,color:"var(--text2)",lineHeight:1.5,fontStyle:"italic"}}>"{goldAI.reason}"</div>}
                    </div>

                    {/* Open positions */}
                    {openPositions.length===0
                      ?<div style={{color:"var(--text3)",fontSize:11,textAlign:"center",padding:"16px 0",background:"#f8f9fc",borderRadius:8}}>No open positions</div>
                      :openPositions.map((pos,i)=>{
                        const tp=getTPData(pos),dir=pos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT';
                        return(
                          <div key={i} style={{background:"#f8f9fc",borderRadius:10,padding:"12px 14px",marginBottom:8,borderLeft:`4px solid ${dir==='LONG'?"var(--G)":"var(--R)"}`}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                                <span style={{fontSize:13,fontWeight:700}}>{(pos.symbol||'').replace('.s','')}</span>
                                <span className={`badge badge-${dir.toLowerCase()}`}>{dir}</span>
                                <span style={{fontSize:10,color:"var(--text3)"}}>{pos.volume}L</span>
                              </div>
                              <span style={{fontSize:16,fontWeight:800,color:pnlColor(pos.profit||0)}}>{pnlStr(pos.profit||0)}</span>
                            </div>
                            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:10}}>
                              {[["Entry",pos.openPrice,"var(--text2)"],["Now",pos.currentPrice,"var(--text)"],["SL",tp?.sl,"var(--R)"]].map(([l,v,c])=>(
                                <div key={l} style={{background:"white",borderRadius:6,padding:"6px 8px",border:"1px solid var(--border)"}}>
                                  <div style={{fontSize:9,color:"var(--text3)",marginBottom:1}}>{l}</div>
                                  <div style={{fontSize:11,fontWeight:600,color:c}}>{v?.toFixed?.(2)||"—"}</div>
                                </div>
                              ))}
                            </div>
                            {tp&&(
                              <>
                                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:8}}>
                                  {[["TP1 · 50%",tp.tp1,tp.tp1Hit,"#c9882a"],["TP2 · 30%",tp.tp2,tp.tp2Hit,"#3b6cf0"],["TP3 · 20%",tp.tp3,tp.tp3Hit,"#0ea56b"]].map(([l,v,hit,c])=>(
                                    <div key={l} style={{background:hit?`${c}12`:"white",border:`1px solid ${hit?c:"var(--border)"}`,borderRadius:6,padding:"6px 8px",transition:"all 0.3s"}}>
                                      <div style={{fontSize:9,color:hit?c:"var(--text3)",marginBottom:1}}>{l}{hit&&" ✓"}</div>
                                      <div style={{fontSize:11,fontWeight:700,color:hit?c:"var(--text)"}}>{v?.toFixed?.(2)||"—"}</div>
                                    </div>
                                  ))}
                                </div>
                                <div className="prog"><div className="prog-fill" style={{width:`${tp.progress}%`}}/></div>
                                <div style={{display:"flex",justifyContent:"space-between",marginTop:3,fontSize:9,color:"var(--text3)"}}>
                                  <span>Entry</span><span style={{color:"#3b6cf0",fontWeight:600}}>{tp.progress.toFixed(0)}% to TP3</span><span>TP3</span>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })
                    }
                  </div>

                  {/* Recent Alerts (log) */}
                  <div className="card">
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                      <div className="stitle" style={{marginBottom:0}}>Recent Alerts</div>
                      <button onClick={()=>setLog([])} style={{background:"none",border:"1px solid var(--border)",borderRadius:5,padding:"2px 9px",color:"var(--text3)",fontSize:10,cursor:"pointer"}}>Clear</button>
                    </div>
                    <div ref={logRef} className="scroll" style={{maxHeight:180}}>
                      {log.slice(-10).reverse().map((e,i)=>(
                        <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",padding:"6px 0",borderBottom:"1px solid var(--border)"}}>
                          <div style={{width:6,height:6,borderRadius:"50%",flexShrink:0,marginTop:3,background:e.type==="signal"?"#3b6cf0":e.type==="error"?"#e8334a":e.type==="warn"?"#e5a830":e.type==="success"?"#0ea56b":"#cbd2e0"}}/>
                          <div>
                            <span style={{fontSize:9,color:"var(--text3)",marginRight:6}}>{e.time}</span>
                            <span style={{fontSize:11,color:"var(--text2)"}}>{e.msg}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ══════ SESSIONS ══════ */}
            {page==="sessions"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                  {['LONDON','NEW_YORK','LONDON_NY_OVERLAP'].map(s=>{
                    const sd=sess[s]||{},active=sessionInfo.session===s||(s==='LONDON_NY_OVERLAP'&&sessionInfo.session==='OVERLAP');
                    return <SessionRing key={s} label={s.replace('_NY_','+')} wr={sd.winRate||0} trades={sd.trades||0} pnl={sd.pnl||0} color={sc(s)} active={active}/>;
                  })}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                  {[["Today",an.daily||{}],["This Week",an.weekly||{}],["This Month",an.monthly||{}]].map(([l,d])=>(
                    <div key={l} className="card">
                      <div className="stitle">{l}</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {[["Trades",d.total||0,"var(--text)"],["Win Rate",`${d.winRate||0}%`,d.winRate>=55?"var(--G)":"var(--Au)"],["P&L",pnlStr(d.pnl||0),pnlColor(d.pnl||0)],["Losses",d.losses||0,d.losses?"var(--R)":"var(--text3)"]].map(([lbl,v,c])=>(
                          <div key={lbl} style={{background:"#f4f6fb",borderRadius:7,padding:"10px 12px"}}>
                            <div style={{fontSize:9,fontWeight:600,color:"var(--text3)",marginBottom:3,letterSpacing:"0.06em"}}>{lbl.toUpperCase()}</div>
                            <div style={{fontSize:18,fontWeight:700,color:c}}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ══════ REPORTS ══════ */}
            {page==="reports"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  {[["Total Trades",an.totalTrades||0,"var(--B)"],["Net P&L",`$${(an.totalPnl||0).toFixed(2)}`,pnlColor(an.totalPnl||0)],["Avg P&L",`$${(an.avgPnl||0).toFixed(2)}`,"var(--Au)"],["SL Hits",an.slHitCount||0,"var(--R)"]].map(([l,v,c])=>(
                    <div key={l} className="card-sm" style={{background:"var(--card)"}}>
                      <div style={{fontSize:10,fontWeight:600,color:"var(--text3)",marginBottom:6}}>{l}</div>
                      <div style={{fontSize:24,fontWeight:800,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <div className="stitle">TP Chain Performance</div>
                  <TPChain tp1={an.tp1Pct||0} tp2={an.tp2Pct||0} tp3={an.tp3Pct||0} be={an.bePct||0}/>
                </div>
                <div className="card">
                  <div className="stitle">Trade Reports</div>
                  <div className="tbl-head tbl-row" style={{gridTemplateColumns:"100px 60px 80px 70px 90px"}}><span>Symbol</span><span>Dir</span><span>Result</span><span>Session</span><span>Exit</span></div>
                  {(!tradeReports.reports||!tradeReports.reports.length)?<div style={{color:"var(--text3)",padding:"16px 0",textAlign:"center",fontSize:11}}>Reports appear after TP hits</div>
                    :tradeReports.reports.map((r,i)=>(
                      <div key={i} className="tbl-row" style={{gridTemplateColumns:"100px 60px 80px 70px 90px"}}>
                        <span style={{fontWeight:600}}>{(r.symbol||'').replace('.s','')}</span>
                        <span><span className={`badge badge-${(r.direction||'wait').toLowerCase()}`}>{r.direction}</span></span>
                        <span style={{fontWeight:700,color:pnlColor(r.totalPnl||0)}}>{pnlStr(r.totalPnl||0)}</span>
                        <span style={{fontSize:10,color:"var(--text3)"}}>{r.session}</span>
                        <span style={{fontSize:10}}>
                          {r.tp1Hit&&<span style={{color:"#c9882a",marginRight:4}}>TP1✓</span>}
                          {r.tp2Hit&&<span style={{color:"#3b6cf0",marginRight:4}}>TP2✓</span>}
                          {r.tp3Hit&&<span style={{color:"#0ea56b"}}>TP3✓</span>}
                          {r.finalExit==='SL_HIT'&&<span style={{color:"#e8334a"}}>SL</span>}
                        </span>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}

            {/* ══════ JOURNAL ══════ */}
            {page==="journal"&&(
              <div className="card">
                <div className="stitle">Trade Journal — {closedTrades.length} entries</div>
                <div className="tbl-head tbl-row" style={{gridTemplateColumns:"110px 60px 50px 90px 90px 100px 85px"}}><span>Instrument</span><span>Side</span><span>Size</span><span>Open</span><span>Close</span><span>Time</span><span>P&L</span></div>
                {closedTrades.length===0?<div style={{color:"var(--text3)",padding:"20px 0",fontSize:11,textAlign:"center"}}>No entries</div>
                  :closedTrades.slice(0,100).map((t,i)=>(
                    <div key={i} className="tbl-row" style={{gridTemplateColumns:"110px 60px 50px 90px 90px 100px 85px"}}>
                      <span style={{fontWeight:600,color:"var(--Au)"}}>{(t.symbol||'').replace('.s','')}</span>
                      <span><span className={`badge badge-${displaySide(t.type).toLowerCase()}`}>{displaySide(t.type)}</span></span>
                      <span style={{color:"var(--text2)"}}>{t.volume}</span>
                      <span style={{color:"var(--text2)",fontSize:11}}>{t.openPrice??'—'}</span>
                      <span style={{color:"var(--text2)",fontSize:11}}>{t.closePrice??'—'}</span>
                      <span style={{color:"var(--text3)",fontSize:10}}>{t.time?new Date(t.time).toLocaleTimeString():"—"}</span>
                      <span style={{fontWeight:700,color:pnlColor(t.profit||0)}}>{pnlStr(t.profit||0)}</span>
                    </div>
                  ))
                }
              </div>
            )}

            {/* ══════ BRAIN — MATCH ANALYSIS ══════ */}
            {page==="brain"&&(()=>{
              // Derived stats for the analysis
              const totalTrades = closedTrades.length;
              const allWins = closedTrades.filter(t=>t.profit>0);
              const allLoss = closedTrades.filter(t=>t.profit<=0);
              const avgWin = allWins.length ? allWins.reduce((s,t)=>s+(t.profit||0),0)/allWins.length : 0;
              const avgLoss = allLoss.length ? Math.abs(allLoss.reduce((s,t)=>s+(t.profit||0),0)/allLoss.length) : 0;
              const rrRatio = avgLoss > 0 ? (avgWin/avgLoss).toFixed(2) : "—";
              const bestTrade = closedTrades.length ? closedTrades.reduce((a,b)=>(b.profit||0)>(a.profit||0)?b:a, closedTrades[0]) : null;
              const worstTrade = closedTrades.length ? closedTrades.reduce((a,b)=>(b.profit||0)<(a.profit||0)?b:a, closedTrades[0]) : null;
              const londonTrades = (sess['LONDON']?.trades)||0;
              const nyTrades = (sess['NEW_YORK']?.trades)||0;
              const overlapTrades = (sess['LONDON_NY_OVERLAP']?.trades)||0;
              const bestSession = [['London',sess['LONDON']?.winRate||0,'#3b82f6'],['New York',sess['NEW_YORK']?.winRate||0,'#0ea56b'],['Overlap',sess['LONDON_NY_OVERLAP']?.winRate||0,'#c9882a']].sort((a,b)=>b[1]-a[1])[0];
              const recentDecisions = prevDecisions['XAUUSD']||[];
              const recentWins = recentDecisions.filter(d=>d.outcome==='WIN').length;
              const recentLoss = recentDecisions.filter(d=>d.outcome==='LOSS').length;
              const topPatterns = Object.entries(learnedStats).filter(([,d])=>d.total>=2).sort((a,b)=>(b[1].winRate||0)-(a[1].winRate||0));
              const worstPatterns = [...Object.entries(learnedStats)].filter(([,d])=>d.total>=2).sort((a,b)=>(a[1].winRate||0)-(b[1].winRate||0));
              const isActive = openPositions.length > 0;
              const currentPos = openPositions[0];

              return(
              <div style={{display:"flex",flexDirection:"column",gap:20}}>

                {/* ── MATCH HEADER ── */}
                <div style={{background:"linear-gradient(135deg,#1a2744 0%,#1e3060 100%)",borderRadius:14,padding:"20px 24px",display:"flex",alignItems:"center",gap:20}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.45)",letterSpacing:"0.1em",marginBottom:4}}>QUANTUM BOT — AI MATCH ANALYSIS</div>
                    <div style={{fontSize:22,fontWeight:800,color:"#fff",letterSpacing:"-0.02em"}}>
                      {isActive ? "🔴 MATCH IN PROGRESS" : goldStatus==='thinking' ? "🧠 PRE-MATCH ANALYSIS" : "📋 POST-MATCH DEBRIEF"}
                    </div>
                    <div style={{fontSize:12,color:"rgba(255,255,255,0.5)",marginTop:4}}>
                      {isActive ? `Active trade on ${(currentPos?.symbol||'').replace('.s','')} — monitoring in real time`
                        : goldStatus==='thinking' ? "Claude is reading the market — decision incoming"
                        : `${totalTrades} trades analysed · Win rate ${wr}% · R/R ratio ${rrRatio}`}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:12}}>
                    {[
                      {l:"Win Rate",v:`${wr}%`,c:parseFloat(wr)>=55?"#4ade80":"#fb923c"},
                      {l:"R/R Ratio",v:rrRatio,c:"#60a5fa"},
                      {l:"Total Trades",v:totalTrades,c:"#fff"},
                    ].map(({l,v,c})=>(
                      <div key={l} style={{background:"rgba(255,255,255,0.07)",borderRadius:10,padding:"12px 16px",textAlign:"center",minWidth:80}}>
                        <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",letterSpacing:"0.1em",marginBottom:4}}>{l}</div>
                        <div style={{fontSize:20,fontWeight:800,color:c,lineHeight:1}}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── THREE COLUMNS ── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,alignItems:"start"}}>

                  {/* ── PRE-MATCH: What Claude sees before entering ── */}
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,padding:"0 4px"}}>
                      <div style={{width:28,height:28,borderRadius:"50%",background:"#eff3fd",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📡</div>
                      <div>
                        <div style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>PRE-MATCH</div>
                        <div style={{fontSize:10,color:"var(--text3)"}}>What I analyse before entering</div>
                      </div>
                    </div>

                    {/* Current AI state */}
                    <div className="card" style={{padding:"16px"}}>
                      <div className="stitle">Current Read — XAU/USD</div>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,marginBottom:12}}>
                        <AIOrb decision={goldAI.decision} confidence={goldAI.confidence} status={goldStatus} reason={null}/>
                      </div>
                      {goldAI.marketRead&&(
                        <div style={{background:"#f4f6fb",borderRadius:8,padding:"10px 12px",marginBottom:10}}>
                          <div style={{fontSize:9,fontWeight:600,color:"var(--text3)",marginBottom:4,letterSpacing:"0.06em"}}>MARKET READ</div>
                          <div style={{fontSize:11,color:"var(--text)",lineHeight:1.6}}>{goldAI.marketRead}</div>
                        </div>
                      )}
                      {goldAI.reason&&(
                        <div style={{background:"#f0faf5",borderRadius:8,padding:"10px 12px",borderLeft:"3px solid #0ea56b"}}>
                          <div style={{fontSize:9,fontWeight:600,color:"#0ea56b",marginBottom:4,letterSpacing:"0.06em"}}>REASONING</div>
                          <div style={{fontSize:11,color:"var(--text)",lineHeight:1.6,fontStyle:"italic"}}>"{goldAI.reason}"</div>
                        </div>
                      )}
                      {!goldAI.reason&&!goldAI.marketRead&&(
                        <div style={{fontSize:11,color:"var(--text3)",textAlign:"center",padding:"8px 0"}}>Waiting for next analysis cycle…</div>
                      )}
                    </div>

                    {/* Setup criteria */}
                    <div className="card" style={{padding:"16px"}}>
                      <div className="stitle">What I Look For</div>
                      {[
                        {label:"W1 Weekly Trend",desc:"8 weekly candles = 2 months of context. The macro direction. Never trade against it.",icon:"🌍"},
        {label:"H4 Trend Direction",desc:"20 candles = 3 days of context. Confirms weekly bias and defines the swing structure.",icon:"📈"},
        {label:"H1 Intraday Structure",desc:"24 candles = 1 full day. Where London started, where NY reversed. Key entry zones.",icon:"⏱️"},
        {label:"M5 Entry Timing",desc:"10 candles = 50 mins. Used to find the precise entry candle — momentum and spread.",icon:"🎯"},
                        {label:"Equilibrium Zone",desc:"DISCOUNT = looking for LONG. PREMIUM = looking for SHORT.",icon:"⚖️"},
                        {label:"RSI Confirmation",desc:"RSI > 55 in uptrend, RSI < 45 in downtrend strengthens conviction.",icon:"📊"},
                        {label:"Session Timing",desc:"London 08:00–16:00 UTC. NY 13:00–21:00 UTC. Overlap is best.",icon:"🕐"},
                        {label:"News & Events",desc:"High-impact events blocked. I wait 30 min around data releases.",icon:"📰"},
                        {label:"Daily Direction",desc:"If 3+ losses in same direction today, I stop trading that way.",icon:"🔄"},
                      ].map(({label,desc,icon})=>(
                        <div key={label} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:"1px solid var(--border)"}}>
                          <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{icon}</span>
                          <div>
                            <div style={{fontSize:11,fontWeight:600,color:"var(--text)",marginBottom:2}}>{label}</div>
                            <div style={{fontSize:10,color:"var(--text3)",lineHeight:1.5}}>{desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ── DURING: Live trade + recent decisions ── */}
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,padding:"0 4px"}}>
                      <div style={{width:28,height:28,borderRadius:"50%",background:isActive?"#fef0f0":"#f0fdf4",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>{isActive?"🔴":"✅"}</div>
                      <div>
                        <div style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>DURING THE TRADE</div>
                        <div style={{fontSize:10,color:"var(--text3)"}}>Live position + recent decisions</div>
                      </div>
                    </div>

                    {/* Live position or last decision */}
                    {isActive && currentPos ? (()=>{
                      const tp=getTPData(currentPos);
                      const dir=currentPos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT';
                      const pnl=currentPos.profit||0;
                      return(
                        <div className="card" style={{padding:"16px",borderTop:`4px solid ${dir==='LONG'?"#0ea56b":"#e8334a"}`}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                            <div>
                              <div style={{fontSize:10,color:"var(--text3)",marginBottom:2}}>LIVE POSITION</div>
                              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                                <span style={{fontSize:14,fontWeight:700}}>{(currentPos.symbol||'').replace('.s','')}</span>
                                <span className={`badge badge-${dir.toLowerCase()}`}>{dir}</span>
                              </div>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{fontSize:10,color:"var(--text3)",marginBottom:2}}>FLOATING P&L</div>
                              <div style={{fontSize:20,fontWeight:800,color:pnlColor(pnl)}}>{pnlStr(pnl)}</div>
                            </div>
                          </div>
                          {tp&&(
                            <>
                              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:10}}>
                                {[["TP1",tp.tp1,tp.tp1Hit,"#c9882a"],["TP2",tp.tp2,tp.tp2Hit,"#3b6cf0"],["TP3",tp.tp3,tp.tp3Hit,"#0ea56b"]].map(([l,v,hit,c])=>(
                                  <div key={l} style={{background:hit?`${c}10`:"#f8f9fc",border:`1px solid ${hit?c:"var(--border)"}`,borderRadius:7,padding:"8px",textAlign:"center",transition:"all 0.3s"}}>
                                    <div style={{fontSize:9,color:hit?c:"var(--text3)",marginBottom:2}}>{l}{hit&&" ✓"}</div>
                                    <div style={{fontSize:12,fontWeight:700,color:hit?c:"var(--text)"}}>{v?`$${v.toFixed(2)}`:"—"}</div>
                                  </div>
                                ))}
                              </div>
                              <div className="prog"><div className="prog-fill" style={{width:`${tp.progress}%`}}/></div>
                              <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:9,color:"var(--text3)"}}>
                                <span>Entry ${tp.entry.toFixed(2)}</span>
                                <span style={{color:"#3b6cf0",fontWeight:600}}>{tp.progress.toFixed(0)}% to TP3</span>
                                <span>SL ${tp.sl?.toFixed(2)||"—"}</span>
                              </div>
                            </>
                          )}
                          {goldAI.risk&&(
                            <div style={{marginTop:10,display:"flex",gap:8,alignItems:"center",padding:"7px 10px",background:"#f8f9fc",borderRadius:7}}>
                              <span style={{fontSize:10,color:"var(--text3)"}}>Risk level:</span>
                              <span style={{fontSize:11,fontWeight:700,color:goldAI.risk==='HIGH'?"#e8334a":goldAI.risk==='LOW'?"#0ea56b":"#c9882a"}}>{goldAI.risk}</span>
                              {goldAI.confidence&&<span style={{fontSize:10,color:"var(--text3)",marginLeft:"auto"}}>Confidence: <strong style={{color:"var(--text)"}}>{goldAI.confidence}%</strong></span>}
                            </div>
                          )}
                        </div>
                      );
                    })():(
                      <div className="card" style={{padding:"16px"}}>
                        <div className="stitle">No active trade</div>
                        <div style={{fontSize:11,color:"var(--text3)",padding:"8px 0"}}>
                          {goldStatus==='thinking'?"Claude is analysing the market right now…":"Bot is waiting for the right setup. Not every candle needs a trade."}
                        </div>
                      </div>
                    )}

                    {/* Recent 5 decisions with outcome */}
                    <div className="card" style={{padding:"16px"}}>
                      <div className="stitle">Last {recentDecisions.length} Decisions — XAU/USD</div>
                      {recentDecisions.length===0
                        ?<div style={{fontSize:11,color:"var(--text3)"}}>No decisions recorded yet this session.</div>
                        :[...recentDecisions].reverse().map((d,i)=>(
                          <div key={i} style={{padding:"10px 12px",marginBottom:7,borderRadius:9,background:"#f8f9fc",borderLeft:`3px solid ${d.outcome==='WIN'?"#0ea56b":d.outcome==='LOSS'?"#e8334a":"#3b6cf0"}`}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                              <div style={{display:"flex",gap:7,alignItems:"center"}}>
                                <span style={{fontSize:12,fontWeight:700,color:d.decision==='LONG'?"#0ea56b":d.decision==='SHORT'?"#e8334a":"var(--text3)"}}>{d.decision}</span>
                                <span style={{fontSize:10,color:"var(--text3)"}}>@ {d.price?.toFixed?.(d.price>100?2:4)||d.price}</span>
                                <span style={{fontSize:9,color:"var(--text3)"}}>· {d.time?new Date(d.time).toLocaleTimeString():""}</span>
                              </div>
                              {d.outcome
                                ?<span style={{fontSize:11,fontWeight:700,padding:"2px 9px",borderRadius:5,background:d.outcome==='WIN'?"#e8f5f0":"#fdecea",color:d.outcome==='WIN'?"#0ea56b":"#e8334a"}}>{d.outcome} {d.pnl>=0?"+":""}${d.pnl?.toFixed(2)}</span>
                                :<span style={{fontSize:10,color:"#3b6cf0",background:"#eff3fd",padding:"2px 8px",borderRadius:5}}>open</span>
                              }
                            </div>
                            <div style={{fontSize:10,color:"var(--text3)",lineHeight:1.5}}>{d.reason}</div>
                          </div>
                        ))
                      }
                      <div style={{marginTop:8,display:"flex",gap:12,padding:"8px 0",borderTop:"1px solid var(--border)"}}>
                        <div style={{fontSize:11}}><span style={{fontWeight:700,color:"#0ea56b"}}>{recentWins} wins</span> <span style={{color:"var(--text3)"}}>in last {recentDecisions.length}</span></div>
                        <div style={{fontSize:11}}><span style={{fontWeight:700,color:"#e8334a"}}>{recentLoss} losses</span></div>
                        {recentDecisions.length>0&&<div style={{fontSize:11,marginLeft:"auto",color:"var(--text3)"}}>recent form: <strong style={{color:recentWins>recentLoss?"#0ea56b":recentWins<recentLoss?"#e8334a":"#c9882a"}}>{recentWins>recentLoss?"📈 Good":"recentWins<recentLoss"?"📉 Struggling":"➡️ Neutral"}</strong></div>}
                      </div>
                    </div>
                  </div>

                  {/* ── AFTER: What I learned ── */}
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,padding:"0 4px"}}>
                      <div style={{width:28,height:28,borderRadius:"50%",background:"#fdf4e8",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🎓</div>
                      <div>
                        <div style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>POST-MATCH DEBRIEF</div>
                        <div style={{fontSize:10,color:"var(--text3)"}}>What the bot has learned over time</div>
                      </div>
                    </div>

                    {/* Performance summary */}
                    <div className="card" style={{padding:"16px"}}>
                      <div className="stitle">Overall Performance</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                        {[
                          {l:"Avg Win",v:`$${avgWin.toFixed(2)}`,c:"#0ea56b"},
                          {l:"Avg Loss",v:`$${avgLoss.toFixed(2)}`,c:"#e8334a"},
                          {l:"R/R Ratio",v:rrRatio,c:"#3b6cf0",desc:"win/loss size"},
                          {l:"Best Session",v:bestSession?bestSession[0]:"—",c:bestSession?bestSession[2]:"var(--text3)"},
                        ].map(({l,v,c,desc})=>(
                          <div key={l} style={{background:"#f4f6fb",borderRadius:8,padding:"10px 12px"}}>
                            <div style={{fontSize:9,color:"var(--text3)",marginBottom:2,fontWeight:600,letterSpacing:"0.06em"}}>{l}</div>
                            <div style={{fontSize:16,fontWeight:800,color:c}}>{v}</div>
                            {desc&&<div style={{fontSize:9,color:"var(--text3)",marginTop:1}}>{desc}</div>}
                          </div>
                        ))}
                      </div>
                      {bestTrade&&<div style={{padding:"8px 10px",background:"#e8f5f0",borderRadius:7,marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div><div style={{fontSize:9,color:"#0ea56b",fontWeight:600,marginBottom:1}}>BEST TRADE</div><div style={{fontSize:11,color:"var(--text)"}}>{(bestTrade.symbol||'').replace('.s','')} {displaySide(bestTrade.type)}</div></div>
                        <div style={{fontSize:15,fontWeight:800,color:"#0ea56b"}}>+${(bestTrade.profit||0).toFixed(2)}</div>
                      </div>}
                      {worstTrade&&<div style={{padding:"8px 10px",background:"#fdecea",borderRadius:7,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div><div style={{fontSize:9,color:"#e8334a",fontWeight:600,marginBottom:1}}>WORST TRADE</div><div style={{fontSize:11,color:"var(--text)"}}>{(worstTrade.symbol||'').replace('.s','')} {displaySide(worstTrade.type)}</div></div>
                        <div style={{fontSize:15,fontWeight:800,color:"#e8334a"}}>${(worstTrade.profit||0).toFixed(2)}</div>
                      </div>}
                    </div>

                    {/* What works — learned patterns */}
                    <div className="card" style={{padding:"16px"}}>
                      <div className="stitle">What Works ({topPatterns.length} patterns)</div>
                      {topPatterns.length===0
                        ?<div style={{fontSize:11,color:"var(--text3)"}}>Patterns accumulate after several trades. Keep running.</div>
                        :topPatterns.slice(0,5).map(([fp,data])=>{
                          const parts=fp.split(':'),wr=data.winRate||0,c=wr>=70?"#0ea56b":wr>=50?"#c9882a":"#e8334a";
                          const session=parts[6]||'';
                          const insight = wr>=70 ? "Strong edge — keep trading this" : wr>=50 ? "Positive but needs more data" : "Avoid this setup for now";
                          return(
                            <div key={fp} style={{padding:"10px 12px",marginBottom:8,borderRadius:9,background:"#f8f9fc",borderLeft:`3px solid ${c}`}}>
                              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                                <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                                  <span style={{fontSize:11,fontWeight:700,color:"var(--Au)"}}>{parts[0]}</span>
                                  <span className={`badge badge-${(parts[1]||'wait').toLowerCase()}`}>{parts[1]}</span>
                                  {session&&<span style={{fontSize:9,color:"var(--text3)",background:"var(--card2)",padding:"1px 6px",borderRadius:4,border:"1px solid var(--border)"}}>{session}</span>}
                                </div>
                                <span style={{fontSize:17,fontWeight:800,color:c,lineHeight:1}}>{wr}%</span>
                              </div>
                              <div style={{display:"flex",gap:10,fontSize:10,marginBottom:5}}>
                                <span style={{color:"#0ea56b",fontWeight:600}}>✓ {data.wins} wins</span>
                                <span style={{color:"#e8334a",fontWeight:600}}>✗ {data.losses} losses</span>
                                <span style={{color:"var(--text3)"}}>Σ {data.total} total</span>
                                {data.avgPips&&<span style={{color:data.avgPips>0?"#0ea56b":"#e8334a",fontWeight:600,marginLeft:"auto"}}>{data.avgPips>0?"+":""}{data.avgPips} avg</span>}
                              </div>
                              <div style={{height:4,background:"#e8ecf5",borderRadius:2,marginBottom:5}}><div style={{height:"100%",background:c,borderRadius:2,width:`${wr}%`,transition:"width 1.2s ease"}}/></div>
                              <div style={{fontSize:9,color:"var(--text3)",fontStyle:"italic"}}>{insight}</div>
                            </div>
                          );
                        })
                      }
                    </div>

                    {/* What doesn't work */}
                    {worstPatterns.filter(([,d])=>d.winRate<50&&d.total>=3).length>0&&(
                      <div className="card" style={{padding:"16px"}}>
                        <div className="stitle">What Doesn't Work</div>
                        {worstPatterns.filter(([,d])=>d.winRate<50&&d.total>=3).slice(0,3).map(([fp,data])=>{
                          const parts=fp.split(':'),wr=data.winRate||0;
                          return(
                            <div key={fp} style={{padding:"9px 12px",marginBottom:7,borderRadius:9,background:"#fdecea",borderLeft:"3px solid #e8334a"}}>
                              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                                  <span style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{parts[0]}</span>
                                  <span className={`badge badge-${(parts[1]||'wait').toLowerCase()}`}>{parts[1]}</span>
                                  {parts[6]&&<span style={{fontSize:9,color:"var(--text3)",background:"white",padding:"1px 5px",borderRadius:4}}>{parts[6]}</span>}
                                </div>
                                <span style={{fontSize:14,fontWeight:800,color:"#e8334a"}}>{wr}%</span>
                              </div>
                              <div style={{fontSize:9,color:"#e8334a",fontStyle:"italic"}}>I struggle here — {data.losses} losses vs {data.wins} wins out of {data.total} trades</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              );
            })()}

          </div>
        </div>
      </div>
    </>
  );
}