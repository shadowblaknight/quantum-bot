import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const INSTRUMENTS = [
  { id: "GBPUSD",  label: "GBP/USD",  type: "FOREX",     color: "#5BA8FF", pip: 4 },
  { id: "BTCUSDT", label: "BTC/USDT", type: "CRYPTO",    color: "#FFB347", pip: 0 },
  { id: "XAUUSD",  label: "XAU/USD",  type: "COMMODITY", color: "#D4AF6A", pip: 2 },
];

const getMarketStatus = () => {
  const now=new Date(),utcDay=now.getUTCDay(),h=now.getUTCHours(),m=now.getUTCMinutes(),t=h+m/60;
  const crypto={open:true,session:"24/7"};
  let forex={open:false,session:"WEEKEND"};
  if(utcDay>=1&&utcDay<=4) forex={open:true,session:t<8?"ASIA":t<16?"LONDON":"NEW YORK"};
  else if(utcDay===5&&t<22) forex={open:true,session:t<16?"LONDON":"NEW YORK"};
  else if(utcDay===0&&t>=22) forex={open:true,session:"SYDNEY"};
  return{GBPUSD:forex,BTCUSDT:crypto,XAUUSD:forex.open?{open:true,session:"COMEX"}:{open:false,session:"WEEKEND"}};
};

const isNearClose=()=>{const n=new Date();return n.getUTCDay()===5&&(n.getUTCHours()+n.getUTCMinutes()/60)>=21.5;};

const getSessionInfo=()=>{
  const now=new Date(),t=now.getUTCHours()+now.getUTCMinutes()/60,d=now.getUTCDay();
  if(d===6||(d===0&&t<22)) return{session:"WEEKEND",isLondon:false,isNY:false,isOverlap:false,tradingAllowed:false,utcTime:t};
  const sun=d===0&&t>=22,lon=t>=8&&t<16,ny=t>=13&&t<21,ov=t>=13&&t<16;
  let session="OFF";
  if(sun)session="SYDNEY";else if(ov)session="OVERLAP";else if(ny)session="NEW YORK";else if(lon)session="LONDON";else session="ASIAN";
  return{session,isLondon:lon,isNY:ny,isOverlap:ov,isSundayReopen:sun,tradingAllowed:lon||ny||sun,utcTime:t};
};

const getConsecLosses=(t=[])=>{let s=0;for(let i=t.length-1;i>=0;i--){if(Number(t[i]?.profit||0)<0)s++;else break;}return s;};
const getTodayPnl=(t=[])=>{const n=new Date();return t.reduce((s,x)=>{const d=new Date(x.time||x.closeTime||"");return d.toDateString()===n.toDateString()?s+Number(x.profit||0):s;},0);};
const fmtPrice=(id,p)=>p!=null?(id==="BTCUSDT"?p.toLocaleString("en",{maximumFractionDigits:0}):p.toFixed(id==="GBPUSD"?4:2)):"—";


/* ─── GLOBAL STYLES ───────────────────────────────────────────────────── */
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,400&family=JetBrains+Mono:wght@300;400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:       #05080d;
    --surface0: #080d14;
    --surface1: #0c1420;
    --surface2: #101c2c;
    --border:   rgba(255,255,255,0.05);
    --border2:  rgba(255,255,255,0.09);
    --text:     #d8e8f4;
    --muted:    #4a6680;
    --faint:    #1e3248;
    --gold:     #D4AF6A;
    --gold2:    #F0C97A;
    --green:    #3DD68C;
    --red:      #FF5C6A;
    --blue:     #5BA8FF;
    --amber:    #FFB347;
    --serif:    'Cormorant Garamond', Georgia, serif;
    --mono:     'JetBrains Mono', 'Courier New', monospace;
  }

  html, body, #root { height: 100%; overflow: hidden; }
  body { background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 11px; }

  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--faint); border-radius: 2px; }

  .panel {
    background: linear-gradient(145deg, var(--surface1) 0%, var(--surface0) 100%);
    border: 1px solid var(--border);
    border-radius: 2px;
    position: relative;
  }
  .panel::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 2px;
    background: linear-gradient(135deg, rgba(212,175,106,0.03) 0%, transparent 50%);
    pointer-events: none;
  }

  .panel-raised {
    background: linear-gradient(145deg, var(--surface2) 0%, var(--surface1) 100%);
    border: 1px solid var(--border2);
    border-radius: 2px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.04) inset;
  }

  .serif-num {
    font-family: var(--serif);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; cursor: pointer;
    color: var(--muted); font-size: 10px; letter-spacing: 0.08em;
    border-left: 2px solid transparent;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.02); }
  .nav-item.active { color: var(--gold); border-left-color: var(--gold); background: rgba(212,175,106,0.04); }

  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 1px;
    font-size: 9px; font-weight: 500; letter-spacing: 0.1em;
  }
  .badge-long  { background: rgba(61,214,140,0.1);  color: var(--green); border: 1px solid rgba(61,214,140,0.2); }
  .badge-short { background: rgba(255,92,106,0.1);  color: var(--red);   border: 1px solid rgba(255,92,106,0.2); }
  .badge-wait  { background: rgba(74,102,128,0.1);  color: var(--muted); border: 1px solid rgba(74,102,128,0.2); }

  .ticker-row {
    padding: 11px 0; border-bottom: 1px solid var(--border);
    cursor: pointer; transition: background 0.1s;
  }
  .ticker-row:hover { background: rgba(212,175,106,0.025); }
  .ticker-row.selected { background: rgba(212,175,106,0.04); border-left: 2px solid var(--gold); margin-left: -1px; }

  .stat-box {
    background: linear-gradient(135deg, var(--surface2), var(--surface1));
    border: 1px solid var(--border);
    padding: 14px 16px;
    border-radius: 2px;
    position: relative; overflow: hidden;
  }
  .stat-box::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(212,175,106,0.2), transparent);
  }

  .tbl-row { display: grid; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .tbl-row:hover { background: rgba(255,255,255,0.01); }
  .tbl-head { color: var(--muted); font-size: 9px; letter-spacing: 0.1em; padding: 6px 0 10px; border-bottom: 1px solid var(--border2); }

  .tp-node {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
  }
  .tp-node-circle {
    width: 52px; height: 52px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    position: relative;
  }

  .notif-card {
    background: linear-gradient(135deg, var(--surface2), var(--surface1));
    border: 1px solid var(--border2);
    border-radius: 2px;
    padding: 14px 18px;
    min-width: 300px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    animation: slideRight 0.25s ease;
    cursor: pointer;
  }
  @keyframes slideRight { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  .live-dot {
    width: 6px; height: 6px; border-radius: 50%;
    animation: livePulse 2s ease-in-out infinite;
  }
  @keyframes livePulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.7)} }

  .progress-track {
    height: 4px; background: var(--faint); border-radius: 2px; overflow: hidden;
    position: relative;
  }
  .progress-fill {
    height: 100%; border-radius: 2px;
    background: linear-gradient(90deg, var(--gold), var(--green));
    transition: width 1s cubic-bezier(0.4,0,0.2,1);
  }

  .grid-bg {
    background-image:
      linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
    background-size: 40px 40px;
  }

  .glow-gold { box-shadow: 0 0 30px rgba(212,175,106,0.06); }
  .glow-green { box-shadow: 0 0 30px rgba(61,214,140,0.06); }
  .glow-red { box-shadow: 0 0 30px rgba(255,92,106,0.06); }

  .section-label {
    font-size: 8px; letter-spacing: 0.18em; color: var(--muted);
    text-transform: uppercase; padding-bottom: 14px;
  }

  .chart-tooltip {
    position: absolute; background: var(--surface2); border: 1px solid var(--border2);
    padding: 6px 10px; border-radius: 2px; font-size: 9px; pointer-events: none;
    color: var(--text); white-space: nowrap;
  }
`;


/* ─── SVG EQUITY CHART ────────────────────────────────────────────────── */
function EquityChart({ data, w=700, h=160 }) {
  const [hover, setHover] = useState(null);
  if (!data || data.length < 3) return (
    <div style={{height:h,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--muted)",fontSize:"10px",letterSpacing:"0.1em"}}>
      ACCUMULATING DATA
    </div>
  );
  const vals = data.map(d=>d.val);
  const min = Math.min(...vals), max = Math.max(...vals), rng = max-min||1;
  const pad = {t:18,r:16,b:28,l:56};
  const W = w-pad.l-pad.r, H = h-pad.t-pad.b;
  const px = (i) => pad.l + (i/(data.length-1))*W;
  const py = (v) => pad.t + (1-(v-min)/rng)*H;
  const pts = data.map((d,i)=>({ x:px(i), y:py(d.val), val:d.val, date:d.date }));
  const linePts = pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `M${pts[0].x},${py(min)} ` + pts.map(p=>`L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + ` L${pts[pts.length-1].x},${py(min)} Z`;
  const isUp = vals[vals.length-1] >= vals[0];
  const color = isUp ? "#3DD68C" : "#FF5C6A";
  const yLabels = [0,0.25,0.5,0.75,1].map(f=>({
    y: pad.t+H*(1-f), v:`$${(min+rng*f).toFixed(0)}`
  }));
  const last = pts[pts.length-1];
  return (
    <div style={{position:"relative"}} onMouseLeave={()=>setHover(null)}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet"
        onMouseMove={e=>{
          const rect=e.currentTarget.getBoundingClientRect();
          const rx=(e.clientX-rect.left)/rect.width*w;
          const nearest=pts.reduce((a,b)=>Math.abs(b.x-rx)<Math.abs(a.x-rx)?b:a);
          setHover(nearest);
        }}>
        <defs>
          <linearGradient id="ecg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18"/>
            <stop offset="70%" stopColor={color} stopOpacity="0.03"/>
            <stop offset="100%" stopColor={color} stopOpacity="0"/>
          </linearGradient>
          <filter id="lineglow">
            <feGaussianBlur stdDeviation="1.5" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        {/* grid */}
        {yLabels.map((yl,i)=>(
          <g key={i}>
            <line x1={pad.l} y1={yl.y} x2={pad.l+W} y2={yl.y} stroke="rgba(255,255,255,0.04)" strokeDasharray="3 4"/>
            <text x={pad.l-7} y={yl.y+3.5} textAnchor="end" fontSize="8" fill="rgba(74,102,128,0.8)" fontFamily="JetBrains Mono">{yl.v}</text>
          </g>
        ))}
        {/* zero line */}
        <line x1={pad.l} y1={pad.t+H} x2={pad.l+W} y2={pad.t+H} stroke="rgba(255,255,255,0.06)"/>
        {/* area */}
        <path d={areaPath} fill="url(#ecg)"/>
        {/* line */}
        <polyline points={linePts} fill="none" stroke={color} strokeWidth="1.5" filter="url(#lineglow)"/>
        {/* last dot */}
        <circle cx={last.x} cy={last.y} r="3.5" fill={color} opacity="0.9"/>
        <circle cx={last.x} cy={last.y} r="6" fill={color} opacity="0.15"/>
        {/* hover */}
        {hover && <>
          <line x1={hover.x} y1={pad.t} x2={hover.x} y2={pad.t+H} stroke="rgba(212,175,106,0.25)" strokeDasharray="3 3"/>
          <circle cx={hover.x} cy={hover.y} r="3.5" fill={color} stroke="var(--surface2)" strokeWidth="1.5"/>
        </>}
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{top:8,left:Math.min(hover.x/w*100,75)+"%"}}>
          <div style={{color:"var(--gold)",fontWeight:500}}>${hover.val.toFixed(2)}</div>
          {hover.date && <div style={{color:"var(--muted)",fontSize:"8px",marginTop:2}}>{new Date(hover.date).toLocaleDateString()}</div>}
        </div>
      )}
    </div>
  );
}

/* ─── DRAWDOWN CHART ──────────────────────────────────────────────────── */
function DrawdownChart({ data, w=700, h=80 }) {
  if (!data || data.length < 3) return null;
  const vals = data.map(d=>d.val);
  let peak=vals[0], dds=vals.map(v=>{if(v>peak)peak=v;return peak>0?((peak-v)/peak)*100:0;});
  const maxDD=Math.max(...dds)||1;
  const pad={t:8,r:16,b:20,l:56};
  const W=w-pad.l-pad.r, H=h-pad.t-pad.b;
  const pts=dds.map((d,i)=>({x:pad.l+(i/(dds.length-1))*W, y:pad.t+(d/maxDD)*H}));
  const linePts=pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath=`M${pts[0].x},${pad.t} `+pts.map(p=>`L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")+` L${pts[pts.length-1].x},${pad.t} Z`;
  const yLabels=[0,50,100].map(f=>({y:pad.t+H*(f/100),v:`${(maxDD*(f/100)).toFixed(1)}%`}));
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="ddg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FF5C6A" stopOpacity="0.25"/>
          <stop offset="100%" stopColor="#FF5C6A" stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      {yLabels.map((yl,i)=>(
        <g key={i}>
          <line x1={pad.l} y1={yl.y} x2={pad.l+W} y2={yl.y} stroke="rgba(255,255,255,0.04)" strokeDasharray="3 4"/>
          <text x={pad.l-7} y={yl.y+3.5} textAnchor="end" fontSize="8" fill="rgba(74,102,128,0.8)" fontFamily="JetBrains Mono">{yl.v}</text>
        </g>
      ))}
      <path d={areaPath} fill="url(#ddg)"/>
      <polyline points={linePts} fill="none" stroke="#FF5C6A" strokeWidth="1.2" opacity="0.7"/>
    </svg>
  );
}

/* ─── SESSION RING ────────────────────────────────────────────────────── */
function SessionRing({ label, wr, trades, pnl, color, active }) {
  const r=32, circ=2*Math.PI*r, arc=(wr/100)*circ;
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"18px 12px",
      background:active?"linear-gradient(145deg,rgba(212,175,106,0.05),rgba(212,175,106,0.01))":"transparent",
      border:`1px solid ${active?"rgba(212,175,106,0.15)":"var(--border)"}`,borderRadius:2,minWidth:120}}>
      <div style={{position:"relative",width:76,height:76}}>
        <svg width="76" height="76" viewBox="0 0 76 76">
          <defs>
            <linearGradient id={`rg_${label}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.5"/>
              <stop offset="100%" stopColor={color}/>
            </linearGradient>
          </defs>
          <circle cx="38" cy="38" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="4"/>
          <circle cx="38" cy="38" r={r} fill="none" stroke={`url(#rg_${label})`} strokeWidth="4"
            strokeDasharray={`${arc.toFixed(2)} ${(circ-arc).toFixed(2)}`}
            strokeLinecap="round" transform="rotate(-90 38 38)"
            style={{transition:"stroke-dasharray 1.4s cubic-bezier(0.4,0,0.2,1)"}}/>
          {/* Inner shadow ring */}
          <circle cx="38" cy="38" r={r-6} fill="rgba(0,0,0,0.3)"/>
        </svg>
        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
          <div className="serif-num" style={{fontSize:18,color:color}}>{wr}%</div>
          <div style={{fontSize:7,color:"var(--muted)",letterSpacing:"0.08em",marginTop:1}}>WIN</div>
        </div>
      </div>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:8,letterSpacing:"0.14em",color:active?color:"var(--muted)",marginBottom:4}}>{label.replace(/_/g," ")}</div>
        <div style={{display:"flex",gap:10,justifyContent:"center"}}>
          <span style={{color:"var(--muted)",fontSize:9}}>{trades}T</span>
          <span style={{color:pnl>=0?"var(--green)":"var(--red)",fontSize:9,fontWeight:500}}>{pnl>=0?"+":""}${pnl.toFixed(0)}</span>
        </div>
      </div>
      {active && <div style={{width:20,height:2,background:`linear-gradient(90deg,transparent,${color},transparent)`,borderRadius:1}}/>}
    </div>
  );
}

/* ─── TP CHAIN ────────────────────────────────────────────────────────── */
function TPChain({ tp1, tp2, tp3, be }) {
  const nodes=[
    {label:"ENTRY",pct:100,color:"var(--muted)",sub:"all trades"},
    {label:"TP 1",pct:tp1,color:"var(--gold)",sub:"50% closed"},
    {label:"TP 2",pct:tp2,color:"var(--blue)",sub:"30% closed"},
    {label:"TP 3",pct:tp3,color:"var(--green)",sub:"runners"},
  ];
  return (
    <div style={{display:"flex",alignItems:"center",gap:0,padding:"4px 0"}}>
      {nodes.map((n,i)=>(
        <div key={n.label} style={{display:"flex",alignItems:"center",flex:1}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
            <div style={{width:54,height:54,borderRadius:"50%",border:`1.5px solid ${n.color}`,
              background:`radial-gradient(circle at 35% 35%, ${n.color}18, ${n.color}06)`,
              display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,
              boxShadow:`0 0 18px ${n.color}15, 0 2px 8px rgba(0,0,0,0.4)`}}>
              <div className="serif-num" style={{fontSize:15,color:n.color,letterSpacing:"-0.03em"}}>{n.pct}%</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:9,letterSpacing:"0.1em",color:"var(--muted)"}}>{n.label}</div>
              <div style={{fontSize:8,color:"var(--faint)",marginTop:1}}>{n.sub}</div>
            </div>
          </div>
          {i<nodes.length-1&&(
            <div style={{width:28,height:"1px",background:`linear-gradient(90deg,${n.color}40,${nodes[i+1].color}40)`,flexShrink:0,marginBottom:20}}/>
          )}
        </div>
      ))}
      <div style={{marginLeft:8,width:1,height:50,background:"var(--border)",flexShrink:0}}/>
      <div style={{marginLeft:12,display:"flex",flexDirection:"column",alignItems:"center",gap:5,padding:"0 12px"}}>
        <div style={{width:44,height:44,borderRadius:"50%",border:"1.5px solid var(--muted)",background:"rgba(74,102,128,0.08)",
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:"0 0 14px rgba(74,102,128,0.1)"}}>
          <div className="serif-num" style={{fontSize:13,color:"var(--muted)"}}>{be}%</div>
        </div>
        <div style={{fontSize:8,letterSpacing:"0.1em",color:"var(--faint)"}}>BE SAVE</div>
      </div>
    </div>
  );
}

/* ─── MAIN APP ───────────────────────────────────────────────────────── */
export default function TradingBotLive() {
  const [prices,setPrices]=useState({GBPUSD:null,BTCUSDT:null,XAUUSD:null});
  const [prevPrices,setPrevPrices]=useState({GBPUSD:null,BTCUSDT:null,XAUUSD:null});
  const [brokerCandles,setBrokerCandles]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [m15C,setM15C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [h4C,setH4C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
  const [d1C,setD1C]=useState({BTCUSDT:[],XAUUSD:[],GBPUSD:[]});
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
  const [page,setPage]=useState("dashboard");
  const [equityCurve,setEquityCurve]=useState([]);
  const [aiDecisions,setAiDecisions]=useState({});
  const [prevDecisions,setPrevDecisions]=useState({});
  const [aiStatus,setAiStatus]=useState({});

  const lastTradeRef=useRef({});
  const pendingRef=useRef({});
  const logRef=useRef(null);
  const blockLogRef=useRef({});
  const prevPosRef=useRef([]);
  const lastAIRef=useRef({});

  // Auto-dismiss notifs
  useEffect(()=>{
    if(!notifs.length)return;
    const t=setTimeout(()=>setNotifs(p=>p.slice(1)),7000);
    return()=>clearTimeout(t);
  },[notifs]);

  // Equity curve
  useEffect(()=>{
    if(!closedTrades.length)return;
    let eq=accountBalance||10000;
    const curve=[...closedTrades].reverse().map(t=>{eq+=(t.profit||0);return{val:parseFloat(eq.toFixed(2)),date:t.time||t.closeTime};});
    setEquityCurve(curve);
  },[closedTrades,accountBalance]);

  const maxDD=useMemo(()=>{
    let peak=0,dd=0;
    equityCurve.forEach(p=>{if(p.val>peak)peak=p.val;const d=peak>0?((peak-p.val)/peak)*100:0;if(d>dd)dd=d;});
    return dd.toFixed(1);
  },[equityCurve]);

  const addLog=useCallback((msg,type="info")=>{
    const now=new Date(),time=`${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
    setLog(p=>[...p.slice(-80),{time,msg,type}]);
  },[]);

  const fetchPos=useCallback(async()=>{try{const r=await fetch("/api/positions");if(r.ok){const d=await r.json();setOpenPositions(d.positions||[]);}}catch(e){}}, []);
  const fetchHist=useCallback(async()=>{try{const r=await fetch("/api/history");if(r.ok){const d=await r.json();setClosedTrades(d.deals||[]);}}catch(e){}}, []);
  const fetchLearn=useCallback(async()=>{try{const r=await fetch("/api/trades?learn=true");if(r.ok){const d=await r.json();setLearnedStats(d.stats||{});}}catch(e){}}, []);
  const fetchReports=useCallback(async()=>{try{const r=await fetch("/api/manage-trades");if(r.ok){const d=await r.json();setTradeReports(d);}}catch(e){}}, []);

  useEffect(()=>{const f=async()=>{try{const r=await fetch("/api/account");if(!r.ok)return;const d=await r.json();const b=Number(d.balance??d.equity??d.accountBalance);if(Number.isFinite(b)&&b>0)setAccountBalance(b);}catch(e){}};f();const i=setInterval(f,30000);return()=>clearInterval(i);},[]);

  useEffect(()=>{
    const sm={BTCUSDT:"BTCUSD",XAUUSD:"XAUUSD.s",GBPUSD:"GBPUSD"};
    const fc=async(id)=>{
      const sym=sm[id];
      try{
        const r=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=M1&limit=200`);
        const d=await r.json();
        if(d.candles?.length>=50){setBrokerCandles(p=>({...p,[id]:d.candles}));const lc=d.candles[d.candles.length-1].close;if(Number.isFinite(lc))setPrices(p=>{setPrevPrices(pp=>({...pp,[id]:p[id]}));return{...p,[id]:lc};});}
        try{const r2=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=M15&limit=100`);const d2=await r2.json();if(d2.candles?.length>=20)setM15C(p=>({...p,[id]:d2.candles}));}catch(e){}
        try{const r3=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=H4&limit=100`);const d3=await r3.json();if(d3.candles?.length>=20)setH4C(p=>({...p,[id]:d3.candles}));}catch(e){}
        try{const r4=await fetch(`/api/broker-candles?symbol=${sym}&timeframe=D1&limit=30`);const d4=await r4.json();if(d4.candles?.length>=10)setD1C(p=>({...p,[id]:d4.candles}));}catch(e){}
      }catch(e){setPrices(p=>({...p,[id]:null}));}
    };
    const fp=async(id)=>{try{const r=await fetch(`/api/broker-price?symbol=${sm[id]}`);const d=await r.json();if(Number.isFinite(d.price))setPrices(p=>{setPrevPrices(pp=>({...pp,[id]:p[id]}));return{...p,[id]:d.price};});}catch(e){}};
    INSTRUMENTS.forEach(i=>fc(i.id));
    const pi=INSTRUMENTS.map(i=>setInterval(()=>fp(i.id),5000));
    const ci=INSTRUMENTS.map(i=>setInterval(()=>fc(i.id),60000));
    addLog("System online — AI brain active","success");
    return()=>{pi.forEach(clearInterval);ci.forEach(clearInterval);};
  },[addLog]);

  useEffect(()=>{const i=setInterval(()=>{setMarketStatus(getMarketStatus());setSessionInfo(getSessionInfo());},60000);return()=>clearInterval(i);},[]);
  useEffect(()=>{const f=async()=>{try{const r=await fetch("/api/news");const d=await r.json();if(d.articles)setNews(d.articles);}catch(e){}};f();const i=setInterval(f,300000);return()=>clearInterval(i);},[]);
  useEffect(()=>{
    const f=async()=>{
      try{const r=await fetch("/api/calendar");const d=await r.json();
        if(d.source==="unavailable"||!Array.isArray(d.events)){setEventAlert({name:"Calendar unavailable",date:null});return;}
        setCalEvents(d.events);const now=Date.now();
        setEventAlert(d.events.find(ev=>{const t=new Date(ev.date).getTime();return t>now&&t<now+30*60*1000;})||null);
      }catch(e){setEventAlert({name:"Calendar error",date:null});}
    };
    f();const i=setInterval(f,300000);return()=>clearInterval(i);
  },[]);

  useEffect(()=>{fetchPos();fetchHist();const i=setInterval(()=>{fetchPos();fetchHist();},30000);return()=>clearInterval(i);},[fetchPos,fetchHist]);
  useEffect(()=>{fetchLearn();const i=setInterval(fetchLearn,300000);return()=>clearInterval(i);},[fetchLearn]);
  useEffect(()=>{fetchReports();const i=setInterval(fetchReports,30000);return()=>clearInterval(i);},[fetchReports]);

  const recordResult=useCallback(async(position,dec,session)=>{
    if(!position||!dec)return;
    const pips=position.profit||0,won=pips>0;
    const payload={instrument:position.symbol?.replace('.s','').replace('.S','')||'UNKNOWN',direction:position.type==='POSITION_TYPE_BUY'?'LONG':'SHORT',won,pips,rr:parseFloat((Math.abs(pips)/Math.max(1,Math.abs(pips))).toFixed(2)),session,grade:dec.confidence>=80?'A':dec.confidence>=65?'B':'C',confluenceScore:dec.confidence,regime:'AI_DECISION'};
    try{
      await fetch('/api/trades?learn=true',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      addLog(`${payload.instrument} ${won?'WIN':'LOSS'} ${pips>=0?'+':''}${pips.toFixed(2)}`,won?'success':'warn');
      setPrevDecisions(p=>{const ex=[...(p[payload.instrument]||[])];const last=ex[ex.length-1];if(last&&!last.outcome)ex[ex.length-1]={...last,outcome:won?'WIN':'LOSS',pnl:pips};return{...p,[payload.instrument]:ex};});
      fetchLearn();
    }catch(e){}
  },[addLog,fetchLearn]);

  useEffect(()=>{
    const prev=prevPosRef.current,cur=openPositions;
    prev.filter(p=>!cur.find(c=>(c.id||c.positionId)===(p.id||p.positionId))).forEach(cp=>{
      const raw=(cp.symbol||'').toUpperCase();
      const id=raw.startsWith('BTCUSD')?'BTCUSDT':raw.startsWith('XAUUSD')?'XAUUSD':raw.startsWith('GBPUSD')?'GBPUSD':null;
      if(id&&aiDecisions[id])recordResult(cp,aiDecisions[id],getSessionInfo().session);
    });
    prevPosRef.current=cur;
  },[openPositions,aiDecisions,recordResult]);

  const manageTrades=useCallback(async()=>{
    if(!openPositions.length)return;
    const managed=openPositions.map(pos=>{
      const raw=(pos.symbol||'').toUpperCase();
      const id=raw.startsWith('BTCUSD')?'BTCUSDT':raw.startsWith('XAUUSD')?'XAUUSD':raw.startsWith('GBPUSD')?'GBPUSD':null;
      const dec=id?aiDecisions[id]:null;
      return{id:pos.id||pos.positionId,symbol:pos.symbol,openPrice:pos.openPrice,currentPrice:pos.currentPrice,stopLoss:pos.stopLoss,volume:pos.volume,direction:pos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT',tp1:dec?.takeProfit1??null,tp2:dec?.takeProfit2??null,tp3:dec?.takeProfit3??null,breakeven:pos.openPrice,atr:null};
    }).filter(p=>p.id&&p.tp1);
    if(!managed.length)return;
    try{
      const r=await fetch('/api/manage-trades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({positions:managed})});
      const d=await r.json();
      if(d.managed?.length>0){
        d.managed.forEach(m=>m.actions.forEach(a=>{
          if(a.type==='PARTIAL_CLOSE_TP1')addLog(`TP1 ${m.symbol} +$${a.pnl?.toFixed(2)}`,'success');
          if(a.type==='PARTIAL_CLOSE_TP2')addLog(`TP2 ${m.symbol} +$${a.pnl?.toFixed(2)}`,'success');
          if(a.type==='FULL_CLOSE_TP3')addLog(`TP3 COMPLETE ${m.symbol} +$${a.pnl?.toFixed(2)}`,'success');
          if(a.type==='SL_TO_BREAKEVEN')addLog(`BE lock ${m.symbol}`,'info');
          if(['PARTIAL_CLOSE_TP1','PARTIAL_CLOSE_TP2','FULL_CLOSE_TP3'].includes(a.type)){
            setNotifs(p=>[...p.slice(-3),{id:Date.now(),symbol:m.symbol,type:a.type,price:a.price,pnl:a.pnl,time:new Date().toLocaleTimeString()}]);
            fetchReports();
          }
        }));
        setTimeout(fetchPos,1500);setTimeout(fetchHist,3000);
      }
    }catch(e){}
  },[openPositions,aiDecisions,addLog,fetchPos,fetchHist,fetchReports]);

  useEffect(()=>{if(!openPositions.length)return;const i=setInterval(manageTrades,30000);manageTrades();return()=>clearInterval(i);},[openPositions,manageTrades]);

  /* V5 BRAIN — BETTER EYES */
  const runAIBrain=useCallback(async(inst)=>{
    const candles=brokerCandles[inst.id];
    if(!candles||candles.length<50||!prices[inst.id]||!accountBalance)return;
    const now=Date.now(),last=lastAIRef.current[inst.id]||0;
    if(now-last<600000)return;
    lastAIRef.current[inst.id]=now;
    setAiStatus(p=>({...p,[inst.id]:'thinking'}));
    const session=getSessionInfo();
    const sumC=(c,label,lb=5)=>{
      if(!c||!c.length)return`${label}:no data`;
      const sl=c.slice(-lb),dir=sl[sl.length-1].close>sl[0].close?'↑':'↓';
      const chg=((sl[sl.length-1].close-sl[0].close)/sl[0].close*100).toFixed(3);
      const hi=Math.max(...sl.map(x=>x.high)).toFixed(inst.id==='BTCUSDT'?0:2);
      const lo=Math.min(...sl.map(x=>x.low)).toFixed(inst.id==='BTCUSDT'?0:2);
      const open=sl[0].close.toFixed(inst.id==='BTCUSDT'?0:2),close=sl[sl.length-1].close.toFixed(inst.id==='BTCUSDT'?0:2);
      return`${label}(${lb}): ${dir}${chg}% start:${open} now:${close} H:${hi} L:${lo}`;
    };
    const cls=candles.map(c=>c.close);
    const rsi=(()=>{if(cls.length<15)return 50;const ch=cls.slice(1).map((p,i)=>p-cls[i]);let g=0,l=0;for(let i=0;i<14;i++){if(ch[i]>0)g+=ch[i];else l-=ch[i];}g/=14;l/=14;for(let i=14;i<ch.length;i++){g=(g*13+Math.max(ch[i],0))/14;l=(l*13+Math.max(-ch[i],0))/14;}return l===0?100:100-(100/(1+g/l));})();
    const ema=(()=>{if(cls.length<21)return null;const k=2/22;let e=cls.slice(0,21).reduce((a,b)=>a+b,0)/21;for(let i=21;i<cls.length;i++)e=cls[i]*k+e*(1-k);return e;})();
    const h4=h4C[inst.id]||[];
    const eq=(()=>{if(h4.length<10)return null;const r=h4.slice(-20),hi=Math.max(...r.map(c=>c.high)),lo=Math.min(...r.map(c=>c.low)),pos=((prices[inst.id]-lo)/(hi-lo))*100;return{position:Math.round(pos),zone:pos>62.5?'PREMIUM':pos<37.5?'DISCOUNT':'EQUILIBRIUM'};})();
    const todayPnl=getTodayPnl(closedTrades),lossStreak=getConsecLosses(closedTrades);
    const todayT=closedTrades.filter(t=>{const d=new Date(t.time||t.closeTime||'');return d.toDateString()===new Date().toDateString();});
    const wr=closedTrades.length>0?((closedTrades.filter(t=>t.profit>0).length/closedTrades.length)*100).toFixed(1):0;
    const ws=(()=>{let s=0;for(let i=closedTrades.length-1;i>=0;i--){if(Number(closedTrades[i]?.profit||0)>0)s++;else break;}return s;})();
    const tl=todayT.filter(t=>t.type==='BUY'),ts=todayT.filter(t=>t.type==='SELL');
    const snap={
      symbol:inst.id,price:prices[inst.id],
      candles_m1:sumC(candles,'M1',10),candles_m15:sumC(m15C[inst.id],'M15',10),
      candles_h4:sumC(h4C[inst.id],'H4',20),candles_d1:sumC(d1C[inst.id],'D1',10),
      rsi:rsi?.toFixed(1),ema21:ema?.toFixed(inst.id==='BTCUSDT'?0:4),
      price_vs_ema21:ema?(prices[inst.id]>ema?'ABOVE':'BELOW'):'UNKNOWN',
      equilibrium_zone:eq?.zone,equilibrium_position:eq?.position,
      session:session.session,session_allowed:session.tradingAllowed,
      news:news.slice(0,3),calendar_events:calEvents.slice(0,3),
      open_positions:openPositions.map(p=>({symbol:p.symbol,type:p.type,profit:p.profit})),
      account_balance:accountBalance,today_pnl:todayPnl?.toFixed(2),today_trades:todayT.length,
      loss_streak:lossStreak,win_streak:ws,overall_win_rate:wr,
      today_long_results:`${tl.filter(t=>(t.profit||0)>0).length}W/${tl.filter(t=>(t.profit||0)<=0).length}L (${tl.length} longs)`,
      today_short_results:`${ts.filter(t=>(t.profit||0)>0).length}W/${ts.filter(t=>(t.profit||0)<=0).length}L (${ts.length} shorts)`,
    };
    try{
      const r=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketSnapshot:snap,instrument:inst.id,previousDecisions:prevDecisions[inst.id]||[]})});
      const dec=await r.json();
      if(dec.decision){
        setAiDecisions(p=>({...p,[inst.id]:dec}));
        setAiStatus(p=>({...p,[inst.id]:dec.decision}));
        addLog(`${inst.label} → ${dec.decision} ${dec.confidence||0}% — ${dec.reason||''}`,dec.decision==='WAIT'?'info':'signal');
        if(dec.decision!=='WAIT'&&dec.confidence>=55){
          const n=Date.now();
          if(lastTradeRef.current[inst.id]&&(n-lastTradeRef.current[inst.id])<300000)return;
          if(pendingRef.current[inst.id])return;
          const evTs=eventAlert?.date?new Date(eventAlert.date).getTime():0;
          if(evTs>n&&evTs<n+30*60*1000){addLog(`Blocked: ${eventAlert.name}`,"warn");return;}
          if(isNearClose()&&inst.type!=="CRYPTO"){addLog("Blocked: near close","warn");return;}
          if(!marketStatus[inst.id]?.open&&inst.type!=="CRYPTO")return;
          const ao=openPositions.some(p=>{const raw=(p.symbol||"").toUpperCase();const norm=raw==="XAUUSD.S"?"XAUUSD":raw.startsWith("BTCUSD")?"BTCUSD":raw.startsWith("GBPUSD")?"GBPUSD":raw.startsWith("XAUUSD")?"XAUUSD":raw;return norm===(inst.id==="BTCUSDT"?"BTCUSD":inst.id);});
          if(ao){addLog(`${inst.label}: already open`,"warn");return;}
          if(openPositions.length>=3){addLog("Max 3 positions","warn");return;}
          if(!dec.stopLoss||!dec.takeProfit3){addLog(`No SL/TP from Claude`,"warn");return;}
          if(!Number.isFinite(accountBalance)||accountBalance<=0)return;
          if(getTodayPnl(closedTrades)<=-(accountBalance*0.05)){addLog("Daily limit hit","error");return;}
          const vol=dec.volume||0.08;
          pendingRef.current[inst.id]=true;
          addLog(`EXECUTE ${inst.label} ${dec.decision} ${vol}L`,"signal");
          setPrevDecisions(p=>({...p,[inst.id]:[...(p[inst.id]||[]).slice(-4),{decision:dec.decision,price:prices[inst.id],reason:dec.reason,time:new Date().toISOString(),outcome:null,pnl:null}]}));
          fetch("/api/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({instrument:inst.id,direction:dec.decision,entry:prices[inst.id],stopLoss:dec.stopLoss,takeProfit:dec.takeProfit3,volume:vol})})
          .then(r=>r.json()).then(d=>{
            pendingRef.current[inst.id]=false;
            if(d.success){lastTradeRef.current[inst.id]=Date.now();addLog(`LIVE ${inst.label} ${dec.decision} ${vol}L @ ${prices[inst.id]}`,"success");setTimeout(fetchPos,2000);setTimeout(fetchHist,3000);}
            else{addLog(`FAILED: ${d.error||"unknown"}`,"error");lastTradeRef.current[inst.id]=Date.now();}
          }).catch(e=>{pendingRef.current[inst.id]=false;addLog(`ERR: ${e.message}`,"error");});
        }
      }
    }catch(e){setAiStatus(p=>({...p,[inst.id]:'error'}));addLog(`Brain error: ${e.message}`,"error");}
  },[brokerCandles,prices,m15C,h4C,d1C,accountBalance,closedTrades,openPositions,news,calEvents,eventAlert,marketStatus,prevDecisions,addLog,fetchPos,fetchHist]);

  useEffect(()=>{
    const run=()=>{const s=getSessionInfo();if(!s.isLondon&&!s.isNY)return;const g=INSTRUMENTS.find(i=>i.id==='XAUUSD');if(g&&brokerCandles['XAUUSD']?.length>=50)runAIBrain(g);};
    const t=setTimeout(run,3000),i=setInterval(run,600000);
    return()=>{clearTimeout(t);clearInterval(i);};
  },[runAIBrain,brokerCandles]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);

  /* ─── COMPUTED ──────────────────────────────────────────────────────── */
  const delta=(id)=>prices[id]&&prevPrices[id]?prices[id]-prevPrices[id]:null;
  const wins=closedTrades.filter(t=>t.profit>0).length;
  const totalPnl=closedTrades.reduce((a,t)=>a+(t.profit||0),0);
  const wr=closedTrades.length>0?((wins/closedTrades.length)*100).toFixed(1):"0.0";
  const lossStreak=getConsecLosses(closedTrades);
  const todayPnl=getTodayPnl(closedTrades);
  const selAI=aiDecisions[selected]||{};
  const selInst=INSTRUMENTS.find(i=>i.id===selected);
  const an=tradeReports.analytics||{};
  const sess=an.sessions||{};
  const nowTs=Date.now(),evTs=eventAlert?.date?new Date(eventAlert.date).getTime():0;
  const showBanner=!!eventAlert&&(!evTs||(evTs>nowTs&&evTs<nowTs+30*60*1000));

  const getTPData=(pos)=>{
    const raw=(pos.symbol||'').toUpperCase();
    const id=raw.startsWith('BTCUSD')?'BTCUSDT':raw.startsWith('XAUUSD')?'XAUUSD':raw.startsWith('GBPUSD')?'GBPUSD':null;
    const dec=id?aiDecisions[id]:null;
    if(!dec||!pos.openPrice)return null;
    const dir=pos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT';
    const tp1=dec.takeProfit1,tp2=dec.takeProfit2,tp3=dec.takeProfit3,sl=dec.stopLoss||pos.stopLoss;
    const curr=pos.currentPrice||pos.openPrice,entry=pos.openPrice;
    const range=Math.abs((tp3||entry)-entry)||1;
    const progress=Math.min(100,Math.max(0,(Math.abs(curr-entry)/range)*100));
    return{dir,entry,curr,sl,tp1,tp2,tp3,progress,tp1Hit:tp1?(dir==='LONG'?curr>=tp1:curr<=tp1):false,tp2Hit:tp2?(dir==='LONG'?curr>=tp2:curr<=tp2):false,tp3Hit:tp3?(dir==='LONG'?curr>=tp3:curr<=tp3):false};
  };

  const SC={LONDON:"#5BA8FF",NEW_YORK:"#3DD68C",LONDON_NY_OVERLAP:"#D4AF6A",OVERLAP:"#D4AF6A"};
  const sc=(s)=>SC[s]||"var(--muted)";

  const NAV=[
    {id:"dashboard",icon:"◈",label:"Dashboard"},
    {id:"positions",icon:"◉",label:"Positions"},
    {id:"intelligence",icon:"◎",label:"Intelligence"},
    {id:"sessions",icon:"▦",label:"Sessions"},
    {id:"analytics",icon:"▣",label:"Analytics"},
    {id:"journal",icon:"≡",label:"Journal"},
    {id:"market",icon:"◈",label:"Market"},
  ];

  /* ─── RENDER ─────────────────────────────────────────────────────────── */
  return (
    <>
      <style>{STYLES}</style>

      {/* ── NOTIFICATIONS ── */}
      <div style={{position:"fixed",top:20,right:20,zIndex:9999,display:"flex",flexDirection:"column",gap:10}}>
        {notifs.map(n=>(
          <div key={n.id} className="notif-card" onClick={()=>setNotifs(p=>p.filter(x=>x.id!==n.id))}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:"1px",background:n.type==='FULL_CLOSE_TP3'?"linear-gradient(90deg,transparent,var(--green),transparent)":n.type==='PARTIAL_CLOSE_TP2'?"linear-gradient(90deg,transparent,var(--blue),transparent)":"linear-gradient(90deg,transparent,var(--gold),transparent)"}}/>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:10,letterSpacing:"0.1em",color:"var(--text)",fontWeight:500}}>
                {n.type==='PARTIAL_CLOSE_TP1'?"TARGET I — 50% SECURED":n.type==='PARTIAL_CLOSE_TP2'?"TARGET II — 30% SECURED":"TARGET III — POSITION COMPLETE"}
              </span>
              <span style={{fontSize:9,color:"var(--muted)"}}>×</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <span style={{color:"var(--muted)",fontSize:10}}>{n.symbol} · {n.price?.toFixed(2)}</span>
              <span className="serif-num" style={{fontSize:18,color:"var(--green)"}}>+${n.pnl?.toFixed(2)}</span>
            </div>
            <div style={{fontSize:8,color:"var(--faint)",marginTop:4,letterSpacing:"0.06em"}}>{n.time} · click to dismiss</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",height:"100vh",overflow:"hidden"}}>

        {/* ══ LEFT NAV ════════════════════════════════════════════════════ */}
        <div style={{width:200,background:"var(--surface0)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",flexShrink:0}}>
          {/* Wordmark */}
          <div style={{padding:"22px 18px 18px",borderBottom:"1px solid var(--border)"}}>
            <div style={{fontFamily:"var(--serif)",fontSize:20,fontWeight:700,color:"var(--gold)",letterSpacing:"0.05em",lineHeight:1}}>Quantum</div>
            <div style={{fontSize:8,color:"var(--muted)",letterSpacing:"0.22em",marginTop:4}}>GOLD · AI · V5</div>
          </div>

          {/* Nav links */}
          <nav style={{flex:1,paddingTop:8,overflowY:"auto"}}>
            {NAV.map(n=>(
              <div key={n.id} className={`nav-item${page===n.id?" active":""}`} onClick={()=>setPage(n.id)}>
                <span style={{fontSize:11,opacity:0.7}}>{n.icon}</span>
                <span style={{letterSpacing:"0.08em"}}>{n.label}</span>
              </div>
            ))}
          </nav>

          {/* Instrument tickers */}
          <div style={{borderTop:"1px solid var(--border)"}}>
            {INSTRUMENTS.map(inst=>{
              const ai=aiDecisions[inst.id],st=aiStatus[inst.id],d=delta(inst.id);
              return (
                <div key={inst.id} className={`ticker-row${selected===inst.id?" selected":""}`} onClick={()=>setSelected(inst.id)}
                  style={{padding:"10px 16px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <span style={{fontSize:9,letterSpacing:"0.1em",color:inst.color,fontWeight:500}}>{inst.label}</span>
                    <span style={{fontSize:9,color:st==='thinking'?"var(--amber)":st==='LONG'?"var(--green)":st==='SHORT'?"var(--red)":"var(--faint)"}}>
                      {st==='thinking'?"···":st||"—"}
                    </span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                    <span className="serif-num" style={{fontSize:15,color:"var(--text)"}}>{fmtPrice(inst.id,prices[inst.id])}</span>
                    {d!=null&&<span style={{fontSize:9,color:d>=0?"var(--green)":"var(--red)"}}>{d>=0?"▲":"▼"}{Math.abs(d).toFixed(inst.id==="GBPUSD"?4:2)}</span>}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                    {ai?.decision&&ai.decision!=='WAIT'?<span className={`badge badge-${ai.decision.toLowerCase()}`}>{ai.decision}</span>:<span style={{fontSize:9,color:"var(--faint)"}}>awaiting</span>}
                    <span style={{fontSize:8,color:marketStatus[inst.id]?.open?"var(--green)":"var(--faint)",letterSpacing:"0.06em"}}>{marketStatus[inst.id]?.open?"● OPEN":"○ CLOSED"}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Session indicator */}
          <div style={{padding:"10px 16px",borderTop:"1px solid var(--border)",display:"flex",alignItems:"center",gap:8}}>
            <span className="live-dot" style={{background:sessionInfo.tradingAllowed?"var(--green)":"var(--faint)",flexShrink:0}}/>
            <span style={{fontSize:9,color:"var(--muted)",letterSpacing:"0.1em"}}>{sessionInfo.session}</span>
          </div>
        </div>

        {/* ══ CONTENT ════════════════════════════════════════════════════ */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>

          {/* Top bar */}
          <div style={{background:"var(--surface0)",borderBottom:"1px solid var(--border)",padding:"0 24px",height:48,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div style={{display:"flex",gap:32}}>
              {[
                {l:"BALANCE",v:accountBalance!=null?`$${accountBalance.toFixed(0)}`:"—",c:"var(--gold)"},
                {l:"TODAY",v:`${todayPnl>=0?"+":""}$${todayPnl.toFixed(2)}`,c:todayPnl>=0?"var(--green)":"var(--red)"},
                {l:"TOTAL P&L",v:`${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`,c:totalPnl>=0?"var(--green)":"var(--red)"},
                {l:"WIN RATE",v:`${wr}%`,c:parseFloat(wr)>=55?"var(--green)":"var(--amber)"},
                {l:"DRAWDOWN",v:`${maxDD}%`,c:parseFloat(maxDD)>10?"var(--red)":"var(--muted)"},
                {l:"OPEN",v:openPositions.length,c:openPositions.length?"var(--amber)":"var(--muted)"},
              ].map(({l,v,c})=>(
                <div key={l} style={{display:"flex",flexDirection:"column",gap:2}}>
                  <span style={{fontSize:8,color:"var(--muted)",letterSpacing:"0.12em"}}>{l}</span>
                  <span className="serif-num" style={{fontSize:14,color:c}}>{v}</span>
                </div>
              ))}
            </div>
            {showBanner&&<div style={{fontSize:9,color:"var(--amber)",letterSpacing:"0.1em",display:"flex",alignItems:"center",gap:6}}>
              <span>⚠</span><span>{eventAlert.name}</span>
            </div>}
          </div>

          {/* Page content */}
          <div style={{flex:1,overflow:"auto",padding:24,background:"var(--bg)"}}>


            {/* ═══ DASHBOARD ═══════════════════════════════════════════ */}
            {page==="dashboard"&&(
              <div style={{display:"flex",flexDirection:"column",gap:16}}>

                {/* Row 1: 5 KPI blocks */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
                  {[
                    {l:"Today P&L",v:`${todayPnl>=0?"+":""}$${todayPnl.toFixed(2)}`,c:todayPnl>=0?"var(--green)":"var(--red)"},
                    {l:"Total Return",v:`${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`,c:totalPnl>=0?"var(--green)":"var(--red)"},
                    {l:"Win Rate",v:`${wr}%`,c:parseFloat(wr)>=55?"var(--green)":"var(--amber)"},
                    {l:"Max Drawdown",v:`${maxDD}%`,c:parseFloat(maxDD)>10?"var(--red)":"var(--muted)"},
                    {l:"Trades",v:closedTrades.length,c:"var(--blue)"},
                  ].map(({l,v,c})=>(
                    <div key={l} className="stat-box">
                      <div style={{fontSize:8,color:"var(--muted)",letterSpacing:"0.14em",marginBottom:8}}>{l.toUpperCase()}</div>
                      <div className="serif-num" style={{fontSize:28,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>

                {/* Row 2: Equity + drawdown chart */}
                <div className="panel" style={{padding:"18px 20px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div className="section-label">EQUITY CURVE</div>
                    <div style={{display:"flex",gap:20}}>
                      {[["PEAK","$"+(equityCurve.length?Math.max(...equityCurve.map(e=>e.val)).toFixed(2):"—"),"var(--green)"],
                        ["TROUGH","$"+(equityCurve.length?Math.min(...equityCurve.map(e=>e.val)).toFixed(2):"—"),"var(--red)"],
                        ["CURRENT","$"+(equityCurve.length?equityCurve[equityCurve.length-1].val.toFixed(2):"—"),"var(--text)"]].map(([k,v,c])=>(
                        <div key={k} style={{textAlign:"right"}}>
                          <div style={{fontSize:8,color:"var(--muted)",letterSpacing:"0.1em",marginBottom:1}}>{k}</div>
                          <div className="serif-num" style={{fontSize:13,color:c}}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <EquityChart data={equityCurve} w={900} h={150}/>
                  <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border)"}}>
                    <div className="section-label" style={{paddingBottom:8,fontSize:7}}>DRAWDOWN</div>
                    <DrawdownChart data={equityCurve} w={900} h={72}/>
                  </div>
                </div>

                {/* Row 3: Sessions + TP Chain */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1.6fr",gap:12}}>
                  <div className="panel" style={{padding:"18px 20px"}}>
                    <div className="section-label">SESSION PERFORMANCE</div>
                    <div style={{display:"flex",gap:10,justifyContent:"space-around"}}>
                      {['LONDON','NEW_YORK','OVERLAP'].map(s=>{
                        const sd=sess[s==='OVERLAP'?'LONDON_NY_OVERLAP':s]||{};
                        return <SessionRing key={s} label={s} wr={sd.winRate||0} trades={sd.trades||0} pnl={sd.pnl||0} color={sc(s)} active={sessionInfo.session===s||(s==='OVERLAP'&&sessionInfo.session==='LONDON_NY_OVERLAP')}/>;
                      })}
                    </div>
                  </div>
                  <div className="panel" style={{padding:"18px 20px"}}>
                    <div className="section-label">TP PROBABILITY CHAIN</div>
                    <TPChain tp1={an.tp1Pct||0} tp2={an.tp2Pct||0} tp3={an.tp3Pct||0} be={an.bePct||0}/>
                  </div>
                </div>

                {/* Row 4: Claude status + recent trades */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div className="panel" style={{padding:"18px 20px"}}>
                    <div className="section-label">AI STATUS</div>
                    {INSTRUMENTS.map((inst,i)=>{
                      const ai=aiDecisions[inst.id],st=aiStatus[inst.id];
                      return (
                        <div key={inst.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:i<INSTRUMENTS.length-1?"1px solid var(--border)":"none"}}>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            <span style={{fontSize:9,letterSpacing:"0.08em",color:inst.color}}>{inst.label}</span>
                            {ai?.decision&&<span className={`badge badge-${(ai.decision||'wait').toLowerCase()}`}>{ai.decision}</span>}
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            {ai?.confidence&&<div style={{width:60,height:3,background:"var(--faint)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${ai.confidence}%`,height:"100%",background:ai.confidence>=70?"var(--green)":"var(--amber)",borderRadius:2}}/></div>}
                            <span style={{fontSize:10,color:st==='thinking'?"var(--amber)":"var(--muted)"}}>{st==='thinking'?"···":ai?.confidence?`${ai.confidence}%`:"—"}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="panel" style={{padding:"18px 20px"}}>
                    <div className="section-label">RECENT TRADES</div>
                    {closedTrades.length===0?<div style={{color:"var(--faint)",fontSize:10,padding:"20px 0"}}>No trades recorded</div>
                      :closedTrades.slice(0,6).map((t,i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:i<5?"1px solid var(--border)":"none"}}>
                          <div style={{display:"flex",gap:10,alignItems:"center"}}>
                            <span style={{fontSize:9,letterSpacing:"0.06em",color:"var(--muted)"}}>{(t.symbol||'').replace('.s','')}</span>
                            <span style={{fontSize:9,color:t.type==='BUY'?"var(--green)":"var(--red)"}}>{t.type}</span>
                          </div>
                          <span className="serif-num" style={{fontSize:14,color:(t.profit||0)>=0?"var(--green)":"var(--red)"}}>{(t.profit||0)>=0?"+":""}${(t.profit||0).toFixed(2)}</span>
                        </div>
                      ))
                    }
                  </div>
                </div>
              </div>
            )}

            {/* ═══ POSITIONS ══════════════════════════════════════════ */}
            {page==="positions"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div className="panel" style={{padding:"18px 20px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                    <div className="section-label">OPEN POSITIONS ({openPositions.length})</div>
                    <button onClick={fetchPos} style={{background:"none",border:"1px solid var(--border)",color:"var(--muted)",padding:"4px 12px",borderRadius:1,cursor:"pointer",fontFamily:"var(--mono)",fontSize:9,letterSpacing:"0.1em"}}>REFRESH</button>
                  </div>
                  {openPositions.length===0?<div style={{color:"var(--faint)",fontSize:10,textAlign:"center",padding:"32px 0",letterSpacing:"0.1em"}}>NO OPEN POSITIONS</div>
                    :openPositions.map((pos,i)=>{
                      const tp=getTPData(pos),dir=pos.type==='POSITION_TYPE_BUY'?'LONG':'SHORT';
                      return (
                        <div key={i} className="panel-raised" style={{padding:"16px 20px",marginBottom:10,borderLeft:`2px solid ${dir==='LONG'?"var(--green)":"var(--red)"}`}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
                            <div style={{display:"flex",gap:12,alignItems:"center"}}>
                              <span style={{fontFamily:"var(--serif)",fontSize:17,fontWeight:700,color:"var(--text)"}}>{(pos.symbol||'').replace('.s','')}</span>
                              <span className={`badge badge-${dir.toLowerCase()}`}>{dir}</span>
                              <span style={{fontSize:9,color:"var(--muted)"}}>{pos.volume} lot</span>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{fontSize:8,letterSpacing:"0.1em",color:"var(--muted)",marginBottom:2}}>UNREALIZED P&L</div>
                              <span className="serif-num" style={{fontSize:22,color:(pos.profit||0)>=0?"var(--green)":"var(--red)"}}>{(pos.profit||0)>=0?"+":""}${(pos.profit||0).toFixed(2)}</span>
                            </div>
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
                            {[["ENTRY",pos.openPrice,"var(--muted)"],["CURRENT",pos.currentPrice,"var(--text)"],["STOP LOSS",tp?.sl,"var(--red)"]].map(([l,v,c])=>(
                              <div key={l} style={{background:"var(--surface0)",padding:"8px 10px",borderRadius:1}}>
                                <div style={{fontSize:8,letterSpacing:"0.12em",color:"var(--faint)",marginBottom:3}}>{l}</div>
                                <div className="serif-num" style={{fontSize:14,color:c}}>{v?.toFixed?.(2)||"—"}</div>
                              </div>
                            ))}
                          </div>
                          {tp&&(
                            <div>
                              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:10}}>
                                {[["TP 1 · 50%",tp.tp1,tp.tp1Hit,"var(--gold)"],["TP 2 · 30%",tp.tp2,tp.tp2Hit,"var(--blue)"],["TP 3 · 20%",tp.tp3,tp.tp3Hit,"var(--green)"]].map(([l,v,hit,c])=>(
                                  <div key={l} style={{background:hit?`color-mix(in srgb,${c} 8%,var(--surface0))`:"var(--surface0)",border:`1px solid ${hit?`color-mix(in srgb,${c} 30%,transparent)`:"var(--border)"}`,padding:"8px 10px",borderRadius:1,transition:"all 0.3s"}}>
                                    <div style={{fontSize:8,letterSpacing:"0.1em",color:hit?c:"var(--faint)",marginBottom:3}}>{l} {hit&&"✓"}</div>
                                    <div className="serif-num" style={{fontSize:14,color:hit?c:"var(--muted)"}}>{v?.toFixed?.(2)||"—"}</div>
                                  </div>
                                ))}
                              </div>
                              <div className="progress-track">
                                <div className="progress-fill" style={{width:`${tp.progress}%`}}/>
                              </div>
                              <div style={{display:"flex",justifyContent:"space-between",marginTop:3,fontSize:8,color:"var(--faint)"}}>
                                <span>ENTRY</span><span style={{color:"var(--gold)"}}>{tp.progress.toFixed(0)}% TO TP3</span><span>TP3</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  }
                </div>
                <div className="panel" style={{padding:"18px 20px"}}>
                  <div className="section-label">TRADE HISTORY</div>
                  <div className="tbl-row tbl-head" style={{gridTemplateColumns:"110px 60px 55px 90px 90px 80px"}}>
                    <span>INSTRUMENT</span><span>SIDE</span><span>SIZE</span><span>OPEN</span><span>CLOSE</span><span>P&L</span>
                  </div>
                  {closedTrades.length===0?<div style={{color:"var(--faint)",padding:"20px 0",fontSize:10,textAlign:"center"}}>No history</div>
                    :closedTrades.slice(0,60).map((t,i)=>(
                      <div key={i} className="tbl-row" style={{gridTemplateColumns:"110px 60px 55px 90px 90px 80px"}}>
                        <span style={{color:"var(--gold)",letterSpacing:"0.05em"}}>{(t.symbol||'').replace('.s','')}</span>
                        <span style={{color:t.type==='BUY'?"var(--green)":"var(--red)",fontSize:9}}>{t.type}</span>
                        <span style={{color:"var(--muted)"}}>{t.volume}</span>
                        <span style={{color:"var(--muted)"}}>{t.openPrice??'—'}</span>
                        <span style={{color:"var(--muted)"}}>{t.closePrice??'—'}</span>
                        <span className="serif-num" style={{fontSize:13,color:(t.profit||0)>=0?"var(--green)":"var(--red)"}}>{(t.profit||0)>=0?"+":""}${(t.profit||0).toFixed(2)}</span>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}

            {/* ═══ INTELLIGENCE ════════════════════════════════════════ */}
            {page==="intelligence"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div className="panel" style={{padding:"22px 24px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
                    <div>
                      <div style={{fontSize:8,letterSpacing:"0.18em",color:"var(--muted)",marginBottom:12}}>CLAUDE ANALYSIS — {selInst?.label}</div>
                      <div style={{fontFamily:"var(--serif)",fontSize:44,fontWeight:700,letterSpacing:"-0.02em",lineHeight:1,
                        color:selAI.decision==="LONG"?"var(--green)":selAI.decision==="SHORT"?"var(--red)":"var(--faint)"}}>
                        {aiStatus[selected]==='thinking'?<span style={{color:"var(--amber)"}}>Thinking…</span>:(selAI.decision||"Waiting")}
                      </div>
                      {selAI.marketRead&&<div style={{maxWidth:480,color:"var(--muted)",fontSize:11,marginTop:12,lineHeight:1.7}}>{selAI.marketRead}</div>}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:8,letterSpacing:"0.14em",color:"var(--muted)",marginBottom:6}}>CONFIDENCE</div>
                      <div className="serif-num" style={{fontSize:40,color:(selAI.confidence||0)>=75?"var(--green)":"var(--amber)"}}>{selAI.confidence||0}<span style={{fontSize:20}}>%</span></div>
                      <div style={{fontSize:9,letterSpacing:"0.1em",color:"var(--muted)",marginTop:4}}>RISK: <span style={{color:selAI.risk==='HIGH'?"var(--red)":selAI.risk==='LOW'?"var(--green)":"var(--amber)"}}>{selAI.risk||"—"}</span></div>
                    </div>
                  </div>
                  {selAI.reason&&(
                    <div style={{background:"var(--surface0)",borderLeft:"2px solid var(--blue)",padding:"12px 16px",marginBottom:16,borderRadius:1}}>
                      <div style={{fontSize:8,letterSpacing:"0.12em",color:"var(--muted)",marginBottom:6}}>REASONING</div>
                      <div style={{color:"var(--text)",fontSize:12,lineHeight:1.75}}>{selAI.reason}</div>
                    </div>
                  )}
                  {selAI.decision&&selAI.decision!=='WAIT'&&(
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
                      {[["ENTRY",prices[selected],"var(--blue)"],["STOP LOSS",selAI.stopLoss,"var(--red)"],["TARGET I",selAI.takeProfit1,"var(--gold)"],["TARGET II",selAI.takeProfit2,"var(--blue)"],["TARGET III",selAI.takeProfit3,"var(--green)"]].map(([l,v,c])=>(
                        <div key={l} style={{background:"var(--surface0)",padding:"12px 14px",borderRadius:1}}>
                          <div style={{fontSize:8,letterSpacing:"0.12em",color:"var(--muted)",marginBottom:5}}>{l}</div>
                          <div className="serif-num" style={{fontSize:16,color:c}}>{v?fmtPrice(selected,v):"—"}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {prevDecisions[selected]?.length>0&&(
                  <div className="panel" style={{padding:"18px 20px"}}>
                    <div className="section-label">DECISION HISTORY</div>
                    {[...(prevDecisions[selected]||[])].reverse().map((d,i)=>(
                      <div key={i} style={{background:"var(--surface0)",padding:"10px 14px",borderRadius:1,marginBottom:8,borderLeft:`2px solid ${d.outcome==='WIN'?"var(--green)":d.outcome==='LOSS'?"var(--red)":"var(--blue)"}`}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                          <span style={{fontSize:10,color:d.decision==='LONG'?"var(--green)":d.decision==='SHORT'?"var(--red)":"var(--muted)",letterSpacing:"0.05em"}}>
                            {d.decision} @ {d.price?.toFixed?.(d.price>100?2:4)||d.price}
                          </span>
                          <span style={{color:d.outcome==='WIN'?"var(--green)":d.outcome==='LOSS'?"var(--red)":"var(--muted)",fontSize:10}}>
                            {d.outcome?`${d.outcome}  ${d.pnl>=0?"+":""}$${d.pnl?.toFixed(2)}`:"pending"}
                          </span>
                        </div>
                        <div style={{color:"var(--faint)",fontSize:10}}>{d.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
                {Object.keys(learnedStats).length>0&&(
                  <div className="panel" style={{padding:"18px 20px"}}>
                    <div className="section-label">LEARNED PATTERNS — {Object.keys(learnedStats).length} FINGERPRINTS</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                      {Object.entries(learnedStats).filter(([,d])=>d.total>=2).sort((a,b)=>(b[1].winRate||0)-(a[1].winRate||0)).slice(0,9).map(([fp,data])=>{
                        const parts=fp.split(':'),wr=data.winRate||0,c=wr>=70?"var(--green)":wr>=50?"var(--amber)":"var(--red)";
                        return (
                          <div key={fp} style={{background:"var(--surface0)",padding:"12px 14px",borderRadius:1,borderTop:`1px solid ${wr>=70?"rgba(61,214,140,0.2)":wr>=50?"rgba(255,179,71,0.2)":"rgba(255,92,106,0.2)"}`}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                                <span style={{fontSize:9,letterSpacing:"0.06em",color:"var(--gold)"}}>{parts[0]}</span>
                                <span className={`badge badge-${(parts[1]||'wait').toLowerCase()}`}>{parts[1]}</span>
                              </div>
                              <span className="serif-num" style={{fontSize:16,color:c}}>{wr}%</span>
                            </div>
                            <div style={{display:"flex",gap:10,fontSize:9,color:"var(--muted)",marginBottom:6}}>
                              <span>✓ {data.wins}</span><span>✗ {data.losses}</span><span>Σ {data.total}</span>
                            </div>
                            <div style={{height:2,background:"var(--faint)",borderRadius:1}}><div style={{height:"100%",background:c,borderRadius:1,width:`${wr}%`,transition:"width 1.2s ease"}}/></div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ═══ SESSIONS ════════════════════════════════════════════ */}
            {page==="sessions"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
                  {['LONDON','NEW_YORK','LONDON_NY_OVERLAP'].map(s=>{
                    const sd=sess[s]||{},active=sessionInfo.session===s||(s==='LONDON_NY_OVERLAP'&&sessionInfo.session==='OVERLAP');
                    return (
                      <div key={s} className="panel" style={{padding:"20px",borderTop:`1px solid ${active?sc(s):"var(--border)"}`}}>
                        {active&&<div style={{position:"absolute",top:12,right:12,fontSize:8,color:sc(s),letterSpacing:"0.14em",background:`color-mix(in srgb,${sc(s)} 10%,transparent)`,padding:"2px 8px",borderRadius:1}}>ACTIVE</div>}
                        <div style={{display:"flex",justifyContent:"center",marginBottom:14}}>
                          <SessionRing label={s.replace('_NY_','+')} wr={sd.winRate||0} trades={sd.trades||0} pnl={sd.pnl||0} color={sc(s)} active={active}/>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                          {[["TP1",`${sd.tp1Pct||0}%`,"var(--gold)"],["TP2",`${sd.tp2Pct||0}%`,"var(--blue)"],["TP3",`${sd.tp3Pct||0}%`,"var(--green)"]].map(([l,v,c])=>(
                            <div key={l} style={{background:"var(--surface0)",padding:"8px",textAlign:"center",borderRadius:1}}>
                              <div style={{fontSize:8,color:"var(--muted)",marginBottom:3,letterSpacing:"0.08em"}}>{l}</div>
                              <div className="serif-num" style={{fontSize:14,color:c}}>{v}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
                  {[["TODAY",an.daily||{}],["THIS WEEK",an.weekly||{}],["THIS MONTH",an.monthly||{}]].map(([l,d])=>(
                    <div key={l} className="panel" style={{padding:"18px 20px"}}>
                      <div className="section-label">{l}</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {[["Trades",d.total||0,"var(--text)"],["Win Rate",`${d.winRate||0}%`,d.winRate>=55?"var(--green)":"var(--amber)"],
                          ["P&L",`${(d.pnl||0)>=0?"+":""}$${(d.pnl||0).toFixed(0)}`,(d.pnl||0)>=0?"var(--green)":"var(--red)"],
                          ["Losses",d.losses||0,d.losses?"var(--red)":"var(--muted)"]].map(([lbl,v,c])=>(
                          <div key={lbl} style={{background:"var(--surface0)",padding:"10px",borderRadius:1}}>
                            <div style={{fontSize:8,color:"var(--muted)",letterSpacing:"0.1em",marginBottom:4}}>{lbl.toUpperCase()}</div>
                            <div className="serif-num" style={{fontSize:18,color:c}}>{v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ═══ ANALYTICS ═══════════════════════════════════════════ */}
            {page==="analytics"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
                  {[["TOTAL TRADES",an.totalTrades||0,"var(--blue)"],["NET P&L",`$${(an.totalPnl||0).toFixed(2)}`,(an.totalPnl||0)>=0?"var(--green)":"var(--red)"],["AVERAGE P&L",`$${(an.avgPnl||0).toFixed(2)}`,"var(--amber)"],["SL HITS",an.slHitCount||0,"var(--red)"]].map(([l,v,c])=>(
                    <div key={l} className="stat-box">
                      <div style={{fontSize:8,letterSpacing:"0.14em",color:"var(--muted)",marginBottom:8}}>{l}</div>
                      <div className="serif-num" style={{fontSize:26,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
                <div className="panel" style={{padding:"20px 22px"}}>
                  <div className="section-label">TP CHAIN PERFORMANCE</div>
                  <TPChain tp1={an.tp1Pct||0} tp2={an.tp2Pct||0} tp3={an.tp3Pct||0} be={an.bePct||0}/>
                </div>
                <div className="panel" style={{padding:"18px 20px"}}>
                  <div className="section-label">TRADE REPORTS</div>
                  {(!tradeReports.reports||!tradeReports.reports.length)?<div style={{color:"var(--faint)",padding:"20px 0",fontSize:10,textAlign:"center",letterSpacing:"0.1em"}}>REPORTS APPEAR AFTER TP HITS</div>
                    :tradeReports.reports.map((r,i)=>(
                      <div key={i} style={{background:"var(--surface0)",padding:"12px 16px",borderRadius:1,marginBottom:8,borderLeft:`2px solid ${r.finalExit==='FULL_CLOSE_TP3'?"var(--green)":r.finalExit==='SL_HIT'?"var(--red)":"var(--gold)"}`}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                          <div style={{display:"flex",gap:10,alignItems:"center"}}>
                            <span style={{fontSize:11,letterSpacing:"0.04em",color:"var(--text)"}}>{(r.symbol||'').replace('.s','')}</span>
                            <span className={`badge badge-${(r.direction||'wait').toLowerCase()}`}>{r.direction}</span>
                            <span style={{fontSize:9,color:sc(r.session||'')}}>{r.session}</span>
                          </div>
                          <span className="serif-num" style={{fontSize:16,color:(r.totalPnl||0)>=0?"var(--green)":"var(--red)"}}>{(r.totalPnl||0)>=0?"+":""}${(r.totalPnl||0).toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          {r.tp1Hit&&<span className="badge" style={{background:"rgba(212,175,106,0.08)",color:"var(--gold)",border:"1px solid rgba(212,175,106,0.15)"}}>TP1 ✓</span>}
                          {r.tp2Hit&&<span className="badge" style={{background:"rgba(91,168,255,0.08)",color:"var(--blue)",border:"1px solid rgba(91,168,255,0.15)"}}>TP2 ✓</span>}
                          {r.tp3Hit&&<span className="badge" style={{background:"rgba(61,214,140,0.08)",color:"var(--green)",border:"1px solid rgba(61,214,140,0.15)"}}>TP3 ✓</span>}
                          {r.beMoved&&<span className="badge" style={{background:"rgba(74,102,128,0.08)",color:"var(--muted)",border:"1px solid rgba(74,102,128,0.15)"}}>BE ✓</span>}
                          {r.finalExit==='SL_HIT'&&<span className="badge" style={{background:"rgba(255,92,106,0.08)",color:"var(--red)",border:"1px solid rgba(255,92,106,0.15)"}}>SL</span>}
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}

            {/* ═══ JOURNAL ═════════════════════════════════════════════ */}
            {page==="journal"&&(
              <div className="panel" style={{padding:"20px 22px"}}>
                <div className="section-label">TRADE JOURNAL — {closedTrades.length} ENTRIES</div>
                <div className="tbl-row tbl-head" style={{gridTemplateColumns:"110px 60px 55px 90px 90px 100px 80px"}}>
                  <span>INSTRUMENT</span><span>SIDE</span><span>SIZE</span><span>OPEN</span><span>CLOSE</span><span>TIME</span><span>P&L</span>
                </div>
                {closedTrades.length===0?<div style={{color:"var(--faint)",padding:"24px 0",fontSize:10,textAlign:"center",letterSpacing:"0.1em"}}>NO ENTRIES</div>
                  :closedTrades.slice(0,100).map((t,i)=>(
                    <div key={i} className="tbl-row" style={{gridTemplateColumns:"110px 60px 55px 90px 90px 100px 80px"}}>
                      <span style={{color:"var(--gold)",letterSpacing:"0.04em"}}>{(t.symbol||'').replace('.s','')}</span>
                      <span style={{color:t.type==='BUY'?"var(--green)":"var(--red)",fontSize:9}}>{t.type}</span>
                      <span style={{color:"var(--muted)"}}>{t.volume}</span>
                      <span style={{color:"var(--muted)",fontSize:10}}>{t.openPrice??'—'}</span>
                      <span style={{color:"var(--muted)",fontSize:10}}>{t.closePrice??'—'}</span>
                      <span style={{color:"var(--faint)",fontSize:9}}>{t.time?new Date(t.time).toLocaleTimeString():"—"}</span>
                      <span className="serif-num" style={{fontSize:13,color:(t.profit||0)>=0?"var(--green)":"var(--red)"}}>{(t.profit||0)>=0?"+":""}${(t.profit||0).toFixed(2)}</span>
                    </div>
                  ))
                }
              </div>
            )}

            {/* ═══ MARKET ══════════════════════════════════════════════ */}
            {page==="market"&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div className="panel" style={{padding:"18px 20px"}}>
                  <div className="section-label">NEWS FEED</div>
                  {news.length===0?<div style={{color:"var(--faint)",padding:"20px 0",fontSize:10}}>Loading…</div>
                    :news.map((a,i)=>(
                      <div key={i} style={{padding:"11px 0",borderBottom:"1px solid var(--border)"}}>
                        <div style={{color:"var(--text)",fontSize:11,lineHeight:1.5,marginBottom:3}}>{a.title}</div>
                        <div style={{fontSize:8,color:"var(--faint)",letterSpacing:"0.08em"}}>{a.source}</div>
                      </div>
                    ))
                  }
                </div>
                <div className="panel" style={{padding:"18px 20px"}}>
                  <div className="section-label">ECONOMIC CALENDAR</div>
                  {calEvents.length===0?<div style={{color:"var(--faint)",padding:"20px 0",fontSize:10}}>Loading…</div>
                    :calEvents.map((ev,i)=>{
                      const evDate=new Date(ev.date),isToday=evDate.toDateString()===new Date().toDateString();
                      return (
                        <div key={i} style={{padding:"10px 0",borderBottom:"1px solid var(--border)",borderLeft:isToday?"2px solid var(--red)":"none",paddingLeft:isToday?10:0}}>
                          <div style={{fontSize:11,color:isToday?"var(--red)":"var(--text)",marginBottom:3,fontWeight:isToday?500:400}}>{ev.name}</div>
                          <div style={{display:"flex",justifyContent:"space-between"}}>
                            <span style={{fontSize:8,color:"var(--faint)",letterSpacing:"0.06em"}}>{evDate.toLocaleTimeString()} · {ev.country}</span>
                            {ev.forecast&&<span style={{fontSize:9,color:"var(--amber)"}}>{ev.forecast}</span>}
                          </div>
                        </div>
                      );
                    })
                  }
                </div>
              </div>
            )}

          </div>{/* end page content */}
        </div>{/* end right column */}

        {/* ══ LOG STRIP ═══════════════════════════════════════════════════ */}
        <div style={{width:200,background:"var(--surface0)",borderLeft:"1px solid var(--border)",display:"flex",flexDirection:"column",flexShrink:0}}>
          <div style={{padding:"12px 14px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:8,letterSpacing:"0.14em",color:"var(--muted)"}}>SYSTEM LOG</span>
            <button onClick={()=>setLog([])} style={{background:"none",border:"none",color:"var(--faint)",cursor:"pointer",fontSize:9}}>CLR</button>
          </div>
          <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"6px 10px"}}>
            {log.map((e,i)=>(
              <div key={i} style={{padding:"2px 0",borderBottom:"1px solid rgba(255,255,255,0.02)",marginBottom:2}}>
                <span style={{fontSize:8,color:"var(--faint)",marginRight:5}}>{e.time}</span>
                <span style={{fontSize:9,lineHeight:1.4,color:e.type==="signal"?"var(--blue)":e.type==="error"?"var(--red)":e.type==="warn"?"var(--amber)":e.type==="success"?"var(--green)":"var(--faint)"}}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>

      </div>{/* end flex */}
    </>
  );
}