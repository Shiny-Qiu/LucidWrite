/**
 * Vercel serverless entry point — standalone, no Bun-specific imports.
 * All routes are reimplemented here to avoid the server.ts → task-runner → @opencode-ai/sdk chain.
 */
import { Hono } from "hono"
import { handle } from "hono/vercel"
import { createClient } from "@supabase/supabase-js"
import { randomUUID } from "node:crypto"
import { runDeepSeekTask } from "../src/web/deepseek"
import { getModeLabel, type ContentMode, type ConversationTurn } from "../src/web/task-prompts"

export const config = { runtime: "nodejs" }

const app = new Hono()

// ── Helpers ───────────────────────────────────────────────────────────────────

function supabaseUserClient(token: string) {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )
}

async function getAuth(c: { req: { header: (n: string) => string | undefined } }) {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice(7)
  try {
    const supabase = supabaseUserClient(token)
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return null
    return { user, supabase }
  } catch { return null }
}

// ── Config & Health ───────────────────────────────────────────────────────────

app.get("/api/config", (c) => c.json({
  supabaseUrl: process.env.SUPABASE_URL ?? null,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
}))

app.get("/api/health", (c) => c.json({ ok: true }))

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>()
  if (!body.email || !body.password) return c.json({ error: "邮箱和密码不能为空" }, 400)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return c.json({ error: "服务端未配置 Supabase" }, 503)
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ email: body.email, password: body.password }),
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) return c.json({ error: (data.error_description || data.msg || "登录失败") as string }, res.status as 400)
  return c.json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    user: data.user,
  })
})

app.post("/api/auth/register", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>()
  if (!body.email || !body.password) return c.json({ error: "邮箱和密码不能为空" }, 400)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return c.json({ error: "服务端未配置 Supabase" }, 503)
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ email: body.email, password: body.password }),
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) return c.json({ error: (data.error_description || data.msg || "注册失败") as string }, res.status as 400)
  if (data.access_token) {
    return c.json({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user })
  }
  return c.json({ session: null, message: "注册成功！请查收确认邮件，点击链接后登录。" })
})

app.post("/api/auth/refresh", async (c) => {
  const body = await c.req.json<{ refresh_token?: string }>()
  if (!body.refresh_token) return c.json({ error: "缺少 refresh_token" }, 400)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return c.json({ error: "服务端未配置 Supabase" }, 503)
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) return c.json({ error: "session 已过期，请重新登录" }, 401)
  return c.json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    user: data.user,
  })
})

app.get("/api/auth/me", async (c) => {
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  return c.json({ id: auth.user.id, email: auth.user.email })
})

// ── Style Fingerprint ─────────────────────────────────────────────────────────

app.get("/api/style-fingerprint", async (c) => {
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  const { data } = await auth.supabase
    .from("style_fingerprints").select("content, skipped").eq("user_id", auth.user.id).single()
  return c.json({
    configured: Boolean(data?.content?.trim() && !data?.skipped),
    skipped: data?.skipped ?? false,
    content: data?.content ?? "",
    path: "supabase:style_fingerprints",
  })
})

app.put("/api/style-fingerprint", async (c) => {
  const body = await c.req.json<{ content?: string; skipped?: boolean }>()
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  if (body.skipped) {
    await auth.supabase.from("style_fingerprints").upsert(
      { user_id: auth.user.id, content: "", skipped: true, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    )
    return c.json({ configured: false, skipped: true })
  }
  if (!body.content?.trim()) return c.json({ error: "content is required" }, 400)
  await auth.supabase.from("style_fingerprints").upsert(
    { user_id: auth.user.id, content: body.content.trim(), skipped: false, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  )
  return c.json({ configured: true, skipped: false })
})

// ── Projects ──────────────────────────────────────────────────────────────────

app.get("/api/projects", async (c) => {
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  const { data: projects, error } = await auth.supabase
    .from("projects").select("id, name, created_at").order("name", { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({
    projects: (projects ?? []).map((p) => ({
      name: p.name, path: p.name, draftPath: `${p.name}/draft.md`, hasDraft: true,
    })),
  })
})

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string; initialContent?: string }>()
  const name = body.name?.trim() ?? ""
  if (!name) return c.json({ error: "Project name is required" }, 400)
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  const { data: project, error } = await auth.supabase
    .from("projects").insert({ name, user_id: auth.user.id }).select("id, name").single()
  if (error) {
    if (error.code === "23505") return c.json({ error: "Project already exists" }, 409)
    return c.json({ error: error.message }, 500)
  }
  const draftContent = body.initialContent?.trim() ? `${body.initialContent.trim()}\n` : `# ${name}\n\n`
  await auth.supabase.from("drafts").insert({ project_id: project.id, user_id: auth.user.id, content: draftContent })
  return c.json({ project: { name, path: name, draftPath: `${name}/draft.md` } }, 201)
})

// ── File read/write (Supabase) ────────────────────────────────────────────────

app.get("/api/file", async (c) => {
  const filePath = c.req.query("path")
  if (!filePath) return c.json({ error: "path query is required" }, 400)
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  const parts = filePath.split("/")
  if (parts.length < 2) return c.json({ error: "Invalid path format" }, 400)
  const projectName = parts[0]
  const fileName = parts[parts.length - 1]
  const { data: project } = await auth.supabase.from("projects").select("id").eq("name", projectName).single()
  if (!project) return c.json({ error: "Project not found" }, 404)
  if (fileName === "draft.md") {
    const { data: draft } = await auth.supabase.from("drafts").select("content").eq("project_id", project.id).single()
    return c.json({ path: filePath, content: draft?.content ?? `# ${projectName}\n\n` })
  }
  if (fileName === "final.md") {
    const { data: final } = await auth.supabase.from("finals").select("content").eq("project_id", project.id).single()
    if (!final) return c.json({ error: "Final not found" }, 404)
    return c.json({ path: filePath, content: final.content })
  }
  return c.json({ error: "Only draft.md and final.md are supported" }, 400)
})

app.post("/api/files", async (c) => {
  const body = await c.req.json<{ path?: string; content?: string }>()
  if (!body.path?.trim()) return c.json({ error: "path is required" }, 400)
  if (body.content === undefined) return c.json({ error: "content is required" }, 400)
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  const parts = body.path.split("/")
  if (parts.length < 2) return c.json({ error: "Invalid path" }, 400)
  const projectName = parts[0]
  const rawFileName = parts[parts.length - 1]
  const fileName = rawFileName.endsWith(".md") ? rawFileName : `${rawFileName}.md`
  if (fileName !== "draft.md" && fileName !== "final.md") {
    return c.json({ error: "Only draft.md and final.md can be saved" }, 400)
  }
  const { data: project } = await auth.supabase.from("projects").select("id").eq("name", projectName).single()
  if (!project) return c.json({ error: "Project not found" }, 404)
  const table = fileName === "draft.md" ? "drafts" : "finals"
  const { error } = await auth.supabase.from(table).upsert(
    { project_id: project.id, user_id: auth.user.id, content: body.content, updated_at: new Date().toISOString() },
    { onConflict: "project_id" },
  )
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ path: body.path })
})

// ── Tasks (synchronous DeepSeek on Vercel) ────────────────────────────────────

app.get("/api/tasks", (c) => c.json({ tasks: [] }))
app.get("/api/tasks/:id", (c) => c.json({ error: "Task not found" }, 404))

app.post("/api/tasks", async (c) => {
  const body = await c.req.json<{
    mode?: string
    message?: string
    context?: string
    conversation?: ConversationTurn[]
  }>()
  if (!body.message?.trim()) return c.json({ error: "Message is required" }, 400)
  const auth = await getAuth(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  const mode = (body.mode ?? "chat") as ContentMode
  const now = new Date().toISOString()
  const taskId = randomUUID()
  try {
    const result = await runDeepSeekTask({
      mode,
      message: body.message,
      context: body.context,
      conversation: Array.isArray(body.conversation) ? body.conversation : [],
    })
    return c.json({
      task: {
        id: taskId, mode, label: getModeLabel(mode), message: body.message,
        status: "completed", directory: "/tmp", output: result.content,
        events: [], createdAt: now, updatedAt: now,
      },
    }, 201)
  } catch (error) {
    return c.json({
      task: {
        id: taskId, mode, label: getModeLabel(mode), message: body.message,
        status: "failed", directory: "/tmp", output: "",
        error: error instanceof Error ? error.message : String(error),
        events: [], createdAt: now, updatedAt: now,
      },
    }, 201)
  }
})

// ── Settings (no local file on Vercel) ───────────────────────────────────────

app.get("/api/settings", (c) => c.json({
  providers: {
    deepseek: { configured: Boolean(process.env.EDITAI_LLM_API_KEY || process.env.DEEPSEEK_API_KEY) },
    openai: { configured: false }, anthropic: { configured: false },
    google: { configured: false }, tavily: { configured: false }, firecrawl: { configured: false },
  },
  settingsPath: "",
}))
app.put("/api/settings", (c) => c.json({ providers: {} }))

// ── Workspace / File tree (no local FS on Vercel) ─────────────────────────────

app.get("/api/workspace", (c) => c.json({ rootDirectory: "/tmp", notesDirectory: "/tmp/editai_note", initialRootDirectory: "/tmp" }))
app.put("/api/workspace", (c) => c.json({ rootDirectory: "/tmp", notesDirectory: "/tmp/editai_note" }))
app.get("/api/files", (c) => c.json({ files: [], current: ".", rootDirectory: "/tmp", notesDirectory: "/tmp" }))
app.get("/api/references", (c) => c.json({ references: [] }))
app.get("/api/reference", (c) => c.json({ error: "Not available" }, 404))
app.get("/api/directories", (c) => c.json({ current: "/tmp", parent: "/", home: "/tmp", workspace: "/tmp", directories: [] }))

export default handle(app)
