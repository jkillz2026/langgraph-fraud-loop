import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * The two fraud-scoring tools Beast calls — same scoring rules as the C#
 * `RunScoreOrderValue` / `RunScoreCustomer` so behavior ports 1:1.
 *
 * LangChain `tool()` = C# `ChatTool.CreateFunctionTool` — name, description,
 * and a schema the model must call against. Zod schema here plays the role
 * the JSON-schema BinaryData played in .NET.
 */
export const scoreOrderValue = tool(
  async ({ orderTotal, itemCount }) => {
    const factors: string[] = [];
    let score = 0;
    if (orderTotal > 1000) { score += 30; factors.push(`High order total ($${orderTotal.toFixed(0)})`); }
    else if (orderTotal > 500) { score += 15; factors.push(`Elevated order total ($${orderTotal.toFixed(0)})`); }
    if (itemCount > 20) { score += 20; factors.push(`Very high item count (${itemCount})`); }
    else if (itemCount > 10) { score += 10; factors.push(`High item count (${itemCount})`); }
    return JSON.stringify({ score: Math.min(score, 50), factors });
  },
  {
    name: "score_order_value_risk",
    description: "Scores financial risk based on the order total and number of items. Returns a risk score 0-50.",
    schema: z.object({
      orderTotal: z.number().describe("Total order value in USD"),
      itemCount: z.number().describe("Total number of line items"),
    }),
  }
);

export const scoreCustomer = tool(
  async ({ customerEmail, shippingCountry }) => {
    const factors: string[] = [];
    let score = 0;
    const domain = customerEmail.includes("@") ? customerEmail.split("@")[1].toLowerCase() : "";
    const freeProviders = ["mailinator.com", "guerrillamail.com", "tempmail.com", "throwam.com"];
    if (freeProviders.includes(domain)) {
      score += 30;
      factors.push(`Disposable email domain (${domain})`);
    }
    const highRiskCountries = ["NG", "RU", "VE", "KP"];
    if (highRiskCountries.includes(shippingCountry.toUpperCase())) {
      score += 20;
      factors.push(`High-risk shipping country (${shippingCountry})`);
    }
    return JSON.stringify({ score: Math.min(score, 50), factors });
  },
  {
    name: "score_customer_risk",
    description: "Scores customer risk based on email domain and shipping country. Returns a risk score 0-50.",
    schema: z.object({
      customerEmail: z.string().describe("Customer email address"),
      shippingCountry: z.string().describe("ISO 2-letter country code"),
    }),
  }
);

// Map tool name -> implementation for Beast's tool-calling loop.
export const toolsByName = {
  score_order_value_risk: scoreOrderValue,
  score_customer_risk: scoreCustomer,
};
export const allTools = Object.values(toolsByName);
