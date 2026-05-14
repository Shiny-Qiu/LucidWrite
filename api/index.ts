/**
 * Vercel Edge Function — pure Web Fetch API, no framework.
 * Routes all /api/* requests.
 */

export const config = { runtime: "edge" }

// ── Supabase helpers ──────────────────────────────────────────────────────────

function sbUser(token: string) {
  const url = process.env.SUPABASE_URL!
  const key = process.env.SUPABASE_ANON_KEY!
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  const from = (table: string) => ({
    select: (cols: string) => ({
      eq: (col: string, val: string) => ({
        single: () => sbGet(`${url}/rest/v1/${table}?select=${cols}&${col}=eq.${val}&limit=1`, headers)
          .then((r: any) => ({ data: r?.[0] ?? null })),
        then: (fn: any) => sbGet(`${url}/rest/v1/${table}?select=${cols}&${col}=eq.${val}`, headers)
          .then((r: any) => fn({ data: r ?? [], error: null })),
      }),
      order: (_col: string, _opts: any) => ({
        then: (fn: any) => sbGet(`${url}/rest/v1/${table}?select=${cols}&order=name.asc`, headers)
          .then((r: any) => fn({ data: r ?? [], error: null })),
      }),
    }),
    insert: (body: object) => ({
      select: (cols: string) => ({
        single: () => sbPost(`${url}/rest/v1/${table}?select=${cols}`, headers, body, "return=representation")
          .then((r: any) => ({ data: r?.[0] ?? null, error: r?.error ?? null })),
      }),
      then: (fn: any) => sbPost(`${url}/rest/v1/${table}`, headers, body)
        .then((r: any) => fn({ data: r, error: null })),
    }),
    upsert: (body: object, opts?: { onConflict: string }) => ({
      then: (fn: any) => {
        const header = { ...headers, "Prefer": `resolution=merge-duplicates,return=minimal` }
        return sbPost(`${url}/rest/v1/${table}`, header, body)
          .then((r: any) => fn({ data: r, error: null }))
      },
    }),
    auth: {
      getUser: async () => {
        const r = await fetch(`${url}/auth/v1/user`, { headers })
        const d = await r.json() as any
        if (!r.ok) return { data: { user: null }, error: d }
        return { data: { user: d }, error: null }
      },
    },
  })
  return { from, auth: { getUser: from("_").auth.getUser } }
}

async function sbGet(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers: { ...headers, Accept: "application/json" } })
  if (!r.ok) return null
  return r.json()
}

async function sbPost(url: string, headers: Record<string, string>, body: object, prefer?: string) {
  const h: Record<string, string> = { ...headers, Accept: "application/json" }
  if (prefer) h["Prefer"] = prefer
  const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) })
  if (!r.ok) {
    const e = await r.json() as any
    return { error: e }
  }
  const text = await r.text()
  return text ? JSON.parse(text) : null
}

async function getAuth(req: Request) {
  const header = req.headers.get("Authorization") ?? ""
  if (!header.startsWith("Bearer ")) return null
  const token = header.slice(7)
  try {
    const sb = sbUser(token)
    const { data: { user }, error } = await sb.auth.getUser()
    if (error || !user) return null
    return { user, token }
  } catch { return null }
}

// ── Direct Supabase REST calls ────────────────────────────────────────────────

async function sbRest(method: string, path: string, token: string, body?: object, prefer?: string) {
  const url = process.env.SUPABASE_URL! + "/rest/v1/" + path
  const headers: Record<string, string> = {
    apikey: process.env.SUPABASE_ANON_KEY!,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  }
  if (prefer) headers["Prefer"] = prefer
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : null }
}

// ── JSON response helpers ─────────────────────────────────────────────────────

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

// ── Auth via Supabase REST API ────────────────────────────────────────────────

async function authLogin(req: Request) {
  const body = await req.json() as any
  if (!body.email || !body.password) return json({ error: "邮箱和密码不能为空" }, 400)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return json({ error: "服务端未配置 Supabase" }, 503)
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ email: body.email, password: body.password }),
  })
  const d = await r.json() as any
  if (!r.ok) return json({ error: d.error_description || d.msg || "登录失败" }, r.status)
  return json({ access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, user: d.user })
}

async function authRegister(req: Request) {
  const body = await req.json() as any
  if (!body.email || !body.password) return json({ error: "邮箱和密码不能为空" }, 400)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return json({ error: "服务端未配置 Supabase" }, 503)
  const r = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ email: body.email, password: body.password }),
  })
  const d = await r.json() as any
  if (!r.ok) return json({ error: d.error_description || d.msg || "注册失败" }, r.status)
  if (d.access_token) return json({ access_token: d.access_token, refresh_token: d.refresh_token, user: d.user })
  return json({ session: null, message: "注册成功！请查收确认邮件，点击链接后登录。" })
}

async function authRefresh(req: Request) {
  const body = await req.json() as any
  if (!body.refresh_token) return json({ error: "缺少 refresh_token" }, 400)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return json({ error: "服务端未配置 Supabase" }, 503)
  const r = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  })
  const d = await r.json() as any
  if (!r.ok) return json({ error: "session 已过期，请重新登录" }, 401)
  return json({ access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, user: d.user })
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  // Config
  if (path === "/api/config") {
    return json({ supabaseUrl: process.env.SUPABASE_URL ?? null, supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null })
  }

  // Health
  if (path === "/api/health") return json({ ok: true })

  // Auth (no token required)
  if (method === "POST" && path === "/api/auth/login") return authLogin(req)
  if (method === "POST" && path === "/api/auth/register") return authRegister(req)
  if (method === "POST" && path === "/api/auth/refresh") return authRefresh(req)

  // All routes below require auth
  const auth = await getAuth(req)
  if (!auth) return json({ error: "Unauthorized" }, 401)
  const { user, token } = auth

  // Auth/me
  if (method === "GET" && path === "/api/auth/me") {
    return json({ id: user.id, email: user.email })
  }

  // Style fingerprint
  if (method === "GET" && path === "/api/style-fingerprint") {
    const r = await sbRest("GET", `style_fingerprints?user_id=eq.${user.id}&select=content,skipped&limit=1`, token)
    const d = r.data?.[0]
    return json({ configured: Boolean(d?.content?.trim() && !d?.skipped), skipped: d?.skipped ?? false, content: d?.content ?? "" })
  }
  if (method === "PUT" && path === "/api/style-fingerprint") {
    const body = await req.json() as any
    if (body.skipped) {
      await sbRest("POST", "style_fingerprints", token, { user_id: user.id, content: "", skipped: true, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal")
      return json({ configured: false, skipped: true })
    }
    if (!body.content?.trim()) return json({ error: "content is required" }, 400)
    await sbRest("POST", "style_fingerprints", token, { user_id: user.id, content: body.content.trim(), skipped: false, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal")
    return json({ configured: true, skipped: false })
  }

  // Projects
  if (method === "GET" && path === "/api/projects") {
    const r = await sbRest("GET", `projects?user_id=eq.${user.id}&select=id,name,created_at&order=name.asc`, token)
    const projects = (r.data ?? []).map((p: any) => ({ name: p.name, path: p.name, draftPath: `${p.name}/draft.md`, hasDraft: true }))
    return json({ projects })
  }
  if (method === "POST" && path === "/api/projects") {
    const body = await req.json() as any
    const name = body.name?.trim() ?? ""
    if (!name) return json({ error: "Project name is required" }, 400)
    const r = await sbRest("POST", "projects?select=id,name", token, { name, user_id: user.id }, "return=representation")
    if (!r.ok) {
      if (JSON.stringify(r.data).includes("23505")) return json({ error: "Project already exists" }, 409)
      return json({ error: r.data?.message ?? "创建失败" }, 500)
    }
    const project = Array.isArray(r.data) ? r.data[0] : r.data
    const draftContent = body.initialContent?.trim() ? `${body.initialContent.trim()}\n` : `# ${name}\n\n`
    await sbRest("POST", "drafts", token, { project_id: project.id, user_id: user.id, content: draftContent })
    return json({ project: { name, path: name, draftPath: `${name}/draft.md` } }, 201)
  }

  // File read
  if (method === "GET" && path === "/api/file") {
    const filePath = url.searchParams.get("path") ?? ""
    if (!filePath) return json({ error: "path required" }, 400)
    const parts = filePath.split("/")
    if (parts.length < 2) return json({ error: "Invalid path" }, 400)
    const [projectName, ...rest] = parts
    const fileName = rest[rest.length - 1]
    const pr = await sbRest("GET", `projects?user_id=eq.${user.id}&name=eq.${encodeURIComponent(projectName)}&select=id&limit=1`, token)
    const project = pr.data?.[0]
    if (!project) return json({ error: "Project not found" }, 404)
    if (fileName === "draft.md") {
      const dr = await sbRest("GET", `drafts?project_id=eq.${project.id}&select=content&limit=1`, token)
      return json({ path: filePath, content: dr.data?.[0]?.content ?? `# ${projectName}\n\n` })
    }
    if (fileName === "final.md") {
      const fr = await sbRest("GET", `finals?project_id=eq.${project.id}&select=content&limit=1`, token)
      if (!fr.data?.[0]) return json({ error: "Final not found" }, 404)
      return json({ path: filePath, content: fr.data[0].content })
    }
    return json({ error: "Only draft.md and final.md are supported" }, 400)
  }

  // File save
  if (method === "POST" && path === "/api/files") {
    const body = await req.json() as any
    if (!body.path?.trim() || body.content === undefined) return json({ error: "path and content required" }, 400)
    const parts = body.path.split("/")
    if (parts.length < 2) return json({ error: "Invalid path" }, 400)
    const [projectName, ...rest] = parts
    const rawName = rest[rest.length - 1]
    const fileName = rawName.endsWith(".md") ? rawName : `${rawName}.md`
    if (fileName !== "draft.md" && fileName !== "final.md") return json({ error: "Only draft.md and final.md" }, 400)
    const pr = await sbRest("GET", `projects?user_id=eq.${user.id}&name=eq.${encodeURIComponent(projectName)}&select=id&limit=1`, token)
    const project = pr.data?.[0]
    if (!project) return json({ error: "Project not found" }, 404)
    const table = fileName === "draft.md" ? "drafts" : "finals"
    await sbRest("POST", table, token, { project_id: project.id, user_id: user.id, content: body.content, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal")
    return json({ path: body.path })
  }

  // Tasks — synchronous DeepSeek
  if (method === "GET" && path === "/api/tasks") return json({ tasks: [] })
  if (method === "GET" && path.startsWith("/api/tasks/")) return json({ error: "Task not found" }, 404)
  if (method === "POST" && path === "/api/tasks") {
    const body = await req.json() as any
    if (!body.message?.trim()) return json({ error: "Message is required" }, 400)
    const apiKey = process.env.EDITAI_LLM_API_KEY || process.env.DEEPSEEK_API_KEY
    const baseUrl = (process.env.EDITAI_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")
    const model = process.env.EDITAI_LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat"
    const taskId = crypto.randomUUID()
    const now = new Date().toISOString()
    const mode = body.mode ?? "chat"
    try {
      const history = (body.conversation ?? []).slice(-12).map((t: any) => ({ role: t.role, content: t.content }))
      const r = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.5,
          messages: [
            { role: "system", content: "You are editAI, an AI writing workspace assistant. When you modify an article, always put the complete updated article in a section starting with ## 文章草稿. Put your explanation in ## 对话回复. Never mix article content with commentary." },
            ...history,
            { role: "user", content: body.message },
          ],
        }),
      })
      const d = await r.json() as any
      const output = d.choices?.[0]?.message?.content?.trim() ?? ""
      return json({ task: { id: taskId, mode, label: mode, message: body.message, status: "completed", directory: "/tmp", output, events: [], createdAt: now, updatedAt: now } }, 201)
    } catch (e: any) {
      return json({ task: { id: taskId, mode, label: mode, message: body.message, status: "failed", directory: "/tmp", output: "", error: e?.message ?? String(e), events: [], createdAt: now, updatedAt: now } }, 201)
    }
  }

  // Settings
  if (path === "/api/settings") {
    return json({ providers: { deepseek: { configured: Boolean(process.env.EDITAI_LLM_API_KEY || process.env.DEEPSEEK_API_KEY) }, openai: { configured: false }, anthropic: { configured: false }, google: { configured: false }, tavily: { configured: false }, firecrawl: { configured: false } }, settingsPath: "" })
  }

  // Workspace / file tree stubs
  if (path === "/api/workspace") return json({ rootDirectory: "/tmp", notesDirectory: "/tmp/editai_note", initialRootDirectory: "/tmp" })
  if (path === "/api/files") return json({ files: [], current: ".", rootDirectory: "/tmp", notesDirectory: "/tmp" })
  if (path === "/api/references") return json({ references: [] })

  return json({ error: "Not found" }, 404)
}
