import { describe, expect, it, vi } from "vitest";
import { chatCompletion, createLLMClient } from "../llm/provider.js";

const { fetchCalls } = vi.hoisted(() => ({
  fetchCalls: [] as Array<{ url: string; init: RequestInit; body: Record<string, unknown> }>,
}));

vi.mock("../utils/proxy-fetch.js", () => ({
  fetchWithProxy: vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({
      url,
      init,
      body: JSON.parse(String(init.body ?? "{}")),
    });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as Response;
  }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(async () => {
    throw new Error("MiniMax OpenAI-compatible requests must use InkOS native transport");
  }),
  streamSimple: vi.fn(async function* () {
    throw new Error("MiniMax OpenAI-compatible requests must use InkOS native transport");
  }),
}));

function minimaxClient(model: string) {
  return createLLMClient({
    provider: "openai",
    service: "minimax",
    model,
    apiKey: "sk-test",
    apiFormat: "chat",
    stream: false,
    temperature: 0.9,
    thinkingBudget: 0,
    extra: {},
  } as never);
}

describe("MiniMax thinking defaults", () => {
  it("disables MiniMax-M3 thinking by default on the OpenAI-compatible endpoint", async () => {
    fetchCalls.length = 0;
    const client = minimaxClient("MiniMax-M3");

    const result = await chatCompletion(client, "MiniMax-M3", [
      { role: "user", content: "hi" },
    ], { retry: false });

    expect(result.content).toBe("ok");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://api.minimaxi.com/v1/chat/completions");
    expect(fetchCalls[0]!.body).toMatchObject({
      model: "MiniMax-M3",
      thinking: { type: "disabled" },
    });
  });

  it("does not send unsupported thinking controls to MiniMax-M2.x models", async () => {
    fetchCalls.length = 0;
    const client = minimaxClient("MiniMax-M2.7");

    await chatCompletion(client, "MiniMax-M2.7", [
      { role: "user", content: "hi" },
    ], { retry: false });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.body).not.toHaveProperty("thinking");
  });
});
