import { afterEach, beforeEach, expect, test } from "bun:test"
import { callWritingModel, writingModelName } from "../../src/web/cloud-model"

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const input = { message: "写一篇文章", conversation: [], mode: "write" }
const requests: Array<{ url: string; headers: Headers; body: any }> = []
let result: any
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (/^(EDITAI_LLM_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GOOGLE_|TAVILY_|FIRECRAWL_)/.test(name)) delete process.env[name]
  requests.length = 0
  result = { choices: [{ message: { content: "## 对话回复\n完成" } }] }
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return Response.json(result)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv } })

test("DeepSeek defaults to V4 Pro and only returns the final answer from thinking responses", async () => {
  result.choices[0].message.reasoning_content = "internal reasoning"
  const output = await callWritingModel(input, { providers: { deepseek: "own-key" } })
  expect(requests[0]!.body.model).toBe("deepseek-v4-pro")
  expect(requests[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions")
  expect(output).not.toContain("internal reasoning")
})

test("retired DeepSeek names resolve to Pro while explicit Flash and other providers are preserved", () => {
  for (const model of ["deepseek-chat", "deepseek-reasoner", "deepseek/deepseek-chat"]) {
    expect(writingModelName({ providers: {}, defaultModel: model })).toBe(model.includes("/") ? "deepseek/deepseek-v4-pro" : "deepseek-v4-pro")
  }
  for (const model of ["deepseek-v4-flash", "openai/gpt-test", "anthropic/claude-test"]) {
    expect(writingModelName({ providers: {}, defaultModel: model })).toBe(model)
  }
})

test("upgrading the server's legacy model keeps the configured gateway credential usable", async () => {
  process.env.EDITAI_LLM_API_KEY = "server-key"
  process.env.EDITAI_LLM_MODEL = "deepseek-chat"
  process.env.EDITAI_LLM_BASE_URL = "https://api.deepseek.com"
  expect(writingModelName({ providers: {} })).toBe("deepseek-v4-pro")
  await callWritingModel(input, { providers: {}, defaultModel: "deepseek-v4-pro" })
  expect(requests[0]!.headers.get("Authorization")).toBe("Bearer server-key")
  expect(requests[0]!.body.model).toBe("deepseek-v4-pro")
})

test("Anthropic uses native Messages requests and excludes non-text response blocks", async () => {
  result = { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "## 对话回复\n完成" }] }
  expect(await callWritingModel(input, { providers: { anthropic: "own-key" }, defaultModel: "anthropic/claude-test" })).not.toContain("private")
  expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages")
  expect(requests[0]!.headers.get("x-api-key")).toBe("own-key")
})

test("Gemini maps assistant turns to model and excludes thought parts", async () => {
  result = { candidates: [{ content: { parts: [{ thought: true, text: "private" }, { text: "完成" }] } }] }
  expect(await callWritingModel({ ...input, conversation: [{ role: "assistant", content: "先前回复" }] }, { providers: { google: "own-key" }, defaultModel: "google/gemini-test" })).toBe("完成")
  expect(requests[0]!.url).toContain("gemini-test:generateContent")
  expect(requests[0]!.body.contents[0].role).toBe("model")
})

test("personal provider keys cannot be sent to a server-configured generic gateway", async () => {
  process.env.EDITAI_LLM_API_KEY = "server-key"
  process.env.EDITAI_LLM_MODEL = "anthropic/claude-test"
  process.env.EDITAI_LLM_BASE_URL = "https://gateway.example"
  result = { content: [{ type: "text", text: "完成" }], choices: [{ message: { content: "完成" } }] }
  await callWritingModel(input, { providers: { anthropic: "own-key" }, defaultModel: "anthropic/claude-test" })
  expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages")
})

test("fact-check reports disclose missing external evidence even when the model omits it", async () => {
  const output = await callWritingModel({ ...input, mode: "fact-check" }, { providers: { deepseek: "test" } })
  expect(output).toContain("未完成外部事实验证")
})

test("truncated model output is rejected before it can replace an article", async () => {
  result = { choices: [{ finish_reason: "length", message: { content: "incomplete article" } }] }
  await expect(callWritingModel(input, { providers: { openai: "test" }, defaultModel: "openai/gpt-test" })).rejects.toThrow("截断")
})
