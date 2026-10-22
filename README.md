# LangGraph Fraud-Review Loop (TypeScript)

A LangGraph/TypeScript port of the orchestration slice from
[X-Men Fulfillment](../xmen-fulfillment) — same pipeline, two runtimes:

| Concept | Custom C# runtime (X-Men) | LangGraph (this project) |
|---|---|---|
| Orchestrator | `Cerebro` planning loop | `cerebro` node + graph edges |
| Shared state | `FulfillmentContext.SharedData` | `Annotation.Root` channels |
| Accumulating log | `context.Log.Add(...)` | `log` channel w/ concat reducer |
| Tool calling | `ChatTool.CreateFunctionTool` + manual `FinishReason.ToolCalls` loop | `tool()` + `bindTools` + manual loop (kept visible on purpose) |
| Fraud routing | `FraudRouter` static class | `addConditionalEdges` on the `beast` node |
| Human approval | `AwaitingApproval` + `POST /orders/{id}/approve` + in-memory map | `interrupt()` + `Command({resume})` + `SqliteSaver` checkpointer |
| Saga compensation | `ICompensatable` implementations | `compensate` node routed on failure |

## Run it

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY

npm run order -- happy      # all agents pass → Completed
npm run order -- declined   # Gambit fails → saga compensation
npm run order -- capture    # auth ok, capture fails → compensation
npm run order -- reject     # fraud ≥70 → auto-reject
npm run order -- stock      # X-003 out of stock → early fail
npm run order -- review     # fraud 30–69 → pauses at the human gate

npm run review -- <orderId> approve   # resumes the PARKED run — separate
npm run review -- <orderId> reject    # process, reads SQLite checkpoint
```

## What's deliberately framework-visible

- **`interrupt()` + checkpointer** is the real lesson: in the C# version,
  human-in-the-loop meant a status flag, a pending-order map, and a second
  endpoint. Here it's one primitive — the graph pauses inside the node,
  persists to SQLite, and `Command({resume: "approve"})` answers it from
  any process, any time later. (Production equivalent: Postgres checkpointer.)
- The tool-calling loop is written out longhand rather than hidden inside
  `createReactAgent` — same reason the .NET loop stays visible: the loop IS
  the concept.
