import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { State } from "./state.js";
import { allTools, toolsByName } from "./tools.js";

const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.1 });

/**
 * Each node = one agent step. Nodes receive the merged graph state and return
 * a PARTIAL update — exactly like `context.SharedData[...] = ...` in C#,
 * except the graph itself owns merging, routing, and checkpointing.
 */

// ── Cerebro — orchestrator. Plans the pipeline like the C# version did. ──────
export async function cerebro(state: State) {
  const res = await model.invoke([
    new SystemMessage(
      "You are Cerebro, an order-fulfillment orchestrator. Decompose the order " +
      "into specialist tasks (validate, fraud-score, inventory, payment, ship, " +
      "confirm). Reply with a one-line execution plan."
    ),
    new HumanMessage(JSON.stringify(state.order)),
  ]);
  const plan = res.text.slice(0, 200);
  return { plan, log: [`🧠 Cerebro: ${plan}`] };
}

// ── Cyclops — deterministic validation (same checks, no LLM needed). ─────────
export async function cyclops(state: State) {
  const o = state.order;
  const ok =
    o.customerEmail.includes("@") &&
    o.items.every(i => i.sku && i.quantity > 0 && i.unitPrice > 0);
  if (!ok)
    return { status: "Failed", log: ["👁️ Cyclops: order payload invalid — pipeline stopped"] };
  const total = o.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  return { log: [`👁️ Cyclops: schema valid — ${o.items.length} item(s), total $${total.toFixed(2)}`] };
}

// ── Beast — the real tool-calling agent. Mirrors the C# while-loop on
//    ChatFinishReason.ToolCalls: model calls tools until it answers. ──────────
export async function beast(state: State) {
  const o = state.order;
  const messages: BaseMessage[] = [
    new SystemMessage(
      "You are Beast, a fraud detection specialist. Call BOTH scoring tools, " +
      'then reply with ONLY JSON: {"riskScore": <0-100>, "factors": [...]}'
    ),
    new HumanMessage(`Score the fraud risk for this order:\n${JSON.stringify(o)}`),
  ];
  const modelWithTools = model.bindTools(allTools);

  let valueScore = 0, customerScore = 0;
  const factors: string[] = [];

  while (true) {
    const res = await modelWithTools.invoke(messages);
    if (!res.tool_calls?.length) break;
    messages.push(res);
    for (const call of res.tool_calls) {
      const tool = toolsByName[call.name as keyof typeof toolsByName];
      // The two tools have different arg schemas; dispatch by name and cast.
      const result = await (tool as { invoke: (a: unknown) => Promise<string> }).invoke(call.args);
      messages.push(new ToolMessage({ content: result as string, tool_call_id: call.id! }));
      const parsed = JSON.parse(result as string);
      if (call.name === "score_order_value_risk") valueScore = parsed.score;
      if (call.name === "score_customer_risk") customerScore = parsed.score;
      factors.push(...parsed.factors);
    }
  }

  // Same rule as C#: trust the tool math, clamp whatever the model returns.
  const final = Math.min(valueScore + customerScore, 100);
  return {
    riskScore: final,
    riskFactors: factors,
    log: [`🧬 Beast: fraud score ${final}/100${factors.length ? ` — ${factors.join(", ")}` : " — no risk factors"}`],
  };
}

// ── Human gate — LangGraph's built-in primitive for the C# AwaitingApproval
//    pattern. interrupt() PAUSES the graph here and persists state to the
//    checkpointer; on resume it returns the reviewer's decision. ──────────────
export async function humanGate(state: State) {
  const decision = interrupt({
    orderId: state.order.orderId,
    riskScore: state.riskScore,
    riskFactors: state.riskFactors,
    question: "Approve or reject this order?",
  }) as "approve" | "reject";
  return {
    decision,
    log: [`🧠 Cerebro: human review — ${decision.toUpperCase()} by reviewer`],
  };
}

// ── Wolverine — inventory reserve (deterministic mock, same X-003 rule). ─────
export async function wolverine(state: State) {
  const oos = state.order.items.some(i => i.sku === "X-003");
  if (oos)
    return { status: "Failed", log: ["⚡ Wolverine: SKU X-003 out of stock — cannot reserve"] };
  const first = state.order.items[0];
  return { log: [`⚡ Wolverine: reserved ${first.quantity} × ${first.sku} — Warehouse East`] };
}

// ── Gambit — authorize + capture. Same pm_* mock protocol as the C# mock. ────
export async function gambit(state: State) {
  const pm = state.order.paymentMethodId;
  const total = state.order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  if (pm.startsWith("pm_fail"))
    return { status: "Failed", log: ["🃏 Gambit: card declined — authorization failed"] };
  if (pm.startsWith("pm_capture_fail"))
    return {
      status: "Failed",
      log: [`🃏 Gambit: authorized $${total.toFixed(2)} — capture failed, must void`],
    };
  return { log: [`🃏 Gambit: authorized + captured $${total.toFixed(2)} on ${pm}`] };
}

// ── Storm + Jean Grey — deterministic tail of the pipeline. ──────────────────
export async function storm(state: State) {
  const label = `LB-${Math.floor(10000 + Math.random() * 89999)}`;
  return { log: [`⛈️ Storm: USPS Ground $4.20, 3-day — label ${label}`] };
}

export async function jeanGrey(state: State) {
  return {
    status: "Completed",
    log: [`🔮 Jean Grey: confirmation sent to ${state.order.customerEmail}`],
  };
}

// ── Compensation — saga rollback when a late step fails. Mirrors
//    ICompensatable: release inventory, void the authorization. ───────────────
export async function compensate(state: State) {
  return {
    status: "Failed",
    log: [
      "↩️ Compensation: released reserved inventory",
      "↩️ Compensation: voided payment authorization",
    ],
  };
}

// ── Auto-reject — fraud score ≥70 stops the pipeline (C# FraudRouter red). ───
export async function autoReject(state: State) {
  return {
    status: "Failed",
    log: [`🧠 Cerebro: order REJECTED — fraud risk too high (${state.riskScore}/100)`],
  };
}
