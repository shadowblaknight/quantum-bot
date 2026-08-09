/* eslint-disable */
// JARVIS · Quantum Bot v17 — Live Dashboard
// ─────────────────────────────────────────────────────────────────────────────
// All panels pull from real API endpoints.
// JARVIS chat is live via POST /api/jarvis.
// Trade DNA computed from recognition-memory (all closed trades).
// QB Nexus analysis is real — computed client-side from trade intersections.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── CSS ─────────────────────────────────────────────────────────────────────
const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#020b18;--panel:#040e1e;--card:rgba(0,20,48,.82);
  --b:rgba(0,229,255,.18);--b2:rgba(0,229,255,.07);
  --ion:#00e5ff;--pulse:#00ff9d;--thr:#ff2d55;
  --amb:#f59e0b;--pur:#a78bfa;--txt:#b8d4f0;
  --dim:rgba(120,170,210,.42);
  --mono:"SF Mono","Fira Code","Consolas",monospace;
  --ui:-apple-system,"Segoe UI",sans-serif
}
html,body,#root{height:100%;overflow:hidden;background:var(--bg);color:var(--txt);font-family:var(--ui);font-size:12px}
.hud{display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}
/* scan-line overlay */
.hud::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:9998;
  background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.022) 3px,rgba(0,0,0,.022) 4px)}
/* grid overlay */
.hud::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9996;
  background-image:linear-gradient(rgba(0,229,255,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,.015) 1px,transparent 1px);
  background-size:64px 64px}
/* ambient glow */
#amb{position:fixed;inset:0;pointer-events:none;z-index:9999;transition:box-shadow .8s}
#amb.monitor{box-shadow:inset 0 0 0 1px rgba(0,229,255,.22),inset 0 0 80px rgba(0,229,255,.04);animation:aP 3s ease-in-out infinite}
#amb.signal{box-shadow:inset 0 0 0 2px rgba(0,255,157,.5),inset 0 0 100px rgba(0,255,157,.06);animation:aP 1.8s ease-in-out infinite}
#amb.warn{box-shadow:inset 0 0 0 2px rgba(245,158,11,.5),inset 0 0 80px rgba(245,158,11,.06);animation:aP 2.2s ease-in-out infinite}
#amb.critical{box-shadow:inset 0 0 0 3px rgba(255,45,85,.7),inset 0 0 120px rgba(255,45,85,.1);animation:aF .9s ease-in-out infinite}
@keyframes aP{0%,100%{opacity:.7}50%{opacity:1}}
@keyframes aF{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes dp{0%,100%{opacity:.4}50%{opacity:1}}
@keyframes slideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
/* panel base */
.pnl{background:var(--card);border:1px solid var(--b);border-radius:6px;position:relative;overflow:hidden}
.pnl::before,.pnl::after{content:'';position:absolute;width:9px;height:9px;z-index:2;pointer-events:none}
.pnl::before{top:-1px;left:-1px;border-top:2px solid var(--ion);border-left:2px solid var(--ion)}
.pnl::after{bottom:-1px;right:-1px;border-bottom:2px solid var(--ion);border-right:2px solid var(--ion)}
.pH{padding:5px 9px;border-bottom:1px solid var(--b2);display:flex;align-items:center;gap:5px;background:rgba(0,229,255,.02)}
.pHL{font-family:var(--mono);font-size:7.5px;text-transform:uppercase;letter-spacing:1.2px;color:var(--ion);font-weight:700;flex:1}
.tag{display:inline-flex;align-items:center;font-size:6.5px;padding:1px 5px;border-radius:6px;font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.2px}
.tag.live{background:rgba(0,255,157,.1);color:var(--pulse);animation:dp 1.8s ease-in-out infinite}
.tag.ai{background:rgba(0,229,255,.1);color:var(--ion)}
.tag.warn{background:rgba(245,158,11,.1);color:var(--amb)}
/* top bar */
#top{height:46px;border-bottom:1px solid rgba(0,229,255,.18);background:rgba(2,11,24,.97);backdrop-filter:blur(12px);
  display:flex;align-items:center;padding:0 12px;gap:10px;z-index:100;flex-shrink:0}
.tLogo{font-family:var(--mono);font-size:12px;color:var(--ion);font-weight:700;letter-spacing:2.5px;display:flex;align-items:center;gap:6px}
.tDot{width:8px;height:8px;border-radius:50%;background:var(--ion);box-shadow:0 0 10px var(--ion);animation:dp 1.5s ease-in-out infinite}
.tSep{width:1px;height:22px;background:rgba(0,229,255,.15)}
.tSt{display:flex;flex-direction:column;align-items:center;min-width:48px}
.tV{font-family:var(--mono);font-size:11px;font-weight:200}
.tL{font-size:6.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
.tV.g{color:var(--pulse)}.tV.r{color:var(--thr)}.tV.a{color:var(--amb)}
.tR{margin-left:auto;display:flex;align-items:center;gap:8px}
.mBadge{font-family:var(--mono);font-size:8px;padding:3px 8px;border-radius:4px;font-weight:700;letter-spacing:.5px;cursor:pointer;transition:all .2s}
.mBadge.active{background:rgba(0,255,157,.1);border:1px solid rgba(0,255,157,.3);color:var(--pulse)}
.mBadge.defensive{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:var(--amb)}
.mBadge.sleep{background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.2);color:var(--ion)}
.mBadge.vacation{background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);color:var(--pur)}
.tbBtn{font-size:8px;font-family:var(--mono);padding:4px 9px;border-radius:4px;cursor:pointer;font-weight:700;letter-spacing:.5px;transition:all .2s;border:none}
.tbBtnR{background:rgba(255,45,85,.08);border:1px solid rgba(255,45,85,.28)!important;color:var(--thr)}
.tbBtnR:hover{background:rgba(255,45,85,.2)}
.tbBtnP{background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.28)!important;color:var(--pur)}
.tbBtnP:hover{background:rgba(167,139,250,.2)}
.tbBtnB{background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.22)!important;color:var(--ion)}
.tbBtnB:hover{background:rgba(0,229,255,.15)}
/* workspace */
#ws{display:grid;grid-template-columns:245px 1fr 245px;gap:8px;padding:8px 8px 0;flex:1;min-height:0;overflow:hidden}
#lCol,#rCol{display:flex;flex-direction:column;gap:6px;overflow-y:auto;overflow-x:hidden;min-height:0;padding-bottom:6px}
#lCol::-webkit-scrollbar,#rCol::-webkit-scrollbar{width:2px}
#lCol::-webkit-scrollbar-thumb,#rCol::-webkit-scrollbar-thumb{background:rgba(0,229,255,.18);border-radius:2px}
#cCol{display:flex;flex-direction:column;gap:6px;overflow:hidden;min-height:0}
/* gates */
.gRow{display:flex;align-items:center;gap:5px;padding:3px 9px;border-bottom:1px solid rgba(0,229,255,.03);position:relative}
.gRow::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:0 2px 2px 0}
.gRow.pass::before{background:var(--pulse);box-shadow:0 0 4px var(--pulse)}
.gRow.off::before{background:var(--thr)}
.gRow.warn::before{background:var(--amb)}
.gIco{font-size:10px;width:13px;text-align:center;flex-shrink:0}
.gName{font-family:var(--mono);font-size:8.5px;flex:1;color:var(--txt)}
.gDesc{font-size:6.5px;color:var(--dim)}
.gVal{font-family:var(--mono);font-size:8px;white-space:nowrap}
.gVal.pass{color:var(--pulse)}.gVal.off{color:var(--thr)}.gVal.warn{color:var(--amb)}
/* news */
.nItem{padding:4px 9px;border-bottom:1px solid rgba(0,229,255,.04)}
.nHead{display:flex;align-items:center;gap:4px;margin-bottom:1px}
.nTag{font-size:6.5px;padding:1px 4px;border-radius:4px;font-family:var(--mono);font-weight:700;text-transform:uppercase}
.nHigh{background:rgba(255,45,85,.1);color:var(--thr)}
.nMed{background:rgba(245,158,11,.1);color:var(--amb)}
.nLow{background:rgba(0,229,255,.07);color:var(--ion)}
.nTitle{font-size:9.5px;color:var(--txt);line-height:1.35}
.nCurr{font-size:7px;color:var(--ion);font-family:var(--mono)}
.nTime{font-size:7px;color:var(--dim);font-family:var(--mono);margin-left:auto}
/* signal panel */
.sigBig{padding:7px 9px 4px}
.sigDir{font-family:var(--mono);font-size:18px;font-weight:200;line-height:1;display:flex;align-items:baseline;gap:6px}
.sigDir.long{color:var(--pulse)}.sigDir.short{color:var(--thr)}.sigDir.none{color:var(--dim)}
.sigSym{font-size:11px;color:var(--ion)}
.sigSub{font-size:7px;color:var(--dim);margin-top:2px;font-family:var(--mono)}
.sigGrid{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:4px 9px}
.sMeta{background:rgba(0,229,255,.04);border-radius:4px;padding:3px 6px}
.sMetaV{font-family:var(--mono);font-size:10px;color:var(--txt)}
.sMetaL{font-size:6.5px;color:var(--dim);margin-top:1px}
/* positions */
.posRow{display:flex;align-items:center;gap:4px;padding:3.5px 9px;border-bottom:1px solid rgba(0,229,255,.04)}
.pSym{font-family:var(--mono);font-size:10px;color:var(--ion);font-weight:700;width:48px}
.pDir{font-family:var(--mono);font-size:7px;padding:1px 4px;border-radius:3px}
.pDir.long{background:rgba(0,255,157,.1);color:var(--pulse)}.pDir.short{background:rgba(255,45,85,.1);color:var(--thr)}
.pInfo{flex:1}.pEntry{font-family:var(--mono);font-size:7.5px;color:var(--dim)}
.pPnl{font-family:var(--mono);font-size:10px}.pPnl.pos{color:var(--pulse)}.pPnl.neg{color:var(--thr)}
/* activity */
.aRow{display:flex;gap:5px;padding:2.5px 9px;align-items:flex-start}
.aDot{width:5px;height:5px;border-radius:50%;margin-top:3px;flex-shrink:0}
.aDot.g{background:var(--pulse)}.aDot.r{background:var(--thr)}.aDot.b{background:var(--ion)}.aDot.a{background:var(--amb)}
.aT{font-size:9.5px;line-height:1.3}.aT b{color:var(--ion)}
.aTm{font-family:var(--mono);font-size:6.5px;color:var(--dim)}
/* orb area */
#orbWrap{flex-shrink:0;background:var(--card);border:1px solid var(--b);border-radius:8px;position:relative;overflow:hidden;
  display:flex;flex-direction:column;align-items:center}
#orbWrap::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,229,255,.05) 0%,transparent 65%);pointer-events:none;z-index:0}
.orbStatus{font-family:var(--mono);font-size:7.5px;text-transform:uppercase;letter-spacing:2px;color:var(--ion);padding:0 0 7px;z-index:1;display:flex;align-items:center;gap:6px}
.orbDot{width:5px;height:5px;border-radius:50%;background:var(--pulse);animation:dp 1.5s ease-in-out infinite}
/* template strip */
#tplStrip{flex-shrink:0;background:var(--card);border:1px solid var(--b);border-radius:6px;overflow:hidden}
#tplRow{display:flex;gap:4px;padding:6px;overflow-x:auto}
#tplRow::-webkit-scrollbar{height:2px}
#tplRow::-webkit-scrollbar-thumb{background:rgba(0,229,255,.18)}
.tChip{flex-shrink:0;background:rgba(0,229,255,.04);border:1px solid rgba(0,229,255,.15);border-radius:5px;
  padding:4px 7px;cursor:pointer;transition:all .2s;min-width:80px;text-align:center}
.tChip:hover{background:rgba(0,229,255,.1);border-color:var(--ion)}
.tChip.dis{opacity:.35}
.tCG{font-size:12px;margin-bottom:2px}
.tCN{font-family:var(--mono);font-size:7.5px;color:var(--ion);font-weight:700;letter-spacing:.3px}
.tCS{font-family:var(--mono);font-size:9.5px;margin-top:1px}
.tCS.g{color:var(--pulse)}.tCS.a{color:var(--amb)}
.tcDNA{display:flex;gap:1px;justify-content:center;margin-top:2px}
.dNb{width:3.5px;height:5px;border-radius:1px}
.dNb.w{background:rgba(0,255,157,.65)}.dNb.l{background:rgba(255,45,85,.65)}.dNb.b{background:rgba(0,229,255,.35)}
/* jarvis chat */
#jConv{flex:1;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--b);border-radius:6px;overflow:hidden;min-height:0}
#jConvH{padding:5px 9px;border-bottom:1px solid var(--b2);display:flex;align-items:center;gap:5px;flex-shrink:0;background:rgba(0,229,255,.02)}
#jMsgs{flex:1;overflow-y:auto;padding:7px;display:flex;flex-direction:column;gap:4px;scroll-behavior:smooth}
#jMsgs::-webkit-scrollbar{width:2px}
#jMsgs::-webkit-scrollbar-thumb{background:rgba(0,229,255,.18)}
.jM{max-width:92%;animation:slideUp .25s ease}
.jM.j{align-self:flex-start}.jM.u{align-self:flex-end}
.jMB{padding:6px 9px;border-radius:7px;font-size:11px;line-height:1.5}
.jM.j .jMB{background:rgba(0,229,255,.06);border:1px solid rgba(0,229,255,.13);border-radius:2px 7px 7px 7px;color:var(--txt)}
.jM.j .jMB .px{font-family:var(--mono);font-size:7px;color:var(--ion);margin-bottom:2px;letter-spacing:.4px}
.jM.u .jMB{background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.22);border-radius:7px 2px 7px 7px;color:var(--txt)}
.jThink{display:inline-flex;gap:3px;align-items:center;padding:2px 0}
.jThink span{width:5px;height:5px;border-radius:50%;background:var(--pur);animation:jT 1.2s ease-in-out infinite}
.jThink span:nth-child(2){animation-delay:.2s}.jThink span:nth-child(3){animation-delay:.4s}
@keyframes jT{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1.1)}}
.jUrgent{color:var(--thr)!important;font-weight:600}
.jElevated{color:var(--amb)!important}
/* command bar */
#cmd{height:70px;border-top:1px solid rgba(0,229,255,.14);background:rgba(2,11,24,.97);padding:8px 12px;
  display:flex;flex-direction:column;gap:5px;flex-shrink:0}
.cmdR1{display:flex;align-items:center;gap:6px}
#cmdIn{flex:1;background:rgba(0,20,48,.55);border:1px solid rgba(0,229,255,.22);border-radius:5px;
  color:var(--txt);font-family:var(--mono);font-size:11px;padding:5px 10px;outline:none;transition:border-color .2s}
#cmdIn:focus{border-color:var(--ion);box-shadow:0 0 8px rgba(0,229,255,.1)}
#cmdIn::placeholder{color:var(--dim)}
.vBtn{width:30px;height:30px;border-radius:50%;background:rgba(0,229,255,.07);border:1px solid rgba(0,229,255,.28);
  color:var(--ion);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.vBtn:hover{background:rgba(0,229,255,.15)}
.qBtns{display:flex;gap:3px;flex-wrap:nowrap;overflow-x:auto}
.qBtns::-webkit-scrollbar{display:none}
.qB{background:rgba(0,229,255,.04);border:1px solid rgba(0,229,255,.16);color:var(--ion);font-family:var(--mono);
  font-size:8px;padding:2px 7px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:all .2s}
.qB:hover{background:rgba(0,229,255,.12)}
.qB.r{border-color:rgba(255,45,85,.28);color:var(--thr);background:rgba(255,45,85,.04)}.qB.r:hover{background:rgba(255,45,85,.14)}
.qB.p{border-color:rgba(167,139,250,.26);color:var(--pur);background:rgba(167,139,250,.04)}.qB.p:hover{background:rgba(167,139,250,.12)}
.qB.g{border-color:rgba(0,255,157,.26);color:var(--pulse);background:rgba(0,255,157,.04)}.qB.g:hover{background:rgba(0,255,157,.12)}
/* equity panel */
.eqBig{font-family:var(--mono);font-size:20px;font-weight:200;color:var(--ion);padding:6px 9px 1px}
.eqSub{font-size:7.5px;font-family:var(--mono);padding:0 9px 5px}
.goalBar{background:var(--b2);border-radius:3px;height:3px;margin:0 9px 5px;overflow:hidden}
.goalFill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--ion),var(--pulse));transition:width .5s}
/* modals */
.overlay{position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;
  background:rgba(2,11,24,.9);backdrop-filter:blur(7px)}
.modCard{background:var(--panel);border-radius:10px;width:min(900px,96vw);max-height:88vh;overflow:hidden;display:flex;flex-direction:column}
.modCard.nexCard{border:1px solid rgba(167,139,250,.4);box-shadow:0 0 60px rgba(167,139,250,.1)}
.modCard.logCard{border:1px solid rgba(0,229,255,.22)}
.modH{display:flex;align-items:center;gap:9px;padding:11px 15px;border-bottom:1px solid rgba(0,229,255,.1);background:rgba(0,229,255,.02);flex-shrink:0}
.modHN{font-family:var(--mono);font-size:13px;color:var(--ion);font-weight:700;flex:1}
.modHN.pur{color:var(--pur)}
.modClose{background:none;border:none;color:var(--dim);font-size:16px;cursor:pointer}
.modBody{flex:1;overflow-y:auto;padding:14px 15px}
.modBody::-webkit-scrollbar{width:3px}
.modBody::-webkit-scrollbar-thumb{background:rgba(0,229,255,.18)}
/* trade log */
.tblWrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:9px}
.tbl th{color:var(--dim);text-align:left;padding:4px 7px;border-bottom:1px solid rgba(0,229,255,.1);font-size:7px;
  text-transform:uppercase;letter-spacing:.4px;font-weight:400;white-space:nowrap}
.tbl td{padding:4px 7px;border-bottom:1px solid rgba(0,229,255,.04);vertical-align:middle}
.tbl tr:hover td{background:rgba(0,229,255,.025)}
.tblWin{color:var(--pulse)}.tblLoss{color:var(--thr)}.tblBE{color:var(--dim)}
.tblFilter{display:flex;gap:4px;margin-bottom:9px;flex-wrap:wrap}
.fBtn{background:rgba(0,229,255,.05);border:1px solid rgba(0,229,255,.16);color:var(--dim);font-family:var(--mono);
  font-size:7.5px;padding:2px 7px;border-radius:3px;cursor:pointer;transition:all .2s}
.fBtn.on{background:rgba(0,229,255,.12);border-color:var(--ion);color:var(--ion)}
/* nexus */
.nexGrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:14px}
.nexCard{background:rgba(167,139,250,.05);border:1px solid rgba(167,139,250,.16);border-radius:6px;padding:9px;text-align:center}
.nexCT{font-family:var(--mono);font-size:7px;color:var(--pur);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.nexCV{font-family:var(--mono);font-size:18px;font-weight:200}
.nexCL{font-size:7px;color:var(--dim);margin-top:2px}
.nexRec{background:rgba(0,229,255,.04);border:1px solid rgba(0,229,255,.1);border-radius:5px;padding:9px;
  margin-bottom:13px;font-size:10px;color:var(--txt);line-height:1.6}
.nexRec b{color:var(--ion)}
.nexBtns{display:flex;gap:7px}
.nexGen{background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.36);color:var(--pur);font-family:var(--mono);
  font-size:9.5px;padding:7px 16px;border-radius:5px;cursor:pointer;font-weight:700}
.nexClose{background:none;border:1px solid var(--dim);color:var(--dim);font-family:var(--mono);font-size:9.5px;padding:7px 12px;border-radius:5px;cursor:pointer}
.nexClose:hover{border-color:var(--ion);color:var(--ion)}
.tplStatGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;margin:10px 0}
.tplStat{background:rgba(0,20,48,.5);border:1px solid var(--b);border-radius:5px;padding:7px;text-align:center}
.tplStatV{font-family:var(--mono);font-size:13px;font-weight:200;margin-bottom:2px}
.tplStatL{font-size:7px;color:var(--dim);text-transform:uppercase;letter-spacing:.3px}
/* e-stop */
.eSBox{background:var(--panel);border:2px solid var(--thr);border-radius:10px;padding:26px;max-width:330px;
  width:90%;text-align:center;box-shadow:0 0 80px rgba(255,45,85,.2)}
.eST{font-family:var(--mono);font-size:17px;color:var(--thr);font-weight:900;margin-bottom:8px;letter-spacing:2px}
.eSM{font-size:10px;color:var(--dim);margin-bottom:18px;line-height:1.6}
.eSBtns{display:flex;gap:8px;justify-content:center}
.eSGo{background:var(--thr);color:#fff;border:none;padding:7px 20px;border-radius:5px;font-size:11px;font-family:var(--mono);font-weight:700;cursor:pointer}
.eSCancel{background:none;border:1px solid var(--dim);color:var(--dim);padding:7px 14px;border-radius:5px;font-size:11px;font-family:var(--mono);cursor:pointer}
.eSCancel:hover{border-color:var(--ion);color:var(--ion)}
/* focus dock */
#jFocus{flex-shrink:0;display:none;padding:0 4px 4px}
#jFocus.show{display:block;animation:slideUp .3s ease}
.fdCard{background:var(--card);border:1px solid var(--b);border-radius:6px;padding:7px 9px}
.fdTitle{font-size:7.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:5px;
  display:flex;justify-content:space-between;align-items:center}
.fdRow{display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(0,229,255,.05)}
.fdRow:last-child{border-bottom:none}
.fdK{font-size:7.5px;color:var(--dim)}.fdV{font-family:var(--mono);font-size:8px;font-weight:600;text-align:right}
.dismissBtn{background:none;border:1px solid rgba(0,229,255,.18);color:var(--dim);font-family:var(--mono);
  font-size:6.5px;padding:1px 6px;border-radius:3px;cursor:pointer}
.dismissBtn:hover{border-color:var(--ion);color:var(--ion)}
::-webkit-scrollbar{width:3px;height:3px}
::-webkit-scrollbar-thumb{background:rgba(0,229,255,.16);border-radius:2px}
`;

// ─── Constants ────────────────────────────────────────────────────────────────
const API = p => `/api/${p}`;

const TPLS = {
  'orb-pro':       { glyph: '⚡', label: 'ORB-PRO' },
  'silver-bullet': { glyph: '🥈', label: 'SILVER-BLT' },
  'alexg':         { glyph: '📐', label: 'ALEX-G' },
  'reaction-fvg':  { glyph: '🌀', label: 'REACT-FVG' },
  'reaction':      { glyph: '🎯', label: 'REACT-IMP' },
  'reaction-ifvg': { glyph: '🔄', label: 'REACT-IFVG' },
  'am-ifvg':       { glyph: '🌅', label: 'AM-IFVG' },
  'unicorn':       { glyph: '🦄', label: 'UNICORN' },
  'turtle-soup':   { glyph: '🐢', label: 'TURTLE-SOP' },
  'judas-swing':   { glyph: '🎭', label: 'JUDAS' },
  'orb':           { glyph: '🚀', label: 'ORB' },
  'ote-continuation': { glyph: '🎯', label: 'OTE-CONT' },
};

const SESSION_LABELS = {
  london: 'LONDON', london_open: 'LONDON', new_york: 'NEW YORK', ny_am: 'NY AM',
  ny_pm: 'NY PM', asian: 'ASIAN', sydney: 'SYDNEY', unknown: '—',
};

const MODE_LABELS = { active: '🟢 ACTIVE', defensive: '🛡 DEFENSIVE', sleep: '🌙 SLEEP', vacation: '🏖 VACATION' };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtMoney = (n, decimals = 0) =>
  typeof n === 'number' && isFinite(n)
    ? (n >= 0 ? '+' : '') + n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '—';

const fmtMoneyAbs = (n, decimals = 0) =>
  typeof n === 'number' && isFinite(n)
    ? '$' + Math.abs(n).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '—';

const fmtR = n => typeof n === 'number' && isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(1) + 'R' : '—';
const pct  = (n, d=0) => typeof n === 'number' && isFinite(n) ? (n*100).toFixed(d) + '%' : '—';

const fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const fmtRelTime = ts => {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff/60)}m ago`;
  return `${Math.round(diff/3600)}h ago`;
};

function tplLabel(id) {
  return TPLS[id]?.label || id?.toUpperCase() || '?';
}
function tplGlyph(id) {
  return TPLS[id]?.glyph || '⊕';
}
function sessLabel(s) {
  return SESSION_LABELS[s?.toLowerCase()] || s?.toUpperCase() || '—';
}

// ─── QB Nexus Real Analysis ───────────────────────────────────────────────────
function computeNexus(trades) {
  if (!trades || trades.length < 10) return null;

  const isWin  = t => t.outcome === 'WIN';
  const isLoss = t => t.outcome === 'LOSS';
  const rOf    = t => (typeof t.pnlR === 'number' && isFinite(t.pnlR)) ? t.pnlR : null;
  const avgArr = arr => arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;

  const total = trades.length;
  const overallWR  = trades.filter(isWin).length / total;
  const overallAvgR = avgArr(trades.map(rOf).filter(v => v !== null));

  // Per-template breakdown
  const byTpl = {};
  for (const t of trades) {
    const k = t.template || 'unknown';
    if (!byTpl[k]) byTpl[k] = { w:0, l:0, r:[] };
    if (isWin(t)) byTpl[k].w++;
    else if (isLoss(t)) byTpl[k].l++;
    const r = rOf(t); if (r !== null) byTpl[k].r.push(r);
  }
  const tplStats = Object.entries(byTpl)
    .map(([id, s]) => ({ id, total: s.w+s.l, wins: s.w, wr: s.w+s.l ? s.w/(s.w+s.l) : 0, avgR: avgArr(s.r) }))
    .filter(s => s.total >= 4)
    .sort((a,b) => b.wr - a.wr);

  // Per-session breakdown
  const bySess = {};
  for (const t of trades) {
    const k = t.session || 'unknown';
    if (!bySess[k]) bySess[k] = { w:0, total:0, r:[] };
    bySess[k].total++;
    if (isWin(t)) bySess[k].w++;
    const r = rOf(t); if (r !== null) bySess[k].r.push(r);
  }
  const sessStats = Object.entries(bySess)
    .map(([id, s]) => ({ id, total: s.total, wins: s.w, wr: s.total ? s.w/s.total : 0, avgR: avgArr(s.r) }))
    .filter(s => s.total >= 4)
    .sort((a,b) => b.wr - a.wr);

  const bestTpl  = tplStats[0] || null;
  const bestSess = sessStats[0] || null;

  // Nexus intersection: best template + best session + no high-impact news
  const nexus = trades.filter(t =>
    (!bestTpl  || t.template === bestTpl.id) &&
    (!bestSess || t.session  === bestSess.id) &&
    !t.highImpactWithin60min
  );

  const nWins  = nexus.filter(isWin).length;
  const nexusWR  = nexus.length ? nWins / nexus.length : 0;
  const nexusAvgR = avgArr(nexus.map(rOf).filter(v => v !== null));

  return {
    total, overallWR, overallAvgR, tplStats, sessStats,
    bestTpl, bestSess,
    nexusSample: nexus.length,
    nexusWR, nexusAvgR,
    confidence: nexus.length >= 25 ? 'HIGH' : nexus.length >= 12 ? 'MEDIUM' : 'LOW',
    nexusTrades: nexus,
  };
}

// ─── Orb Canvas ───────────────────────────────────────────────────────────────
function OrbCanvas({ state }) {
  const canvasRef = useRef(null);
  const animRef   = useRef(null);
  const t0        = useRef(Date.now());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W/2, cy = H/2;

    const color = state === 'signal' ? '#00ff9d' : state === 'warn' ? '#f59e0b' : state === 'critical' ? '#ff2d55' : '#00e5ff';
    const rgb   = state === 'signal' ? '0,255,157' : state === 'warn' ? '245,158,11' : state === 'critical' ? '255,45,85' : '0,229,255';

    const draw = () => {
      const now = (Date.now() - t0.current) / 1000;
      ctx.clearRect(0, 0, W, H);

      // outer glow
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 80);
      g.addColorStop(0, `rgba(${rgb},.1)`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // rings
      [70, 54, 38].forEach((r, i) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r + Math.sin(now * (0.5 + i * 0.2)) * 2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${0.15 + i * 0.05})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // rotating particles
      for (let i = 0; i < 8; i++) {
        const angle = (now * 0.6 + (i / 8) * Math.PI * 2);
        const rx = cx + Math.cos(angle) * 54;
        const ry = cy + Math.sin(angle) * 54;
        ctx.beginPath();
        ctx.arc(rx, ry, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${0.3 + 0.3 * Math.sin(now * 2 + i)})`;
        ctx.fill();
      }

      // inner pulse
      const pulse = 0.7 + 0.3 * Math.sin(now * 2);
      const gi = ctx.createRadialGradient(cx, cy, 0, cx, cy, 24 * pulse);
      gi.addColorStop(0, `rgba(${rgb},.7)`);
      gi.addColorStop(0.5, `rgba(${rgb},.25)`);
      gi.addColorStop(1, 'transparent');
      ctx.fillStyle = gi;
      ctx.beginPath();
      ctx.arc(cx, cy, 24 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // core dot
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      animRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [state]);

  return <canvas ref={canvasRef} width={160} height={160} style={{ display:'block', position:'relative', zIndex:1 }} />;
}

// ─── Gate Row ─────────────────────────────────────────────────────────────────
function GateRow({ icon, name, desc, value, status }) {
  return (
    <div className={`gRow ${status}`}>
      <span className="gIco">{icon}</span>
      <div style={{flex:1}}>
        <div className="gName">{name}</div>
        {desc && <div className="gDesc">{desc}</div>}
      </div>
      <span className={`gVal ${status}`}>{value}</span>
    </div>
  );
}

// ─── Gates Panel ─────────────────────────────────────────────────────────────
function GatesPanel({ jarvisState, rules }) {
  const kz   = jarvisState?.killZone;
  const cb   = jarvisState?.circuitBreakers || {};
  const mode = rules?.activeMode || 'active';

  const gatingRules = jarvisState?.gatingRules || {};
  const blockedTpls = Object.entries(gatingRules)
    .filter(([k, v]) => v === false || v?.enabled === false)
    .map(([k]) => k);

  const gates = [
    {
      icon: '⏱', name: 'Kill Zone', desc: kz?.label || '—',
      value: kz?.inKillZone ? kz.label : (kz?.minutesUntilNext ? `in ${kz.minutesUntilNext}m` : 'INACTIVE'),
      status: kz?.inKillZone ? 'pass' : 'warn',
    },
    {
      icon: '🎯', name: 'Active Mode', desc: 'Bot behavioral posture',
      value: mode.toUpperCase(),
      status: mode === 'active' ? 'pass' : mode === 'defensive' ? 'warn' : 'off',
    },
    {
      icon: '🔄', name: 'Trading Mode', desc: rules?.tradingMode === 'auto' ? 'Auto-execute signals' : 'Alert only',
      value: (rules?.tradingMode || 'auto').toUpperCase(),
      status: rules?.tradingMode === 'auto' ? 'pass' : 'warn',
    },
    {
      icon: '📏', name: 'Lot Multiplier', desc: `Tier A × ${rules?.tierALotMultiplier?.toFixed(2) || '1.00'} · Tier B × ${rules?.tierBLotMultiplier?.toFixed(2) || '1.00'}`,
      value: `×${(rules?.tierBLotMultiplier || 1).toFixed(2)}`,
      status: (rules?.tierBLotMultiplier || 1) >= 1 ? 'pass' : 'warn',
    },
    {
      icon: '🚫', name: 'OTE-Continuation', desc: 'Permanently disabled',
      value: 'BLOCKED', status: 'off',
    },
    {
      icon: '⚡', name: 'SB Immediate', desc: 'Silver Bullet immediate-only',
      value: 'ENFORCED', status: 'pass',
    },
    {
      icon: '📋', name: 'Blocked Templates', desc: blockedTpls.length ? blockedTpls.join(', ') : 'none',
      value: blockedTpls.length ? `${blockedTpls.length} blocked` : 'ALL CLEAR',
      status: blockedTpls.length ? 'warn' : 'pass',
    },
  ];

  const passCount = gates.filter(g => g.status === 'pass').length;

  return (
    <div className="pnl" style={{flexShrink:0}}>
      <div className="pH">
        <span className="pHL">Signal Gates</span>
        <span className="tag ai">{passCount}/{gates.length}</span>
      </div>
      <div style={{padding:'4px 0'}}>
        {gates.map((g,i) => <GateRow key={i} {...g} />)}
      </div>
    </div>
  );
}

// ─── News Panel ───────────────────────────────────────────────────────────────
function NewsPanel({ news }) {
  const events = useMemo(() => {
    const list = news?.upcoming || news?.events || [];
    return list.filter(e => e.ts > Date.now()).slice(0, 6);
  }, [news]);

  return (
    <div className="pnl" style={{flexShrink:0}}>
      <div className="pH">
        <span className="pHL">News Feed</span>
        <span className="tag ai">LIVE</span>
      </div>
      {events.length === 0 && (
        <div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No high-impact events in next 12h</div>
      )}
      {events.map((e,i) => {
        const impClass = e.impact === 'high' ? 'nHigh' : e.impact === 'medium' ? 'nMed' : 'nLow';
        const minsAway = Math.round((e.ts - Date.now()) / 60000);
        return (
          <div className="nItem" key={i}>
            <div className="nHead">
              <span className={`nTag ${impClass}`}>{e.impact}</span>
              <span className="nCurr">{e.currency}</span>
              <span className="nTime">{minsAway < 60 ? `${minsAway}m` : `${Math.round(minsAway/60)}h`}</span>
            </div>
            <div className="nTitle">{e.title}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Signal Panel ─────────────────────────────────────────────────────────────
function SignalPanel({ jarvisState }) {
  const watchers = jarvisState?.watchers || {};
  const activeAssets = Object.entries(watchers).filter(([,w]) => w?.currentSetup || w?.direction);
  const best = activeAssets[0];
  const w    = best?.[1];
  const asset = best?.[0];

  if (!w) {
    return (
      <div className="pnl" style={{flexShrink:0}}>
        <div className="pH"><span className="pHL">Live Signal</span></div>
        <div className="sigBig">
          <div className="sigDir none">SCANNING<span className="sigSym">—</span></div>
          <div className="sigSub">No active setups across all instruments</div>
        </div>
      </div>
    );
  }

  const dir = (w.direction || 'long').toLowerCase();
  const template = w.currentSetup?.template || w.template || '—';
  const knnWR = w.knnWR || jarvisState?.sigQual?.knnWinRate;

  return (
    <div className="pnl" style={{flexShrink:0}}>
      <div className="pH">
        <span className="pHL">Live Signal</span>
        <span className="tag live">ACTIVE</span>
      </div>
      <div className="sigBig">
        <div className={`sigDir ${dir}`}>
          {dir === 'long' ? 'LONG' : 'SHORT'}
          <span className="sigSym">{asset?.toUpperCase()}</span>
        </div>
        <div className="sigSub">{tplLabel(template)} · {sessLabel(jarvisState?.killZone?.label)}</div>
      </div>
      <div className="sigGrid">
        <div className="sMeta"><div className="sMetaV">{tplLabel(template)}</div><div className="sMetaL">Template</div></div>
        <div className="sMeta"><div className="sMetaV">{knnWR ? pct(knnWR,0) : '—'}</div><div className="sMetaL">KNN Match</div></div>
        <div className="sMeta"><div className="sMetaV">{w.pendingCount || '—'}</div><div className="sMetaL">Pending</div></div>
        <div className="sMeta"><div className="sMetaV">{jarvisState?.sigQual?.knnAvgR ? fmtR(jarvisState.sigQual.knnAvgR) : '—'}</div><div className="sMetaL">Avg R</div></div>
      </div>
    </div>
  );
}

// ─── Template Strip ───────────────────────────────────────────────────────────
function TemplateStrip({ rules, trades, onSelectTpl }) {
  const tplIds = Object.keys(rules?.templateOverrides || TPLS);

  const dnaMap = useMemo(() => {
    const m = {};
    for (const t of (trades || [])) {
      const id = t.template || 'unknown';
      if (!m[id]) m[id] = [];
      m[id].push(t.outcome);
    }
    return m;
  }, [trades]);

  const wrMap = useMemo(() => {
    const m = {};
    for (const id of tplIds) {
      const arr = dnaMap[id] || [];
      if (!arr.length) { m[id] = null; continue; }
      const wins = arr.filter(o => o === 'WIN').length;
      m[id] = wins / arr.length;
    }
    return m;
  }, [dnaMap, tplIds]);

  return (
    <div id="tplStrip">
      <div className="pH">
        <span className="pHL">Templates · {trades?.length || 0} trades</span>
        <button onClick={() => onSelectTpl('log')} className="tbBtnB tbBtn" style={{fontSize:7.5}}>Trade Log</button>
      </div>
      <div id="tplRow">
        {tplIds.map(id => {
          const meta   = TPLS[id] || { glyph:'⊕', label: id.toUpperCase() };
          const ov     = rules?.templateOverrides?.[id] || {};
          const enabled = ov.enabled !== false;
          const wr     = wrMap[id];
          const dna    = (dnaMap[id] || []).slice(-12);

          return (
            <div key={id} className={`tChip ${!enabled ? 'dis' : ''}`} onClick={() => onSelectTpl(id)}>
              <div className="tCG">{meta.glyph}</div>
              <div className="tCN">{meta.label}</div>
              <div className={`tCS ${wr !== null ? (wr >= 0.5 ? 'g' : 'a') : ''}`}>
                {wr !== null ? pct(wr,0) : (dnaMap[id]?.length ? pct(0,0) : '—')}
              </div>
              <div className="tcDNA">
                {dna.map((o,i) => (
                  <div key={i} className={`dNb ${o === 'WIN' ? 'w' : o === 'LOSS' ? 'l' : 'b'}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Positions Panel ──────────────────────────────────────────────────────────
function PositionsPanel({ positions }) {
  if (!positions?.length) return (
    <div className="pnl">
      <div className="pH"><span className="pHL">Open Positions</span></div>
      <div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No open positions</div>
    </div>
  );

  return (
    <div className="pnl">
      <div className="pH">
        <span className="pHL">Open Positions</span>
        <span className="tag live">{positions.length}</span>
      </div>
      {positions.map((p,i) => {
        const isLong = (p.type === 'POSITION_TYPE_BUY' || p.type === 'BUY' || p.type === 0);
        const pnl = p.profit ?? p.unrealizedProfit ?? 0;
        const sym = (p.symbol || p.id || '').replace(/^.*\//, '').toUpperCase();
        return (
          <div className="posRow" key={i}>
            <span className="pSym">{sym.slice(0, 8)}</span>
            <span className={`pDir ${isLong ? 'long' : 'short'}`}>{isLong ? 'BUY' : 'SELL'}</span>
            <div className="pInfo">
              <div className="pEntry">{p.volume ? `${p.volume} lot` : ''} · {p.openPrice?.toFixed(p.openPrice > 100 ? 2 : 5) || ''}</div>
            </div>
            <span className={`pPnl ${pnl >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(pnl,2)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Equity Panel ─────────────────────────────────────────────────────────────
function EquityPanel({ account, dailyPnL, goals }) {
  const equity = account?.equity ?? account?.balance ?? 0;
  const balance = account?.balance ?? equity;
  const float   = account?.profit ?? 0;
  const dailyGoal = goals?.daily?.target || 0;
  const dailyAchieved = goals?.daily?.achieved ?? Math.max(0, dailyPnL);
  const goalPct = dailyGoal > 0 ? Math.min(100, (dailyAchieved / dailyGoal) * 100) : 0;

  return (
    <div className="pnl">
      <div className="pH">
        <span className="pHL">Account</span>
        {dailyGoal > 0 && <span className="tag ai">{goalPct.toFixed(0)}% goal</span>}
      </div>
      <div className="eqBig">{equity ? `$${equity.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</div>
      <div className="eqSub" style={{color: dailyPnL >= 0 ? 'var(--pulse)' : 'var(--thr)'}}>
        Today {fmtMoney(dailyPnL,2)} · Float {fmtMoney(float,2)}
      </div>
      {dailyGoal > 0 && (
        <>
          <div className="goalBar"><div className="goalFill" style={{width:`${goalPct}%`}} /></div>
          <div style={{padding:'0 9px 5px',fontSize:7.5,color:'var(--dim)',fontFamily:'var(--mono)'}}>
            Goal {fmtMoneyAbs(dailyAchieved)} / {fmtMoneyAbs(dailyGoal)} daily
          </div>
        </>
      )}
      <div style={{display:'flex',gap:7,padding:'3px 9px 6px',flexWrap:'wrap'}}>
        <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--mono)'}}>
          BAL <span style={{color:'var(--txt)'}}>{balance ? `$${balance.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—'}</span>
        </span>
        {goals?.monthly?.target > 0 && (
          <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--mono)'}}>
            MTH <span style={{color:'var(--pulse)'}}>
              {pct((goals.monthly.achieved||0)/goals.monthly.target,0)}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Activity Panel ───────────────────────────────────────────────────────────
function ActivityPanel({ activity }) {
  const items = useMemo(() => (activity || []).slice(0,20), [activity]);

  const dotColor = type => {
    if (!type) return 'b';
    const t = type.toLowerCase();
    if (t.includes('win') || t.includes('tp') || t.includes('profit')) return 'g';
    if (t.includes('loss') || t.includes('sl') || t.includes('error')) return 'r';
    if (t.includes('warn') || t.includes('skip') || t.includes('block')) return 'a';
    return 'b';
  };

  return (
    <div className="pnl" style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}>
      <div className="pH"><span className="pHL">Activity Log</span></div>
      <div style={{flex:1,overflowY:'auto',padding:'3px 0'}}>
        {items.length === 0 && <div style={{padding:'8px 9px',color:'var(--dim)',fontSize:9}}>No activity yet</div>}
        {items.map((a,i) => (
          <div className="aRow" key={i}>
            <div className={`aDot ${dotColor(a.type)}`} />
            <div>
              <div className="aT" dangerouslySetInnerHTML={{__html: (a.message || a.msg || '').replace(/\b(WIN|LOSS|BE|BLOCKED|SKIP)\b/g, '<b>$1</b>')}} />
              <div className="aTm">{fmtRelTime(a.ts)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── JARVIS Chat ──────────────────────────────────────────────────────────────
function JarvisChat({ messages, thinking, focusDock, onDismissFocus }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  return (
    <div id="jConv">
      <div id="jConvH">
        <div style={{width:6,height:6,borderRadius:'50%',background:'var(--pur)',animation:'dp 1.5s ease-in-out infinite'}} />
        <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--pur)',letterSpacing:1.5,fontWeight:700}}>JARVIS · AI CO-PILOT</span>
        <span className="tag ai" style={{marginLeft:'auto'}}>LIVE</span>
      </div>
      {focusDock && (
        <div id="jFocus" className="show">
          <div className="fdCard">
            <div className="fdTitle">
              <span>{focusDock.title || 'JARVIS FOCUS'}</span>
              <button className="dismissBtn" onClick={onDismissFocus}>dismiss</button>
            </div>
            {(focusDock.rows || []).map((row,i) => (
              <div className="fdRow" key={i}>
                <span className="fdK">{row.k}</span>
                <span className="fdV" style={{color: row.color || 'var(--txt)'}}>{row.v}</span>
              </div>
            ))}
            {focusDock.bar != null && (
              <div className="goalBar" style={{marginTop:5}}>
                <div className="goalFill" style={{width:`${Math.min(100,focusDock.bar*100)}%`}} />
              </div>
            )}
          </div>
        </div>
      )}
      <div id="jMsgs">
        {messages.map((m,i) => (
          <div key={i} className={`jM ${m.role === 'jarvis' ? 'j' : 'u'}`}>
            <div className={`jMB ${m.urgency === 'critical' ? 'jUrgent' : m.urgency === 'elevated' ? 'jElevated' : ''}`}>
              {m.role === 'jarvis' && <div className="px">JARVIS · {fmtTime(m.ts)}</div>}
              {m.text}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="jM j">
            <div className="jMB">
              <div className="px">JARVIS · processing…</div>
              <div className="jThink"><span/><span/><span/></div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── Trade Log Modal ──────────────────────────────────────────────────────────
function TradeLogModal({ trades, onClose }) {
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let arr = trades || [];
    if (filter !== 'ALL') arr = arr.filter(t => t.outcome === filter);
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter(t => (t.asset||'').includes(q) || (t.template||'').includes(q) || (t.session||'').includes(q));
    }
    return arr.slice().sort((a,b) => (b.closedAt||0) - (a.closedAt||0));
  }, [trades, filter, search]);

  const wins   = filtered.filter(t => t.outcome === 'WIN').length;
  const losses = filtered.filter(t => t.outcome === 'LOSS').length;
  const wrLive = filtered.length ? pct(wins/filtered.length,0) : '—';
  const rVals  = filtered.map(t => t.pnlR).filter(v => typeof v === 'number' && isFinite(v));
  const avgR   = rVals.length ? (rVals.reduce((a,b)=>a+b,0)/rVals.length).toFixed(2) : '—';

  return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard logCard">
        <div className="modH">
          <span className="modHN">📊 Trade Log · {trades?.length || 0} total</span>
          <span style={{fontFamily:'var(--mono)',fontSize:9,color:'var(--dim)'}}>WR {wrLive} · Avg R {avgR}R · {wins}W / {losses}L</span>
          <button className="modClose" onClick={onClose}>✕</button>
        </div>
        <div className="modBody">
          <div style={{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap',alignItems:'center'}}>
            <div className="tblFilter">
              {['ALL','WIN','LOSS','BREAKEVEN'].map(f => (
                <button key={f} className={`fBtn ${filter===f?'on':''}`} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Filter by asset, template…"
              style={{background:'rgba(0,20,48,.5)',border:'1px solid var(--b)',borderRadius:4,color:'var(--txt)',
                fontFamily:'var(--mono)',fontSize:9,padding:'3px 8px',outline:'none',flex:1,minWidth:140}}
            />
            <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>{filtered.length} rows</span>
          </div>
          <div className="tblWrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th><th>Asset</th><th>Dir</th><th>Template</th>
                  <th>Session</th><th>Outcome</th><th>PnL</th><th>R</th><th>Hold</th><th>KNN</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0,300).map((t,i) => {
                  const oc = t.outcome === 'WIN' ? 'tblWin' : t.outcome === 'LOSS' ? 'tblLoss' : 'tblBE';
                  return (
                    <tr key={i}>
                      <td style={{color:'var(--dim)',whiteSpace:'nowrap'}}>{fmtTime(t.closedAt)}</td>
                      <td style={{color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                      <td>
                        <span style={{fontSize:7,padding:'1px 4px',borderRadius:3,
                          background: t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',
                          color: t.direction==='long'?'var(--pulse)':'var(--thr)'}}>
                          {(t.direction||'?').toUpperCase()}
                        </span>
                      </td>
                      <td style={{color:'var(--txt)'}}>{tplLabel(t.template)}</td>
                      <td style={{color:'var(--dim)'}}>{sessLabel(t.session)}</td>
                      <td className={oc}>{t.outcome}</td>
                      <td className={oc}>{fmtMoney(t.pnl,2)}</td>
                      <td className={oc}>{fmtR(t.pnlR)}</td>
                      <td style={{color:'var(--dim)'}}>{t.holdTimeMinutes != null ? `${t.holdTimeMinutes}m` : '—'}</td>
                      <td style={{color:'var(--dim)'}}>{t.qualityTier || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── QB Nexus Modal ───────────────────────────────────────────────────────────
function NexusModal({ trades, onClose }) {
  const nexus = useMemo(() => computeNexus(trades), [trades]);

  if (!nexus) return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard nexCard" style={{padding:24,textAlign:'center'}}>
        <div style={{color:'var(--pur)',fontFamily:'var(--mono)',fontSize:14,fontWeight:800,marginBottom:8}}>⬡ QB-NEXUS</div>
        <div style={{color:'var(--dim)',fontSize:10}}>Insufficient trade data (need ≥ 10 closed trades)</div>
        <button className="nexClose" style={{marginTop:16}} onClick={onClose}>Close</button>
      </div>
    </div>
  );

  const realWR  = pct(nexus.nexusWR,1);
  const baseWR  = pct(nexus.overallWR,1);
  const lift    = ((nexus.nexusWR - nexus.overallWR)*100).toFixed(1);

  return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard nexCard">
        <div className="modH">
          <span className="modHN pur">⬡ QB-NEXUS · Real Analysis</span>
          <span style={{fontFamily:'var(--mono)',fontSize:8,color:'var(--dim)'}}>{nexus.total} trades analysed</span>
          <button className="modClose" onClick={onClose}>✕</button>
        </div>
        <div className="modBody">
          <div className="nexGrid">
            <div className="nexCard">
              <div className="nexCT">Nexus WR</div>
              <div className="nexCV" style={{color:'var(--pulse)'}}>{realWR}</div>
              <div className="nexCL">vs {baseWR} overall ({lift >= 0 ? '+':''}{lift}pp lift)</div>
            </div>
            <div className="nexCard">
              <div className="nexCT">Nexus Avg R</div>
              <div className="nexCV" style={{color:'var(--ion)'}}>{fmtR(nexus.nexusAvgR)}</div>
              <div className="nexCL">vs {fmtR(nexus.overallAvgR)} overall</div>
            </div>
            <div className="nexCard">
              <div className="nexCT">Confidence</div>
              <div className="nexCV" style={{color:'var(--pur)'}}>{nexus.confidence}</div>
              <div className="nexCL">{nexus.nexusSample} qualifying trades</div>
            </div>
          </div>

          <div className="nexRec">
            <b>⬡ QB-NEXUS</b> optimal conditions identified from real data:<br/>
            {nexus.bestTpl && <><b>Best template:</b> {tplLabel(nexus.bestTpl.id)} ({pct(nexus.bestTpl.wr,1)} WR on {nexus.bestTpl.total} trades) <br/></>}
            {nexus.bestSess && <><b>Best session:</b> {sessLabel(nexus.bestSess.id)} ({pct(nexus.bestSess.wr,1)} WR on {nexus.bestSess.total} trades)<br/></>}
            <b>No-news filter:</b> exclude trades within 60m of high-impact events<br/>
            <b>Intersection sample:</b> {nexus.nexusSample} trades · {realWR} WR · {fmtR(nexus.nexusAvgR)} avg R
            {nexus.confidence === 'LOW' && <><br/><span style={{color:'var(--amb)'}}>⚠ Sample size low — use as directional guidance only</span></>}
          </div>

          <div style={{fontSize:9,color:'var(--dim)',marginBottom:6,fontFamily:'var(--mono)',textTransform:'uppercase',letterSpacing:.5}}>Template Breakdown (all {nexus.total} trades)</div>
          <div className="tplStatGrid">
            {nexus.tplStats.map((s,i) => (
              <div className="tplStat" key={i}>
                <div className="tplStatV" style={{color: s.wr>=0.6?'var(--pulse)':s.wr>=0.45?'var(--ion)':'var(--thr)'}}>
                  {pct(s.wr,1)}
                </div>
                <div style={{fontFamily:'var(--mono)',fontSize:7,color:'var(--ion)',marginBottom:3}}>{tplLabel(s.id)}</div>
                <div className="tplStatL">{s.total} trades · {fmtR(s.avgR)}</div>
              </div>
            ))}
          </div>

          <div style={{fontSize:9,color:'var(--dim)',marginBottom:6,marginTop:10,fontFamily:'var(--mono)',textTransform:'uppercase',letterSpacing:.5}}>Session Breakdown</div>
          <div className="tplStatGrid">
            {nexus.sessStats.map((s,i) => (
              <div className="tplStat" key={i}>
                <div className="tplStatV" style={{color: s.wr>=0.6?'var(--pulse)':s.wr>=0.45?'var(--ion)':'var(--thr)'}}>
                  {pct(s.wr,1)}
                </div>
                <div style={{fontFamily:'var(--mono)',fontSize:7,color:'var(--ion)',marginBottom:3}}>{sessLabel(s.id)}</div>
                <div className="tplStatL">{s.total} trades · {fmtR(s.avgR)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Template Detail Modal ────────────────────────────────────────────────────
function TemplateModal({ tplId, trades, rules, onClose }) {
  const meta  = TPLS[tplId] || { glyph:'⊕', label: tplId };
  const tTrades = useMemo(() => (trades||[]).filter(t => t.template === tplId), [trades, tplId]);
  const wins  = tTrades.filter(t => t.outcome === 'WIN').length;
  const losses= tTrades.filter(t => t.outcome === 'LOSS').length;
  const wr    = tTrades.length ? wins/tTrades.length : 0;
  const rVals = tTrades.map(t=>t.pnlR).filter(v=>typeof v==='number'&&isFinite(v));
  const avgR  = rVals.length ? rVals.reduce((a,b)=>a+b,0)/rVals.length : 0;
  const recent= tTrades.slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)).slice(0,50);
  const ov    = rules?.templateOverrides?.[tplId] || {};

  return (
    <div className="overlay" onClick={e => e.target.className.includes('overlay') && onClose()}>
      <div className="modCard logCard">
        <div className="modH">
          <span style={{fontSize:20}}>{meta.glyph}</span>
          <span className="modHN">{meta.label}</span>
          <button className="modClose" onClick={onClose}>✕</button>
        </div>
        <div className="modBody">
          <div className="tplStatGrid" style={{gridTemplateColumns:'repeat(4,1fr)'}}>
            <div className="tplStat"><div className="tplStatV" style={{color:'var(--pulse)'}}>{pct(wr,1)}</div><div className="tplStatL">Win Rate</div></div>
            <div className="tplStat"><div className="tplStatV" style={{color:'var(--ion)'}}>{fmtR(avgR)}</div><div className="tplStatL">Avg R</div></div>
            <div className="tplStat"><div className="tplStatV">{tTrades.length}</div><div className="tplStatL">Total Trades</div></div>
            <div className="tplStat"><div className="tplStatV" style={{color: ov.enabled!==false?'var(--pulse)':'var(--thr)'}}>{ov.enabled!==false?'ON':'OFF'}</div><div className="tplStatL">Status</div></div>
          </div>
          <div style={{display:'flex',gap:1.5,margin:'10px 0',overflow:'hidden',height:24,borderRadius:4}}>
            {tTrades.slice(-60).map((t,i) => (
              <div key={i} style={{flex:1,minWidth:4,background:t.outcome==='WIN'?'rgba(0,255,157,.7)':t.outcome==='LOSS'?'rgba(255,45,85,.7)':'rgba(0,229,255,.25)',borderRadius:1}} />
            ))}
            {tTrades.length === 0 && <div style={{color:'var(--dim)',fontSize:9,padding:'4px 0'}}>No trade data</div>}
          </div>
          <div style={{fontSize:8,color:'var(--dim)',marginBottom:8,fontFamily:'var(--mono)'}}>Recent trades (trade DNA · last 60)</div>
          <div className="tblWrap">
            <table className="tbl">
              <thead><tr><th>Time</th><th>Asset</th><th>Dir</th><th>Session</th><th>Outcome</th><th>PnL</th><th>R</th></tr></thead>
              <tbody>
                {recent.map((t,i) => {
                  const oc = t.outcome==='WIN'?'tblWin':t.outcome==='LOSS'?'tblLoss':'tblBE';
                  return (
                    <tr key={i}>
                      <td style={{color:'var(--dim)'}}>{fmtTime(t.closedAt)}</td>
                      <td style={{color:'var(--ion)',fontWeight:700}}>{(t.asset||'?').toUpperCase()}</td>
                      <td><span style={{fontSize:7,padding:'1px 4px',borderRadius:3,background:t.direction==='long'?'rgba(0,255,157,.1)':'rgba(255,45,85,.1)',color:t.direction==='long'?'var(--pulse)':'var(--thr)'}}>{(t.direction||'?').toUpperCase()}</span></td>
                      <td style={{color:'var(--dim)'}}>{sessLabel(t.session)}</td>
                      <td className={oc}>{t.outcome}</td>
                      <td className={oc}>{fmtMoney(t.pnl,2)}</td>
                      <td className={oc}>{fmtR(t.pnlR)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [account,     setAccount]     = useState(null);
  const [positions,   setPositions]   = useState([]);
  const [rules,       setRules]       = useState(null);
  const [activity,    setActivity]    = useState([]);
  const [dailyPnL,    setDailyPnL]    = useState(0);
  const [trades,      setTrades]      = useState([]);
  const [jarvisState, setJarvisState] = useState(null);
  const [goals,       setGoals]       = useState(null);
  const [news,        setNews]        = useState(null);
  const [messages,    setMessages]    = useState([]);
  const [thinking,    setThinking]    = useState(false);
  const [modal,       setModal]       = useState(null); // null | {type:'log'|'nexus'|'tpl'|'estop', id?}
  const [focusDock,   setFocusDock]   = useState(null);
  const [clock,       setClock]       = useState('');
  const [input,       setInput]       = useState('');
  const [ambClass,    setAmbClass]    = useState('monitor');
  const inputRef = useRef(null);

  // ── Clock ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const ny = new Date(d.toLocaleString('en-US',{timeZone:'America/New_York'}));
      setClock(ny.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) + ' NY');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Data polling ───────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const fast = async () => {
      try {
        const [a, p] = await Promise.all([
          fetch(API('broker?action=account')).then(r=>r.json()).catch(()=>null),
          fetch(API('broker?action=positions')).then(r=>r.json()).catch(()=>[]),
        ]);
        if (!alive) return;
        if (a && !a.error) setAccount(a);
        setPositions(Array.isArray(p) ? p : []);
      } catch (_) {}
    };
    fast();
    const id = setInterval(fast, 5000);
    return () => { alive=false; clearInterval(id); };
  }, []);

  useEffect(() => {
    let alive = true;
    const slow = async () => {
      try {
        const [r, act, pnl, js, g, n] = await Promise.all([
          fetch(API('rules')).then(r=>r.json()).catch(()=>null),
          fetch(API('rules?action=activity&limit=60')).then(r=>r.json()).catch(()=>null),
          fetch(API('manage-trades?action=today-pnl')).then(r=>r.json()).catch(()=>null),
          fetch(API('jarvis-state')).then(r=>r.json()).catch(()=>null),
          fetch(API('jarvis-goal')).then(r=>r.json()).catch(()=>null),
          fetch(API('news-context')).then(r=>r.json()).catch(()=>null),
        ]);
        if (!alive) return;
        if (r && !r.error)            setRules(r);
        if (act?.activity)            setActivity(act.activity);
        if (pnl?.pnl != null)         setDailyPnL(pnl.pnl);
        else if (pnl?.ok === false) {
          // fallback
          fetch(API('rules?action=daily-pnl')).then(r=>r.json()).then(r2 => { if(alive && r2?.pnl!=null) setDailyPnL(r2.pnl); }).catch(()=>{});
        }
        if (js && !js.error)          setJarvisState(js);
        if (g && !g.error)            setGoals(g);
        if (n && !n.error)            setNews(n);
      } catch (_) {}
    };
    slow();
    const id = setInterval(slow, 20000);
    return () => { alive=false; clearInterval(id); };
  }, []);

  // Load all trades once, then refresh every 5 minutes
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(API('recognition-memory?action=list&limit=600')).then(r=>r.json());
        if (alive && Array.isArray(r)) setTrades(r);
        else if (alive && Array.isArray(r?.trades)) setTrades(r.trades);
      } catch (_) {}
    };
    load();
    const id = setInterval(load, 300000);
    return () => { alive=false; clearInterval(id); };
  }, []);

  // ── Ambient glow from jarvis urgency ──────────────────────────────────────
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'jarvis') return;
    if (last.urgency === 'critical')      setAmbClass('critical');
    else if (last.urgency === 'elevated') setAmbClass('warn');
    else                                  setAmbClass('monitor');
  }, [messages]);

  // ── JARVIS send ────────────────────────────────────────────────────────────
  const sendToJarvis = useCallback(async (text) => {
    if (!text.trim() || thinking) return;
    const userMsg = { role:'user', text: text.trim(), ts: Date.now() };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setThinking(true);
    try {
      const res = await fetch(API('jarvis'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim(), base: window.location.origin }),
      });
      const data = await res.json();
      const reply = {
        role: 'jarvis',
        text: data.speech || 'No response.',
        urgency: data.urgency,
        focusPanel: data.focusPanel,
        action: data.action,
        ts: Date.now(),
      };
      setMessages(m => [...m, reply]);

      // Build focus dock from JARVIS response
      if (data.focusPanel === 'goal' && goals) {
        const achieved = goals.daily.achieved ?? dailyPnL;
        const target   = goals.daily.target;
        setFocusDock({
          title: 'GOAL PROGRESS',
          rows: [
            { k: 'Today banked', v: fmtMoneyAbs(achieved,2), color: 'var(--pulse)' },
            { k: 'Daily target', v: fmtMoneyAbs(target,2) },
            { k: 'Remaining',   v: fmtMoneyAbs(Math.max(0,target-achieved),2), color: 'var(--amb)' },
          ],
          bar: target > 0 ? Math.min(1, achieved / target) : null,
        });
      } else if (data.focusPanel && data.action) {
        setFocusDock(null);
      }

      if (data.urgency === 'critical' || (data.urgency === 'elevated' && data.action?.type === 'pending_trade')) {
        setAmbClass('signal');
      }
    } catch (e) {
      setMessages(m => [...m, { role:'jarvis', text:`Error: ${e.message}`, urgency:'elevated', ts: Date.now() }]);
    } finally {
      setThinking(false);
    }
  }, [thinking, goals, dailyPnL]);

  // ── E-Stop ─────────────────────────────────────────────────────────────────
  const fireEStop = useCallback(async () => {
    try {
      await fetch(API('rules?action=emergency-stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: true }),
      });
      setModal(null);
      setAmbClass('critical');
      setMessages(m => [...m, { role:'jarvis', text:'Emergency stop activated. All new trade execution halted. Existing positions are still managed.', urgency:'critical', ts: Date.now() }]);
    } catch (e) {
      setMessages(m => [...m, { role:'jarvis', text:`E-Stop failed: ${e.message}`, urgency:'critical', ts: Date.now() }]);
    }
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const mode  = rules?.activeMode || 'active';
  const orbState = positions.length > 0 && positions.some(p => (p.profit??0) < -50) ? 'warn'
                 : positions.length > 0 ? 'signal' : 'monitor';

  // Greeting on first load
  useEffect(() => {
    const eq = account?.equity;
    const msg = eq
      ? `Good ${new Date().getHours()<12?'morning':new Date().getHours()<18?'afternoon':'evening'}, Sir. Quantum Bot v17 online. Equity $${eq.toLocaleString('en-US',{maximumFractionDigits:2})} · ${trades.length} trades in memory · Mode: ${(rules?.activeMode||'active').toUpperCase()}. How can I assist?`
      : `JARVIS online. Type any command or question, Sir.`;
    if (messages.length === 0 && (account || trades.length > 0)) {
      setMessages([{ role:'jarvis', text: msg, urgency:'normal', ts: Date.now() }]);
    }
  }, [account, trades.length, rules?.activeMode]);

  const quickBtns = [
    { label:'⚡ Signal',      q:'What is the current signal?' },
    { label:'🔒 Gates',       q:'Show me all gates status' },
    { label:'📊 Performance', q:'What is my performance today?' },
    { label:'🌍 Briefing',    q:'Market briefing and news' },
    { label:'📡 Pine',        q:'Show pine vision across all timeframes' },
    { label:'🎯 Calibrate',   q:'Calibrate sizing for my goal' },
    { label:'🧠 Advise',      q:'What should I do right now?' },
    { label:'⬡ QB-NEXUS',    q:null, action:()=>setModal({type:'nexus'}), cls:'p' },
    { label:'📋 Trade Log',  q:null, action:()=>setModal({type:'log'}), cls:'g' },
    { label:'⛔ E-STOP',     q:null, action:()=>setModal({type:'estop'}), cls:'r' },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="hud">
        <div id="amb" className={ambClass} />

        {/* TOP BAR */}
        <div id="top">
          <div className="tLogo">
            <div className="tDot" />
            JARVIS · QB v17
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className={`tV ${dailyPnL >= 0 ? 'g' : 'r'}`}>{fmtMoney(dailyPnL, 2)}</span>
            <span className="tL">Today P&L</span>
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className="tV" style={{color:'var(--ion)'}}>
              {account?.equity ? `$${Math.round(account.equity).toLocaleString()}` : '—'}
            </span>
            <span className="tL">Equity</span>
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className="tV" style={{color: positions.length?'var(--pulse)':'var(--dim)'}}>
              {positions.length}
            </span>
            <span className="tL">Positions</span>
          </div>
          <div className="tSep" />
          <div className="tSt">
            <span className="tV" style={{color:'var(--txt)'}}>{trades.length}</span>
            <span className="tL">Trades</span>
          </div>
          <div className="tR">
            <span style={{fontFamily:'var(--mono)',fontSize:9.5,color:'var(--ion)',letterSpacing:.5}}>{clock}</span>
            <span className={`mBadge ${mode}`} onClick={() => sendToJarvis(`Set mode to ${mode==='active'?'defensive':'active'}`)}>
              {MODE_LABELS[mode] || mode.toUpperCase()}
            </span>
            <button className="tbBtn tbBtnP" onClick={() => setModal({type:'nexus'})}>⬡ NEXUS</button>
            <button className="tbBtn tbBtnB" onClick={() => setModal({type:'log'})}>📋 LOG</button>
            <button className="tbBtn tbBtnR" onClick={() => setModal({type:'estop'})}>⛔ E-STOP</button>
          </div>
        </div>

        {/* WORKSPACE */}
        <div id="ws">
          {/* LEFT */}
          <div id="lCol">
            <SignalPanel jarvisState={jarvisState} />
            <GatesPanel jarvisState={jarvisState} rules={rules} />
            <NewsPanel news={news} />
          </div>

          {/* CENTER */}
          <div id="cCol">
            <div id="orbWrap" style={{height:175}}>
              <OrbCanvas state={orbState} />
              <div className="orbStatus">
                <div className="orbDot" />
                {jarvisState?.killZone?.inKillZone ? jarvisState.killZone.label : 'SCANNING'} ·{' '}
                {rules?.tradingMode === 'auto' ? 'AUTO' : 'MANUAL'}
              </div>
            </div>
            <JarvisChat
              messages={messages}
              thinking={thinking}
              focusDock={focusDock}
              onDismissFocus={() => setFocusDock(null)}
            />
            <TemplateStrip
              rules={rules}
              trades={trades}
              onSelectTpl={id => id === 'log' ? setModal({type:'log'}) : setModal({type:'tpl', id})}
            />
          </div>

          {/* RIGHT */}
          <div id="rCol">
            <EquityPanel account={account} dailyPnL={dailyPnL} goals={goals} />
            <PositionsPanel positions={positions} />
            <ActivityPanel activity={activity} />
          </div>
        </div>

        {/* COMMAND BAR */}
        <div id="cmd">
          <div className="cmdR1">
            <button className="vBtn" title="Voice (coming soon)">🎙</button>
            <input
              id="cmdIn"
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendToJarvis(input)}
              placeholder="Ask JARVIS anything…  e.g. 'I want $1000 today' · 'Close gold' · 'Show performance'"
              disabled={thinking}
            />
            <button className="vBtn" onClick={() => sendToJarvis(input)} title="Send" style={{background:'rgba(0,229,255,.12)'}}>⚡</button>
          </div>
          <div className="qBtns">
            {quickBtns.map((b,i) => (
              <button
                key={i}
                className={`qB ${b.cls||''}`}
                onClick={() => b.action ? b.action() : sendToJarvis(b.q)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MODALS */}
      {modal?.type === 'log' && (
        <TradeLogModal trades={trades} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'nexus' && (
        <NexusModal trades={trades} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'tpl' && (
        <TemplateModal tplId={modal.id} trades={trades} rules={rules} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'estop' && (
        <div className="overlay">
          <div className="eSBox">
            <div className="eST">⛔ EMERGENCY STOP</div>
            <div className="eSM">All new trade execution will be immediately halted. Open positions continue to be managed. This is a config change — it does not close any position.</div>
            <div className="eSBtns">
              <button className="eSGo" onClick={fireEStop}>CONFIRM STOP</button>
              <button className="eSCancel" onClick={() => setModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
