import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  ComposedChart, AreaChart, BarChart,
  Line, Area, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

// ─────────────────────────────────────────────
// SYMBOL UNIVERSE
// ─────────────────────────────────────────────
const SYMBOL_UNIVERSE = [
  { sym:"AAPL",  base:185,  sector:"Tech" },
  { sym:"TSLA",  base:220,  sector:"Auto" },
  { sym:"NVDA",  base:480,  sector:"Tech" },
  { sym:"MSFT",  base:380,  sector:"Tech" },
  { sym:"AMZN",  base:175,  sector:"Retail" },
  { sym:"META",  base:490,  sector:"Tech" },
  { sym:"GOOGL", base:140,  sector:"Tech" },
  { sym:"SPY",   base:450,  sector:"ETF" },
  { sym:"JPM",   base:195,  sector:"Finance" },
  { sym:"AMD",   base:165,  sector:"Tech" },
  { sym:"TQQQ",  base:65,   sector:"Leveraged" }, // 3× Long Nasdaq
  { sym:"SQQQ",  base:12,   sector:"Leveraged" }, // 3× Short Nasdaq
];
const DEFAULT_WATCHLIST = ["AAPL","TSLA","NVDA","MSFT","AMZN","SPY"];

// Leveraged ETFs need wider stops due to 3× daily volatility
const LEVERAGED_SYMS = new Set(["TQQQ","SQQQ"]);
// SL/TP multipliers for leveraged symbols vs standard settings
const LEV_SL_MULT   = 2.0;  // e.g. 2% SL → 4% for leveraged
const LEV_TRAIL_MULT= 1.5;  // e.g. 4% trail → 6% for leveraged
const LEV_ACTIV_MULT= 1.5;  // e.g. 3% activation → 4.5% for leveraged
const LEV_SIZE_MULT = 0.5;  // half position size to compensate for wider stops
const BASE_PX = Object.fromEntries(SYMBOL_UNIVERSE.map(s=>[s.sym,s.base]));

const INIT_CAP  = 10000;
const SEED_N    = 130;
const SIM_TICK  = 1800;    // ms between sim ticks
const LIVE_TICK = 300000;  // ms between live data refreshes (5 min)

// Drop your Twelve Data API key here so it's pre-filled on load.
// (Visible to anyone who views this app's source — fine for a personal/private deploy,
// but don't share this file publicly with your key still in it.)
const DEFAULT_API_KEY = "7864cdf4bef5481d919d0fb2b9293770";

const STORAGE_KEY = "autotrader_pro_state_v1";

// ─────────────────────────────────────────────
// TWELVE DATA API  (free tier — one key only)
// ─────────────────────────────────────────────
async function tdFetch(symbols, interval, outputsize, key) {
  const params = new URLSearchParams({
    symbol: symbols.join(","),
    interval,
    outputsize,
    apikey: key,
    order: "ASC",
  });
  let res;
  try {
    res = await fetch(`https://api.twelvedata.com/time_series?${params}`);
  } catch {
    throw new Error("Network error — check your internet connection.");
  }
  if (!res.ok) {
    let msg = "";
    try { const j = await res.json(); msg = j.message || ""; } catch {}
    throw new Error(msg || (res.status === 403 ? "API key unauthorized — check your key and plan limits." : res.status === 429 ? "Rate limit hit — wait a minute and try again." : `HTTP ${res.status} — check your API key`));
  }
  const data = await res.json();
  if (data.status === "error") throw new Error(data.message || "API error — check your key");
  return data;
}

// Parse a Twelve Data bar → internal candle format
function tdBar(b) {
  return {
    o: +parseFloat(b.open).toFixed(3),
    h: +parseFloat(b.high).toFixed(3),
    l: +parseFloat(b.low).toFixed(3),
    c: +parseFloat(b.close).toFixed(3),
    v: parseInt(b.volume) || 0,
    t: b.datetime,
  };
}

// Extract values array for a symbol from Twelve Data response
function tdValues(data, sym, isSingle) {
  return isSingle ? data?.values : data?.[sym]?.values;
}

function barToCandle(b) {
  return {
    o: +parseFloat(b.o).toFixed(3),
    h: +parseFloat(b.h).toFixed(3),
    l: +parseFloat(b.l).toFixed(3),
    c: +parseFloat(b.c).toFixed(3),
    v: b.v || 0,
    t: b.t,
  };
}

// ─────────────────────────────────────────────
// PRICE SIMULATION  (fallback / sim mode)
// ─────────────────────────────────────────────
function seedCandles(n, p0) {
  const cs=[]; let p=p0, mom=0;
  for(let i=0;i<n;i++){
    mom=mom*0.55+(Math.random()-0.5)*0.011;
    const chg=mom+(p0-p)/p0*0.009;
    const o=p,c=Math.max(0.01,p*(1+chg));
    const hi=Math.max(o,c)*(1+Math.random()*0.006),lo=Math.min(o,c)*(1-Math.random()*0.006);
    cs.push({o:+o.toFixed(3),h:+hi.toFixed(3),l:+lo.toFixed(3),c:+c.toFixed(3),v:~~(800+Math.random()*9200)});
    p=c;
  }
  return cs;
}
function nextCandle(prevC,base){
  const chg=(base-prevC)/base*0.009+(Math.random()-0.5)*0.017;
  const o=prevC,c=Math.max(0.01,o*(1+chg));
  const hi=Math.max(o,c)*(1+Math.random()*0.007),lo=Math.min(o,c)*(1-Math.random()*0.007);
  return {o:+o.toFixed(3),h:+hi.toFixed(3),l:+lo.toFixed(3),c:+c.toFixed(3),v:~~(500+Math.random()*9500)};
}

// ─────────────────────────────────────────────
// INDICATORS
// ─────────────────────────────────────────────
const emaOf=(arr,p)=>{const k=2/(p+1);return arr.reduce((acc,v,i)=>(acc.push(i?v*k+acc[i-1]*(1-k):v),acc),[]);};
const rsiOf=(cs,p=14)=>{
  if(cs.length<=p)return cs.map(()=>50);
  const out=Array(p).fill(50);let G=0,L=0;
  for(let i=1;i<=p;i++){const d=cs[i]-cs[i-1];d>0?G+=d:L-=d;}
  G/=p;L/=p;out.push(L===0?100:100-100/(1+G/L));
  for(let i=p+1;i<cs.length;i++){const d=cs[i]-cs[i-1];G=((p-1)*G+(d>0?d:0))/p;L=((p-1)*L+(d<0?-d:0))/p;out.push(L===0?100:100-100/(1+G/L));}
  return out;
};
const macdOf=cs=>{const e12=emaOf(cs,12),e26=emaOf(cs,26),m=e12.map((v,i)=>v-e26[i]),sig=emaOf(m,9);return{line:m,signal:sig,hist:m.map((v,i)=>v-sig[i])};};
const bbOf=(cs,p=20,k=2)=>cs.map((_,i)=>{const sl=cs.slice(Math.max(0,i-p+1),i+1),mean=sl.reduce((a,b)=>a+b,0)/sl.length,sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mean)**2,0)/sl.length);return{u:mean+k*sd,m:mean,l:mean-k*sd};});
const atrOf=(cs,p=14)=>emaOf(cs.map((c,i)=>i===0?c.h-c.l:Math.max(c.h-c.l,Math.abs(c.h-cs[i-1].c),Math.abs(c.l-cs[i-1].c))),p);

function adxOf(candles,period=14){
  const n=candles.length,fb=Array(n).fill(20);
  if(n<period*2+2)return fb;
  const tr=[],pdm=[],mdm=[];
  for(let i=1;i<n;i++){const c=candles[i],p=candles[i-1];tr.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)));const up=c.h-p.h,dn=p.l-c.l;pdm.push(up>dn&&up>0?up:0);mdm.push(dn>up&&dn>0?dn:0);}
  const wS=(arr,p)=>{if(arr.length<p)return Array(arr.length).fill(0);const out=[];let s=arr.slice(0,p).reduce((a,b)=>a+b,0);for(let i=p;i<arr.length;i++){s=s-s/p+arr[i];out.push(s);}return out;};
  const sTR=wS(tr,period),sPDM=wS(pdm,period),sMDM=wS(mdm,period);
  const dx=sTR.map((t,i)=>{const pdi=t>0?100*sPDM[i]/t:0,mdi=t>0?100*sMDM[i]/t:0,sum=pdi+mdi;return sum>0?100*Math.abs(pdi-mdi)/sum:0;});
  if(dx.length<period)return fb;
  let av=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const ar=[av];for(let i=period;i<dx.length;i++){av=(av*(period-1)+dx[i])/period;ar.push(av);}
  return [...Array(n-ar.length).fill(20),...ar];
}

function computeInd(candles){
  const cs=candles.map(c=>c.c),vols=candles.map(c=>c.v);
  const volSMA=vols.map((_,i)=>{const sl=vols.slice(Math.max(0,i-19),i+1);return sl.reduce((a,b)=>a+b,0)/sl.length;});
  return{e9:emaOf(cs,9),e21:emaOf(cs,21),e50:emaOf(cs,50),rsi:rsiOf(cs,14),macd:macdOf(cs),bb:bbOf(cs,20,2),atr:atrOf(candles,14),adx:adxOf(candles,14),vols,volSMA};
}

// ─────────────────────────────────────────────
// SIGNAL ENGINE
// ─────────────────────────────────────────────
const SCORE_MAX=3.8;
const MIN_STR={Weak:12,Moderate:28,Strong:45,"Very Strong":62};

function computeSignal(candles,ind,strat){
  const n=candles.length-1;
  if(n<55)return{dir:null,strength:0,label:"Weak",reasons:[],bull:0,bear:0,price:candles[n]?.c||0,adx:20,volRatio:1};
  const{e9,e21,e50,rsi,macd,bb,adx,vols,volSMA}=ind;
  const cn=candles[n],cp=candles[n-1],px=cn.c,ppx=cp.c;
  let bull=0,bear=0,reasons=[];
  const adxVal=adx[n]||20,volRatio=(vols[n]||1)/(volSMA[n]||1);
  const adxOk=!strat.filters.adxEnabled||adxVal>=strat.filters.adxMin;

  if(strat.mom.on){
    const w=strat.mom.w,r=rsi[n];
    if(r<strat.mom.oversold){bull+=w*.5;reasons.push(`RSI Oversold (${~~r})`);}
    else if(r>strat.mom.overbought){bear+=w*.5;reasons.push(`RSI Overbought (${~~r})`);}
    if(macd.hist[n]>0&&macd.hist[n-1]<=0){bull+=w*.5;reasons.push("MACD Bull Cross");}
    else if(macd.hist[n]<0&&macd.hist[n-1]>=0){bear+=w*.5;reasons.push("MACD Bear Cross");}
    else macd.hist[n]>0?bull+=w*.2:bear+=w*.2;
  }
  if(strat.trend.on){
    const w=strat.trend.w*(adxOk?1:0.35);
    if(e9[n]>e21[n]&&e21[n]>e50[n]){bull+=w*.6;reasons.push(`Bullish EMA Stack${!adxOk?" (weak)":""}`);}
    else if(e9[n]<e21[n]&&e21[n]<e50[n]){bear+=w*.6;reasons.push(`Bearish EMA Stack${!adxOk?" (weak)":""}`);}
    px>e50[n]?bull+=w*.25:bear+=w*.25;
    if(e9[n]>e21[n]&&e9[n-1]<=e21[n-1]){bull+=w*.45;reasons.push("Golden Cross 9/21");}
    else if(e9[n]<e21[n]&&e9[n-1]>=e21[n-1]){bear+=w*.45;reasons.push("Death Cross 9/21");}
    if(adxOk&&adxVal>=25&&bull>bear)reasons.push(`ADX ${~~adxVal} ✓`);
  }
  if(strat.pa.on){
    const w=strat.pa.w;
    if(px<bb[n].l&&px>ppx){bull+=w*.4;reasons.push("BB Lower Bounce");}
    if(px>bb[n].u&&px<ppx){bear+=w*.4;reasons.push("BB Upper Reject");}
    const body=Math.abs(cn.c-cn.o),lw=Math.min(cn.o,cn.c)-cn.l,uw=cn.h-Math.max(cn.o,cn.c),pb=Math.abs(cp.c-cp.o);
    if(lw>body*2&&uw<body*.5&&cn.c>cn.o){bull+=w*.35;reasons.push("Hammer");}
    if(uw>body*2&&lw<body*.5&&cn.c<cn.o){bear+=w*.35;reasons.push("Shooting Star");}
    if(cn.c>cn.o&&cn.c>=cp.o&&cn.o<=cp.c&&body>pb*.7){bull+=w*.28;reasons.push("Bull Engulfing");}
    if(cn.c<cn.o&&cn.c<=cp.o&&cn.o>=cp.c&&body>pb*.7){bear+=w*.28;reasons.push("Bear Engulfing");}
  }
  const volBoost=strat.filters.volEnabled?(volRatio>=strat.filters.volMult?1.25:volRatio<0.7?0.7:1):1;
  if(strat.filters.volEnabled&&volRatio>=strat.filters.volMult)reasons.push(`Vol ${(volRatio*100).toFixed(0)}% avg ✓`);
  const strength=Math.min(100,(Math.abs(bull-bear)/SCORE_MAX)*100*volBoost);
  const label=strength<20?"Weak":strength<38?"Moderate":strength<60?"Strong":"Very Strong";
  return{dir:strength<12?null:(bull-bear)>0?"BUY":"SELL",strength,label,reasons,bull,bear,price:px,adx:adxVal,volRatio};
}

function sizePos(capital,price,rp,mult=1){
  const rA=capital*rp.riskPct/100*mult,sD=price*rp.slPct/100;
  return Math.max(1,Math.min(sD>0?~~(rA/sD):0,~~(capital*rp.maxPos/100/price*mult)));
}

// ─────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────
const T={bg:"#04060f",surface:"#0b0f1e",card:"#0f1629",border:"#1a2035",G:"#00d4aa",R:"#ff4d6d",B:"#4f8fff",P:"#a78bfa",Y:"#fbbf24",O:"#fb923c",GR:"#2a3555",text:"#e2e8f0",muted:"#64748b",dim:"#2a3555"};
const SECTOR_COL={Tech:T.B,Finance:T.G,Retail:T.Y,Auto:T.P,ETF:"#94a3b8",Leveraged:T.O};

// ─────────────────────────────────────────────
// MICRO COMPONENTS
// ─────────────────────────────────────────────
const Card=({children,style={},glow})=>(<div style={{background:T.card,border:`1px solid ${glow?glow+"44":T.border}`,borderRadius:12,padding:14,boxShadow:glow?`0 0 20px ${glow}18`:"none",...style}}>{children}</div>);
const Lbl=({children,style={}})=>(<div style={{fontSize:10,color:T.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,fontWeight:700,...style}}>{children}</div>);
function Toggle({on,onChange}){return(<div onClick={()=>onChange(!on)} style={{width:38,height:21,borderRadius:11,background:on?T.G:T.GR,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}><div style={{position:"absolute",top:2.5,left:on?18:2.5,width:16,height:16,borderRadius:"50%",background:"white",transition:"left .2s"}}/></div>);}
function Slider({label,value,min,max,step=1,onChange,fmt}){return(<div style={{marginBottom:16}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:12,color:"#94a3b8"}}>{label}</span><span style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"monospace"}}>{fmt?fmt(value):value}</span></div><input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(+e.target.value)} style={{width:"100%",accentColor:T.B,cursor:"pointer"}}/></div>);}
function StrBadge({lbl}){const col={Weak:T.GR,Moderate:T.Y,Strong:T.B,"Very Strong":T.G}[lbl]??T.GR;return <span style={{background:col+"22",color:col,border:`1px solid ${col}44`,fontSize:9,fontWeight:800,padding:"2px 7px",borderRadius:4}}>{lbl?.toUpperCase()}</span>;}
function DirChip({dir}){if(!dir)return<span style={{color:T.muted,fontSize:11}}>—</span>;const b=dir==="BUY";return<span style={{background:b?`${T.G}15`:`${T.R}15`,color:b?T.G:T.R,border:`1px solid ${b?T.G:T.R}55`,fontSize:11,fontWeight:800,padding:"3px 9px",borderRadius:5}}>{b?"▲ BUY":"▼ SELL"}</span>;}
function MiniBar({strength,dir}){const col=dir==="BUY"?T.G:dir==="SELL"?T.R:T.muted;return<div style={{height:4,background:T.dim,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${strength||0}%`,background:`linear-gradient(90deg,${col}55,${col})`,borderRadius:2,transition:"width .5s"}}/></div>;}
function ADXPill({val}){const col=val>=30?T.G:val>=20?T.Y:T.R,lbl=val>=30?"Trending":val>=20?"Moderate":"Choppy";return<span style={{background:col+"18",color:col,border:`1px solid ${col}44`,fontSize:9,fontWeight:800,padding:"2px 7px",borderRadius:4}}>ADX {~~val} {lbl}</span>;}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
function initSymbols(){return Object.fromEntries(SYMBOL_UNIVERSE.map(({sym,base})=>[sym,{candles:seedCandles(SEED_N,base)}]));}

// ── Persistence: save/restore trading state across refreshes ──
function loadPersisted(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return null;
    return JSON.parse(raw);
  }catch{return null;}
}
function savePersisted(payload){
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(payload));}catch{}
}

export default function AutoTraderPro(){
  const persisted = loadPersisted();

  const ts=useRef(persisted?.ts ?? {symbols:initSymbols(),watchlist:[...DEFAULT_WATCHLIST],capital:INIT_CAP,open:[],closed:[],signals:[],dailyPnL:0,portHist:[{v:INIT_CAP}],n:0});

  const [strat,setStrat]=useState(persisted?.strat ?? {mom:{on:true,w:1,oversold:35,overbought:65},trend:{on:true,w:1},pa:{on:true,w:1},filters:{adxEnabled:true,adxMin:20,volEnabled:true,volMult:1.2}});
  const [rp,setRp]=useState(persisted?.rp ?? {maxPos:20,riskPct:1,slPct:2,tpRatio:2,maxOpen:5,maxDailyLoss:5,minStr:"Moderate",trailEnabled:true,trailActivation:3,lockInPct:1,trailPct:4,partialTP:true,partialPct:50,pyramidEnabled:true,pyramidTrigger:3,pyramidSize:50});

  // Live data state
  const [dataMode,setDataMode]=useState(persisted?.dataMode ?? "sim");
  const [apiKey,setApiKey]=useState(persisted?.apiKey || DEFAULT_API_KEY);
  const [tf,setTf]=useState(persisted?.tf ?? "5min");
  const [connected,setConnected]=useState(false); // re-verified on mount below
  const [connecting,setConnecting]=useState(false);
  const [connErr,setConnErr]=useState("");
  const [lastRefresh,setLastRefresh]=useState(persisted?.lastRefresh ? new Date(persisted.lastRefresh) : null);
  const [mktStatus,setMktStatus]=useState("");

  const [running,setRunning]=useState(persisted?.running ?? false);
  const [liveOnlyMode,setLiveOnlyMode]=useState(persisted?.liveOnlyMode ?? true); // when true, NEVER fall back to sim
  const [liveBlocked,setLiveBlocked]=useState(false); // true when live fetch failed and liveOnly is on
  const [reconnecting,setReconnecting]=useState(persisted?.dataMode==="live");
  const [tab,setTab]=useState("scanner");
  const [selSym,setSelSym]=useState("AAPL");
  const [wlOpen,setWlOpen]=useState(false);
  const [tick,bump]=useState(0);
  const [scannerSigs,setScannerSigs]=useState({});
  const [restored]=useState(!!persisted);

  const sRef=useRef(strat); useEffect(()=>{sRef.current=strat;},[strat]);
  const rRef=useRef(rp);    useEffect(()=>{rRef.current=rp;},[rp]);
  const dataModeRef=useRef(dataMode); useEffect(()=>{dataModeRef.current=dataMode;},[dataMode]);
  const connRef=useRef(connected);    useEffect(()=>{connRef.current=connected;},[connected]);
  const keyRef=useRef(apiKey);        useEffect(()=>{keyRef.current=apiKey;},[apiKey]);
  const tfRef=useRef(tf);             useEffect(()=>{tfRef.current=tf;},[tf]);
  const liveOnlyRef=useRef(liveOnlyMode); useEffect(()=>{liveOnlyRef.current=liveOnlyMode;},[liveOnlyMode]);
  const tickLock=useRef(false);

  // ── Connect to Twelve Data ──────────────────
  async function connectLive(keyOverride?, tfOverride?, silent?){
    const k=keyOverride||apiKey, useTf=tfOverride||tf;
    if(!k){if(!silent)setConnErr("Please enter your API key.");return false;}
    if(!silent)setConnecting(true);
    if(!silent)setConnErr("");
    try{
      const wl=ts.current.watchlist;
      const data=await tdFetch(wl,useTf,200,k);
      const isSingle=wl.length===1;
      let loaded=0;
      for(const sym of wl){
        const vals=tdValues(data,sym,isSingle);
        if(vals&&vals.length>0){ts.current.symbols[sym].candles=vals.map(tdBar);loaded++;}
      }
      if(loaded===0)throw new Error("No data returned. Check your API key and try again.");
      setConnected(true);setDataMode("live");setConnErr("");setLiveBlocked(false);
      setLastRefresh(new Date());setMktStatus("open");
      if(!silent)setTab("scanner");
      bump(n=>n+1);
      return true;
    }catch(err){
      if(!silent)setConnErr(err.message||"Connection failed. Check your key and try again.");
      else{
        // Silent reconnect on mount failed — if liveOnly, freeze don't sim
        setConnected(false);
        if(liveOnlyRef.current){setLiveBlocked(true);}
        else{setDataMode("sim");}
      }
      return false;
    }finally{
      if(!silent)setConnecting(false);
      setReconnecting(false);
    }
  }

  function disconnect(){setConnected(false);setDataMode("sim");setMktStatus("");setLiveBlocked(false);setReconnecting(false);}

  // ── On mount: restore live connection, freeze ticks until confirmed ──
  const didInit=useRef(false);
  useEffect(()=>{
    if(didInit.current)return;
    didInit.current=true;
    if(persisted?.dataMode==="live"&&(persisted?.apiKey||DEFAULT_API_KEY)){
      connectLive(persisted.apiKey||DEFAULT_API_KEY,persisted.tf,true);
    } else {
      setReconnecting(false);
    }
  },[]);

  // ── Persist state on every change ──
  useEffect(()=>{
    const id=setInterval(()=>{
      savePersisted({
        ts:ts.current, strat, rp, dataMode, apiKey, tf, running, liveOnlyMode,
        lastRefresh:lastRefresh?lastRefresh.toISOString():null,
      });
    },4000);
    return()=>clearInterval(id);
  },[strat,rp,dataMode,apiKey,tf,running,liveOnlyMode,lastRefresh]);

  // ── Main tick ───────────────────────────────
  const doTick=useCallback(async()=>{
    if(tickLock.current)return;
    tickLock.current=true;
    try{
      const s=ts.current,r=rRef.current,st=sRef.current;
      s.n++;

      // ── Advance candles ──
      if(dataModeRef.current==="live"&&connRef.current){
        try{
          const wl=s.watchlist,isSingle=wl.length===1;
          const data=await tdFetch(wl,tfRef.current,3,keyRef.current);
          let gotNew=false;
          for(const sym of wl){
            const vals=tdValues(data,sym,isSingle);
            if(vals&&vals.length>0){
              const nc=tdBar(vals[vals.length-1]);
              const prev=s.symbols[sym].candles[s.symbols[sym].candles.length-1];
              if(!prev.t||prev.t!==nc.t){s.symbols[sym].candles=[...s.symbols[sym].candles.slice(-199),nc];gotNew=true;}
            }
          }
          if(gotNew)setLastRefresh(new Date());
          setMktStatus(gotNew?"open":"closed");
        }catch(err){
          console.warn("Live fetch failed:",err.message);
          if(liveOnlyRef.current){
            // Live Only mode — freeze completely, do not inject sim candles
            setLiveBlocked(true);
            setMktStatus("closed");
            tickLock.current=false;
            return;
          }
          // Sim fallback only if Live Only is off
          for(const sym of s.watchlist){const sd=s.symbols[sym];const nc=nextCandle(sd.candles[sd.candles.length-1].c,BASE_PX[sym]||150);s.symbols[sym].candles=[...sd.candles.slice(-199),nc];}
        }
      }else{
        // Sim mode — only run if Live Only is off
        if(liveOnlyRef.current&&persisted?.dataMode==="live"){
          tickLock.current=false;
          return;
        }
        for(const sym of s.watchlist){const sd=s.symbols[sym];const nc=nextCandle(sd.candles[sd.candles.length-1].c,BASE_PX[sym]||150);s.symbols[sym].candles=[...sd.candles.slice(-199),nc];}
      }

      const symData={};
      for(const sym of s.watchlist){const sd=s.symbols[sym];const px=sd.candles[sd.candles.length-1].c;const ind=computeInd(sd.candles);symData[sym]={px,ind};}

      // ── SL / Partial TP / Full TP ──
      const nowOpen=[];
      for(const t of s.open){
        const px=symData[t.sym]?.px??t.entry;
        if(!t.partialDone&&r.partialTP&&t.tp!=null){
          const hitTP1=t.dir==="BUY"?px>=t.tp:px<=t.tp;
          if(hitTP1){
            const pSh=Math.max(1,Math.round(t.shares*r.partialPct/100));
            const pnl=(t.dir==="BUY"?1:-1)*(t.tp-t.entry)*pSh;
            s.capital+=pSh*t.entry+pnl;s.dailyPnL+=pnl;
            s.closed=[{...t,ep:+t.tp.toFixed(3),pnl:+pnl.toFixed(2),shares:pSh,reason:`🎯 Partial TP (${r.partialPct}%)`,ct:new Date().toLocaleTimeString(),isPartial:true},...s.closed].slice(0,400);
            const rem=t.shares-pSh;if(rem>0)nowOpen.push({...t,shares:rem,cost:+(t.cost*rem/t.shares).toFixed(2),partialDone:true,tp:null});
            continue;
          }
        }
        const hitSL=t.dir==="BUY"?px<=t.sl:px>=t.sl;
        const hitTP=t.tp!=null&&(t.dir==="BUY"?px>=t.tp:px<=t.tp);
        if(hitSL||hitTP){
          const ep=hitSL?t.sl:t.tp,pnl=(t.dir==="BUY"?1:-1)*(ep-t.entry)*t.shares;
          s.capital+=t.shares*t.entry+pnl;s.dailyPnL+=pnl;
          s.closed=[{...t,ep:+ep.toFixed(3),pnl:+pnl.toFixed(2),reason:hitSL?"🛑 Stop Loss":"🎯 Take Profit",ct:new Date().toLocaleTimeString()},...s.closed].slice(0,400);
        }else nowOpen.push(t);
      }
      s.open=nowOpen;

      // ── Trailing stops ──
      if(r.trailEnabled){
        s.open=s.open.map(t=>{
          const px=symData[t.sym]?.px??t.entry;
          const prof=(t.dir==="BUY"?1:-1)*(px-t.entry)/t.entry*100;
          const isLev=t.isLeveraged||LEVERAGED_SYMS.has(t.sym);
          const activation=r.trailActivation*(isLev?LEV_ACTIV_MULT:1);
          const trailPct=r.trailPct*(isLev?LEV_TRAIL_MULT:1);
          const lockPct=r.lockInPct*(isLev?LEV_SL_MULT:1);
          if(!t.trailingActive&&prof>=activation){const lsl=t.dir==="BUY"?+(t.entry*(1+lockPct/100)).toFixed(3):+(t.entry*(1-lockPct/100)).toFixed(3);return{...t,sl:lsl,trailingActive:true,peakPx:px};}
          if(t.trailingActive){const px2=symData[t.sym]?.px??t.entry,pk=t.dir==="BUY"?Math.max(t.peakPx??t.entry,px2):Math.min(t.peakPx??t.entry,px2),tsl=t.dir==="BUY"?+(pk*(1-trailPct/100)).toFixed(3):+(pk*(1+trailPct/100)).toFixed(3),better=t.dir==="BUY"?tsl>t.sl:tsl<t.sl;return{...t,sl:better?tsl:t.sl,peakPx:pk};}
          return t;
        });
      }

      // ── Signals + Trades + Pyramiding ──
      const newScanSigs={};
      const minPct=MIN_STR[r.minStr],dlLimit=INIT_CAP*r.maxDailyLoss/100;
      for(const sym of s.watchlist){
        const{px,ind}=symData[sym];
        const sig=computeSignal(s.symbols[sym].candles,ind,st);
        newScanSigs[sym]={...sig,px,prevPx:s.symbols[sym].candles[s.symbols[sym].candles.length-2]?.c||px};
        if(!sig.dir||sig.strength<minPct)continue;
        const canOpen=s.dailyPnL>-dlLimit&&s.open.length<r.maxOpen;
        // Pyramid check
        if(r.pyramidEnabled&&canOpen){
          const par=s.open.find(t=>t.sym===sym&&t.dir===sig.dir&&!t.pyramided&&!t.isPyramid);
          if(par){
            const pf=(par.dir==="BUY"?1:-1)*(px-par.entry)/par.entry*100;
            const isLev=LEVERAGED_SYMS.has(sym);
            const levActiv=isLev?r.pyramidTrigger*LEV_ACTIV_MULT:r.pyramidTrigger;
            if(pf>=levActiv){
              const sizeMult=(r.pyramidSize/100)*(isLev?LEV_SIZE_MULT:1);
              const pySh=sizePos(s.capital,px,r,sizeMult),cost=pySh*px;
              if(pySh>0&&cost<=s.capital){
                const slPct=r.slPct*(isLev?LEV_SL_MULT:1);
                const sl=sig.dir==="BUY"?+(px*(1-slPct/100)).toFixed(3):+(px*(1+slPct/100)).toFixed(3);
                const tp=sig.dir==="BUY"?+(px*(1+slPct/100*r.tpRatio)).toFixed(3):+(px*(1-slPct/100*r.tpRatio)).toFixed(3);
                s.capital-=cost;
                s.open=[...s.open,{id:Date.now()+s.n+sym+"py",sym,dir:sig.dir,entry:+px.toFixed(3),shares:pySh,cost:+cost.toFixed(2),sl,tp,why:"🔺 Pyramid add-on",ot:new Date().toLocaleTimeString(),str:sig.label,isPyramid:true,isLeveraged:isLev}];
                s.open=s.open.map(t=>t.id===par.id?{...t,pyramided:true}:t);
              }
            }
          }
        }
        // New trade
        const alreadyIn=s.open.some(t=>t.sym===sym&&t.dir===sig.dir&&!t.isPyramid);
        if(alreadyIn||!canOpen){s.signals=[{...sig,id:Date.now()+s.n+sym,sym,traded:false,fr:alreadyIn?"Already in position":"Risk limit",time:new Date().toLocaleTimeString()},...s.signals].slice(0,100);continue;}
        const isLev=LEVERAGED_SYMS.has(sym);
        const sh=sizePos(s.capital,px,r,isLev?LEV_SIZE_MULT:1);
        const cost=sh*px;
        if(sh<=0||cost>s.capital){s.signals=[{...sig,id:Date.now()+s.n+sym,sym,traded:false,fr:"Insufficient Capital",time:new Date().toLocaleTimeString()},...s.signals].slice(0,100);continue;}
        const slPct=r.slPct*(isLev?LEV_SL_MULT:1);
        const sl=sig.dir==="BUY"?+(px*(1-slPct/100)).toFixed(3):+(px*(1+slPct/100)).toFixed(3);
        const tp=sig.dir==="BUY"?+(px*(1+slPct/100*r.tpRatio)).toFixed(3):+(px*(1-slPct/100*r.tpRatio)).toFixed(3);
        s.capital-=cost;
        s.open=[...s.open,{id:Date.now()+s.n+sym,sym,dir:sig.dir,entry:+px.toFixed(3),shares:sh,cost:+cost.toFixed(2),sl,tp,why:sig.reasons.slice(0,2).join(" + "),ot:new Date().toLocaleTimeString(),str:sig.label,isLeveraged:isLev}];
        s.signals=[{...sig,id:Date.now()+s.n+sym,sym,traded:true,fr:null,time:new Date().toLocaleTimeString()},...s.signals].slice(0,100);
      }

      // ── Portfolio snapshot ──
      const unrealPnL=s.open.reduce((a,t)=>a+(t.dir==="BUY"?1:-1)*((symData[t.sym]?.px||t.entry)-t.entry)*t.shares,0);
      const invested=s.open.reduce((a,t)=>a+t.shares*t.entry,0);
      s.portHist=[...s.portHist,{v:+(s.capital+invested+unrealPnL).toFixed(2)}].slice(-120);
      setScannerSigs(newScanSigs);bump(n=>n+1);
    }finally{tickLock.current=false;}
  },[]);

  const activeTick=dataMode==="live"?LIVE_TICK:SIM_TICK;
  useEffect(()=>{
    if(!running||reconnecting)return;
    const id=setInterval(()=>doTick(),activeTick);
    return()=>clearInterval(id);
  },[running,reconnecting,doTick,activeTick]);

  const reset=()=>{ts.current={symbols:initSymbols(),watchlist:[...DEFAULT_WATCHLIST],capital:INIT_CAP,open:[],closed:[],signals:[],dailyPnL:0,portHist:[{v:INIT_CAP}],n:0};setScannerSigs({});setRunning(false);try{localStorage.removeItem(STORAGE_KEY);}catch{};bump(n=>n+1);};
  const toggleWL=sym=>{const s=ts.current,idx=s.watchlist.indexOf(sym);if(idx>=0){if(s.watchlist.length<=1)return;s.watchlist=s.watchlist.filter(x=>x!==sym);}else s.watchlist=[...s.watchlist,sym];bump(n=>n+1);};

  // ── Derived ─────────────────────────────────
  const s=ts.current;
  const selCandles=s.symbols[selSym]?.candles||[];
  const selInd=useMemo(()=>selCandles.length>0?computeInd(selCandles):null,[tick,selSym]);
  const selSig=useMemo(()=>selInd?computeSignal(selCandles,selInd,strat):null,[tick,selSym,strat]);
  const selN=selCandles.length-1;
  const selPx=selCandles[selN]?.c??0,selPpx=selCandles[selN-1]?.c??selPx;
  const selDPx=selPx-selPpx,selDPct=selPpx?(selDPx/selPpx)*100:0;
  const allPxMap=Object.fromEntries(s.watchlist.map(sym=>[sym,s.symbols[sym]?.candles[s.symbols[sym].candles.length-1]?.c||0]));
  const unrealPnL=s.open.reduce((a,t)=>a+(t.dir==="BUY"?1:-1)*((allPxMap[t.sym]||t.entry)-t.entry)*t.shares,0);
  const invested=s.open.reduce((a,t)=>a+t.shares*t.entry,0);
  const tv=s.capital+invested+unrealPnL,totPnL=tv-INIT_CAP,totPnLPct=(totPnL/INIT_CAP)*100;
  const wins=s.closed.filter(t=>t.pnl>0).length,wr=s.closed.length?(wins/s.closed.length)*100:0;
  const latRSI=selInd?.rsi[selN]??50,latMACDH=selInd?.macd.hist[selN]??0,latADX=selInd?.adx[selN]??20;
  const sgn=v=>v>=0?T.G:T.R;
  const fmt$=v=>`$${Math.abs(v).toLocaleString("en",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const fmtPct=(v,d=2)=>`${v>=0?"+":""}${v.toFixed(d)}%`;

  const chartData=useMemo(()=>{
    if(!selInd||selCandles.length===0)return[];
    const start=Math.max(0,selCandles.length-80);
    return selCandles.slice(start).map((c,i)=>{const a=start+i;return{i:a,c:+c.c.toFixed(2),e9:+selInd.e9[a].toFixed(2),e21:+selInd.e21[a].toFixed(2),e50:+selInd.e50[a].toFixed(2),bbu:+selInd.bb[a].u.toFixed(2),bbl:+selInd.bb[a].l.toFixed(2),rsi:+selInd.rsi[a].toFixed(1),mh:+selInd.macd.hist[a].toFixed(5),adx:+selInd.adx[a].toFixed(1)};});
  },[tick,selSym]);

  const analytics=useMemo(()=>{
    const closed=s.closed;
    if(!closed.length)return null;
    // Per-symbol stats
    const bySymbol:{[k:string]:{sym:string,trades:number,wins:number,losses:number,pnl:number}}={};
    for(const t of closed){
      if(!bySymbol[t.sym])bySymbol[t.sym]={sym:t.sym,trades:0,wins:0,losses:0,pnl:0};
      bySymbol[t.sym].trades++;bySymbol[t.sym].pnl+=t.pnl;
      if(t.pnl>0)bySymbol[t.sym].wins++;else bySymbol[t.sym].losses++;
    }
    const symStats=Object.values(bySymbol).sort((a,b)=>b.pnl-a.pnl);
    // P&L distribution (8 bins)
    const pnls=closed.map(t=>t.pnl);
    const mn=Math.min(...pnls),mx=Math.max(...pnls);
    const range=mx-mn||1,binW=range/8;
    const bins=Array.from({length:8},(_,i)=>{const lo=mn+i*binW;return{label:(lo).toFixed(1),count:0,pos:lo+binW/2>=0};});
    for(const p of pnls){const idx=Math.min(7,Math.floor((p-mn)/binW));bins[idx].count++;}
    // Win/loss metrics
    const winTrades=closed.filter(t=>t.pnl>0),lossTrades=closed.filter(t=>t.pnl<0);
    const avgWin=winTrades.length?winTrades.reduce((a,t)=>a+t.pnl,0)/winTrades.length:0;
    const avgLoss=lossTrades.length?lossTrades.reduce((a,t)=>a+t.pnl,0)/lossTrades.length:0;
    const wrFrac=winTrades.length/closed.length;
    const expectancy=wrFrac*avgWin+(1-wrFrac)*avgLoss;
    const profitFactor=lossTrades.length&&Math.abs(avgLoss*lossTrades.length)>0?(avgWin*winTrades.length)/Math.abs(avgLoss*lossTrades.length):0;
    // Best/worst
    const best=closed.reduce((a,t)=>t.pnl>a.pnl?t:a,closed[0]);
    const worst=closed.reduce((a,t)=>t.pnl<a.pnl?t:a,closed[0]);
    // Max win streak
    let maxStreak=0,cur=0;
    for(const t of [...closed].reverse()){if(t.pnl>0){cur++;maxStreak=Math.max(maxStreak,cur);}else cur=0;}
    // Portfolio heatmap cells (up to 120 ticks, each cell = direction)
    const hist=s.portHist;
    const heatCells=hist.slice(1).map((h,i)=>({up:h.v>=hist[i].v,v:h.v}));
    return{symStats,bins,avgWin,avgLoss,expectancy,profitFactor,best,worst,maxStreak,heatCells};
  },[tick,s.closed.length]);

  const priceTT=({active,payload})=>{if(!active||!payload?.length)return null;const d=payload[0].payload;return(<div style={{background:"#060a18",border:`1px solid ${T.border}`,padding:"8px 12px",borderRadius:8,fontSize:11}}><div style={{color:T.text,marginBottom:4}}>Price: <b>${d.c}</b></div>{[["EMA9","#34d399",d.e9],["EMA21","#60a5fa",d.e21],["EMA50",T.P,d.e50]].map(([l,c,v])=><div key={l} style={{color:c}}>{l}: ${v}</div>)}<div style={{color:T.Y,marginTop:4}}>BB: ${d.bbl}–${d.bbu}</div><div style={{color:d.adx>=25?T.G:T.Y,marginTop:2}}>ADX: {d.adx}</div></div>);};

  const tabs=[
    {id:"scanner",lbl:`📡 Scanner (${s.watchlist.length})`},
    {id:"dashboard",lbl:`📊 ${selSym}`},
    {id:"strategies",lbl:"⚙️ Strategies"},
    {id:"signals",lbl:`🎯 Signals${s.signals.length?` (${s.signals.length})`:""}`},
    {id:"risk",lbl:"🛡️ Risk"},
    {id:"trades",lbl:`📋 Trades${s.closed.length?` (${s.closed.length})`:""}`},
    {id:"analytics",lbl:"📈 Analytics"},
    {id:"connect",lbl:connected?"🟢 Live Data":"🔌 Connect"},
  ];

  // ─────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────
  return(
    <div style={{background:T.bg,minHeight:"100vh",color:T.text,fontFamily:"'Inter',system-ui,sans-serif",fontSize:13}}>

      {/* HEADER */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:17,fontWeight:900,background:"linear-gradient(135deg,#4f8fff,#a78bfa,#00d4aa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>⚡ AutoTrader Pro</div>
          <div style={{fontSize:10,color:T.muted,marginTop:1,display:"flex",alignItems:"center",gap:8}}>
            <span>{connected?"🟢 Live — Twelve Data":"⚪ Simulated prices"}</span>
            {connected&&mktStatus&&<span style={{color:mktStatus==="open"?T.G:T.Y}}>{mktStatus==="open"?"● Market Open":"● Market Closed / After Hours"}</span>}
            {connected&&lastRefresh&&<span style={{color:T.muted}}>· Updated {lastRefresh.toLocaleTimeString()}</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{position:"relative"}}>
            <button onClick={()=>setWlOpen(w=>!w)} style={{background:T.card,color:T.text,border:`1px solid ${wlOpen?T.B:T.border}`,padding:"5px 12px",borderRadius:6,fontSize:12,cursor:"pointer",fontWeight:600}}>
              📋 Watchlist ({s.watchlist.length}) {wlOpen?"▲":"▼"}
            </button>
            {wlOpen&&(
              <div style={{position:"absolute",top:34,right:0,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:12,zIndex:100,width:230,boxShadow:"0 8px 32px #00000088"}}>
                <div style={{fontSize:11,color:T.muted,marginBottom:10,fontWeight:700}}>MONITOR SYMBOLS</div>
                {SYMBOL_UNIVERSE.map(({sym,sector})=>{const active=s.watchlist.includes(sym);return(
                  <div key={sym} onClick={()=>toggleWL(sym)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 8px",borderRadius:6,cursor:"pointer",marginBottom:4,background:active?T.B+"11":"transparent",border:`1px solid ${active?T.B+"44":"transparent"}`}}>
                    <div><span style={{fontWeight:700,color:active?T.text:T.muted,fontSize:13}}>{sym}</span><span style={{fontSize:10,color:SECTOR_COL[sector]||T.muted,marginLeft:6}}>{sector}</span></div>
                    <div style={{width:14,height:14,borderRadius:3,background:active?T.B:T.dim,border:`2px solid ${active?T.B:T.GR}`,display:"flex",alignItems:"center",justifyContent:"center"}}>{active&&<span style={{color:"white",fontSize:10}}>✓</span>}</div>
                  </div>
                );})}
              </div>
            )}
          </div>
          <button onClick={reset} style={{background:T.card,color:T.muted,border:`1px solid ${T.border}`,padding:"5px 10px",borderRadius:6,fontSize:12,cursor:"pointer"}}>↺ Reset</button>
          <button onClick={()=>setRunning(r=>!r)} disabled={reconnecting||liveBlocked}
            style={{background:reconnecting||liveBlocked?"#1f2937":running?"linear-gradient(135deg,#7f1d1d,#ef4444)":"linear-gradient(135deg,#065f46,#00d4aa)",color:reconnecting||liveBlocked?T.muted:"white",border:"none",padding:"6px 16px",borderRadius:6,fontWeight:800,fontSize:12,cursor:reconnecting||liveBlocked?"not-allowed":"pointer",boxShadow:reconnecting||liveBlocked?"none":`0 0 16px ${running?"#ef444440":"#00d4aa35"}`}}>
            {reconnecting?"⏳ Reconnecting...":liveBlocked?"🚫 No Live Data":running?"⏹ Stop Bot":"▶ Start Bot"}
          </button>
        </div>
      </div>

      {restored && !reconnecting && !liveBlocked && (
        <div style={{background:T.G+"15",borderBottom:`1px solid ${T.G}33`,padding:"6px 16px",fontSize:11,color:T.G,textAlign:"center"}}>
          ✓ Restored previous session — capital, trades and history loaded from this device
        </div>
      )}

      {reconnecting && (
        <div style={{background:T.Y+"15",borderBottom:`1px solid ${T.Y}33`,padding:"8px 16px",fontSize:11,color:T.Y,textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",border:`2px solid ${T.Y}`,borderTopColor:"transparent",animation:"spin 0.8s linear infinite"}}/>
          Reconnecting to live market data — ticking paused until real bars are confirmed...
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      {liveBlocked && !reconnecting && (
        <div style={{background:T.R+"15",borderBottom:`1px solid ${T.R}44`,padding:"8px 16px",fontSize:11,color:T.R,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <span>🚫 <b>Live Data Only mode</b> — connection lost. Bot is frozen. No sim data will run.</span>
          <button onClick={()=>connectLive()} style={{background:T.R+"22",color:T.R,border:`1px solid ${T.R}55`,padding:"4px 12px",borderRadius:6,fontSize:11,cursor:"pointer",fontWeight:700}}>↺ Retry Connection</button>
        </div>
      )}

      {/* STATUS BAR */}
      <div style={{background:T.surface,display:"flex",borderBottom:`1px solid ${T.border}`,overflowX:"auto"}}>
        {[
          {l:"Portfolio",v:fmt$(tv),s:fmtPct(totPnLPct),c:sgn(totPnL)},
          {l:"Total P&L",v:(totPnL>=0?"+":"-")+fmt$(totPnL),c:sgn(totPnL)},
          {l:"Today P&L",v:(s.dailyPnL>=0?"+":"-")+fmt$(s.dailyPnL),c:sgn(s.dailyPnL)},
          {l:"Win Rate",v:`${wr.toFixed(0)}%`,s:`${wins}/${s.closed.length}`,c:wr>=50?T.G:s.closed.length?T.R:T.muted},
          {l:"Open",v:`${s.open.length}/${rp.maxOpen}`,c:T.text},
          {l:"Scanning",v:`${s.watchlist.length} symbols`,c:connected?T.G:T.B},
        ].map((x,i)=>(
          <div key={i} style={{padding:"8px 14px",borderRight:`1px solid ${T.border}`,flexShrink:0,minWidth:90}}>
            <div style={{fontSize:10,color:T.muted,marginBottom:2}}>{x.l}</div>
            <div style={{fontSize:14,fontWeight:700,color:x.c,fontFamily:"monospace"}}>{x.v}</div>
            {x.s&&<div style={{fontSize:10,color:x.c,opacity:.75}}>{x.s}</div>}
          </div>
        ))}
        <div style={{padding:"8px 14px",flexShrink:0}}>
          <div style={{fontSize:10,color:T.muted,marginBottom:5}}>Bot</div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:running?T.G:T.GR,boxShadow:running?`0 0 8px ${T.G}`:""}}/>
            <span style={{fontSize:11,fontWeight:700,color:running?T.G:T.muted}}>{running?"ACTIVE":"IDLE"}</span>
          </div>
        </div>
      </div>

      {/* TABS */}
      <div style={{background:T.surface,display:"flex",borderBottom:`1px solid ${T.border}`,overflowX:"auto"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{background:"none",border:"none",color:tab===t.id?T.B:connected&&t.id==="connect"?T.G:T.muted,padding:"10px 13px",fontSize:12,cursor:"pointer",whiteSpace:"nowrap",borderBottom:`2px solid ${tab===t.id?T.B:"transparent"}`,fontWeight:tab===t.id?700:400}}>
            {t.lbl}
          </button>
        ))}
      </div>

      <div style={{padding:"14px",maxWidth:960,margin:"0 auto"}}>

        {/* ══ SCANNER ══════════════════════════════════════════ */}
        {tab==="scanner"&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:12,color:T.muted}}>Click any card to open its chart · {connected?"🟢 Live Twelve Data":"⚪ Simulated prices"}</div>
              <div style={{display:"flex",gap:10,fontSize:11}}>
                <span style={{color:T.G}}>▲ {Object.values(scannerSigs).filter(s=>s.dir==="BUY").length} bullish</span>
                <span style={{color:T.R}}>▼ {Object.values(scannerSigs).filter(s=>s.dir==="SELL").length} bearish</span>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:10}}>
              {s.watchlist.map(sym=>{
                const sg=scannerSigs[sym],px=sg?.px??(s.symbols[sym]?.candles[s.symbols[sym].candles.length-1]?.c||0);
                const dPct=sg?.prevPx?(px-sg.prevPx)/sg.prevPx*100:0;
                const openTrade=s.open.find(t=>t.sym===sym),hasPyramid=s.open.find(t=>t.sym===sym&&t.isPyramid);
                const info=SYMBOL_UNIVERSE.find(x=>x.sym===sym),hasSig=sg?.dir;
                return(
                  <div key={sym} onClick={()=>{setSelSym(sym);setTab("dashboard");}}
                    style={{background:T.card,border:`1px solid ${hasSig?(sg.dir==="BUY"?T.G:T.R)+"55":selSym===sym?T.B+"55":T.border}`,borderRadius:10,padding:"12px 14px",cursor:"pointer",boxShadow:hasSig?`0 0 12px ${sg.dir==="BUY"?T.G:T.R}18`:""}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                      <div><div style={{fontWeight:800,fontSize:15}}>{sym}</div><div style={{fontSize:10,color:SECTOR_COL[info?.sector]||T.muted}}>{info?.sector}</div></div>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
                        {openTrade&&<span style={{fontSize:9,background:T.B+"22",color:T.B,border:`1px solid ${T.B}44`,padding:"1px 5px",borderRadius:3,fontWeight:800}}>IN</span>}
                        {hasPyramid&&<span style={{fontSize:9,background:T.O+"22",color:T.O,border:`1px solid ${T.O}44`,padding:"1px 5px",borderRadius:3,fontWeight:800}}>+PY</span>}
                        {LEVERAGED_SYMS.has(sym)&&<span style={{fontSize:9,background:T.R+"22",color:T.R,border:`1px solid ${T.R}44`,padding:"1px 5px",borderRadius:3,fontWeight:800}}>3×</span>}
                      </div>
                    </div>
                    <div style={{fontFamily:"monospace",fontWeight:700,fontSize:16,marginBottom:2}}>${px.toFixed(2)}</div>
                    <div style={{fontSize:11,color:sgn(dPct),marginBottom:6}}>{fmtPct(dPct)}</div>
                    {sg?(<><div style={{display:"flex",alignItems:"center",gap:5,marginBottom:5,flexWrap:"wrap"}}><DirChip dir={sg.dir}/>{sg.dir&&<StrBadge lbl={sg.label}/>}</div><MiniBar strength={sg.strength||0} dir={sg.dir}/><div style={{marginTop:5}}><ADXPill val={sg.adx||20}/></div><div style={{fontSize:9,color:T.muted,marginTop:4}}>{sg.reasons?.slice(0,1).join("")||"Scanning..."}</div></>):<div style={{fontSize:10,color:T.muted,marginTop:4}}>Awaiting tick...</div>}
                  </div>
                );
              })}
            </div>
            {s.open.length>0&&(
              <Card style={{marginTop:14}}>
                <Lbl>Open Positions</Lbl>
                {s.open.map(t=>{const px=allPxMap[t.sym]||t.entry,upnl=(t.dir==="BUY"?1:-1)*(px-t.entry)*t.shares;return(
                  <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:T.surface,borderRadius:8,padding:"8px 12px",marginBottom:6,border:`1px solid ${(t.dir==="BUY"?T.G:T.R)+"33"}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><DirChip dir={t.dir}/><b>{t.sym}</b><span style={{fontSize:11,color:T.muted}}>{t.shares}sh@${t.entry}</span>{t.trailingActive&&<span style={{background:T.G+"18",color:T.G,border:`1px solid ${T.G}55`,fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:3}}>🔒</span>}{t.isPyramid&&<span style={{background:T.O+"18",color:T.O,border:`1px solid ${T.O}55`,fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:3}}>🔺</span>}{t.partialDone&&<span style={{background:T.Y+"18",color:T.Y,border:`1px solid ${T.Y}55`,fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:3}}>50%✓</span>}{(t.isLeveraged||LEVERAGED_SYMS.has(t.sym))&&<span style={{background:T.R+"18",color:T.R,border:`1px solid ${T.R}55`,fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:3}}>3×LEV</span>}</div>
                    <div style={{textAlign:"right"}}><div style={{fontWeight:700,fontFamily:"monospace",color:sgn(upnl)}}>{upnl>=0?"+":"-"}${Math.abs(upnl).toFixed(2)}</div><div style={{fontSize:10,color:T.muted}}>SL ${t.sl}</div></div>
                  </div>
                );})}
              </Card>
            )}
          </div>
        )}

        {/* ══ DASHBOARD ════════════════════════════════════════ */}
        {tab==="dashboard"&&(
          <div>
            <div style={{display:"flex",gap:6,marginBottom:12,overflowX:"auto"}}>
              {s.watchlist.map(sym=>{const sg=scannerSigs[sym];return(<button key={sym} onClick={()=>setSelSym(sym)} style={{background:sym===selSym?T.B+"22":T.card,border:`1px solid ${sym===selSym?T.B:sg?.dir?(sg.dir==="BUY"?T.G:T.R)+"44":T.border}`,color:sym===selSym?T.text:T.muted,padding:"5px 12px",borderRadius:7,fontSize:12,cursor:"pointer",fontWeight:sym===selSym?700:400,whiteSpace:"nowrap"}}>{sym}{sg?.dir==="BUY"?" ▲":sg?.dir==="SELL"?" ▼":""}</button>);})}
            </div>
            <Card glow={selSig?.dir==="BUY"?T.G:selSig?.dir==="SELL"?T.R:null} style={{marginBottom:12}}>
              <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                <div style={{flex:"1 1 180px"}}>
                  <Lbl>{selSym} — Signal {connected&&<span style={{color:T.G,fontWeight:400,textTransform:"none"}}>· Live data</span>}</Lbl>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}><DirChip dir={selSig?.dir}/>{selSig&&<StrBadge lbl={selSig.label}/>}<ADXPill val={latADX}/></div>
                  <div style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:10,color:T.muted}}>Signal Strength</span><span style={{fontSize:11,fontWeight:700,color:selSig?.dir==="BUY"?T.G:selSig?.dir==="SELL"?T.R:T.muted}}>{(selSig?.strength||0).toFixed(0)}%</span></div>
                    <div style={{height:5,background:T.dim,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${selSig?.strength||0}%`,background:`linear-gradient(90deg,${(selSig?.dir==="BUY"?T.G:selSig?.dir==="SELL"?T.R:T.B)+"66"},${selSig?.dir==="BUY"?T.G:selSig?.dir==="SELL"?T.R:T.B})`,transition:"width .6s",borderRadius:3}}/></div>
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{selSig?.reasons.map((r,i)=><span key={i} style={{background:T.dim,color:"#94a3b8",fontSize:10,padding:"2px 7px",borderRadius:4}}>{r}</span>)}{!selSig?.dir&&<span style={{color:T.muted,fontSize:11}}>No signal — watching {selSym}...</span>}</div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,alignContent:"start"}}>
                  {[["RSI(14)",latRSI.toFixed(1),latRSI<35?T.G:latRSI>65?T.R:T.text],["MACD",latMACDH.toFixed(5),latMACDH>0?T.G:T.R],["ADX",latADX.toFixed(1),latADX>=30?T.G:latADX>=20?T.Y:T.R],["Volume",`${((selInd?.vols[selN]||1)/(selInd?.volSMA[selN]||1)*100).toFixed(0)}% avg`,((selInd?.vols[selN]||1)/(selInd?.volSMA[selN]||1))>=strat.filters.volMult?T.G:T.muted],["EMA9/21",(selInd?.e9[selN]||0)>(selInd?.e21[selN]||0)?"Bull ▲":"Bear ▼",(selInd?.e9[selN]||0)>(selInd?.e21[selN]||0)?T.G:T.R],["vs EMA50",selPx>(selInd?.e50[selN]||0)?"Above ▲":"Below ▼",selPx>(selInd?.e50[selN]||0)?T.G:T.R]].map(([l,v,c])=>(<div key={l} style={{background:T.surface,borderRadius:7,padding:"7px 10px",border:`1px solid ${T.border}`}}><div style={{fontSize:9,color:T.muted,marginBottom:2}}>{l}</div><div style={{fontSize:12,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div></div>))}
                </div>
              </div>
            </Card>
            <Card style={{marginBottom:12}}>
              <Lbl>{selSym} — Price Chart</Lbl>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData} margin={{top:4,right:4,left:0,bottom:0}}>
                  <defs><linearGradient id="bbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.Y} stopOpacity={0.06}/><stop offset="100%" stopColor={T.Y} stopOpacity={0.01}/></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border}/>
                  <XAxis dataKey="i" hide/><YAxis domain={["auto","auto"]} tick={{fill:T.muted,fontSize:9}} width={52} tickFormatter={v=>`$${v}`}/>
                  <Tooltip content={priceTT}/>
                  <Area type="monotone" dataKey="bbu" fill="url(#bbg)" stroke={T.Y} strokeWidth={0.7} dot={false} strokeOpacity={0.5}/>
                  <Area type="monotone" dataKey="bbl" fill="transparent" stroke={T.Y} strokeWidth={0.7} dot={false} strokeOpacity={0.5}/>
                  <Line type="monotone" dataKey="e50" stroke={T.P} strokeWidth={1.5} dot={false}/>
                  <Line type="monotone" dataKey="e21" stroke="#60a5fa" strokeWidth={1} dot={false} strokeDasharray="5 2"/>
                  <Line type="monotone" dataKey="e9" stroke="#34d399" strokeWidth={1} dot={false} strokeDasharray="2 2"/>
                  <Line type="monotone" dataKey="c" stroke="white" strokeWidth={2} dot={false}/>
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
              <Card><Lbl>RSI(14)</Lbl><ResponsiveContainer width="100%" height={70}><ComposedChart data={chartData.slice(-40)} margin={{top:0,right:0,left:0,bottom:0}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis hide/><YAxis domain={[0,100]} tick={{fill:T.muted,fontSize:9}} width={22}/><ReferenceLine y={70} stroke={T.R} strokeOpacity={0.5} strokeDasharray="3"/><ReferenceLine y={30} stroke={T.G} strokeOpacity={0.5} strokeDasharray="3"/><Line type="monotone" dataKey="rsi" stroke={T.P} strokeWidth={1.5} dot={false}/></ComposedChart></ResponsiveContainer><div style={{textAlign:"center",fontFamily:"monospace",fontWeight:700,fontSize:13,color:latRSI<30?T.G:latRSI>70?T.R:T.text,marginTop:4}}>{latRSI.toFixed(1)}</div></Card>
              <Card><Lbl>MACD Hist</Lbl><ResponsiveContainer width="100%" height={70}><BarChart data={chartData.slice(-40)} margin={{top:0,right:0,left:0,bottom:0}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis hide/><YAxis tick={{fill:T.muted,fontSize:9}} width={38}/><ReferenceLine y={0} stroke={T.border}/><Bar dataKey="mh" radius={[1,1,0,0]}>{chartData.slice(-40).map((d,i)=><Cell key={i} fill={d.mh>=0?T.G:T.R} opacity={0.85}/>)}</Bar></BarChart></ResponsiveContainer><div style={{textAlign:"center",fontFamily:"monospace",fontWeight:700,fontSize:12,color:latMACDH>=0?T.G:T.R,marginTop:4}}>{latMACDH.toFixed(5)}</div></Card>
              <Card><Lbl>ADX — Trend Strength</Lbl><ResponsiveContainer width="100%" height={70}><ComposedChart data={chartData.slice(-40)} margin={{top:0,right:0,left:0,bottom:0}}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis hide/><YAxis domain={[0,60]} tick={{fill:T.muted,fontSize:9}} width={22}/><ReferenceLine y={strat.filters.adxMin} stroke={T.Y} strokeDasharray="3" strokeOpacity={0.6}/><Line type="monotone" dataKey="adx" stroke={T.O} strokeWidth={2} dot={false}/></ComposedChart></ResponsiveContainer><div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:10}}><span style={{color:T.Y}}>Min:{strat.filters.adxMin}</span><span style={{fontWeight:700,color:latADX>=30?T.G:latADX>=20?T.Y:T.R,fontFamily:"monospace",fontSize:13}}>{latADX.toFixed(1)}</span><span style={{color:T.G}}>30=✓</span></div></Card>
            </div>
            <Card><Lbl>Portfolio</Lbl><ResponsiveContainer width="100%" height={90}><AreaChart data={s.portHist} margin={{top:4,right:0,left:0,bottom:0}}><defs><linearGradient id="pvg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={tv>=INIT_CAP?T.G:T.R} stopOpacity={0.28}/><stop offset="95%" stopColor={tv>=INIT_CAP?T.G:T.R} stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis hide/><YAxis domain={["auto","auto"]} tick={{fill:T.muted,fontSize:9}} width={56} tickFormatter={v=>`$${(v/1000).toFixed(1)}k`}/><ReferenceLine y={INIT_CAP} stroke={T.dim} strokeDasharray="4"/><Tooltip formatter={v=>[`$${(+v).toFixed(2)}`,"Portfolio"]} contentStyle={{background:T.card,border:`1px solid ${T.border}`,fontSize:11,borderRadius:6}}/><Area type="monotone" dataKey="v" stroke={tv>=INIT_CAP?T.G:T.R} fill="url(#pvg)" strokeWidth={2} dot={false}/></AreaChart></ResponsiveContainer></Card>
          </div>
        )}

        {/* ══ STRATEGIES ═══════════════════════════════════════ */}
        {tab==="strategies"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {[{key:"mom",name:"📈 Momentum",color:T.G,desc:"RSI overbought/oversold + MACD crossovers.",extra:<><Slider label="RSI Oversold" value={strat.mom.oversold} min={20} max={45} onChange={v=>setStrat(s=>({...s,mom:{...s.mom,oversold:v}}))} fmt={v=>`${v}`}/><Slider label="RSI Overbought" value={strat.mom.overbought} min={55} max={80} onChange={v=>setStrat(s=>({...s,mom:{...s.mom,overbought:v}}))} fmt={v=>`${v}`}/></>},{key:"trend",name:"📉 Trend Following",color:T.B,desc:"EMA stack + Golden/Death cross. ADX-suppressed in choppy markets.",extra:null},{key:"pa",name:"🕯️ Price Action",color:T.Y,desc:"Bollinger Band bounces + candlestick patterns.",extra:null}].map(item=>(
              <Card key={item.key} glow={strat[item.key].on?item.color:null}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
                  <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}><span style={{fontWeight:700,fontSize:14}}>{item.name}</span><span style={{fontSize:9,background:strat[item.key].on?item.color+"22":T.dim,color:strat[item.key].on?item.color:T.muted,padding:"2px 7px",borderRadius:4,fontWeight:800}}>{strat[item.key].on?"ACTIVE":"OFF"}</span></div><div style={{fontSize:11,color:T.muted}}>{item.desc}</div></div>
                  <Toggle on={strat[item.key].on} onChange={v=>setStrat(s=>({...s,[item.key]:{...s[item.key],on:v}}))}/>
                </div>
                {strat[item.key].on&&<div style={{marginTop:14,borderTop:`1px solid ${T.border}`,paddingTop:14}}><Slider label="Weight" value={strat[item.key].w} min={0.5} max={2} step={0.1} onChange={v=>setStrat(s=>({...s,[item.key]:{...s[item.key],w:v}}))} fmt={v=>`${v.toFixed(1)}×`}/>{item.extra}</div>}
              </Card>
            ))}
            <Card glow={T.P}>
              <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🎚️ Signal Quality Filters</div>
              <div style={{background:T.surface,borderRadius:8,padding:"12px 14px",marginBottom:12,border:`1px solid ${T.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:strat.filters.adxEnabled?12:0}}><div><div style={{fontWeight:700,marginBottom:2}}>ADX Filter</div><div style={{fontSize:11,color:T.muted}}>Suppresses trend signals in choppy markets (ADX below threshold).</div></div><Toggle on={strat.filters.adxEnabled} onChange={v=>setStrat(s=>({...s,filters:{...s.filters,adxEnabled:v}}))}/>
                </div>
                {strat.filters.adxEnabled&&<Slider label="Min ADX" value={strat.filters.adxMin} min={10} max={40} onChange={v=>setStrat(s=>({...s,filters:{...s.filters,adxMin:v}}))} fmt={v=>`${v}`}/>}
              </div>
              <div style={{background:T.surface,borderRadius:8,padding:"12px 14px",border:`1px solid ${T.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:strat.filters.volEnabled?12:0}}><div><div style={{fontWeight:700,marginBottom:2}}>Volume Confirmation</div><div style={{fontSize:11,color:T.muted}}>Boosts signals on high volume, penalises low-volume signals.</div></div><Toggle on={strat.filters.volEnabled} onChange={v=>setStrat(s=>({...s,filters:{...s.filters,volEnabled:v}}))}/>
                </div>
                {strat.filters.volEnabled&&<Slider label="Volume threshold (× 20-bar average)" value={strat.filters.volMult} min={1.0} max={2.5} step={0.1} onChange={v=>setStrat(s=>({...s,filters:{...s.filters,volMult:v}}))} fmt={v=>`${v.toFixed(1)}×`}/>}
              </div>
            </Card>
          </div>
        )}

        {/* ══ SIGNALS ══════════════════════════════════════════ */}
        {tab==="signals"&&<>
          <Card style={{marginBottom:12}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}><div><Lbl>Signal Feed</Lbl><span style={{fontSize:11,color:T.muted}}>Min: <b style={{color:T.text}}>{rp.minStr}</b> · {s.signals.length} total</span></div><div style={{display:"flex",gap:12,fontSize:11}}><span style={{color:T.G}}>✓ {s.signals.filter(x=>x.traded).length}</span><span style={{color:T.muted}}>⚠ {s.signals.filter(x=>!x.traded).length}</span></div></div></Card>
          {s.signals.length===0?<div style={{textAlign:"center",color:T.muted,padding:"40px 0",fontSize:12}}>No signals yet.</div>:s.signals.map(sg=>(
            <div key={sg.id} style={{background:T.card,border:`1px solid ${sg.traded?(sg.dir==="BUY"?T.G:T.R)+"44":T.border}`,borderRadius:9,padding:"10px 12px",marginBottom:8,cursor:"pointer"}} onClick={()=>{setSelSym(sg.sym);setTab("dashboard");}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><DirChip dir={sg.dir}/><StrBadge lbl={sg.label}/><b>{sg.sym}</b><ADXPill val={sg.adx||20}/></div><div style={{textAlign:"right"}}>{sg.traded?<span style={{fontSize:11,color:T.G,fontWeight:700}}>✓ TRADED</span>:<span style={{fontSize:11,color:T.muted}}>⚠ {sg.fr}</span>}<div style={{fontSize:10,color:"#475569"}}>{sg.time}</div></div></div>
              <div style={{fontSize:11,color:T.muted,marginBottom:6}}>@ ${sg.price?.toFixed(2)} · {sg.strength?.toFixed(0)}% · Vol {(sg.volRatio*100||100).toFixed(0)}% avg</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{sg.reasons?.map((r,i)=><span key={i} style={{background:T.dim,color:"#94a3b8",fontSize:10,padding:"2px 7px",borderRadius:4}}>{r}</span>)}</div>
            </div>
          ))}
        </>}

        {/* ══ RISK ═════════════════════════════════════════════ */}
        {tab==="risk"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <Card><div style={{fontWeight:700,marginBottom:14}}>Position Sizing</div><Slider label="Max Position Size (%)" value={rp.maxPos} min={5} max={50} onChange={v=>setRp(r=>({...r,maxPos:v}))} fmt={v=>`${v}%`}/><Slider label="Risk Per Trade (%)" value={rp.riskPct} min={0.5} max={5} step={0.5} onChange={v=>setRp(r=>({...r,riskPct:v}))} fmt={v=>`${v}%`}/></Card>
            <Card><div style={{fontWeight:700,marginBottom:14}}>Stop Loss & Take Profit</div><Slider label="Stop Loss %" value={rp.slPct} min={0.5} max={10} step={0.5} onChange={v=>setRp(r=>({...r,slPct:v}))} fmt={v=>`${v}%`}/><Slider label="Take Profit R:R" value={rp.tpRatio} min={1} max={5} step={0.5} onChange={v=>setRp(r=>({...r,tpRatio:v}))} fmt={v=>`${v}:1`}/></Card>
            <Card glow={rp.trailEnabled?T.G:null}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:rp.trailEnabled?14:0}}><div style={{fontWeight:700,fontSize:14}}>🔒 Trailing Stop</div><Toggle on={rp.trailEnabled} onChange={v=>setRp(r=>({...r,trailEnabled:v}))}/></div>{rp.trailEnabled&&<><Slider label="Activate at +" value={rp.trailActivation} min={1} max={10} step={0.5} onChange={v=>setRp(r=>({...r,trailActivation:v}))} fmt={v=>`${v}%`}/><Slider label="Lock SL to +" value={rp.lockInPct} min={0.5} max={5} step={0.5} onChange={v=>setRp(r=>({...r,lockInPct:v}))} fmt={v=>`+${v}%`}/><Slider label="Trail %" value={rp.trailPct} min={1} max={10} step={0.5} onChange={v=>setRp(r=>({...r,trailPct:v}))} fmt={v=>`${v}%`}/></>}</Card>
            <Card glow={rp.partialTP?T.Y:null}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><div><div style={{fontWeight:700,fontSize:14,marginBottom:3}}>🎯 Partial Take Profit</div><div style={{fontSize:11,color:T.muted}}>Close a portion at TP, let the rest run on the trailing stop.</div></div><Toggle on={rp.partialTP} onChange={v=>setRp(r=>({...r,partialTP:v}))}/></div>{rp.partialTP&&<div style={{marginTop:14,borderTop:`1px solid ${T.border}`,paddingTop:14}}><Slider label="% to close at TP" value={rp.partialPct} min={25} max={75} step={5} onChange={v=>setRp(r=>({...r,partialPct:v}))} fmt={v=>`${v}% close · ${100-v}% runs on`}/></div>}</Card>
            <Card glow={rp.pyramidEnabled?T.O:null}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><div><div style={{fontWeight:700,fontSize:14,marginBottom:3}}>🔺 Pyramiding</div><div style={{fontSize:11,color:T.muted}}>Add a smaller position when trade is profitable and signal agrees.</div></div><Toggle on={rp.pyramidEnabled} onChange={v=>setRp(r=>({...r,pyramidEnabled:v}))}/></div>{rp.pyramidEnabled&&<div style={{marginTop:14,borderTop:`1px solid ${T.border}`,paddingTop:14}}><Slider label="Trigger profit %" value={rp.pyramidTrigger} min={1} max={10} step={0.5} onChange={v=>setRp(r=>({...r,pyramidTrigger:v}))} fmt={v=>`+${v}%`}/><Slider label="Add-on size (% of normal)" value={rp.pyramidSize} min={25} max={75} step={5} onChange={v=>setRp(r=>({...r,pyramidSize:v}))} fmt={v=>`${v}%`}/></div>}</Card>
            <Card><div style={{fontWeight:700,marginBottom:14}}>Trade Filters</div><Slider label="Max Concurrent Positions" value={rp.maxOpen} min={1} max={15} onChange={v=>setRp(r=>({...r,maxOpen:v}))} fmt={v=>`${v}`}/><Slider label="Daily Loss Limit" value={rp.maxDailyLoss} min={1} max={20} onChange={v=>setRp(r=>({...r,maxDailyLoss:v}))} fmt={v=>`${v}%`}/><div style={{marginTop:8}}><div style={{fontSize:12,color:"#94a3b8",marginBottom:10}}>Min Signal Strength</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["Weak","Moderate","Strong","Very Strong"].map(opt=>(<button key={opt} onClick={()=>setRp(r=>({...r,minStr:opt}))} style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${rp.minStr===opt?T.B:T.border}`,background:rp.minStr===opt?T.B+"22":"transparent",color:rp.minStr===opt?"white":T.muted,fontSize:11,cursor:"pointer",fontWeight:rp.minStr===opt?700:400}}>{opt}</button>))}</div></div></Card>
          </div>
        )}

        {/* ══ TRADES ═══════════════════════════════════════════ */}
        {tab==="trades"&&<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:12}}>{[{l:"Closed",v:`${s.closed.length}`,c:T.text},{l:"Win Rate",v:`${wr.toFixed(0)}%`,c:wr>=50?T.G:s.closed.length?T.R:T.muted},{l:"P&L",v:(totPnL>=0?"+":"-")+fmt$(totPnL),c:sgn(totPnL)},{l:"Avg Win",v:wins?"+"+fmt$(s.closed.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/wins):"—",c:T.G}].map((x,i)=>(<Card key={i} style={{padding:12,textAlign:"center"}}><div style={{fontSize:10,color:T.muted,marginBottom:5}}>{x.l}</div><div style={{fontSize:16,fontWeight:700,color:x.c,fontFamily:"monospace"}}>{x.v}</div></Card>))}</div>
          {s.closed.length===0?<Card><div style={{textAlign:"center",color:T.muted,padding:"32px 0",fontSize:12}}>No trades yet.</div></Card>:s.closed.map((t,i)=>{const pp=(t.pnl/(t.shares*t.entry))*100;return(<div key={i} style={{background:T.card,border:`1px solid ${(t.pnl>=0?T.G:T.R)+"44"}`,borderRadius:9,padding:"10px 12px",marginBottom:8}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><DirChip dir={t.dir}/><b>{t.sym}</b><span style={{fontSize:11,color:T.muted}}>{t.shares}sh</span>{t.isPartial&&<span style={{background:T.Y+"22",color:T.Y,border:`1px solid ${T.Y}44`,fontSize:9,fontWeight:800,padding:"2px 6px",borderRadius:4}}>PARTIAL</span>}{t.isPyramid&&<span style={{background:T.O+"22",color:T.O,border:`1px solid ${T.O}44`,fontSize:9,fontWeight:800,padding:"2px 6px",borderRadius:4}}>PYRAMID</span>}<StrBadge lbl={t.str}/></div><div style={{textAlign:"right"}}><div style={{fontWeight:700,fontFamily:"monospace",fontSize:14,color:sgn(t.pnl)}}>{t.pnl>=0?"+":"-"}${Math.abs(t.pnl).toFixed(2)}</div><div style={{fontSize:10,color:sgn(t.pnl)}}>{fmtPct(pp)}</div></div></div><div style={{display:"flex",gap:14,marginTop:7,fontSize:10,color:T.muted,flexWrap:"wrap"}}><span>Entry <b style={{color:T.text}}>${t.entry}</b></span><span>Exit <b style={{color:T.text}}>${t.ep}</b></span><span>{t.reason}</span><span>{t.ot}→{t.ct}</span></div>{t.why&&<div style={{fontSize:10,color:"#475569",marginTop:4}}>↗ {t.why}</div>}</div>);})}
        </>}

        {/* ══ ANALYTICS ════════════════════════════════════════ */}
        {tab==="analytics"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {!analytics?(
              <Card><div style={{textAlign:"center",color:T.muted,padding:"48px 0",fontSize:12}}>
                <div style={{fontSize:28,marginBottom:12}}>📈</div>
                <div style={{fontWeight:700,marginBottom:6,color:T.text}}>No data yet</div>
                <div>Start the bot and let it run — analytics appear once trades close.</div>
              </div></Card>
            ):(
              <>
                {/* ── Top summary row ── */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                  {[
                    {l:"Expectancy",v:(analytics.expectancy>=0?"+":"")+fmt$(analytics.expectancy),c:sgn(analytics.expectancy),tip:"Avg $ per trade"},
                    {l:"Profit Factor",v:analytics.profitFactor?analytics.profitFactor.toFixed(2)+"×":"—",c:analytics.profitFactor>=1?T.G:T.R,tip:"Gross wins / gross losses"},
                    {l:"Best Trade",v:"+"+fmt$(analytics.best.pnl),c:T.G,tip:`${analytics.best.sym} ${analytics.best.dir}`},
                    {l:"Worst Trade",v:"-"+fmt$(Math.abs(analytics.worst.pnl)),c:T.R,tip:`${analytics.worst.sym} ${analytics.worst.dir}`},
                  ].map((x,i)=>(
                    <Card key={i} style={{padding:12,textAlign:"center"}}>
                      <div style={{fontSize:9,color:T.muted,marginBottom:2,textTransform:"uppercase",letterSpacing:"0.07em"}}>{x.l}</div>
                      <div style={{fontSize:14,fontWeight:800,color:x.c,fontFamily:"monospace",marginBottom:2}}>{x.v}</div>
                      <div style={{fontSize:9,color:"#475569"}}>{x.tip}</div>
                    </Card>
                  ))}
                </div>

                {/* ── Avg win / loss + streak ── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  <Card style={{padding:12,textAlign:"center"}}>
                    <div style={{fontSize:9,color:T.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.07em"}}>Avg Win</div>
                    <div style={{fontSize:16,fontWeight:800,color:T.G,fontFamily:"monospace"}}>+{fmt$(analytics.avgWin)}</div>
                  </Card>
                  <Card style={{padding:12,textAlign:"center"}}>
                    <div style={{fontSize:9,color:T.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.07em"}}>Avg Loss</div>
                    <div style={{fontSize:16,fontWeight:800,color:T.R,fontFamily:"monospace"}}>-{fmt$(Math.abs(analytics.avgLoss))}</div>
                  </Card>
                  <Card style={{padding:12,textAlign:"center"}}>
                    <div style={{fontSize:9,color:T.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:"0.07em"}}>Best Win Streak</div>
                    <div style={{fontSize:16,fontWeight:800,color:T.Y,fontFamily:"monospace"}}>{analytics.maxStreak} in a row</div>
                  </Card>
                </div>

                {/* ── By-symbol breakdown ── */}
                <Card>
                  <Lbl>Performance by Symbol</Lbl>
                  {analytics.symStats.map(sym=>{
                    const wr2=sym.trades?sym.wins/sym.trades*100:0;
                    const maxAbsPnl=Math.max(...analytics.symStats.map(s=>Math.abs(s.pnl)))||1;
                    const barW=Math.abs(sym.pnl)/maxAbsPnl*100;
                    return(
                      <div key={sym.sym} style={{marginBottom:10}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontWeight:800,fontSize:13,width:48}}>{sym.sym}</span>
                            <span style={{fontSize:10,color:T.muted}}>{sym.trades} trades</span>
                            <span style={{fontSize:10,color:T.G}}>{sym.wins}W</span>
                            <span style={{fontSize:10,color:T.R}}>{sym.losses}L</span>
                            <span style={{fontSize:10,background:wr2>=50?T.G+"22":T.R+"22",color:wr2>=50?T.G:T.R,padding:"1px 6px",borderRadius:4,fontWeight:700}}>{wr2.toFixed(0)}%</span>
                          </div>
                          <span style={{fontFamily:"monospace",fontWeight:700,fontSize:13,color:sgn(sym.pnl)}}>{sym.pnl>=0?"+":"-"}${Math.abs(sym.pnl).toFixed(2)}</span>
                        </div>
                        <div style={{height:6,background:T.dim,borderRadius:3,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${barW}%`,background:sym.pnl>=0?`linear-gradient(90deg,${T.G}55,${T.G})`:
                            `linear-gradient(90deg,${T.R}55,${T.R})`,borderRadius:3,transition:"width .4s"}}/>
                        </div>
                      </div>
                    );
                  })}
                </Card>

                {/* ── P&L distribution ── */}
                <Card>
                  <Lbl>P&L Distribution</Lbl>
                  <div style={{display:"flex",alignItems:"flex-end",gap:4,height:80,padding:"0 4px"}}>
                    {analytics.bins.map((bin,i)=>{
                      const maxCount=Math.max(...analytics.bins.map(b=>b.count))||1;
                      const h=Math.max(4,(bin.count/maxCount)*72);
                      return(
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                          <div style={{fontSize:8,color:T.muted,fontFamily:"monospace"}}>{bin.count||""}</div>
                          <div style={{width:"100%",height:h,background:bin.pos?`${T.G}99`:`${T.R}99`,borderRadius:"3px 3px 0 0",border:`1px solid ${bin.pos?T.G:T.R}44`}}/>
                          <div style={{fontSize:7,color:T.muted,fontFamily:"monospace",transform:"rotate(-35deg)",transformOrigin:"top left",marginTop:2,whiteSpace:"nowrap"}}>{bin.label}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:18,fontSize:10,color:T.muted}}>
                    <span style={{color:T.R}}>← Losses</span>
                    <span style={{color:T.G}}>Wins →</span>
                  </div>
                </Card>

                {/* ── Portfolio tick heatmap ── */}
                <Card>
                  <Lbl>Portfolio Tick Heatmap <span style={{color:T.muted,fontWeight:400,textTransform:"none",letterSpacing:0}}>— each cell = one price tick, green = up, red = down</span></Lbl>
                  {analytics.heatCells.length===0?(
                    <div style={{color:T.muted,fontSize:11}}>No ticks yet — start the bot.</div>
                  ):(
                    <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                      {analytics.heatCells.map((cell,i)=>(
                        <div key={i} title={`$${cell.v.toFixed(2)}`} style={{width:14,height:14,borderRadius:3,background:cell.up?`${T.G}88`:`${T.R}88`,border:`1px solid ${cell.up?T.G:T.R}33`,cursor:"default"}}/>
                      ))}
                    </div>
                  )}
                  <div style={{display:"flex",gap:16,marginTop:10,fontSize:10,color:T.muted}}>
                    <span>🟩 {analytics.heatCells.filter(c=>c.up).length} up ticks</span>
                    <span>🟥 {analytics.heatCells.filter(c=>!c.up).length} down ticks</span>
                    <span>Total ticks: {analytics.heatCells.length}</span>
                  </div>
                </Card>
              </>
            )}
          </div>
        )}

        {/* ══ CONNECT — LIVE DATA ══════════════════════════════ */}
        {tab==="connect"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>

            {connected?(
              <Card glow={T.G} style={{background:"linear-gradient(135deg,#062a1f,#0b0f1e)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                  <div>
                    <div style={{fontWeight:800,fontSize:14,color:T.G,marginBottom:4}}>🟢 Connected to Twelve Data</div>
                    <div style={{fontSize:12,color:T.muted}}>Timeframe: <b style={{color:T.text}}>{tf}</b> · Refreshes every 5 minutes when bot is running</div>
                    {lastRefresh&&<div style={{fontSize:11,color:T.muted,marginTop:4}}>Last updated: {lastRefresh.toLocaleTimeString()}</div>}
                    {mktStatus==="closed"&&<div style={{fontSize:11,color:T.Y,marginTop:4}}>⚠ Market closed / after hours — holding last available prices</div>}
                  </div>
                  <button onClick={disconnect} style={{background:"#1f2937",color:T.R,border:`1px solid ${T.R}44`,padding:"8px 16px",borderRadius:7,fontSize:12,cursor:"pointer",fontWeight:700}}>Disconnect</button>
                </div>
              </Card>
            ):(
              <Card style={{background:"linear-gradient(135deg,#0c1628,#0b0f1e)",border:`1px solid ${T.B}33`}}>
                <div style={{fontWeight:800,fontSize:14,color:T.B,marginBottom:6}}>🔌 Connect to Live Market Data</div>
                <p style={{fontSize:12,color:T.muted,margin:0,lineHeight:1.6}}>Swap the price simulation for real OHLCV bars from Twelve Data. Free account, one API key, done in under a minute.</p>
              </Card>
            )}

            {!connected&&(
              <Card>
                <Lbl>Setup — 3 Steps</Lbl>
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  {[
                    {n:"1",l:"Sign up at twelvedata.com",d:"Just email and password — no credit card. Free tier gives you 800 requests/day.",link:"https://twelvedata.com",txt:"twelvedata.com →"},
                    {n:"2",l:"Copy your API key",d:'After signing up, go to your Dashboard. Your API key is shown immediately on the main page — just copy it.'},
                    {n:"3",l:"Paste it below and connect",d:"That's it. One key, no secret. Your key stays in your browser and goes only to Twelve Data's servers."},
                  ].map(step=>(
                    <div key={step.n} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                      <div style={{width:24,height:24,borderRadius:"50%",background:T.B+"22",color:T.B,border:`1px solid ${T.B}44`,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{step.n}</div>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,marginBottom:3}}>{step.l}</div>
                        <div style={{fontSize:11,color:T.muted,lineHeight:1.5}}>{step.d}</div>
                        {step.link&&<a href={step.link} target="_blank" rel="noreferrer" style={{fontSize:11,color:T.B,textDecoration:"none"}}>{step.txt}</a>}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card>
              <Lbl>{connected?"Connection Settings":"API Key"}</Lbl>
              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:"#94a3b8",marginBottom:6}}>Twelve Data API Key</div>
                <input value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="your_api_key_here" disabled={connected}
                  style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,color:T.text,padding:"8px 12px",borderRadius:7,fontSize:12,boxSizing:"border-box",outline:"none",fontFamily:"monospace",opacity:connected?0.5:1}}/>
              </div>

              <div style={{marginBottom:16}}>
                <div style={{fontSize:12,color:"#94a3b8",marginBottom:8}}>Timeframe</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[["1min","1 Min"],["5min","5 Min"],["15min","15 Min"],["1h","1 Hour"],["1day","Daily"]].map(([val,lbl])=>(
                    <button key={val} onClick={()=>setTf(val)} disabled={connected}
                      style={{padding:"6px 12px",borderRadius:7,border:`1px solid ${tf===val?T.B:T.border}`,background:tf===val?T.B+"22":"transparent",color:tf===val?"white":T.muted,fontSize:11,cursor:connected?"not-allowed":"pointer",fontWeight:tf===val?700:400,opacity:connected?0.6:1}}>
                      {lbl}
                    </button>
                  ))}
                </div>
                <div style={{fontSize:10,color:T.muted,marginTop:8}}>5 Min or 15 Min is a good balance between signal frequency and noise for intraday trading.</div>
              </div>

              {connErr&&<div style={{background:"#1f0a0a",border:`1px solid ${T.R}44`,borderRadius:8,padding:"10px 12px",fontSize:12,color:T.R,marginBottom:12}}>⚠ {connErr}</div>}

              {!connected?(
                <button onClick={()=>connectLive()} disabled={connecting||!apiKey}
                  style={{width:"100%",background:connecting||!apiKey?"#1f2937":"linear-gradient(135deg,#065f46,#00d4aa)",color:connecting||!apiKey?T.muted:"white",border:"none",padding:"10px",borderRadius:8,fontWeight:800,fontSize:13,cursor:connecting||!apiKey?"not-allowed":"pointer"}}>
                  {connecting?"⏳ Loading real market data...":"🔌 Connect & Load Real Data"}
                </button>
              ):(
                <div style={{background:T.surface,borderRadius:8,padding:"10px 12px",fontSize:12,color:T.G,border:`1px solid ${T.G}33`,textAlign:"center"}}>
                  ✓ Connected · {tf} bars · {s.watchlist.length} symbols loaded · refreshes every 5 min
                </div>
              )}
            </Card>

            <Card glow={liveOnlyMode?T.R:null}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
                <div>
                  <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🚫 Live Data Only Mode</div>
                  <div style={{fontSize:11,color:T.muted,lineHeight:1.6}}>
                    When enabled, the bot will <b style={{color:T.text}}>never fall back to simulated data</b> if the live connection drops. Instead it freezes completely — no fake candles, no skewed results. Your paper trading data stays clean. <b style={{color:T.R}}>Recommended: always leave this on.</b>
                  </div>
                </div>
                <Toggle on={liveOnlyMode} onChange={v=>setLiveOnlyMode(v)}/>
              </div>
              {!liveOnlyMode&&(
                <div style={{marginTop:10,background:"#1f0a0a",border:`1px solid ${T.R}33`,borderRadius:7,padding:"8px 12px",fontSize:11,color:T.R}}>
                  ⚠ Sim fallback is <b>ON</b> — if live connection drops, mock data will activate and skew your results.
                </div>
              )}
            </Card>

            <Card>
              <Lbl>Free Tier Limits</Lbl>
              <div style={{display:"flex",flexDirection:"column",gap:8,fontSize:12,color:T.muted,lineHeight:1.6}}>
                <div>📊 <b style={{color:T.text}}>800 API credits/day, 8/minute.</b> With 6 symbols refreshing every 5 minutes, you'll use roughly 6 credits every 5 minutes — comfortably within limits for a full trading day.</div>
                <div>📱 <b style={{color:T.text}}>Your trade history, open positions, and capital save automatically</b> to this device every few seconds. Refreshing the page or reopening the tab restores everything — it won't reset to $10,000.</div>
                <div>⚠️ <b style={{color:T.text}}>Phone browsers suspend background tabs</b> to save battery. If you lock your phone or switch apps for a long time, the bot pauses ticking — your data is safe, but it won't trade while suspended. Reopening the tab resumes it from where it left off.</div>
                <div>🔐 <b style={{color:T.text}}>Your key stays in your browser</b> and goes only to Twelve Data's servers.</div>
                <div>🕐 <b style={{color:T.text}}>Outside market hours</b> the bot holds at last available prices. New bars come in when the market opens.</div>
                <div>💡 <b style={{color:T.text}}>Still paper trading.</b> No real orders are placed — this purely feeds real price data into the signal engine.</div>
              </div>
            </Card>
          </div>
        )}

      </div>
    </div>
  );
}
