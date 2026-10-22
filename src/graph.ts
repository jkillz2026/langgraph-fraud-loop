import { StateGraph, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { GraphState, type State } from "./state.js";
import * as A from "./agents.js";

/**
 * Graph wiring = what Cerebro's `switch`/routing logic did by hand in C#.
 * LangGraph owns: node execution order, conditional edges (your FraudRouter),
 * checkpointed interrupts (your AwaitingApproval), and state merging.
 */

const builder = new StateGraph(GraphState)
  .addNode("cerebro", A.cerebro)
  .addNode("cyclops", A.cyclops)
  .addNode("beast", A.beast)
  .addNode("humanGate", A.humanGate)
  .addNode("wolverine", A.wolverine)
  .addNode("gambit", A.gambit)
  .addNode("storm", A.storm)
  .addNode("jeanGrey", A.jeanGrey)
  .addNode("compensate", A.compensate)
  .addNode("autoReject", A.autoReject)

  .addEdge(START, "cerebro")
  .addEdge("cerebro", "cyclops")

  // Validation failure ends the run early.
  .addConditionalEdges("cyclops", (s: State) =>
    s.status === "Failed" ? "end" : "beast", { beast: "beast", end: END })

  // FraudRouter: 0-29 continue, 30-69 human review, 70+ auto-reject.
  .addConditionalEdges("beast", (s: State) => {
    if (s.riskScore >= 70) return "reject";
    if (s.riskScore >= 30) return "review";
    return "fulfill";
  }, { reject: "autoReject", review: "humanGate", fulfill: "wolverine" })

  // Human decision resumes the run — interrupt() returns on resume.
  .addConditionalEdges("humanGate", (s: State) =>
    s.decision === "approve" ? "fulfill" : "reject",
    { fulfill: "wolverine", reject: "autoReject" })

  // Out-of-stock ends the run BEFORE payment — nothing reserved yet, so
  // there's nothing to compensate. (Gambit failures DO route to compensate:
  // inventory was already reserved by then.)
  .addConditionalEdges("wolverine", (s: State) =>
    s.status === "Failed" ? "end" : "gambit", { gambit: "gambit", end: END })

  // Saga: any fulfillment failure routes to compensation before ending.
  .addConditionalEdges("gambit", (s: State) =>
    s.status === "Failed" ? "compensate" : "ship",
    { compensate: "compensate", ship: "storm" })

  .addEdge("storm", "jeanGrey")
  .addEdge("jeanGrey", END)
  .addEdge("compensate", END)
  .addEdge("autoReject", END);

// SqliteSaver = the checkpointer. REQUIRED for interrupt(): it's what lets the
// graph pause mid-node, persist state, and resume days later on the same
// thread_id — the framework version of your pending-orders map in C#.
// File-backed (not memory) so a parked order survives process restarts —
// production LangGraph uses the Postgres checkpointer; same API.
export const graph = builder.compile({
  checkpointer: SqliteSaver.fromConnString("checkpoints.sqlite"),
});
