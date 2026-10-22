import "dotenv/config";
import { Command } from "@langchain/langgraph";
import { graph } from "./graph.js";
import type { Order } from "./state.js";

/**
 * CLI driver:
 *   npm run order -- <scenario>        → submit an order, watch nodes run
 *   npm run review -- <orderId> <approve|reject>  → resolve a paused order
 *
 * Scenarios mirror the dashboard presets: happy | stock | declined |
 * capture | review | reject
 */

const BASE: Order = {
  orderId: "",
  customerEmail: "jean.grey@xmen.com",
  country: "US",
  items: [{ sku: "X-001", quantity: 1, unitPrice: 49.99 }],
  paymentMethodId: "pm_ok_test",
};

const SCENARIOS: Record<string, Partial<Order> & { items?: Order["items"] }> = {
  happy:    {},
  stock:    { items: [{ sku: "X-003", quantity: 1, unitPrice: 49.99 }] },
  declined: { paymentMethodId: "pm_fail_test" },
  capture:  { paymentMethodId: "pm_capture_fail_test" },
  review:   { customerEmail: "test@mailinator.com" },
  reject:   { customerEmail: "test@mailinator.com", country: "NG",
              items: [{ sku: "X-001", quantity: 1, unitPrice: 1500 }] },
};

async function printStream(threadId: string, input: object | Command) {
  const config = { configurable: { thread_id: threadId } };
  let lastLogLen = 0;
  for await (const chunk of await graph.stream(input as never, { ...config, streamMode: "values" })) {
    const log = (chunk as { log?: string[] }).log ?? [];
    for (const line of log.slice(lastLogLen)) console.log("  " + line);
    lastLogLen = log.length;
  }
  const state = await graph.getState(config);
  // An interrupted graph parks on the interrupt() inside humanGate.
  const pending = state.tasks.flatMap(t => t.interrupts ?? []);
  if (pending.length) {
    console.log(`\n⏸  Pipeline PAUSED — fraud score ${pending[0].value.riskScore}/100.`);
    console.log(`   Review it:  npm run review -- ${threadId} <approve|reject>\n`);
  } else {
    console.log(`\n■ Pipeline ${(state.values as { status: string }).status}\n`);
  }
}

const [, , cmd, arg1, arg2] = process.argv;

if (cmd === "submit") {
  const scenario = arg1 ?? "happy";
  const patch = SCENARIOS[scenario];
  if (!patch) {
    console.error(`Unknown scenario '${scenario}'. Options: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }
  const orderId = `ORD-${scenario.toUpperCase()}-${Date.now()}`;
  const order: Order = { ...BASE, ...patch, orderId };
  console.log(`\n▶ Submitting ${orderId} (${scenario})\n`);
  await printStream(orderId, { order });
} else if (cmd === "review") {
  const [threadId, decision] = [arg1, arg2];
  if (!threadId || !["approve", "reject"].includes(decision ?? "")) {
    console.error("Usage: npm run review -- <orderId> <approve|reject>");
    process.exit(1);
  }
  console.log(`\n▶ Resuming ${threadId} with decision: ${decision}\n`);
  // Command({resume}) is the framework way of answering an interrupt() —
  // equivalent to POST /orders/{id}/approve hitting the pending order.
  await printStream(threadId, new Command({ resume: decision }));
} else {
  console.log("Usage:\n  npm run order -- <happy|stock|declined|capture|review|reject>\n  npm run review -- <orderId> <approve|reject>");
}
