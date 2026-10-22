import "dotenv/config";
import http from "node:http";
import { Command } from "@langchain/langgraph";
import { graph } from "./graph.js";
import type { Order } from "./state.js";

/**
 * Local demo server — the same graph the CLI runs, behind a minimal web UI.
 * SSE streams each node's log lines as they land; when interrupt() parks the
 * run, the UI shows approve/reject buttons that POST a Command({resume}).
 */

const BASE: Order = {
  orderId: "",
  customerEmail: "jean.grey@xmen.com",
  country: "US",
  items: [{ sku: "X-001", quantity: 1, unitPrice: 49.99 }],
  paymentMethodId: "pm_ok_test",
};

const SCENARIOS: Record<string, Partial<Order>> = {
  happy:    {},
  stock:    { items: [{ sku: "X-003", quantity: 1, unitPrice: 49.99 }] },
  declined: { paymentMethodId: "pm_fail_test" },
  capture:  { paymentMethodId: "pm_capture_fail_test" },
  review:   { customerEmail: "test@mailinator.com" },
  reject:   { customerEmail: "test@mailinator.com", country: "NG",
              items: [{ sku: "X-001", quantity: 1, unitPrice: 1500 }] },
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LangGraph Fraud Loop</title><style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui;background:#0b1020;color:#e6e9f2}
  header{padding:14px 20px;border-bottom:1px solid #1e2a4a;display:flex;justify-content:space-between;align-items:center}
  h1{font-size:1rem;margin:0}.tag{font-size:.65rem;background:#1f9d63;border-radius:99px;padding:2px 9px;font-weight:700;text-transform:uppercase}
  main{max-width:760px;margin:0 auto;padding:24px 20px}
  .scen{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px}
  button{background:#16224a;border:1px solid #2a3a6e;color:#e6e9f2;border-radius:8px;padding:10px;font-size:.8rem;cursor:pointer;text-align:left}
  button:hover{border-color:#7c9aff} .sub{display:block;font-size:.65rem;color:#8a97b8;margin-top:2px}
  #log{background:#060a18;border:1px solid #1e2a4a;border-radius:10px;padding:14px;font-size:.82rem;line-height:1.7;white-space:pre-wrap;min-height:120px}
  #gate{margin-top:14px;display:none;background:#1a1430;border:1px solid #7c5cbf;border-radius:10px;padding:14px}
  #gate b{color:#c9a8ff} #gate .row{display:flex;gap:8px;margin-top:10px}
  .ok{background:#14532d;border-color:#22c55e}.no{background:#7f1d1d;border-color:#ef4444}
  .status{font-weight:700}.done{color:#4ade80}.fail{color:#f87171}.pause{color:#fbbf24}
</style></head><body>
<header><h1>🧠 LangGraph Fraud-Review Loop</h1><span class="tag">local</span></header>
<main>
  <div class="scen" id="scen"></div>
  <div id="log">Pick a scenario — the graph streams each agent step as it runs.</div>
  <div id="gate"><b>⏸ Human review required</b><div id="gateinfo" style="font-size:.8rem;margin-top:4px"></div>
    <div class="row"><button class="ok" onclick="review('approve')">✅ Approve</button>
    <button class="no" onclick="review('reject')">❌ Reject</button></div></div>
</main>
<script>
const SC = {happy:['✅ Happy path','all agents pass'],stock:['📦 Out of stock','inventory fails'],
  declined:['💳 Card declined','saga compensation'],capture:['↩️ Capture fails','compensation'],
  review:['🟡 Fraud review','pauses for human'],reject:['🚫 Auto-reject','score ≥70']};
const scen = document.getElementById('scen'), log = document.getElementById('log'),
      gate = document.getElementById('gate'), gateinfo = document.getElementById('gateinfo');
for (const [k,[t,s]] of Object.entries(SC)) {
  const b = document.createElement('button');
  b.innerHTML = t + '<span class="sub">' + s + '</span>';
  b.onclick = () => run(k); scen.appendChild(b);
}
let cur = null;
async function run(sc) {
  gate.style.display='none'; log.textContent='';
  const es = new EventSource('/submit?scenario='+sc+'&t='+Date.now());
  es.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.log) log.innerHTML += d.log + '\\n';
    if (d.paused) { cur = d.orderId; gateinfo.textContent = 'Order '+d.orderId+' — fraud score '+d.score+'/100'; gate.style.display='block'; es.close(); }
    if (d.status) { log.innerHTML += '\\n<span class="status '+(d.status==='Completed'?'done':'fail')+'">■ Pipeline '+d.status+'</span>'; es.close(); }
  };
  es.onerror = () => es.close();
}
async function review(decision) {
  gate.style.display='none';
  const es = new EventSource('/review?orderId='+cur+'&decision='+decision);
  es.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.log) log.innerHTML += d.log + '\\n';
    if (d.status) { log.innerHTML += '\\n<span class="status '+(d.status==='Completed'?'done':'fail')+'">■ Pipeline '+d.status+'</span>'; es.close(); }
  };
  es.onerror = () => es.close();
}
</script></body></html>`;

function sse(res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(PAGE);
  }

  if (url.pathname === "/submit" || url.pathname === "/review") {
    const send = sse(res);
    try {
      let threadId: string;
      let input: object | Command;
      if (url.pathname === "/submit") {
        const patch = SCENARIOS[url.searchParams.get("scenario") ?? "happy"] ?? {};
        threadId = `ORD-${Date.now()}`;
        input = { order: { ...BASE, ...patch, orderId: threadId } };
      } else {
        threadId = url.searchParams.get("orderId")!;
        input = new Command({ resume: url.searchParams.get("decision") });
      }

      const config = { configurable: { thread_id: threadId } };
      let seen = 0;
      for await (const chunk of await graph.stream(input as never, { ...config, streamMode: "values" })) {
        const lines = (chunk as { log?: string[] }).log ?? [];
        for (const l of lines.slice(seen)) send({ log: l });
        seen = lines.length;
      }

      const state = await graph.getState(config);
      const pending = state.tasks.flatMap(t => t.interrupts ?? []);
      if (pending.length) {
        const v = pending[0].value as { orderId: string; riskScore: number };
        send({ paused: true, orderId: threadId, score: v.riskScore });
      } else {
        send({ status: (state.values as { status: string }).status });
      }
    } catch (e) {
      send({ status: `Error: ${e instanceof Error ? e.message : e}` });
    }
    return res.end();
  }

  res.writeHead(404); res.end();
});

const port = Number(process.env.PORT ?? 5080);
server.listen(port, () => console.log(`LangGraph demo → http://localhost:${port}`));
