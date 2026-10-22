import { Annotation } from "@langchain/langgraph";

/**
 * Graph state = the LangGraph analog of FulfillmentContext + SharedData in the
 * C# version. Each node returns a PARTIAL update; the graph merges it.
 *
 * Key LangGraph concept: `Annotation.Root` declares the channels. Plain
 * `Annotation<T>` is "last write wins"; a channel with `reducer` merges
 * instead of replaces — that's why `log` accumulates across nodes like
 * context.Log did in C#.
 */
export interface Order {
  orderId: string;
  customerEmail: string;
  country: string;
  items: { sku: string; quantity: number; unitPrice: number }[];
  paymentMethodId: string;
}

export const GraphState = Annotation.Root({
  order: Annotation<Order>,
  plan: Annotation<string | null>,
  riskScore: Annotation<number>,
  riskFactors: Annotation<string[]>,
  decision: Annotation<"approve" | "reject" | null>,
  // reducer channel — every node appends, nothing overwrites
  log: Annotation<string[]>({
    reducer: (a: string[], b: string[]) => a.concat(b),
    default: () => [],
  }),
  status: Annotation<string>,
});

export type State = typeof GraphState.State;
