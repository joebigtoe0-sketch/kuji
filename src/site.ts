import type express from "express";
import { state, ledgerTail } from "./store.js";
import { gradeStats, grades } from "./grader.js";
import { indexStats } from "./comps.js";

/**
 * The machine's public face — same visual family as quantriku.fun:
 * ink (#100f0a), construction amber (#e8b62e), signal (#ffc21a), cream
 * (#f4ecca), Anton display type, Consolas lab text. NERDNAME's twist: it
 * reads like an instrument panel, because the agent IS an instrument.
 */

const CSS = `
@font-face{font-family:'Anton';src:url('/fonts/Anton-Regular.ttf') format('truetype');font-display:swap}
:root{--ink:#100f0a;--ink2:#131209;--acid:#e8b62e;--signal:#ffc21a;--cream:#f4ecca;--red:#ff3a24;--green:#39ff88;
--disp:'Anton','Arial Narrow',Impact,sans-serif;--lab:'Consolas','Cascadia Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0}
body{background:var(--ink);color:var(--cream);font-family:var(--lab);font-size:14px;line-height:1.5}
a{color:inherit;text-decoration:none}
.wrap{max-width:1080px;margin:0 auto;padding:24px 20px 80px}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #f4ecca33;padding-bottom:14px;margin-bottom:26px}
.wordmark{font:400 2.2rem var(--disp);letter-spacing:.02em}
.wordmark span{color:var(--acid)}
nav{display:flex;gap:22px;font:700 12px var(--lab);letter-spacing:.16em;text-transform:uppercase}
nav a:hover{color:var(--signal)}
h1{font:400 clamp(2.6rem,7vw,4.6rem)/.85 var(--disp);text-transform:uppercase;margin:10px 0 6px}
h1 i{font-style:normal;color:transparent;-webkit-text-stroke:1.5px var(--cream)}
.sub{font:600 11.5px var(--lab);letter-spacing:.2em;text-transform:uppercase;color:var(--acid);margin-bottom:26px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:18px 0 30px}
.stat{border:1px solid #f4ecca2e;background:var(--ink2);padding:14px 16px}
.stat small{display:block;font:700 10px var(--lab);letter-spacing:.22em;text-transform:uppercase;opacity:.55;margin-bottom:6px}
.stat b{font:400 1.7rem var(--disp);letter-spacing:.02em}
.stat b.up{color:var(--green)} .stat b.amber{color:var(--signal)}
.card{border:1px solid #f4ecca2e;background:var(--ink2);padding:16px 18px;margin-bottom:12px}
.card h3{font:400 1.25rem var(--disp);text-transform:uppercase;letter-spacing:.02em;margin-bottom:6px}
.dim{opacity:.6}.mono{font-family:var(--lab)}
.bar{height:8px;background:#f4ecca1f;margin:10px 0 6px;position:relative}
.bar i{position:absolute;inset:0 auto 0 0;background:var(--signal)}
.tag{display:inline-block;border:1px solid currentColor;padding:2px 9px;font:700 10px var(--lab);letter-spacing:.14em;text-transform:uppercase;margin-left:8px}
.tag.open{color:var(--signal)}.tag.resolved{color:var(--green)}.tag.refunded{color:#8b8b7a}.tag.holder{color:#b8a7ff}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font:700 10px var(--lab);letter-spacing:.18em;text-transform:uppercase;text-align:left;opacity:.55;padding:8px 10px;border-bottom:1px solid #f4ecca2e}
td{padding:8px 10px;border-bottom:1px solid #f4ecca14;vertical-align:top}
.up{color:var(--green)}.down{color:var(--red)}.amber{color:var(--signal)}
pre{background:#0c0b07;border:1px solid #f4ecca22;padding:14px;overflow-x:auto;font-size:12px}
.paper{position:fixed;top:10px;right:-34px;transform:rotate(35deg);background:var(--red);color:var(--cream);
font:700 11px var(--lab);letter-spacing:.2em;padding:5px 42px;z-index:9}
`;

function page(title: string, nav: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NERDNAME — ${title}</title><style>${CSS}</style></head><body>
<div class="paper">PAPER MODE</div>
<div class="wrap">
<header>
  <a class="wordmark" href="/">NERD<span>NAME</span></a>
  <nav>
    <a href="/">machine</a><a href="/raffles">raffles</a><a href="/vault">vault</a>
    <a href="/grades">grades</a><a href="/feed">feed</a>
  </nav>
</header>
${body}
</div></body></html>`;
}

const usd = (n: number) => "$" + (+n).toFixed(2).replace(/\.00$/, "");
const ago = (t: number) => {
  const m = (Date.now() - t) / 60000;
  return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function mountSite(app: express.Express): void {
  app.get("/", (_req, res) => {
    const live = state.vault.filter((v) => v.status === "vault" || v.status === "raffled");
    const cost = live.reduce((s, v) => s + v.paidUsd, 0);
    const comp = live.reduce((s, v) => s + v.compUsd, 0);
    const gs = gradeStats();
    const ix = indexStats();
    const open = state.raffles.filter((r) => r.status === "open");
    res.type("html").send(page("the machine", "", `
<h1>THE HOUSE HAS<br><i>NO EDGE.</i></h1>
<p class="sub">a machine that buys cards below market and raffles them at exactly what they're worth · built by riku</p>
<div class="grid">
  <div class="stat"><small>wallet</small><b>${usd(state.walletUsd)}</b></div>
  <div class="stat"><small>vault cost → value</small><b class="${comp >= cost ? "up" : "down"}">${usd(cost)} → ${usd(comp)}</b></div>
  <div class="stat"><small>realized spread</small><b class="${state.realizedProfitUsd >= 0 ? "up" : "down"}">${usd(state.realizedProfitUsd)}</b></div>
  <div class="stat"><small>holder drop pool</small><b class="amber">${usd(state.holderPoolUsd)}</b></div>
  <div class="stat"><small>edge validation</small><b>${gs.graded ? gs.validationPct + "%" : "—"}</b></div>
  <div class="stat"><small>comp index</small><b>${ix.groups}</b></div>
</div>
<div class="card"><h3>how it works</h3>
<p>1. trading fees fund the sniper. 2. the sniper buys cards listed below what
comparable listings say they're worth — every buy published with its math.
3. each card becomes a raffle: N tickets at exactly value ÷ N. sell out → a
committed future solana blockhash picks the winner. don't sell out → refund.
4. half the realized spread funds <b>free raffles for token holders</b>.</p>
<p class="dim" style="margin-top:8px">the machine profits only on the spread it sniped. odds are committed before
tickets exist. every draw is recomputable from public data.</p></div>
${open.length ? `<div class="card"><h3>live raffles</h3>${open.map((r) => {
  const sold = r.sold.reduce((s, t) => s + t.n, 0);
  return `<p><a href="/raffle/${r.id}"><b>${r.title.slice(0, 60)}</b></a><span class="tag ${r.kind === "holder" ? "holder" : "open"}">${r.kind}</span></p>
  <div class="bar"><i style="width:${Math.min(100, (100 * sold) / r.tickets)}%"></i></div>
  <p class="dim">${sold}/${r.tickets} tickets ${r.kind === "paid" ? "· " + usd(r.ticketUsd) + " each" : "· free — holding is the ticket"}</p>`;
}).join("")}</div>` : ""}
`));
  });

  app.get("/raffles", (_req, res) => {
    const rows = [...state.raffles].reverse().map((r) => {
      const sold = r.sold.reduce((s, t) => s + t.n, 0);
      return `<tr><td><a href="/raffle/${r.id}">${r.id}</a></td><td>${r.title.slice(0, 46)}</td>
<td><span class="tag ${r.status === "open" ? "open" : r.status}">${r.status}</span>${r.kind === "holder" ? '<span class="tag holder">holder</span>' : ""}</td>
<td>${sold}/${r.tickets}</td><td>${r.kind === "paid" ? usd(r.ticketUsd) : "free"}</td>
<td>${r.winner ? `<b class="up">${r.winner}</b>` : '<span class="dim">—</span>'}</td></tr>`;
    }).join("");
    res.type("html").send(page("raffles", "", `
<h1>RAFFLES</h1>
<p class="sub">fill-or-refund · odds committed before a single ticket exists</p>
<div class="card"><table><tr><th>id</th><th>card</th><th>status</th><th>tickets</th><th>price</th><th>winner</th></tr>${rows || "<tr><td colspan=6 class=dim>none yet — the sniper is stocking the vault</td></tr>"}</table></div>`));
  });

  app.get("/raffle/:id", (req, res) => {
    const r = state.raffles.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).type("html").send(page("404", "", "<h1>NO SUCH<br><i>RAFFLE.</i></h1>"));
    const card = state.vault.find((v) => v.nft === r.nft);
    const sold = r.sold.reduce((s, t) => s + t.n, 0);
    res.type("html").send(page(r.id, "", `
<h1>${r.title.slice(0, 40)}</h1>
<p class="sub">${r.kind === "paid" ? "paid raffle — fill or refund" : "free holder drop"} <span class="tag ${r.status === "open" ? "open" : r.status}">${r.status}</span></p>
<div class="grid">
  <div class="stat"><small>tickets</small><b>${sold}/${r.tickets}</b></div>
  <div class="stat"><small>ticket price</small><b>${r.kind === "paid" ? usd(r.ticketUsd) : "FREE"}</b></div>
  ${card ? `<div class="stat"><small>machine paid</small><b>${usd(card.paidUsd)}</b></div>
  <div class="stat"><small>comp value</small><b class="amber">${usd(card.compUsd)}</b></div>` : ""}
  ${r.winner ? `<div class="stat"><small>winner</small><b class="up">${r.winner}</b></div>` : ""}
</div>
${card ? `<div class="card"><h3>the card</h3><p>${card.itemName}</p><p class="dim">${card.gradingCompany} ${card.grade} · comp basis: ${card.compBasis}</p></div>` : ""}
<div class="card"><h3>fairness receipts</h3>
<table>
<tr><td class="dim">commitment (before any ticket)</td><td class="mono">${r.commitHash}</td></tr>
<tr><td class="dim">resolve slot (named in commit)</td><td class="mono">${r.resolveSlot}</td></tr>
${r.seed ? `<tr><td class="dim">seed (revealed)</td><td class="mono">${r.seed}</td></tr>` : ""}
${r.blockhash ? `<tr><td class="dim">blockhash used</td><td class="mono">${r.blockhash}</td></tr>` : ""}
</table>
<p class="dim" style="margin-top:10px">${r.status === "resolved"
  ? `verify it yourself: <a href="/api/verify/${r.id}" class="amber">/api/verify/${r.id}</a> recomputes the winner from published data only.`
  : "the seed reveals at resolution. the blockhash doesn't exist yet — that's the point."}</p></div>`));
  });

  app.get("/vault", (_req, res) => {
    const rows = [...state.vault].reverse().map((v) => {
      const edge = ((v.compUsd - v.paidUsd) / v.compUsd) * 100;
      return `<tr><td>${v.itemName.slice(0, 52)}</td><td>${v.gradingCompany} ${v.grade}</td>
<td>${usd(v.paidUsd)}</td><td>${usd(v.compUsd)}</td><td class="${edge >= 0 ? "up" : "down"}">${edge.toFixed(0)}%</td>
<td class="dim">${v.status}</td><td class="dim">${ago(v.boughtAt)}</td></tr>`;
    }).join("");
    res.type("html").send(page("vault", "", `
<h1>THE VAULT</h1>
<p class="sub">every card with what the machine paid and what the comps said · nothing hidden</p>
<div class="card"><table><tr><th>card</th><th>grade</th><th>paid</th><th>comp</th><th>edge</th><th>status</th><th>when</th></tr>${rows || "<tr><td colspan=7 class=dim>empty — sweeps run every " + "10 minutes</td></tr>"}</table></div>`));
  });

  app.get("/grades", (_req, res) => {
    const gs = gradeStats();
    const rows = [...grades()].reverse().slice(0, 100).map((g) => `
<tr><td>${g.item.slice(0, 48)}</td><td>${usd(g.paidUsd)}</td><td>${usd(g.compUsd)}</td>
<td class="${g.outcome === "taken" ? "up" : g.outcome === "still-listed" ? "down" : "amber"}">${g.outcome}</td>
<td class="dim">${g.detail}</td></tr>`).join("");
    res.type("html").send(page("grades", "", `
<h1>DID THE EDGES<br><i>TURN OUT REAL?</i></h1>
<p class="sub">paper buys leave the real listing on the market — what happens to it is the experiment</p>
<div class="grid">
  <div class="stat"><small>graded</small><b>${gs.graded}</b></div>
  <div class="stat"><small>taken (validated)</small><b class="up">${gs.taken}</b></div>
  <div class="stat"><small>still listed</small><b class="down">${gs.stillListed}</b></div>
  <div class="stat"><small>repriced</small><b class="amber">${gs.repriced}</b></div>
  <div class="stat"><small>validation rate</small><b>${gs.graded ? gs.validationPct + "%" : "—"}</b></div>
</div>
<div class="card"><table><tr><th>card</th><th>paid</th><th>comp</th><th>outcome</th><th>detail</th></tr>${rows || "<tr><td colspan=5 class=dim>first grades land " + "24h after the first paper buys</td></tr>"}</table></div>`));
  });

  app.get("/feed", (_req, res) => {
    const rows = ledgerTail(80).reverse().map((e: any) => `
<tr><td class="dim">${ago(e.at)}</td><td><span class="tag ${e.kind === "paper-buy" ? "open" : e.kind.includes("resolve") ? "resolved" : e.kind.includes("grade") ? "holder" : "refunded"}">${e.kind}</span></td>
<td>${(e.item ?? e.raffle ?? e.note ?? "").toString().slice(0, 46)}</td>
<td class="dim">${[e.price != null ? "paid " + usd(e.price) : "", e.comp != null ? "comp " + usd(e.comp) : "", e.edge != null ? "edge " + Math.round(e.edge * 100) + "%" : "", e.winner ? "winner " + e.winner : "", e.note ?? ""].filter(Boolean).join(" · ").slice(0, 90)}</td></tr>`).join("");
    res.type("html").send(page("feed", "", `
<h1>THE FEED</h1>
<p class="sub">every decision, with its reasoning, as it happens</p>
<div class="card"><table><tr><th>when</th><th>event</th><th>what</th><th>detail</th></tr>${rows}</table></div>`));
  });
}
