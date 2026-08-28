import type express from "express";
import { cfg } from "./config.js";
import { state, ledgerTail, type Machine } from "./store.js";
import { gradeStats, grades } from "./grader.js";
import { indexStats } from "./comps.js";
import { marketFor } from "./market.js";
import { capsulePrice, remainingPrizes } from "./capsules.js";

/**
 * The machine's storefront — TCG identity: Pokemon-logo type treatment
 * (yellow fill, blue stroke), rounded card frames with chunky borders,
 * holo-foil accents, HP-bar fills, game-button CTAs. A gacha is a
 * THEATER; the receipts are the set dressing, not the show.
 */

const CSS = `
@font-face{font-family:'Lilita';src:url('/fonts/LilitaOne-Regular.ttf') format('truetype');font-display:swap}
@font-face{font-family:'Nunito';src:url('/fonts/Nunito.ttf') format('truetype');font-weight:200 1000;font-display:swap}
:root{--ink:#03060f;--ink2:#071324;--panel:#0b1d33;--edge:#14456b;--acid:#6fe0ff;--signal:#2ee6c8;--signal-d:#0e7f78;
--blue:#0a3a5c;--cream:#eaf9ff;--red:#ff5b5b;--green:#51e087;
--glass:linear-gradient(160deg,#1d6ea733 0%,#0a2f4d66 40%,#03060f88 100%);
--beam:linear-gradient(180deg,#6fe0ff26 0%,transparent 70%);
--holo:linear-gradient(115deg,#7de2ff,#b58fff 30%,#ff8fd8 62%,#ffd86b);
--disp:'Lilita','Arial Rounded MT Bold',Impact,sans-serif;--body:'Nunito','Segoe UI',sans-serif;
--lab:'Nunito','Segoe UI',sans-serif;--mono:'Consolas','Cascadia Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0}
html{scroll-behavior:smooth;background:var(--ink)}
body{background:var(--ink);color:var(--cream);font-family:var(--body);font-size:15px;line-height:1.55;overflow-x:hidden;
position:relative}
body::before{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
background:
 radial-gradient(120% 80% at 50% -10%,#1b6ea955 0%,transparent 60%),
 radial-gradient(80% 60% at 10% 20%,#0d4d7a44 0%,transparent 70%),
 radial-gradient(80% 60% at 90% 30%,#12608f44 0%,transparent 70%),
 linear-gradient(180deg,#061a2e 0%,#03060f 70%)}
/* the glass panes of the display case */
body::after{content:"";position:fixed;inset:-10% -5%;z-index:-1;pointer-events:none;opacity:.5;
background:repeating-linear-gradient(74deg,
  transparent 0 90px,#6fe0ff08 90px 132px,#6fe0ff14 132px 138px,transparent 138px 240px);
transform:skewX(-4deg)}
a{color:inherit;text-decoration:none}
::selection{background:var(--signal);color:var(--ink)}
.lab{font:800 11px var(--lab);letter-spacing:.24em;text-transform:uppercase}

/* soft grain */
.noise{position:fixed;inset:-100%;z-index:90;opacity:.05;pointer-events:none;
background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.6'/%3E%3C/svg%3E");
animation:grain .3s steps(2,end) infinite}
@keyframes grain{0%{transform:translate(0,0)}50%{transform:translate(-2%,2%)}100%{transform:translate(2%,-2%)}}

/* header */
.hd{position:sticky;top:0;z-index:50;display:flex;justify-content:space-between;align-items:center;
padding:0 3.5vw;height:76px;background:#03060fd9;backdrop-filter:blur(10px);border-bottom:2px solid #6fe0ff44;
box-shadow:0 8px 30px #6fe0ff1a}
.wordmark{font:400 2.1rem var(--disp);color:var(--signal);-webkit-text-stroke:1.6px #04283d;letter-spacing:.03em;
text-shadow:0 0 22px #2ee6c877}
.wordmark b{color:var(--signal);font-weight:400}
.hd nav{display:flex;gap:26px;font:800 13px var(--lab);letter-spacing:.14em;text-transform:uppercase}
.hd nav a{padding:6px 2px;border-bottom:3px solid transparent}
.hd nav a:hover{color:var(--signal);border-bottom-color:var(--signal)}
.papertag{border:2px solid var(--red);color:#ffb0b0;padding:6px 14px;border-radius:999px;font:800 10.5px var(--lab);letter-spacing:.18em}
.livetag{border:2px solid var(--green);color:var(--green);padding:6px 14px;border-radius:999px;font:800 10.5px var(--lab);letter-spacing:.18em}
.xlink{font-size:1.25rem;font-weight:900;width:40px;height:40px;display:grid;place-items:center;border:2px solid var(--edge);border-radius:12px}
.xlink:hover{border-color:var(--signal);color:var(--signal)}
.capill{display:inline-flex;align-items:center;gap:10px;margin-top:22px;padding:10px 16px;border-radius:999px;cursor:pointer;
background:#07223a99;border:1px solid #6fe0ff44;color:var(--cream);transition:all .15s;backdrop-filter:blur(3px)}
.capill:hover{border-color:var(--signal)}
.capill small{font:900 10px var(--lab);letter-spacing:.2em;color:var(--acid)}
.capill code{font:700 13px var(--mono)}
.capill .cpy{font:900 9.5px var(--lab);letter-spacing:.12em;text-transform:uppercase;color:var(--signal)}
.capill.soon{cursor:default;opacity:.55}
.xfoot{display:inline-block;margin-top:18px;font:900 13px var(--lab);letter-spacing:.12em;border:2px solid var(--signal);border-radius:999px;padding:8px 18px;color:var(--signal)}
.xfoot:hover{background:var(--signal);color:#04101f}
@media(max-width:760px){.hd nav{display:none}}

/* ticker */
.tick{border-bottom:1px solid #6fe0ff26;background:#04101fcc;backdrop-filter:blur(6px);overflow:hidden}
.ticktrack{display:inline-flex;white-space:nowrap;animation:tickm var(--tickdur,45s) linear infinite;will-change:transform}
.ticktrack>span{display:inline-block;padding:9px 0;font:800 10.5px var(--lab);letter-spacing:.2em;text-transform:uppercase}
@keyframes tickm{to{transform:translateX(-50%)}}
.tick b{color:var(--signal)} .tick i{font-style:normal;color:#eaf6f155;margin:0 18px}

/* hero */
.hero{position:relative;padding:9vh 5vw 7vh;isolation:isolate;overflow:hidden;
display:grid;grid-template-columns:minmax(0,820px) 430px;justify-content:start;gap:5vw;align-items:center}
.hero>.copy{min-width:0}
.hero::before{content:"ZERO EDGE ZERO EDGE";position:absolute;top:6%;left:-4vw;font:400 16vw/1 var(--disp);
color:#6fe0ff12;white-space:nowrap;pointer-events:none;z-index:-1}
h1{font:400 clamp(3rem,8vw,7rem)/.95 var(--disp);text-transform:uppercase;letter-spacing:.01em;margin-top:16px;
color:var(--cream);text-shadow:0 2px 24px #6fe0ff4d}
h1 i{font-style:normal;color:var(--signal);-webkit-text-stroke:2.5px #04283d;display:block;text-shadow:0 0 34px #2ee6c866}
.deck{font:800 clamp(1.05rem,1.8vw,1.4rem)/1.5 var(--body);margin:24px 0 8px;max-width:600px}
.deck em{font-style:normal;color:var(--signal)}
.herofan{position:relative;width:430px;height:430px;pointer-events:none}
.herofan img{position:absolute;width:64%;border:6px solid #eaf9ff;border-radius:14px;background:#071324;
box-shadow:0 0 0 3px #6fe0ff55,0 18px 34px #000c,0 0 44px #6fe0ff3d}
.herofan img:nth-child(1){left:0;top:36px;transform:rotate(-9deg)}
.herofan img:nth-child(2){left:24%;top:0;transform:rotate(3deg);z-index:2}
.herofan img:nth-child(3){left:44%;top:56px;transform:rotate(12deg)}
@media(max-width:900px){.herofan{display:none}.hero{display:block}}
.stamp{position:absolute;right:-8px;bottom:-6px;width:140px;height:140px;border-radius:50%;
display:grid;place-content:center;text-align:center;animation:float 5s ease-in-out infinite;
background:var(--holo);color:#06251f;border:4px solid #fff;box-shadow:0 8px 22px #0009;z-index:3}
.stamp::before{content:"";position:absolute;inset:8px;border:2px dashed #06251f66;border-radius:50%}
.stamp b{font:400 1.05rem var(--disp);text-transform:uppercase}
.stamp span{font:900 8.5px var(--lab);letter-spacing:.12em;text-transform:uppercase;margin-top:3px}
@keyframes float{50%{transform:translateY(-10px) rotate(4deg)}}

/* game-button CTA */
.cta{display:inline-grid;grid-template-columns:1fr auto;gap:2px 14px;padding:15px 24px;background:var(--signal);
color:#06251f;border-radius:16px;border:0;cursor:pointer;box-shadow:0 6px 0 var(--signal-d),0 10px 30px #2ee6c840;
transition:all .15s;margin-top:26px;text-align:left}
.cta:hover{transform:translateY(-2px);box-shadow:0 8px 0 var(--signal-d),0 16px 40px #2ee6c855}
.cta:active{transform:translateY(3px);box-shadow:0 2px 0 var(--signal-d)}
.cta small{grid-column:1;font:900 9.5px var(--lab);letter-spacing:.18em;text-transform:uppercase;opacity:.65}
.cta b{font:400 1.35rem var(--disp);letter-spacing:.03em;text-transform:uppercase}
.cta span{grid-area:1/2/3/3;align-self:center;font-size:1.5rem}

/* sections */
section{padding:7vh 5vw}
h2{font:400 clamp(2.2rem,6vw,4.4rem)/.95 var(--disp);text-transform:uppercase;margin-bottom:8px;
color:var(--cream);text-shadow:0 2px 20px #6fe0ff40}
h2 i{font-style:normal;color:var(--signal);-webkit-text-stroke:2px #04283d;text-shadow:0 0 28px #2ee6c855}
.side{font:800 11.5px var(--lab);letter-spacing:.2em;text-transform:uppercase;color:var(--acid);margin-bottom:34px}

/* product cards - TCG frames */
.shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:28px}
.prod{position:relative;background:var(--glass);border:2px solid #6fe0ff40;border-radius:16px;overflow:hidden;
transition:all .2s;display:block;backdrop-filter:blur(3px);
box-shadow:inset 0 1px 0 #ffffff2e,0 14px 34px #00060fbb}
.prod:hover{transform:translateY(-6px);border-color:var(--signal);
box-shadow:inset 0 1px 0 #ffffff40,0 18px 44px #00060f,0 0 46px #2ee6c840}
.prod .art{position:relative;height:270px;overflow:hidden;display:grid;place-items:center;
border-bottom:1px solid #6fe0ff33;
background:radial-gradient(ellipse at 50% 22%,#1d78b0 0%,#0a2f4d 45%,#04101f 100%)}
.prod .art::before{content:"";position:absolute;top:-30%;left:50%;width:140%;height:120%;pointer-events:none;
transform:translateX(-50%);background:var(--beam);
clip-path:polygon(38% 0,62% 0,100% 100%,0 100%);opacity:.75}
.prod .art::after{content:"";position:absolute;inset:-40%;background:linear-gradient(115deg,transparent 42%,#ffffff2e 50%,transparent 58%);
transform:translateX(-70%);transition:transform .5s}
.prod:hover .art::after{transform:translateX(70%)}
.prod .art img{max-height:230px;max-width:82%;filter:drop-shadow(0 14px 22px #000c)}
.prod .art .none{font:400 3rem var(--disp);color:#8fb0ff44}
.ribbon{position:absolute;top:14px;left:-4px;background:var(--signal);color:#06251f;padding:6px 16px;
border-radius:0 999px 999px 0;font:900 10px var(--lab);letter-spacing:.16em;text-transform:uppercase;box-shadow:0 4px 10px #0008}
.ribbon.won{background:var(--green)} .ribbon.dead{background:#7c7f9e;color:#fff} .ribbon.free{background:var(--holo)}
.prod .bd{padding:16px 16px 18px}
.prod h3{font:400 1.15rem/1.1 var(--disp);text-transform:uppercase;letter-spacing:.02em;min-height:2.3em}
.meta{display:flex;justify-content:space-between;align-items:baseline;margin-top:10px}
.meta .px{font:400 1.7rem var(--disp);color:var(--signal)}
.meta .px small{font:900 9px var(--lab);letter-spacing:.14em;color:var(--cream);opacity:.6;display:block}
.meta .left{font:800 10.5px var(--lab);letter-spacing:.12em;text-transform:uppercase;opacity:.75}
/* HP-bar fills */
.fill{height:13px;background:#05060a;margin-top:12px;position:relative;border-radius:999px;border:2px solid #000306;overflow:hidden}
.fill i{position:absolute;inset:0 auto 0 0;background:linear-gradient(180deg,#8ff7e4,#2ee6c8 55%,#149a83);border-radius:999px}
.fill.done i{background:linear-gradient(180deg,#ffe371,#ffcb05 55%,#e0a900)}
.winline{margin-top:10px;font:900 11px var(--lab);letter-spacing:.1em;text-transform:uppercase;color:var(--green)}

/* capsule machine */
.mach{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:0;background:var(--glass);
border:2px solid #6fe0ff44;border-radius:20px;overflow:hidden;backdrop-filter:blur(3px);
box-shadow:inset 0 1px 0 #ffffff2e,0 18px 46px #00060fcc}
.mach .art{position:relative;display:grid;place-items:center;min-height:340px;overflow:hidden;
background:radial-gradient(ellipse at 50% 25%,#2189c4 0%,#0a3a5c 45%,#04101f 100%)}
.mach .art::before{content:"";position:absolute;top:-25%;left:50%;width:150%;height:125%;pointer-events:none;
transform:translateX(-50%);background:var(--beam);clip-path:polygon(40% 0,60% 0,100% 100%,0 100%)}
.mach .art img{max-height:290px;max-width:80%;filter:drop-shadow(0 16px 26px #000d)}
.mach .bd{padding:30px 32px}
.mach h3{font:400 clamp(1.5rem,2.6vw,2.2rem)/1.05 var(--disp);text-transform:uppercase}
.pool{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}
.chip{border:1px solid #6fe0ff40;background:#07223a99;padding:5px 13px;border-radius:999px;
font:800 10.5px var(--lab);letter-spacing:.08em;text-transform:uppercase}
.chip.card{background:var(--holo);border-color:#fff;color:#06251f}
.chip s{opacity:.5}
.machmeta{display:flex;gap:26px;align-items:baseline;margin:6px 0 2px}
.machmeta .px{font:400 2.2rem var(--disp);color:var(--signal);transition:color .2s}
.machmeta .px.moved{animation:pxflash .9s ease-out}
@keyframes pxflash{0%{color:#fff;text-shadow:0 0 30px #6fe0ff}100%{color:var(--signal);text-shadow:none}}
.pricenote{font-size:13px;font-weight:600;opacity:.82;margin:10px 0 4px;max-width:52ch}
.machmeta small{font:900 10px var(--lab);letter-spacing:.14em;text-transform:uppercase;opacity:.6}
@media(max-width:860px){.mach{display:block}}
/* capsule reveal - pack rip */
.reveal{position:fixed;inset:0;background:#05060af0;z-index:200;display:grid;place-items:center}
.reveal .rc{position:relative;background:var(--cream);color:#06251f;padding:42px 50px;text-align:center;border-radius:18px;
border:8px solid var(--signal);box-shadow:0 12px 0 #000306,0 30px 60px #000c;transform:rotate(-2deg);
animation:pop .45s cubic-bezier(.2,1.7,.4,1);overflow:hidden}
.reveal .rc::after{content:"";position:absolute;inset:-40%;background:linear-gradient(115deg,transparent 40%,#ffffffb0 50%,transparent 60%);
transform:translateX(-80%);animation:shine 1.1s .25s ease-out forwards}
@keyframes shine{to{transform:translateX(80%)}}
.reveal .rc b{font:400 2.2rem var(--disp);text-transform:uppercase;display:block}
.reveal .rc span{font:900 11px var(--lab);letter-spacing:.18em;text-transform:uppercase;opacity:.6}
@keyframes pop{from{transform:scale(.3) rotate(-16deg);opacity:0}}

/* ticket market */
.mkt{margin-top:22px;border:3px solid #06251f;border-radius:14px;padding:16px 18px;background:#dff3ec}
.mkt h4{font:400 1.2rem var(--disp);text-transform:uppercase;margin-bottom:4px}
.mkt .imp{font:800 10.5px var(--lab);letter-spacing:.1em;text-transform:uppercase;opacity:.65;margin-bottom:10px}
.mkt table{width:100%;border-collapse:collapse;font-size:13px;font-weight:700}
.mkt td{padding:6px 6px;border-bottom:1px solid #06251f22}
.mkt .buy{cursor:pointer;background:#06251f;color:var(--signal);border:0;border-radius:999px;padding:6px 14px;
font:900 10px var(--lab);letter-spacing:.12em;text-transform:uppercase;box-shadow:0 3px 0 #000306}
.mkt .buy:hover{background:var(--blue)}
.mkt .buy:active{transform:translateY(2px);box-shadow:none}

/* live buy widget */
.buyrow{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:22px}
.qty{display:inline-flex;align-items:center;gap:0;border:3px solid #06251f;border-radius:999px;overflow:hidden;background:#fff}
.qty button{width:42px;height:42px;border:0;background:#fff;color:#06251f;font:400 1.4rem var(--disp);cursor:pointer}
.qty button:hover{background:var(--signal)}
.qty b{min-width:46px;text-align:center;font:400 1.3rem var(--disp);color:#06251f}
.buycta{margin-top:0}

/* how-it-works */
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
.step{border:2px solid #6fe0ff33;background:var(--glass);padding:34px 30px 30px;position:relative;border-radius:16px;
backdrop-filter:blur(3px);box-shadow:inset 0 1px 0 #ffffff24,0 12px 30px #00060faa}
.step b{position:absolute;top:16px;right:24px;font:400 3rem var(--disp);color:var(--signal);-webkit-text-stroke:1.5px var(--blue);opacity:.5}
.step h3{font:400 1.4rem var(--disp);text-transform:uppercase;margin-bottom:8px;color:var(--signal)}
.step p{font-size:14px;font-weight:600;opacity:.94}

/* detail page - the graded card frame */
.case{display:grid;grid-template-columns:1fr 1.1fr;gap:0;background:var(--cream);color:#06251f;
border:8px solid var(--signal);border-radius:22px;overflow:hidden;transform:rotate(-1deg);
box-shadow:0 14px 0 #000306,0 30px 50px #000a;margin:30px 0}
.case .art{display:grid;place-items:center;min-height:420px;position:relative;overflow:hidden;
background:radial-gradient(ellipse at 50% 22%,#2189c4 0%,#0a3a5c 45%,#04101f 100%)}
.case .art::before{content:"";position:absolute;top:-25%;left:50%;width:150%;height:125%;pointer-events:none;
transform:translateX(-50%);background:var(--beam);clip-path:polygon(40% 0,60% 0,100% 100%,0 100%)}
.case .art img{max-height:380px;max-width:86%;filter:drop-shadow(0 18px 30px #000d)}
.case .txt{padding:44px 42px}
.case .txt .lab{color:#0d6b5c}
.case h2{color:#06251f;font-size:clamp(1.8rem,3.4vw,2.8rem);margin:10px 0 18px;text-shadow:none}
.duel{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.duel div{border:3px solid #06251f;border-radius:12px;padding:12px 14px;background:#f6fbf8}
.duel small{display:block;font:900 9.5px var(--lab);letter-spacing:.16em;text-transform:uppercase;opacity:.6}
.duel b{font:400 1.8rem var(--disp)}
.receipts{background:#02080fcc;color:var(--cream);border:1px solid #6fe0ff33;border-radius:12px;padding:20px 22px;
margin-top:26px;backdrop-filter:blur(4px)}
.receipts h3{font:400 1.3rem var(--disp);text-transform:uppercase;color:var(--signal);margin-bottom:12px}
.receipts table{width:100%;border-collapse:collapse;font-size:12px;font-family:var(--mono)}
.receipts td{padding:6px 8px;border-bottom:1px solid #ffffff12;word-break:break-all}
.receipts td:first-child{opacity:.55;white-space:nowrap;font-family:var(--body);font-weight:700}
.bigstamp{position:absolute;inset:auto 18px 18px auto;transform:rotate(-8deg);border:4px solid var(--green);border-radius:12px;
color:var(--green);padding:8px 20px;font:400 1.6rem var(--disp);text-transform:uppercase;background:#08090dd9}
@media(max-width:860px){.case{display:block;transform:none}.case .art{min-height:300px}}

/* gallery (vault) */
.slabs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:24px}
.slab{background:var(--glass);border:2px solid #6fe0ff33;border-radius:14px;padding:16px 14px;text-align:center;
position:relative;backdrop-filter:blur(3px);box-shadow:inset 0 1px 0 #ffffff24,0 10px 26px #00060faa;transition:all .2s}
.slab:hover{border-color:var(--signal);box-shadow:inset 0 1px 0 #ffffff33,0 14px 32px #00060f,0 0 34px #2ee6c833}
.slab img{max-height:200px;max-width:88%;filter:drop-shadow(0 12px 18px #000c)}
.slab h4{font:400 1rem/1.15 var(--disp);text-transform:uppercase;margin:12px 0 4px;min-height:2.3em}
.slab .edge{font:800 11.5px var(--lab);letter-spacing:.06em}
.slab .st{position:absolute;top:10px;right:10px;font:900 9px var(--lab);letter-spacing:.12em;text-transform:uppercase;
border:2px solid currentColor;border-radius:999px;padding:2px 9px;opacity:.9}

/* instrument tables (grades/feed) */
table.inst{width:100%;border-collapse:collapse;font-size:13.5px;font-weight:600}
table.inst th{font:900 10px var(--lab);letter-spacing:.16em;text-transform:uppercase;text-align:left;opacity:.55;
padding:8px 10px;border-bottom:2px solid var(--edge)}
table.inst td{padding:8px 10px;border-bottom:1px solid #ffffff10}
.up{color:var(--green)}.down{color:var(--red)}.amber{color:var(--signal)}.dim{opacity:.6}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:0 0 26px}
.stat{border:2px solid #6fe0ff2e;background:var(--glass);border-radius:12px;padding:14px 16px;
backdrop-filter:blur(3px);box-shadow:inset 0 1px 0 #ffffff1f,0 8px 22px #00060f99}
.stat small{display:block;font:900 9.5px var(--lab);letter-spacing:.18em;text-transform:uppercase;opacity:.55;margin-bottom:5px}
.stat b{font:400 1.6rem var(--disp)}

footer{background:linear-gradient(180deg,#0a3a5c 0%,#04101f 100%);color:var(--cream);padding:5vh 5vw;margin-top:8vh;
border-top:2px solid #6fe0ff55;box-shadow:inset 0 1px 0 #ffffff2e}
footer .big{font:400 clamp(1.9rem,5.5vw,4rem)/1 var(--disp);text-transform:uppercase;color:var(--signal);text-shadow:0 0 30px #2ee6c855}
footer p{font:800 12.5px var(--lab);letter-spacing:.04em;text-transform:uppercase;margin-top:16px;max-width:680px}
`;

const usd = (n: number) => "$" + (+n).toFixed(2).replace(/\.00$/, "");
const ago = (t: number) => {
  const m = (Date.now() - t) / 60000;
  return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function shell(title: string, body: string, ticker?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NERDNAME — ${title}</title><style>${CSS}</style></head><body>
<div class="noise"></div>
<header class="hd">
  <a class="wordmark" href="/">NERD<b>NAME</b><span style="font:10px var(--lab);vertical-align:top">®</span></a>
  <nav>${(() => { const m = state.machines.find((x) => x.status === "open"); return m ? `<a href="/machine/${m.id}" style="color:var(--signal)">Candy Machine</a>` : ""; })()}<a href="/raffles">Raffles</a><a href="/vault">The Vault</a><a href="/grades">Receipts</a><a href="/feed">Live Feed</a></nav>
  <div style="display:flex;gap:14px;align-items:center">
    ${cfg.xUrl ? `<a class="xlink" href="${cfg.xUrl}" target="_blank" rel="noopener" aria-label="X">𝕏</a>` : ""}
    ${cfg.live ? `<span class="livetag">● LIVE${cfg.devnet ? " · DEVNET" : ""}</span>` : `<span class="papertag">● PAPER MODE</span>`}
  </div>
</header>
${ticker ? (() => {
  // repeat short content so one copy always exceeds the viewport, then
  // duplicate the whole copy once for the seamless -50% loop
  let copy = ticker;
  while (copy.length < 2600) copy += ticker;
  const dur = Math.max(30, Math.round(copy.length / 28));
  return `<div class="tick"><div class="ticktrack" style="--tickdur:${dur}s"><span>${copy}</span><span>${copy}</span></div></div>`;
})() : ""}
${body}
<footer>
  <div class="big">THE HOUSE HAS NO EDGE.<br>THE MACHINE JUST BUYS BETTER.</div>
  <p>Every draw committed on-chain before a single ticket exists. Paper mode: real market data,
  real cryptography, fake money — until the math proves itself.</p>
  ${cfg.xUrl ? `<a class="xfoot" href="${cfg.xUrl}" target="_blank" rel="noopener">𝕏 · FOLLOW THE MACHINE</a>` : ""}
</footer>
<script>
setTimeout(()=>location.reload(), 45000);
document.querySelectorAll('.capill[data-ca]').forEach(el=>{
  el.onclick=async()=>{
    try{await navigator.clipboard.writeText(el.dataset.ca);}catch(e){
      const t=document.createElement('textarea');t.value=el.dataset.ca;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();}
    const c=el.querySelector('.cpy'),o=c.textContent;c.textContent='copied!';setTimeout(()=>c.textContent=o,1600);
  };
});
</script>
</body></html>`;
}

function prodCard(r: any, card: any): string {
  const sold = r.sold.reduce((s: number, t: any) => s + t.n, 0);
  const pct = Math.min(100, (100 * sold) / r.tickets);
  const ribbon = r.status === "resolved" ? `<span class="ribbon won">WON</span>`
    : r.status === "refunded" ? `<span class="ribbon dead">REFUNDED</span>`
    : r.kind === "holder" ? `<span class="ribbon free">FREE — HOLDERS</span>`
    : `<span class="ribbon">LIVE</span>`;
  return `<a class="prod" href="/raffle/${r.id}">
  <div class="art">${card?.image ? `<img src="${card.image}" loading="lazy" alt="">` : `<div class="none">?</div>`}${ribbon}</div>
  <div class="bd">
    <h3>${r.title.slice(0, 52)}</h3>
    <div class="meta">
      <div class="px">${r.kind === "paid" ? usd(r.ticketUsd) : "FREE"}<small>${r.kind === "paid" ? "per ticket" : "hold to enter"}</small></div>
      <div class="left">${sold}/${r.tickets}<br>tickets</div>
    </div>
    <div class="fill ${r.status === "resolved" ? "done" : ""}"><i style="width:${pct}%"></i></div>
    ${r.winner ? `<div class="winline">🏆 ${r.winner} — verified draw</div>` : ""}
  </div></a>`;
}

function poolChips(m: Machine): string {
  // aggregate the pool into "label xN (M left)" chips, card first
  const agg = new Map<string, { total: number; left: number; isCard: boolean; valueUsd: number }>();
  for (const p of m.prizes) {
    const key = p.kind === "card" ? "THE CARD" : p.label;
    const a = agg.get(key) ?? { total: 0, left: 0, isCard: p.kind === "card", valueUsd: p.valueUsd };
    a.total++;
    if (!p.claimedBy) a.left++;
    agg.set(key, a);
  }
  return [...agg.entries()]
    .sort((a, b) => b[1].valueUsd - a[1].valueUsd)
    .map(([label, a]) => `<span class="chip ${a.isCard ? "card" : ""}">${a.isCard ? `THE CARD $${a.valueUsd}` : label}
      ${a.left ? `× ${a.left}/${a.total}` : `<s>× 0/${a.total} gone</s>`}</span>`)
    .join("");
}

function machBlock(m: Machine, card: { image?: string } | undefined): string {
  const opened = m.opens.length;
  return `<div class="mach">
    <div class="art">${card?.image ? `<img src="${card.image}" alt="">` : ""}
      ${m.status === "closed" ? `<span class="ribbon dead">EMPTY</span>` : `<span class="ribbon">CAPSULES LIVE</span>`}</div>
    <div class="bd">
      <p class="lab" style="color:var(--acid)">CAPSULE MACHINE ${m.id} · EVERY ENVELOPE PRICED · ZERO HOUSE EDGE</p>
      <h3>${m.title.slice(0, 60)}</h3>
      <div class="machmeta">
        <div class="px" id="livepx" data-m="${m.id}">$${capsulePrice(m).toFixed(2)}<small style="display:block">per capsule — floats</small></div>
        <div><b style="font:400 1.5rem var(--disp)">${m.capsules - opened}</b><small style="display:block">capsules left</small></div>
        <div><b style="font:400 1.5rem var(--disp)">$${remainingPrizes(m).reduce((t, p) => t + p.valueUsd, 0).toFixed(2)}</b><small style="display:block">still in the rack</small></div>
      </div>
      <p class="pricenote">A capsule always costs exactly what the rack is worth: value left ÷ capsules left.
      Pull the chase and the price drops for everyone after you. Started at $${m.priceUsd.toFixed(2)}.</p>
      <div class="fill" style="margin:10px 0 4px"><i style="width:${(100 * opened) / m.capsules}%"></i></div>
      <div class="pool">${poolChips(m)}</div>
      ${m.status === "open" ? `<a class="cta" href="/machine/${m.id}"><small>the rack is public — count what's left</small><b>OPEN A CAPSULE</b><span>↗</span></a>` : `<p class="lab" style="opacity:.6">closed — unclaimed cash rolled to the next machine</p>`}
    </div>
  </div>`;
}

export function mountSite(app: express.Express): void {
  const cardOf = (nft: string) => state.vault.find((v) => v.nft === nft);

  app.get("/", (_req, res) => {
    const live = state.raffles.filter((r) => r.status === "open");
    const done = state.raffles.filter((r) => r.status === "resolved").slice(-6).reverse();
    const vaultLive = state.vault.filter((v) => v.status === "vault" || v.status === "raffled");
    const fan = state.vault.filter((v) => v.image).slice(-3);
    const tick = ledgerTail(14).reverse().map((e: any) =>
      e.kind === "paper-buy" ? `<b>SNIPED</b> ${String(e.item).slice(0, 30)} @ ${usd(e.price)}` :
      e.kind === "raffle-resolve" ? `<b>WON</b> by ${e.winner}` :
      e.kind === "raffle-open" ? `<b>NEW RAFFLE</b> ${String(e.item ?? "").slice(0, 30)}` :
      e.kind === "grade" ? `<b>GRADED</b> ${String(e.item).slice(0, 26)}: ${e.outcome}` : null,
    ).filter(Boolean).map((s) => `${s}<i>◆</i>`).join("");
    res.type("html").send(shell("the machine", `
<section class="hero">
  <div class="copy">
    <p class="lab" style="color:var(--acid)">GRADED CARDS · ZERO HOUSE EDGE · PROVABLY FAIR DRAWS</p>
    <h1>EVERY TICKET<br><i>WORTH EXACTLY</i>WHAT IT COSTS.</h1>
    <p class="deck">The machine snipes graded cards <em>below market</em>, then raffles them at
    <em>exactly their value</em>. Its only profit is the discount it caught. Your odds are
    committed on-chain <em>before tickets exist</em>.</p>
    ${cfg.tokenMint ? `<button class="capill" data-ca="${cfg.tokenMint}" title="click to copy">
      <small>CA</small><code>${cfg.tokenMint.slice(0, 6)}…${cfg.tokenMint.slice(-6)}</code><span class="cpy">⧉ copy</span>
    </button>` : `<div class="capill soon"><small>CA</small><code>coming soon</code></div>`}
    <br>
    <a class="cta" href="/raffles"><small>${live.length} live raffle${live.length === 1 ? "" : "s"} right now</small><b>ENTER THE MACHINE</b><span>↗</span></a>
  </div>
  <div class="herofan">
    ${fan.map((v) => `<img src="${v.image}" alt="">`).join("")}
    <div class="stamp"><b>PROVABLY<br>FAIR</b><span>VERIFY EVERY DRAW</span></div>
  </div>
</section>

${(() => {
  const m = state.machines.find((x) => x.status === "open") ?? [...state.machines].reverse()[0];
  return m ? `<section>
  <h2>THE CANDY<br><i>MACHINE.</i></h2>
  <p class="side">PRICE = WHAT THE RACK IS WORTH, LIVE · THE WHOLE POOL IS PUBLIC · BUY IT ALL AND YOU GET IT ALL BACK</p>
  ${machBlock(m, cardOf(m.nft))}
</section>` : "";
})()}

${live.length ? `<section>
  <h2>LIVE <i>RAFFLES.</i></h2>
  <p class="side">FILL OR REFUND — NO SELLOUT, NO DRAW, MONEY BACK · TICKETS TRADE UNTIL THE DRAW</p>
  <div class="shelf">${live.map((r) => prodCard(r, cardOf(r.nft))).join("")}</div>
</section>` : ""}

<section>
  <h2>HOW THE<br><i>MACHINE WORKS.</i></h2>
  <p class="side">THREE MOVES, ALL PUBLIC, ALL THE TIME</p>
  <div class="steps">
    <div class="step"><b>01</b><h3>IT SNIPES</h3><p>A machine that watches every listing on Collector Crypt and buys
    graded cards priced below comparable sales. Every buy published with the math that justified it.</p></div>
    <div class="step"><b>02</b><h3>IT RAFFLES</h3><p>Each card becomes N tickets priced at exactly value ÷ N.
    The house takes nothing — its profit was already earned at the snipe. Doesn't sell out? Full refund.</p></div>
    <div class="step"><b>03</b><h3>IT PROVES IT</h3><p>The winning ticket comes from a future Solana blockhash
    named in a commitment before the first ticket sold. Nobody — including the machine — can steer it. Recompute any draw yourself.</p></div>
  </div>
</section>

${done.length ? `<section>
  <h2>RECENT <i>WINNERS.</i></h2>
  <p class="side">EVERY DRAW INDEPENDENTLY VERIFIABLE — CLICK THROUGH FOR THE RECEIPTS</p>
  <div class="shelf">${done.map((r) => prodCard(r, cardOf(r.nft))).join("")}</div>
</section>` : ""}

<section>
  <h2>THE VAULT<br><i>RIGHT NOW.</i></h2>
  <p class="side">WHAT THE MACHINE HOLDS — COST ${usd(vaultLive.reduce((s, v) => s + v.paidUsd, 0))} · MARKET ${usd(vaultLive.reduce((s, v) => s + v.compUsd, 0))} · SPREAD REALIZED ${usd(state.realizedProfitUsd)} · HOLDER POOL ${usd(state.holderPoolUsd)}</p>
  <a class="cta" href="/vault"><small>every card, every price, every receipt</small><b>OPEN THE VAULT</b><span>↗</span></a>
</section>
`, tick));
  });

  app.get("/raffles", (_req, res) => {
    const rs = [...state.raffles].reverse();
    res.type("html").send(shell("raffles", `
<section>
  <h2>ALL <i>RAFFLES.</i></h2>
  <p class="side">FILL OR REFUND · ODDS COMMITTED BEFORE A SINGLE TICKET EXISTS</p>
  <div class="shelf">${rs.map((r) => prodCard(r, state.vault.find((v) => v.nft === r.nft))).join("") || '<p class="dim">the sniper is stocking the vault…</p>'}</div>
</section>`));
  });

  app.get("/raffle/:id", (req, res) => {
    const r = state.raffles.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).type("html").send(shell("404", `<section><h1>NO SUCH<br><i>RAFFLE.</i></h1></section>`));
    const card = state.vault.find((v) => v.nft === r.nft);
    const sold = r.sold.reduce((s, t) => s + t.n, 0);
    const pct = Math.min(100, (100 * sold) / r.tickets);
    res.type("html").send(shell(r.title.slice(0, 40), `
<section>
  <p class="lab" style="color:var(--acid)">${r.kind === "paid" ? "PAID RAFFLE — FILL OR REFUND" : "FREE HOLDER DROP — HOLDING IS THE TICKET"} · ${r.status.toUpperCase()}</p>
  <div class="case">
    <div class="art">${card?.image ? `<img src="${card.image}" alt="">` : ""}${r.winner ? `<div class="bigstamp">WON · ${r.winner}</div>` : ""}</div>
    <div class="txt">
      <span class="lab">${card ? `${card.gradingCompany} ${card.grade}` : ""}</span>
      <h2>${r.title.slice(0, 70)}</h2>
      ${card ? `<div class="duel">
        <div><small>machine paid</small><b>${usd(card.paidUsd)}</b></div>
        <div><small>market says</small><b>${usd(card.compUsd)}</b></div>
      </div>
      <p style="font:600 11px var(--lab);letter-spacing:.08em;text-transform:uppercase;opacity:.7">comp basis: ${card.compBasis}</p>` : ""}
      <div class="duel" style="margin-top:14px">
        <div><small>ticket</small><b>${r.kind === "paid" ? usd(r.ticketUsd) : "FREE"}</b></div>
        <div><small>sold</small><b>${sold}/${r.tickets}</b></div>
      </div>
      <div class="fill ${r.status === "resolved" ? "done" : ""}" style="background:#10100a22"><i style="width:${pct}%"></i></div>
      ${r.status === "open" && r.kind === "paid" ? `<p style="margin-top:14px;font:700 11px var(--lab);letter-spacing:.1em;text-transform:uppercase">
      fill deadline: <span id="cd" data-t="${r.fillDeadline}"></span> — no sellout, everyone refunded</p>` : ""}
      ${r.status === "open" && r.kind === "paid" && cfg.live ? `
      <div class="buybox" data-raffle="${r.id}" data-ticket="${r.ticketUsd}">
        <div class="qty"><button id="qm">−</button><b id="qn">1</b><button id="qp">+</button></div>
        <button class="cta buycta" id="buy"><small id="buyusd">$${r.ticketUsd.toFixed(2)} USDC</small><b>BUY WITH PHANTOM</b><span>↗</span></button>
        <p id="paymsg" class="dim" style="font-size:12px;margin-top:8px"></p>
      </div>` : ""}
      ${r.status === "open" && r.kind === "paid" && !cfg.live ? `<p style="margin-top:12px;font:700 10.5px var(--lab);letter-spacing:.14em;text-transform:uppercase;opacity:.55">paper mode — tickets are bought by the simulator, not by people</p>` : ""}
      ${(() => {
        if (r.kind !== "paid" || r.status !== "open") return "";
        const mkt = marketFor(r.id);
        const rows = mkt.listings.slice(0, 6).map((l) => `
          <tr><td>${l.n} tix</td><td><b>${usd(l.priceUsd)}</b> each</td><td class="dim">${l.seller.slice(0, 14)}</td>
          <td><button class="buy mktbuy" data-l="${l.id}" data-usd="${(l.n * l.priceUsd).toFixed(2)}">BUY ${usd(l.n * l.priceUsd)}</button></td></tr>`).join("");
        return `<div class="mkt">
          <h4>TICKET MARKET</h4>
          <p class="imp">${mkt.lastPriceUsd ? `last trade ${usd(mkt.lastPriceUsd)}/tix — the market prices this card at ~$${mkt.impliedCardUsd}` : "no trades yet — tickets trade freely until the draw"}</p>
          ${rows ? `<table>${rows}</table>` : `<p class="dim" style="font-size:12px">no open listings — holders are holding</p>`}
        </div>`;
      })()}
    </div>
  </div>
  <div class="receipts">
    <h3>FAIRNESS RECEIPTS</h3>
    <table>
      <tr><td>commitment (published before any ticket)</td><td>${r.commitHash}</td></tr>
      ${r.commitSig ? `<tr><td>commit anchored on-chain</td><td><a style="color:var(--signal)" href="https://solscan.io/tx/${r.commitSig}${cfg.devnet ? "?cluster=devnet" : ""}">${r.commitSig}</a></td></tr>` : ""}
      <tr><td>resolve slot (named in the commitment)</td><td>${r.resolveSlot}</td></tr>
      ${r.revealSig ? `<tr><td>reveal anchored on-chain</td><td><a style="color:var(--signal)" href="https://solscan.io/tx/${r.revealSig}${cfg.devnet ? "?cluster=devnet" : ""}">${r.revealSig}</a></td></tr>` : ""}
      ${r.seed ? `<tr><td>seed (revealed at resolution)</td><td>${r.seed}</td></tr>` : ""}
      ${r.blockhash ? `<tr><td>solana blockhash used</td><td>${r.blockhash}</td></tr>` : ""}
      ${r.winner ? `<tr><td>winner (ticket ${(r.winnerIndex ?? 0) + 1} of ${r.tickets})</td><td>${r.winner}</td></tr>` : ""}
    </table>
    <p style="margin-top:12px;font-size:12px" class="dim">${r.status === "resolved"
      ? `recompute it yourself: <a href="/api/verify/${r.id}" style="color:var(--signal)">/api/verify/${r.id}</a> — sha256 the manifest, mix the seed with the blockhash, land on the same ticket.`
      : `the seed reveals at resolution. the blockhash literally does not exist yet — that is the whole trick.`}</p>
  </div>
</section>
<script>
const cd=document.getElementById('cd');
if(cd){const t=+cd.dataset.t;const f=()=>{const s=Math.max(0,(t-Date.now())/1000|0);
cd.textContent=s>3600?((s/3600)|0)+'h '+(((s%3600)/60)|0)+'m':((s/60)|0)+'m '+(s%60|0)+'s';};f();setInterval(f,1000)}
document.querySelectorAll('.mktbuy').forEach(b=>{
  b.onclick=async()=>{
    ${cfg.live ? `
    try{
      const ph=window.phantom?.solana||window.solana;
      if(!ph){b.textContent='NO PHANTOM';return;}
      await ph.connect();
      const j=await (await fetch('/api/paytx?kind=market&listing='+b.dataset.l+'&payer='+ph.publicKey.toBase58())).json();
      if(!j.ok){b.textContent=j.why.slice(0,18);return;}
      const tx=solanaWeb3.Transaction.from(Uint8Array.from(atob(j.tx),c=>c.charCodeAt(0)));
      await ph.signAndSendTransaction(tx);
      b.textContent='SENT ✓';
      setTimeout(()=>location.reload(), 25000);
    }catch(e){b.textContent='FAILED';}
    ` : `
    const j=await (await fetch('/api/market/'+b.dataset.l+'/buy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({buyer:'you_'+Math.random().toString(36).slice(2,6)})})).json();
    b.textContent=j.ok?'BOUGHT ✓':'GONE';
    if(j.ok) setTimeout(()=>location.reload(), 1200);
    `}
  };
});
</script>
${cfg.live ? `<script src="https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js"></script>
<script>
(function(){
  const box=document.querySelector('.buybox'); if(!box) return;
  const price=+box.dataset.ticket, id=box.dataset.raffle;
  let n=1;
  const qn=document.getElementById('qn'), usd=document.getElementById('buyusd'), msg=document.getElementById('paymsg');
  const draw=()=>{qn.textContent=n; usd.textContent='$'+(n*price).toFixed(2)+' USDC';};
  document.getElementById('qm').onclick=()=>{n=Math.max(1,n-1);draw();};
  document.getElementById('qp').onclick=()=>{n=Math.min(25,n+1);draw();};
  document.getElementById('buy').onclick=async()=>{
    try{
      const ph=window.phantom?.solana||window.solana;
      if(!ph){msg.textContent='phantom not found — install the extension';return;}
      msg.textContent='connecting…';
      await ph.connect();
      msg.textContent='building transaction…';
      const j=await (await fetch('/api/paytx?raffle='+id+'&n='+n+'&payer='+ph.publicKey.toBase58())).json();
      if(!j.ok){msg.textContent=j.why;return;}
      const tx=solanaWeb3.Transaction.from(Uint8Array.from(atob(j.tx),c=>c.charCodeAt(0)));
      msg.textContent='sign it in phantom…';
      const {signature}=await ph.signAndSendTransaction(tx);
      msg.textContent='sent: '+signature.slice(0,16)+'… tickets credit when it confirms (~30s)';
      setTimeout(()=>location.reload(), 30000);
    }catch(e){msg.textContent=String(e.message||e).slice(0,90);}
  };
})();
</script>` : ""}`));
  });

  app.get("/machine/:id", (req, res) => {
    const m = state.machines.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).type("html").send(shell("404", `<section><h1>NO SUCH<br><i>MACHINE.</i></h1></section>`));
    const card = cardOf(m.nft);
    const feed = [...m.opens].reverse().slice(0, 30).map((o) => {
      const p = m.prizes[o.prizeIdx];
      return `<tr><td class="dim">${ago(o.at)}</td><td>${o.buyer.slice(0, 16)}</td>
      <td class="${p.kind === "card" ? "amber" : ""}">${p.label.slice(0, 44)}</td><td>${usd(p.valueUsd)}</td></tr>`;
    }).join("");
    res.type("html").send(shell(`machine ${m.id}`, `
<section>
  <p class="lab" style="color:var(--acid)">CAPSULE MACHINE · ${m.status.toUpperCase()} · EVERY OPEN VERIFIABLE THE MOMENT IT HAPPENS</p>
  <div style="margin-top:14px">${machBlock(m, card)}</div>

  ${m.status === "open" ? `
  <div style="margin-top:26px;display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    ${cfg.live ? `
    <div class="qty" style="background:#fff"><button id="qm">−</button><b id="qn">1</b><button id="qp">+</button></div>
    <button class="cta buycta" id="openbtn"><small id="openusd">$${capsulePrice(m).toFixed(2)} USDC</small><b>OPEN WITH PHANTOM</b><span>◉</span></button>
    ` : `
    <button class="cta buycta" id="openbtn"><small id="openusd" data-paper="1">paper mode — $${capsulePrice(m).toFixed(2)} a capsule, real draw</small><b>OPEN ONE (PAPER)</b><span>◉</span></button>
    `}
    <p id="paymsg" class="dim" style="font-size:12px"></p>
  </div>` : ""}

  <div class="receipts" style="margin-top:30px">
    <h3>HOW THIS IS FAIR</h3>
    <table>
      <tr><td>prize table committed</td><td>${m.commitHash}</td></tr>
      ${m.commitSig ? `<tr><td>commit anchored on-chain</td><td><a style="color:var(--signal)" href="https://solscan.io/tx/${m.commitSig}${cfg.devnet ? "?cluster=devnet" : ""}">${m.commitSig}</a></td></tr>` : ""}
      <tr><td>per-open draw</td><td>sha256(machineId | your tx signature | blockhash of your confirmation slot) over the remaining pool — you fix your signature before that blockhash exists; we control neither</td></tr>
      <tr><td>the price rule</td><td>a capsule costs (value still in the rack) ÷ (capsules still in the rack), recomputed at every open — so every capsule is a fair bet at the moment you buy it, and there is no good or bad time to play</td></tr>
      <tr><td>the machine ends</td><td>only when the rack is empty — no prize closes it early</td></tr>
      <tr><td>recompute every open</td><td><a style="color:var(--signal)" href="/api/verify-machine/${m.id}">/api/verify-machine/${m.id}</a></td></tr>
    </table>
  </div>

  <h2 style="margin-top:40px;font-size:2rem">RECENT <i>OPENS.</i></h2>
  <table class="inst"><tr><th>when</th><th>who</th><th>pulled</th><th>value</th></tr>
  ${feed || `<tr><td colspan="4" class="dim">nobody has dared yet</td></tr>`}</table>
</section>
<script>
(function(){
  const btn=document.getElementById('openbtn'); if(!btn) return;
  const msg=document.getElementById('paymsg');
  let price=${capsulePrice(m)};
  let n=1;
  const qn=document.getElementById('qn'), ou=document.getElementById('openusd'), px=document.getElementById('livepx');
  const draw=()=>{
    if(qn) qn.textContent=n;
    if(ou && !ou.dataset.paper) ou.textContent='$'+(n*price).toFixed(2)+' USDC';
  };
  async function tick(){
    try{
      const j=await (await fetch('/api/machine/${m.id}/price?n='+n)).json();
      if(!j.ok) return;
      const moved=Math.abs(j.priceUsd-price)>0.004;
      price=j.priceUsd;
      if(px){
        px.firstChild.textContent='$'+price.toFixed(2);
        if(moved){px.classList.remove('moved');void px.offsetWidth;px.classList.add('moved');}
      }
      if(ou&&!ou.dataset.paper) ou.textContent='$'+j.quote.totalUsd.toFixed(2)+' USDC';
      if(j.status!=='open') location.reload();
    }catch(e){}
  }
  setInterval(tick, 5000);
  if(qn){
    document.getElementById('qm').onclick=()=>{n=Math.max(1,n-1);draw();tick();};
    document.getElementById('qp').onclick=()=>{n=Math.min(25,n+1);draw();tick();};
  }
  function reveal(prizes,spent){
    const d=document.createElement('div'); d.className='reveal';
    d.innerHTML='<div class="rc"><span>the capsule holds</span><b>'+prizes.map(p=>p.label).join('<br>')+'</b>'+
      '<span>paid $'+(spent||0).toFixed(2)+' · worth $'+prizes.reduce((s,p)=>s+p.valueUsd,0).toFixed(2)+'</span></div>';
    d.onclick=()=>location.reload();
    document.body.appendChild(d);
    setTimeout(()=>location.reload(), 6000);
  }
  btn.onclick=async()=>{
    try{
      ${cfg.live ? `
      const ph=window.phantom?.solana||window.solana;
      if(!ph){msg.textContent='phantom not found';return;}
      await ph.connect();
      msg.textContent='building transaction…';
      const j=await (await fetch('/api/paytx?kind=capsule&machine=${m.id}&n='+n+'&payer='+ph.publicKey.toBase58())).json();
      if(!j.ok){msg.textContent=j.why;return;}
      const tx=solanaWeb3.Transaction.from(Uint8Array.from(atob(j.tx),c=>c.charCodeAt(0)));
      msg.textContent='sign it in phantom…';
      const {signature}=await ph.signAndSendTransaction(tx);
      msg.textContent='sent '+signature.slice(0,14)+'… your capsule opens when it confirms (~30s)';
      setTimeout(()=>location.reload(), 25000);
      ` : `
      msg.textContent='drawing against a live solana blockhash…';
      const j=await (await fetch('/api/machine/${m.id}/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({buyer:'you_'+Math.random().toString(36).slice(2,6),n:1})})).json();
      if(!j.ok){msg.textContent=j.why;return;}
      reveal(j.prizes, j.spentUsd);
      `}
    }catch(e){msg.textContent=String(e.message||e).slice(0,90);}
  };
})();
</script>
${cfg.live ? `<script src="https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js"></script>` : ""}`));
  });

  app.get("/vault", (_req, res) => {
    const rows = [...state.vault].reverse();
    res.type("html").send(shell("the vault", `
<section>
  <h2>THE <i>VAULT.</i></h2>
  <p class="side">EVERY CARD · WHAT THE MACHINE PAID · WHAT THE MARKET SAYS · NOTHING HIDDEN</p>
  <div class="slabs">${rows.map((v) => {
    const edge = ((v.compUsd - v.paidUsd) / v.compUsd) * 100;
    return `<div class="slab">
      <span class="st ${v.status === "vault" ? "amber" : "dim"}">${v.status}</span>
      ${v.image ? `<img src="${v.image}" loading="lazy" alt="">` : `<div style="height:200px;display:grid;place-items:center"><span style="font:400 3rem var(--disp);color:#e8b62e33">?</span></div>`}
      <h4>${v.itemName.slice(0, 46)}</h4>
      <div class="edge"><span class="dim">${usd(v.paidUsd)} →</span> <span class="amber">${usd(v.compUsd)}</span>
      <span class="${edge >= 0 ? "up" : "down"}">(${edge.toFixed(0)}%)</span></div>
    </div>`;
  }).join("") || '<p class="dim">empty — sweeps every 10 minutes</p>'}</div>
</section>`));
  });

  app.get("/grades", (_req, res) => {
    const gs = gradeStats();
    const rows = [...grades()].reverse().slice(0, 100).map((g) => `
<tr><td>${g.item.slice(0, 48)}</td><td>${usd(g.paidUsd)}</td><td>${usd(g.compUsd)}</td>
<td class="${g.outcome === "taken" ? "up" : g.outcome === "still-listed" ? "down" : "amber"}">${g.outcome}</td>
<td class="dim">${g.detail}</td></tr>`).join("");
    res.type("html").send(shell("receipts", `
<section>
  <h2>DID THE EDGES<br><i>TURN OUT REAL?</i></h2>
  <p class="side">PAPER BUYS LEAVE THE REAL LISTING ON THE MARKET — ITS FATE IS THE EXPERIMENT</p>
  <div class="statgrid">
    <div class="stat"><small>graded</small><b>${gs.graded}</b></div>
    <div class="stat"><small>taken (validated)</small><b class="up">${gs.taken}</b></div>
    <div class="stat"><small>still listed</small><b class="down">${gs.stillListed}</b></div>
    <div class="stat"><small>repriced</small><b class="amber">${gs.repriced}</b></div>
    <div class="stat"><small>validation rate</small><b>${gs.graded ? gs.validationPct + "%" : "—"}</b></div>
    <div class="stat"><small>comp index</small><b>${indexStats().groups}</b></div>
  </div>
  <table class="inst"><tr><th>card</th><th>paid</th><th>comp</th><th>outcome</th><th>detail</th></tr>
  ${rows || `<tr><td colspan="5" class="dim">first grades land a few hours after the first paper buys</td></tr>`}</table>
</section>`));
  });

  app.get("/admin", (_req, res) => {
    res.type("html").send(shell("admin", `
<section style="max-width:760px">
  <h2>MACHINE <i>CONTROLS.</i></h2>
  <p class="side">OPERATOR ONLY — THE KEY NEVER LEAVES YOUR BROWSER</p>
  <div class="receipts" style="margin-top:0">
    <h3>ACCESS</h3>
    <input id="key" type="password" placeholder="admin key" style="width:100%;padding:12px 14px;border-radius:10px;border:2px solid var(--edge);background:#0d1016;color:var(--cream);font:700 14px var(--mono)">
    <button class="cta" id="load" style="margin-top:14px;padding:10px 20px"><b>UNLOCK</b></button>
    <p id="amsg" class="dim" style="margin-top:10px;font-size:13px"></p>
  </div>
  <div id="panel" style="display:none">
    <div class="receipts"><h3>STATUS</h3><table id="stat"></table></div>
    <div class="receipts">
      <h3>SETTINGS</h3>
      <p class="dim" style="font-size:12px;margin-bottom:6px">token contract address (shows in the hero with click-to-copy)</p>
      <input id="ca" placeholder="token CA (mint address)" style="width:100%;padding:10px 12px;border-radius:10px;border:2px solid var(--edge);background:#0d1016;color:var(--cream);font:700 13px var(--mono)">
      <p class="dim" style="font-size:12px;margin:12px 0 6px">X profile URL (header + footer link)</p>
      <input id="xu" placeholder="https://x.com/…" style="width:100%;padding:10px 12px;border-radius:10px;border:2px solid var(--edge);background:#0d1016;color:var(--cream);font:700 13px var(--mono)">
      <button class="cta" id="saveset" style="margin-top:14px;padding:10px 20px"><b>SAVE SETTINGS</b></button>
    </div>
    <div class="receipts">
      <h3>THE SWITCH</h3>
      <p style="font-size:13px;margin-bottom:12px">Live mode = the sniper spends <b>real USDC</b> on mainnet, commitments go
      on-chain, payments/refunds/prizes move for real, and the simulator stops. Paper mode simulates everything.</p>
      <button class="cta" id="livebtn" style="padding:12px 22px"><b>…</b></button>
      <button class="cta" id="haltbtn" style="padding:12px 22px;background:var(--red);box-shadow:0 6px 0 #8f2222"><b>…</b></button>
      <p style="font-size:13px;margin:16px 0 8px">Bootstrap mode: at launch, inventory beats edge. Cheap cards
      (under $${cfg.bootstrapMaxCardUsd}) buy at a relaxed ${Math.round(cfg.bootstrapMinEdge * 100)}% edge bar, and penny cards under
      $${cfg.junkMaxUsd} buy with no edge at all as capsule filler. Turn it off once the vault is stocked.</p>
      <button class="cta" id="bootbtn" style="padding:10px 20px;background:var(--acid);box-shadow:0 6px 0 #2b7f74"><b>…</b></button>
      <p id="lmsg" class="dim" style="margin-top:10px;font-size:13px"></p>
    </div>
  </div>
</section>
<script>
const $=id=>document.getElementById(id);
const hdr=()=>({'content-type':'application/json','x-admin-key':$('key').value.trim()});
let st=null;
$('key').value=localStorage.getItem('nerdkey')||'';
async function refresh(){
  const r=await fetch('/api/admin/status',{headers:hdr()});
  if(r.status===403){$('amsg').textContent='wrong key (or ADMIN_KEY not set in env)';$('panel').style.display='none';return;}
  st=await r.json();
  localStorage.setItem('nerdkey',$('key').value.trim());
  $('amsg').textContent='';$('panel').style.display='block';
  $('stat').innerHTML=[
    ['mode', st.live?(st.devnet?'LIVE — devnet':'🔴 LIVE — MAINNET'):'paper'],
    ['halted', st.halted?'YES — nothing buys or pays':'no'],
    ['wallet', st.wallet],
    ['SOL / USDC', st.sol+' / $'+st.usdc],
    ['vault / raffles / machine', st.vault+' cards / '+st.openRaffles+' open / '+(st.openMachine?'running':'none')],
    ['junk cards (capsule filler)', st.junk],
    ['bootstrap mode', st.bootstrap?'ON — cheap cards on a relaxed edge + junk buying':'off — full edge bar only'],
    ['payouts pending / stuck', st.payouts.pending+' / '+st.payouts.stuck.length],
    ['token CA', st.tokenMint||'— not set'],
    ['X', st.xUrl||'— not set'],
  ].map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('');
  $('ca').value=st.tokenMint||'';$('xu').value=st.xUrl||'';
  $('livebtn').querySelector('b').textContent=st.live?'SWITCH TO PAPER':'GO LIVE (MAINNET)';
  $('haltbtn').querySelector('b').textContent=st.halted?'RESUME MACHINE':'EMERGENCY HALT';
  $('bootbtn').querySelector('b').textContent=st.bootstrap?'BOOTSTRAP: ON':'BOOTSTRAP: OFF';
}
$('load').onclick=refresh;
$('saveset').onclick=async()=>{
  await fetch('/api/admin/settings',{method:'POST',headers:hdr(),body:JSON.stringify({tokenMint:$('ca').value.trim(),xUrl:$('xu').value.trim()})});
  $('lmsg').textContent='settings saved';refresh();
};
$('livebtn').onclick=async()=>{
  const goingLive=!st.live;
  if(goingLive&&!confirm('GO LIVE?

The machine starts spending REAL USDC from wallet
'+st.wallet+'
from this moment. Sure?'))return;
  await fetch('/api/admin/settings',{method:'POST',headers:hdr(),body:JSON.stringify({live:goingLive})});
  $('lmsg').textContent=goingLive?'MACHINE IS LIVE':'back to paper';refresh();
};
$('bootbtn').onclick=async()=>{
  await fetch('/api/admin/settings',{method:'POST',headers:hdr(),body:JSON.stringify({bootstrap:!st.bootstrap})});
  refresh();
};
$('haltbtn').onclick=async()=>{
  await fetch('/api/admin/halt',{method:'POST',headers:hdr(),body:JSON.stringify({on:!st.halted,why:'admin panel'})});
  refresh();
};
if($('key').value)refresh();
</script>`));
  });

  app.get("/feed", (_req, res) => {
    const rows = ledgerTail(80).reverse().map((e: any) => `
<tr><td class="dim">${ago(e.at)}</td><td class="${e.kind === "paper-buy" ? "amber" : e.kind.includes("resolve") ? "up" : ""}">${e.kind}</td>
<td>${(e.item ?? e.raffle ?? "").toString().slice(0, 44)}</td>
<td class="dim">${[e.price != null ? "paid " + usd(e.price) : "", e.comp != null ? "comp " + usd(e.comp) : "", e.edge != null ? "edge " + Math.round(e.edge * 100) + "%" : "", e.winner ? "→ " + e.winner : "", e.note ?? "", e.outcome ?? ""].filter(Boolean).join(" · ").slice(0, 88)}</td></tr>`).join("");
    res.type("html").send(shell("live feed", `
<section>
  <h2>THE <i>FEED.</i></h2>
  <p class="side">EVERY DECISION, WITH ITS REASONING, AS IT HAPPENS</p>
  <table class="inst"><tr><th>when</th><th>event</th><th>what</th><th>detail</th></tr>${rows}</table>
</section>`));
  });
}
