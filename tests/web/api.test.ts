import { afterEach, beforeEach, expect, test } from "bun:test"
import handler from "../../api/index"

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
let requests: Array<{ url: URL; method: string; body: any }> = []
let failWrites = false
let llmStatus = 200
let modelGate: Promise<void> | undefined
let llmOutput = "## 对话回复\n完成\n## 文章草稿\n# 测试文章\n正文"
const db: Record<string, any[]> = {}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://database.example"
  process.env.SUPABASE_ANON_KEY = "test-anon"
  process.env.EDITAI_LLM_API_KEY = "test-model-key"
  process.env.EDITAI_LLM_BASE_URL = "https://model.example/v1"
  requests = []
  failWrites = false
  llmStatus = 200
  modelGate = undefined
  llmOutput = "## 对话回复\n完成\n## 文章草稿\n# 测试文章\n正文"
  for (const key of Object.keys(db)) delete db[key]
  db.projects = [{ id: "project-1", user_id: "user-1", name: "测试", state: {} }]
  db.drafts = [{ project_id: "project-1", user_id: "user-1", content: "# 原稿" }]
  db.finals = []
  db.style_fingerprints = []
  db.user_settings = []
  db.writing_tasks = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    const method = init.method || "GET"
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ url, method, body })
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", email: "test@example.com" })
    if (url.hostname === "model.example") {
      await modelGate
      return Response.json(llmStatus === 200
      ? { choices: [{ message: { content: llmOutput } }] }
      : { error: { message: "Provider unavailable" } }, { status: llmStatus })
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.split("/").pop()!
      const rows = db[table] ??= []
      const matching = rows.filter(row => [...url.searchParams].every(([key, val]) => !val.startsWith("eq.") || String(row[key]) === val.slice(3)))
      if (method === "GET") return Response.json(matching)
      if (failWrites) return Response.json({ code: "42501", message: "write denied" }, { status: 403 })
      if (method === "POST") {
        const key = table === "drafts" || table === "finals" ? "project_id" : table === "user_settings" || table === "style_fingerprints" ? "user_id" : "id"
        const existing = rows.find(row => row[key] === body[key])
        if (existing && url.searchParams.get("on_conflict") !== key && key !== "id" && table !== "style_fingerprints") {
          return Response.json({ code: "23505", message: "duplicate key" }, { status: 409 })
        }
        const row = { id: body.id || "new-id", ...body }
        if (existing) Object.assign(existing, row)
        else rows.push(row)
        return Response.json([existing || row])
      }
      if (method === "PATCH") { matching.forEach(row => Object.assign(row, body)); return Response.json(matching) }
      if (method === "DELETE") { db[table] = rows.filter(row => !matching.includes(row)); return new Response(null, { status: 204 }) }
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  }) as typeof fetch
})

afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv } })

const call = (path: string, method = "GET", body?: unknown) => handler(new Request(`https://app.example${path}`, {
  method, headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}))

test("saving an existing draft really updates persisted content", async () => {
  const saved = await call("/api/files", "POST", { path: "测试/draft.md", content: "# 新稿\n\n**保留格式**" })
  expect(saved.ok).toBe(true)
  const reread = await (await call("/api/file?path=" + encodeURIComponent("测试/draft.md"))).json()
  expect(reread.content).toBe("# 新稿\n\n**保留格式**")
})

test("database write failures must never be reported as saved", async () => {
  failWrites = true
  expect((await call("/api/files", "POST", { path: "测试/draft.md", content: "new" })).ok).toBe(false)
  expect((await call("/api/style-fingerprint", "PUT", { content: "style" })).ok).toBe(false)
})

test("cloud file tree and references expose persisted projects and drafts", async () => {
  const root = await (await call("/api/files")).json()
  expect(root.files.some((file: any) => file.path === "测试" && file.type === "directory")).toBe(true)
  const files = await (await call("/api/files?dir=" + encodeURIComponent("测试"))).json()
  expect(files.files.some((file: any) => file.path === "测试/draft.md")).toBe(true)
  const ref = await (await call("/api/reference?path=" + encodeURIComponent("测试/draft.md"))).json()
  expect(ref.content).toBe("# 原稿")
})

test("invalid names and nested file paths are rejected", async () => {
  expect((await call("/api/projects", "POST", { name: "bad/name" })).status).toBe(400)
  expect((await call("/api/files", "POST", { path: "测试/elsewhere/draft.md", content: "bad" })).status).toBe(400)
})

test("provider HTTP failures and empty output cannot complete a task", async () => {
  llmStatus = 429
  const response = await call("/api/tasks", "POST", { message: "测试写作", projectPath: "测试" })
  const data = await response.json()
  expect(response.ok && data.task?.status === "completed").toBe(false)
  llmStatus = 200
  llmOutput = ""
  const empty = await (await call("/api/tasks", "POST", { message: "测试写作", projectPath: "测试" })).json()
  expect(empty.task?.status).not.toBe("completed")
})

test("OpenAI compatible base URL does not duplicate /v1", async () => {
  await (await call("/api/tasks", "POST", { message: "测试写作", projectPath: "测试" })).json()
  expect(requests.find(r => r.url.hostname === "model.example")?.url.pathname).toBe("/v1/chat/completions")
})

test("slow model requests send a response before generation finishes and finish as valid JSON", async () => {
  let release = () => {}
  modelGate = new Promise<void>(resolve => { release = resolve })
  const pending = call("/api/tasks", "POST", { message: "测试写作", projectPath: "测试" })
  try {
    const response = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))])
    expect(response).not.toBeNull()
    const reader = response!.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toMatch(/^\s+$/)
    expect(db.writing_tasks[0].status).toBe("running")
    release()
    let text = new TextDecoder().decode(first.value)
    while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value) }
    expect(JSON.parse(text).task.status).toBe("completed")
    expect(db.writing_tasks[0].status).toBe("completed")
  } finally { release(); await pending.then(response => response.bodyUsed ? undefined : response.text()) }
})

test("settings persist while secret values stay out of the response", async () => {
  const response = await call("/api/settings", "PUT", { providers: { deepseek: "private-test-key" }, defaultModel: "deepseek-v4-pro" })
  expect(response.ok).toBe(true)
  expect(await response.text()).not.toContain("private-test-key")
  const saved = await (await call("/api/settings")).json()
  expect(saved.defaultModel).toBe("deepseek-v4-pro")
  expect(db.user_settings[0]?.providers.deepseek).toBe("private-test-key")
})

test("malformed JSON returns a JSON 400 rather than throwing", async () => {
  const response = await handler(new Request("https://app.example/api/projects", { method: "POST", headers: { Authorization: "Bearer test-token" }, body: "{" }))
  expect(response.status).toBe(400)
  expect((await response.json()).error).toBeTruthy()
})

test("saving a stale draft returns conflict instead of overwriting a newer revision", async () => {
  db.drafts[0].updated_at = "2026-09-07T10:00:00.000Z"
  const response = await call("/api/files", "POST", { path: "测试/draft.md", content: "stale overwrite", expectedUpdatedAt: "2026-09-07T09:00:00.000Z" })
  expect(response.status).toBe(409)
  expect(db.drafts[0].content).toBe("# 原稿")
})
