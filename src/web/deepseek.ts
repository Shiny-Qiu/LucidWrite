import type { BuildPromptInput, ConversationTurn } from "./task-prompts"
import { buildPipelineApprovalPrompt, buildTaskPrompt } from "./task-prompts"

export interface DeepSeekResult {
  content: string
  model: string
}

interface DeepSeekMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
  message?: string
}

function getBaseUrl(): string {
  return (process.env.EDITAI_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")
}

export function hasDeepSeekConfig(): boolean {
  return Boolean(process.env.EDITAI_LLM_API_KEY || process.env.DEEPSEEK_API_KEY)
}

export function getDeepSeekModel(): string {
  return process.env.EDITAI_LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat"
}

export async function runDeepSeekTask(input: BuildPromptInput): Promise<DeepSeekResult> {
  const prompt = buildTaskPrompt({ ...input, conversation: [] })
  return callDeepSeek([
    {
      role: "system",
      content:
        `You are editAI, an AI writing workspace assistant. You help users write and refine articles in Chinese.

MANDATORY OUTPUT FORMAT — follow this exactly every time:

## 对话回复
(Your explanation, analysis, or suggestions. Never put article content here.)

## 文章草稿
(The COMPLETE modified article. Only include this section if you actually modified the article. Must be the full article, never partial.)

STRICT RULES:
1. Always use these exact section headers. Never write content outside a section.
2. If you modify the article in any way, you MUST output ## 文章草稿 with the COMPLETE article.
3. Never put article content inside ## 对话回复.
4. Never output only the changed paragraph — always output the COMPLETE article in ## 文章草稿.
5. If you are only answering a question or giving analysis without changing the article, omit ## 文章草稿 entirely.`,
    },
    ...toDeepSeekHistory(input.conversation),
    { role: "user", content: prompt },
  ])
}

export async function continueDeepSeekPipeline(outline: string): Promise<DeepSeekResult> {
  return callDeepSeek([
    {
      role: "system",
      content:
        "You are editAI running the approved content pipeline. Produce the final Markdown deliverable with source notes and fact-check notes.",
    },
    { role: "user", content: buildPipelineApprovalPrompt(outline) },
  ])
}

async function callDeepSeek(messages: DeepSeekMessage[]): Promise<DeepSeekResult> {
  const apiKey = process.env.EDITAI_LLM_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error("EDITAI_LLM_API_KEY or DEEPSEEK_API_KEY is not configured")
  }

  const model = getDeepSeekModel()
  const maxAttempts = Number(process.env.EDITAI_LLM_MAX_RETRIES || process.env.DEEPSEEK_MAX_RETRIES || 3)
  const timeoutMs = Number(process.env.EDITAI_LLM_TIMEOUT_MS || process.env.DEEPSEEK_TIMEOUT_MS || 60_000)
  let lastError = ""

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const abortController = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let response: Response
    try {
      const request = fetch(`${getBaseUrl()}/v1/chat/completions`, {
        method: "POST",
        signal: abortController.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.5,
        }),
      })
      response = await withTimeout(request, timeoutMs, () => abortController.abort())
    } catch (error) {
      if (timeout) clearTimeout(timeout)
      lastError = error instanceof Error && error.name === "AbortError"
        ? `LLM request timed out after ${timeoutMs}ms`
        : error instanceof Error ? error.message : String(error)
      if (attempt >= maxAttempts) break
      await sleep(Math.min(8000, 800 * 2 ** (attempt - 1)))
      continue
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    const data = await readDeepSeekResponse(response)
    if (response.ok) {
      const content = data.choices?.[0]?.message?.content?.trim()
      if (!content) {
        throw new Error("LLM returned an empty response")
      }

      return { content, model }
    }

    lastError = data.error?.message || data.message || `LLM request failed with HTTP ${response.status}`
    if (!isRetriableLLMError(response.status, lastError) || attempt >= maxAttempts) break
    await sleep(Math.min(8000, 800 * 2 ** (attempt - 1)))
  }

  throw new Error(formatLLMError(lastError))
}

async function readDeepSeekResponse(response: Response): Promise<DeepSeekResponse> {
  try {
    return await response.json() as DeepSeekResponse
  } catch {
    return { message: `LLM request failed with HTTP ${response.status}` }
  }
}

function isRetriableLLMError(status: number, message: string): boolean {
  return status === 429 || status >= 500 || /busy|overload|rate limit|temporarily|timeout|繁忙|过载|限流/i.test(message)
}

function formatLLMError(message: string): string {
  if (/timed out|timeout|超时/i.test(message)) {
    return "模型服务请求超时，供应商当前没有及时响应。你可以稍后重试，或在 .env 中临时切换 EDITAI_LLM_BASE_URL / EDITAI_LLM_MODEL / EDITAI_LLM_API_KEY 到其他 OpenAI-compatible 服务。"
  }
  if (/Service is too busy|busy|overload|temporarily|繁忙|过载/i.test(message)) {
    return "模型服务当前繁忙，已自动重试但仍未成功。你可以稍后重试，或在 .env 中临时切换 EDITAI_LLM_BASE_URL / EDITAI_LLM_MODEL / EDITAI_LLM_API_KEY 到其他 OpenAI-compatible 服务。"
  }
  return message
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout()
      const error = new Error(`LLM request timed out after ${timeoutMs}ms`)
      error.name = "AbortError"
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

function toDeepSeekHistory(conversation: ConversationTurn[] = []): DeepSeekMessage[] {
  return conversation
    .filter((turn) => turn.content.trim())
    .slice(-12)
    .map((turn) => ({
      role: turn.role,
      content: trimForContext(turn.content.trim(), 6000),
    }))
}

function trimForContext(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n\n[Content truncated for context length]`
}
