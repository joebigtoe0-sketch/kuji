import type express from "express";
import { state, ledgerTail } from "./store.js";
import { gradeStats, grades } from "./grader.js";
import { indexStats } from "./comps.js";

/**
 * The machine's storefront — same design language as quantriku.fun's landing:
 * ink + construction amber, Anton display type, skewed CTAs with hard
 * shadows, rotated case-cards, ghost watermarks, marquees, grain. A gacha
 * is a THEATER; the receipts are the set dressing, not the show.
 */

const CSS = `
@font-face{font-family:'Anton';src:url('/fonts/Anton-Regular.ttf') format('truetype');font-display:swap}
:root{--ink:#100f0a;--ink2:#131209;--acid:#e8b62e;--signal:#ffc21a;--cream:#f4ecca;--red:#ff3a24;--green:#39ff88;
--disp:'Anton','Arial Narrow',Impact,sans-serif;--lab:'Consolas','Cascadia Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0}
html{scroll-behavior:smooth;background:var(--ink)}
body{background:var(--ink);color:var(--cream);font-family:var(--lab);font-size:14px;line-height:1.5;overflow-x:hidden}
a{color:inherit;text-decoration:none}
::selection{background:var(--signal);color:var(--ink)}
.lab{font:700 11px var(--lab);letter-spacing:.26em;text-transform:uppercase}

/* grain */
.noise{position:fixed;inset:-100%;z-index:90;opacity:.10;pointer-events:none;
background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.6'/%3E%3C/svg%3E");
animation:grain .24s steps(2,end) infinite}
@keyframes grain{0%{transform:translate(0,0)}50%{transform:translate(-2%,2%)}100%{transform:translate(2%,-2%)}}

/* header */
.hd{position:sticky;top:0;z-index:50;display:flex;justify-content:space-between;align-items:center;
padding:0 3.5vw;height:74px;background:#100f0acc;backdrop-filter:blur(4px);border-bottom:1px solid #f4ecca38}
.wordmark{font:400 2rem var(--disp);letter-spacing:.02em}
.wordmark b{color:var(--signal);font-weight:400}
.hd nav{display:flex;gap:30px;font:700 12.5px var(--lab);letter-spacing:.16em;text-transform:uppercase}
.hd nav a:hover{color:var(--signal)}
.papertag{border:1px solid var(--red);color:#ff9d90;padding:6px 13px;font:700 10.5px var(--lab);letter-spacing:.2em}
@media(max-width:760px){.hd nav{display:none}}

/* ticker */
.tick{border-bottom:1px solid #f4ecca24;background:var(--ink2);overflow:hidden;white-space:nowrap}
.tick span{display:inline-block;padding:9px 0;font:700 10.5px var(--lab);letter-spacing:.22em;text-transform:uppercase;
animation:tickm 40s linear infinite}
@keyframes tickm{to{transform:translateX(-50%)}}
.tick b{color:var(--signal)} .tick i{font-style:normal;color:#f4ecca66;margin:0 18px}

/* hero */
.hero{position:relative;padding:9vh 5vw 7vh;isolation:isolate;overflow:hidden}
.hero::before{content:"NO EDGE NO EDGE NO EDGE";position:absolute;top:8%;left:-4vw;font:400 17vw/1 var(--disp);
color:#e8b62e0d;white-space:nowrap;pointer-events:none;z-index:-1}
h1{font:400 clamp(3.4rem,10.5vw,9rem)/.8 var(--disp);text-transform:uppercase;letter-spacing:-.01em}
h1 i{font-style:normal;color:transparent;-webkit-text-stroke:2px var(--cream);display:block}
.deck{font:400 clamp(1.1rem,2vw,1.6rem)/1.35 var(--disp);letter-spacing:.03em;text-transform:uppercase;
margin:26px 0 8px;max-width:640px}
.deck em{font-style:normal;color:var(--signal)}
.herofan{position:absolute;right:2vw;top:12vh;width:min(390px,34vw);height:420px;pointer-events:none;z-index:-1}
.herofan img{position:absolute;width:64%;border:6px solid #1c1a10;box-shadow:14px 16px #0a0a08cc;background:#181712}
.herofan img:nth-child(1){left:0;top:36px;transform:rotate(-9deg)}
.herofan img:nth-child(2){left:24%;top:0;transform:rotate(3deg);z-index:2}
.herofan img:nth-child(3){left:44%;top:56px;transform:rotate(12deg)}
@media(max-width:900px){.herofan{display:none}}
.stamp{position:absolute;right:5vw;bottom:5vh;width:138px;height:138px;border:1.5px solid var(--cream);border-radius:50%;
display:grid;place-content:center;text-align:center;animation:float 5s ease-in-out infinite;background:#100f0aa8;z-index:3}
.stamp::before{content:"";position:absolute;inset:9px;border:1px dashed var(--cream);border-radius:50%}
.stamp b{font:400 1.05rem var(--disp);text-transform:uppercase}
.stamp span{font:700 8.5px var(--lab);letter-spacing:.14em;text-transform:uppercase;margin-top:3px}
@keyframes float{50%{transform:translateY(-10px) rotate(3deg)}}

/* skewed CTA */
.cta{display:inline-grid;grid-template-columns:1fr auto;gap:2px 14px;padding:16px 22px;background:var(--signal);
color:#14130a;transform:skew(-2deg);box-shadow:7px 7px #0a0a08;transition:all .2s;margin-top:26px}
.cta:hover{transform:translate(-3px,-3px) skew(-2deg);box-shadow:10px 10px #0a0a08}
.cta small{grid-column:1;font:700 9.5px var(--lab);letter-spacing:.2em;text-transform:uppercase;opacity:.65}
.cta b{font:400 1.35rem var(--disp);letter-spacing:.02em;text-transform:uppercase}
.cta span{grid-area:1/2/3/3;align-self:center;font-size:1.5rem}

/* sections */
section{padding:7vh 5vw}
h2{font:400 clamp(2.4rem,6.5vw,5rem)/.82 var(--disp);text-transform:uppercase;margin-bottom:8px}
h2 i{font-style:normal;color:transparent;-webkit-text-stroke:1.5px var(--cream)}
.side{font:600 11px var(--lab);letter-spacing:.22em;text-transform:uppercase;color:var(--acid);margin-bottom:34px}

/* product cards */
.shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:26px}
.prod{position:relative;background:var(--ink2);border:1px solid #f4ecca30;transition:transform .2s;display:block}
.prod:hover{transform:translateY(-5px)}
.prod .art{position:relative;height:270px;background:radial-gradient(ellipse at 50% 30%,#26220f 0%,#131209 70%);
display:grid;place-items:center;border-bottom:1px solid #f4ecca24;overflow:hidden}
.prod .art img{max-height:230px;max-width:82%;filter:drop-shadow(0 14px 22px #000c)}
.prod .art .none{font:400 3rem var(--disp);color:#e8b62e33}
.ribbon{position:absolute;top:14px;left:-8px;background:var(--signal);color:var(--ink);padding:5px 14px;
font:700 10px var(--lab);letter-spacing:.18em;text-transform:uppercase;box-shadow:4px 4px #0a0a08}
.ribbon.won{background:var(--green)} .ribbon.dead{background:#6b685a;color:var(--cream)} .ribbon.free{background:#b8a7ff}
.prod .bd{padding:16px 16px 18px}
.prod h3{font:400 1.1rem/1.05 var(--disp);text-transform:uppercase;letter-spacing:.02em;min-height:2.2em}
.meta{display:flex;justify-content:space-between;align-items:baseline;margin-top:10px}
.meta .px{font:400 1.6rem var(--disp);color:var(--signal)}
.meta .px small{font:700 9px var(--lab);letter-spacing:.16em;color:var(--cream);opacity:.6;display:block}
.meta .left{font:700 10.5px var(--lab);letter-spacing:.14em;text-transform:uppercase;opacity:.7}
.fill{height:10px;background:#f4ecca1c;margin-top:12px;position:relative}
.fill i{position:absolute;inset:0 auto 0 0;background:var(--signal)}
.fill.done i{background:var(--green)}
.winline{margin-top:10px;font:700 11px var(--lab);letter-spacing:.12em;text-transform:uppercase;color:var(--green)}

/* how-it-works */
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.step{border:1px solid #f4ecca30;background:var(--ink2);padding:22px 20px;position:relative}
.step b{position:absolute;top:-18px;right:14px;font:400 3.4rem var(--disp);color:#e8b62e2b}
.step h3{font:400 1.35rem var(--disp);text-transform:uppercase;margin-bottom:8px;color:var(--signal)}
.step p{font-size:13px;opacity:.92}

/* detail page */
.case{display:grid;grid-template-columns:1fr 1.1fr;gap:0;background:#f4ecca;color:var(--ink);
transform:rotate(-1deg);box-shadow:22px 26px #3a3214;margin:30px 0}
.case .art{background:#181712;display:grid;place-items:center;min-height:420px;position:relative;overflow:hidden}
.case .art img{max-height:380px;max-width:86%;filter:drop-shadow(0 18px 30px #000d)}
.case .txt{padding:44px 42px}
.case .txt .lab{color:#7a6414}
.case h2{color:var(--ink);font-size:clamp(1.8rem,3.4vw,2.8rem);margin:10px 0 18px}
.duel{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}
.duel div{border:2px solid var(--ink);padding:12px 14px}
.duel small{display:block;font:700 9.5px var(--lab);letter-spacing:.18em;text-transform:uppercase;opacity:.6}
.duel b{font:400 1.8rem var(--disp)}
.receipts{background:#0c0b07;color:var(--cream);border:1px solid #f4ecca26;padding:20px 22px;margin-top:26px}
.receipts h3{font:400 1.3rem var(--disp);text-transform:uppercase;color:var(--signal);margin-bottom:12px}
.receipts table{width:100%;border-collapse:collapse;font-size:12px}
.receipts td{padding:6px 8px;border-bottom:1px solid #f4ecca12;word-break:break-all}
.receipts td:first-child{opacity:.55;white-space:nowrap}
.bigstamp{position:absolute;inset:auto 18px 18px auto;transform:rotate(-8deg);border:4px solid var(--green);
color:var(--green);padding:8px 20px;font:400 1.6rem var(--disp);text-transform:uppercase;background:#100f0ac9}
@media(max-width:860px){.case{display:block;transform:none}.case .art{min-height:300px}}

/* gallery (vault) */
.slabs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:22px}
.slab{background:var(--ink2);border:1px solid #f4ecca30;padding:14px;text-align:center;position:relative}
.slab img{max-height:200px;max-width:88%;filter:drop-shadow(0 12px 18px #000c)}
.slab h4{font:400 .95rem/1.1 var(--disp);text-transform:uppercase;margin:12px 0 4px;min-height:2.1em}
.slab .edge{font:700 11px var(--lab);letter-spacing:.1em}
.slab .st{position:absolute;top:10px;right:10px;font:700 9px var(--lab);letter-spacing:.14em;text-transform:uppercase;
border:1px solid currentColor;padding:2px 8px;opacity:.85}

/* instrument tables (grades/feed) */
table.inst{width:100%;border-collapse:collapse;font-size:13px}
table.inst th{font:700 10px var(--lab);letter-spacing:.18em;text-transform:uppercase;text-align:left;opacity:.55;
padding:8px 10px;border-bottom:1px solid #f4ecca2e}
table.inst td{padding:8px 10px;border-bottom:1px solid #f4ecca14}
.up{color:var(--green)}.down{color:var(--red)}.amber{color:var(--signal)}.dim{opacity:.6}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 26px}
.stat{border:1px solid #f4ecca2e;background:var(--ink2);padding:14px 16px}
.stat small{display:block;font:700 9.5px var(--lab);letter-spacing:.2em;text-transform:uppercase;opacity:.55;margin-bottom:5px}
.stat b{font:400 1.6rem var(--disp)}

footer{background:var(--signal);color:var(--ink);padding:5vh 5vw;margin-top:8vh}
footer .big{font:400 clamp(2rem,6vw,4.4rem)/.85 var(--disp);text-transform:uppercase}
footer p{font:600 12px var(--lab);letter-spacing:.06em;text-transform:uppercase;margin-top:16px;max-width:640px}
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
  <nav><a href="/raffles">Raffles</a><a href="/vault">The Vault</a><a href="/grades">Receipts</a><a href="/feed">Live Feed</a></nav>
  <span class="papertag">● PAPER MODE</span>
</header>
${ticker ? `<div class="tick"><span>${ticker}${ticker}</span></div>` : ""}
${body}
<footer>
  <div class="big">THE HOUSE HAS NO EDGE.<br>WE JUST BUY BETTER THAN YOU.</div>
  <p>Built by RIKU. Every draw committed to a future Solana blockhash before a single ticket exists.
  Paper mode: real market data, real cryptography, fake money — until the math proves itself.</p>
</footer>
<script>setTimeout(()=>location.reload(), 45000)</script>
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
  <div class="herofan">${fan.map((v) => `<img src="${v.image}" alt="">`).join("")}</div>
  <p class="lab" style="color:var(--acid)">A MACHINE BUILT BY RIKU · GRADED CARDS · PROVABLY FAIR</p>
  <h1>EVERY TICKET<br><i>WORTH EXACTLY</i>WHAT IT COSTS.</h1>
  <p class="deck">The machine snipes graded cards <em>below market</em>, then raffles them at
  <em>exactly their value</em>. Its only profit is the discount it caught. Your odds are
  committed on-chain <em>before tickets exist</em>.</p>
  <a class="cta" href="/raffles"><small>${live.length} live raffle${live.length === 1 ? "" : "s"} right now</small><b>ENTER THE MACHINE</b><span>↗</span></a>
  <div class="stamp"><b>PROVABLY<br>FAIR</b><span>VERIFY EVERY DRAW</span></div>
</section>

${live.length ? `<section>
  <h2>LIVE <i>RAFFLES.</i></h2>
  <p class="side">FILL OR REFUND — NO SELLOUT, NO DRAW, MONEY BACK</p>
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
    </div>
  </div>
  <div class="receipts">
    <h3>FAIRNESS RECEIPTS</h3>
    <table>
      <tr><td>commitment (published before any ticket)</td><td>${r.commitHash}</td></tr>
      <tr><td>resolve slot (named in the commitment)</td><td>${r.resolveSlot}</td></tr>
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
</script>`));
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
