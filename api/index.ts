/** Vercel Web Fetch API entry point. Keep cloud routes independent of Bun/filesystem APIs. */
import { callWritingModel, publicProviders, writingModelName, type ModelSettings, providerNames } from "../src/web/cloud-model"

export const config = { runtime: "edge" }

class HttpError extends Error {
  constructor(message: string, readonly status = 500, readonly code?: string) { super(message) }
}

type Auth = { user: { id: string; email?: string }; token: string }
type Project = { id: string; name: string; state?: Record<string, unknown> }
const json = (data: unknown, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
})
const now = () => new Date().toISOString()
const eq = (value: string) => "eq." + value
const query = (table: string, params: Record<string, string>) => table + "?" + new URLSearchParams(params)
const workspace = { mode: "cloud", rootDirectory: ".", notesDirectory: "云端项目", initialRootDirectory: "." }

// Edge functions must begin responding within 25 seconds. JSON whitespace keeps
// the connection alive while the model runs without changing the response format.
function streamingTask(produce: () => Promise<unknown>) {
  const encoder = new TextEncoder()
  let cancelled = false
  let heartbeat: ReturnType<typeof setInterval>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("\n"))
      heartbeat = setInterval(() => { if (!cancelled) controller.enqueue(encoder.encode("\n")) }, 10_000)
      void produce().catch(error => ({
        error: error instanceof HttpError ? error.message : "任务结果保存失败，请刷新查看任务状态后重试",
      })).then(result => {
        if (!cancelled) { controller.enqueue(encoder.encode(JSON.stringify(result))); controller.close() }
      }).finally(() => clearInterval(heartbeat))
    },
    cancel() { cancelled = true; clearInterval(heartbeat) },
  })
  return new Response(stream, { status: 201, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff",
  } })
}

function configuration() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "")
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new HttpError("服务端未配置 Supabase", 503)
  return { url, key }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data: any = null
    if (text) {
      try { data = JSON.parse(text) }
      catch { throw new HttpError("上游服务返回了无效响应，请稍后重试", 502) }
    }
    return { response, data }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(controller.signal.aborted ? "服务响应超时，请重试" : "无法连接服务，请稍后重试", 502)
  } finally { clearTimeout(timer) }
}

async function sbRest(method: string, path: string, token: string, body?: unknown, prefer?: string) {
  const { url, key } = configuration()
  const headers: Record<string, string> = {
    apikey: key, Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json",
  }
  if (prefer) headers.Prefer = prefer
  const { response, data } = await fetchJson(url + "/rest/v1/" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const missingSchema = ["42P01", "42703", "PGRST204", "PGRST205", "PGRST202"].includes(data?.code)
    const message = missingSchema
      ? "数据库需要更新，请执行 supabase/migrations/202609070001_web_functionality.sql"
      : data?.code === "23505" ? "记录已存在，请刷新后重试" : "数据读取或保存失败，请重试"
    throw new HttpError(message, missingSchema ? 503 : response.status === 409 ? 409 : 502, data?.code)
  }
  return data
}

async function getAuth(req: Request): Promise<Auth> {
  const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw new HttpError("登录已过期，请重新登录", 401)
  const { url, key } = configuration()
  const { response, data } = await fetchJson(url + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + token } })
  if (response.status === 401 || response.status === 403 || (response.ok && !data?.id)) throw new HttpError("登录已过期，请重新登录", 401)
  if (!response.ok) throw new HttpError("登录服务暂时不可用，请稍后重试", 502)
  return { user: data, token }
}

async function bodyOf(req: Request): Promise<Record<string, any>> {
  let value: unknown
  try {
    const text = await req.text()
    if (new TextEncoder().encode(text).length > 2_000_000) throw new HttpError("请求内容过大", 413)
    value = JSON.parse(text)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError("请求必须是有效的 JSON", 400)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError("请求格式无效", 400)
  return value as Record<string, any>
}

function textField(value: unknown, label: string, max = 200_000, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new HttpError(label + "不能为空", 400)
  if (value.length > max) throw new HttpError(label + "过长", 400)
  return value
}

function projectName(value: unknown) {
  const name = textField(value, "项目名", 120).trim()
  if (name === "." || name === ".." || /[/\\:\x00-\x1f\x7f]/.test(name)) throw new HttpError("项目名不能包含 /、\\、: 或控制字符", 400)
  return name
}

function parseFile(value: unknown) {
  const path = textField(value, "文件路径", 200)
  const parts = path.split("/")
  if (parts.length !== 2 || !["draft.md", "final.md"].includes(parts[1]!)) throw new HttpError("文件路径必须为 项目名/draft.md 或 项目名/final.md", 400)
  return { name: projectName(parts[0]), file: parts[1]!, path }
}

async function projects(auth: Auth): Promise<Project[]> {
  return await sbRest("GET", query("projects", { user_id: eq(auth.user.id), select: "id,name,created_at", order: "name.asc" }), auth.token)
}

async function projectFor(auth: Auth, name: string): Promise<Project> {
  const rows = await sbRest("GET", query("projects", { user_id: eq(auth.user.id), name: eq(name), select: "id,name", limit: "1" }), auth.token)
  if (!rows?.[0]) throw new HttpError("项目不存在或无权访问", 404)
  return rows[0]
}

async function fileRows(auth: Auth, project: Project) {
  const results = await Promise.all(["drafts", "finals"].map(table =>
    sbRest("GET", query(table, { user_id: eq(auth.user.id), project_id: eq(project.id), select: "content,updated_at", limit: "1" }), auth.token)))
  return results.flatMap((rows, index) => rows?.[0] ? [{
    name: index === 0 ? "draft.md" : "final.md",
    path: project.name + (index === 0 ? "/draft.md" : "/final.md"),
    type: "markdown", content: rows[0].content, updatedAt: rows[0].updated_at,
  }] : [])
}

async function readFile(auth: Auth, path: string) {
  const parsed = parseFile(path)
  const project = await projectFor(auth, parsed.name)
  const rows = await sbRest("GET", query(parsed.file === "draft.md" ? "drafts" : "finals", {
    user_id: eq(auth.user.id), project_id: eq(project.id), select: "content,updated_at", limit: "1",
  }), auth.token)
  if (!rows?.[0]) throw new HttpError("文件不存在", 404)
  return { path, name: parsed.file, type: "markdown", content: rows[0].content, updatedAt: rows[0].updated_at }
}

async function settingsFor(auth: Auth): Promise<ModelSettings> {
  const rows = await sbRest("GET", query("user_settings", { user_id: eq(auth.user.id), select: "providers,default_model", limit: "1" }), auth.token)
  return { providers: rows?.[0]?.providers ?? {}, defaultModel: rows?.[0]?.default_model || "" }
}

function publicSettings(settings: ModelSettings) {
  return { providers: publicProviders(settings), defaultModel: writingModelName(settings), settingsPath: "云端个人设置" }
}

async function authRoute(req: Request, kind: string) {
  const body = await bodyOf(req)
  const { url, key } = configuration()
  let endpoint: string
  let payload: object
  if (kind === "refresh") {
    endpoint = "/token?grant_type=refresh_token"
    payload = { refresh_token: textField(body.refresh_token, "刷新凭据", 10000) }
  } else {
    const email = textField(body.email, "邮箱", 320).trim()
    const password = textField(body.password, "密码", 1024)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError("邮箱格式无效", 400)
    if (kind === "register" && password.length < 6) throw new HttpError("密码至少需要 6 位", 400)
    endpoint = kind === "register" ? "/signup?redirect_to=" + encodeURIComponent(new URL("/app", req.url).href) : "/token?grant_type=password"
    payload = { email, password }
  }
  const { response, data } = await fetchJson(url + "/auth/v1" + endpoint, {
    method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify(payload),
  })
  if (!response.ok) throw new HttpError(
    kind === "refresh" && response.status < 500 ? "登录已过期，请重新登录" : data?.error_description || data?.msg || "认证失败，请重试",
    response.status >= 500 ? 502 : kind === "refresh" && response.status !== 429 ? 401 : response.status,
  )
  if (!data?.access_token) {
    if (kind !== "register") throw new HttpError("登录服务返回了无效凭据", 502)
    return json({ session: null, message: "注册成功！请查收确认邮件，点击链接后登录。" })
  }
  return json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, user: data.user })
}

function publicTask(row: any) {
  const expired = row.status === "running" && Date.now() - Date.parse(row.created_at) > 240_000
  return {
    id: row.id, projectPath: row.project_name, mode: row.mode, label: row.mode,
    status: expired ? "failed" : row.status, output: row.output || "",
    error: expired ? "任务超时，请重试；原稿已保留。" : row.error,
    request: row.request, events: [], createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, "")
  const method = req.method
  if (method === "GET" && path === "/api/config") return json({
    mode: "cloud", supabaseUrl: process.env.SUPABASE_URL || null, supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  })
  if (method === "GET" && path === "/api/health") return json({ ok: true, mode: "cloud", authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) })
  if (method === "POST" && ["/api/auth/login", "/api/auth/register", "/api/auth/refresh"].includes(path)) return authRoute(req, path.split("/").pop()!)
  const auth = await getAuth(req)
  const { user, token } = auth
  if (method === "GET" && path === "/api/auth/me") return json({ id: user.id, email: user.email })
  if (method === "GET" && path === "/api/workspace") return json(workspace)

  if (method === "GET" && path === "/api/style-fingerprint") {
    const rows = await sbRest("GET", query("style_fingerprints", { user_id: eq(user.id), select: "content,skipped", limit: "1" }), token)
    const row = rows?.[0]
    return json({ configured: Boolean(row?.content?.trim() && !row?.skipped), skipped: row?.skipped ?? false, content: row?.content ?? "" })
  }
  if (method === "PUT" && path === "/api/style-fingerprint") {
    const body = await bodyOf(req)
    const skipped = body.skipped === true
    const content = skipped ? "" : textField(body.content, "风格样本").trim()
    await sbRest("POST", "style_fingerprints?on_conflict=user_id", token,
      { user_id: user.id, content, skipped, updated_at: now() }, "resolution=merge-duplicates,return=minimal")
    return json({ configured: !skipped, skipped })
  }

  if (method === "GET" && path === "/api/projects") return json({ ...workspace, projects: (await projects(auth)).map(p => ({
    id: p.id, name: p.name, path: p.name, draftPath: p.name + "/draft.md",
  })) })
  if (method === "POST" && path === "/api/projects") {
    const body = await bodyOf(req)
    const name = projectName(body.name)
    const content = body.initialContent === undefined ? "# " + name + "\n\n" : textField(body.initialContent, "初始正文", 500_000, true)
    const rows = await sbRest("POST", "projects?select=id,name", token, { user_id: user.id, name }, "return=representation")
    const project = rows?.[0]
    if (!project?.id) throw new HttpError("项目创建失败", 502)
    try {
      await sbRest("POST", "drafts", token, { user_id: user.id, project_id: project.id, content })
    } catch (error) {
      // Roll back only the project created by this request if its initial draft failed.
      await sbRest("DELETE", query("projects", { id: eq(project.id), user_id: eq(user.id) }), token)
      throw error
    }
    return json({ project: { id: project.id, name, path: name, draftPath: name + "/draft.md" } }, 201)
  }
  if (method === "DELETE" && path === "/api/projects") {
    const body = await bodyOf(req)
    const name = projectName(body.name)
    const id = textField(body.id, "项目 ID", 80)
    const project = await projectFor(auth, name)
    // A stale tab must not delete a replacement project with the same name.
    if (project.id !== id) throw new HttpError("项目已发生变化，请刷新列表后重试", 409)
    const tasks = await sbRest("GET", query("writing_tasks", {
      user_id: eq(user.id), project_id: eq(id), status: eq("running"), select: "status,created_at",
    }), token)
    if (tasks.some((task: any) => publicTask(task).status === "running")) throw new HttpError("该项目仍在生成文章，请等待任务结束后再删除", 409)
    // PostgreSQL cascades the draft, final and task records in the same transaction.
    const deleted = await sbRest("DELETE", query("projects", { id: eq(id), user_id: eq(user.id), select: "id" }), token, undefined, "return=representation")
    if (!deleted?.some((row: any) => row.id === id)) throw new HttpError("项目已不存在，请刷新列表", 404)
    return json({ deleted: true, id, name })
  }

  if (method === "GET" && path === "/api/file") return json(await readFile(auth, url.searchParams.get("path") || ""))
  if (method === "POST" && path === "/api/files") {
    const body = await bodyOf(req)
    const parsed = parseFile(body.path)
    const content = textField(body.content, "正文", 500_000, true)
    const project = await projectFor(auth, parsed.name)
    const updatedAt = now()
    const table = parsed.file === "draft.md" ? "drafts" : "finals"
    if (body.expectedUpdatedAt !== undefined) {
      const expected = textField(body.expectedUpdatedAt, "正文版本", 80)
      const rows = await sbRest("PATCH", query(table, {
        user_id: eq(user.id), project_id: eq(project.id), updated_at: eq(expected), select: "updated_at",
      }), token, { content, updated_at: updatedAt }, "return=representation")
      if (!rows?.length) throw new HttpError("云端正文已在其他页面更新，未覆盖新版本。本机编辑已保留，请重新打开项目比较恢复副本。", 409)
    } else {
      await sbRest("POST", table + "?on_conflict=project_id", token,
        { user_id: user.id, project_id: project.id, content, updated_at: updatedAt }, "resolution=merge-duplicates,return=minimal")
    }
    return json({ path: parsed.path, updatedAt })
  }
  if (path === "/api/project-state" && (method === "GET" || method === "PUT")) {
    const body = method === "PUT" ? await bodyOf(req) : null
    const name = projectName(body?.projectPath ?? url.searchParams.get("projectPath"))
    const project = await projectFor(auth, name)
    const filter = query("projects", { id: eq(project.id), user_id: eq(user.id), select: "state" })
    if (body) {
      if (!body.state || typeof body.state !== "object" || Array.isArray(body.state) || JSON.stringify(body.state).length > 500_000) throw new HttpError("项目进度格式无效或过大", 400)
      await sbRest("PATCH", filter, token, { state: body.state, updated_at: now() })
      return json({ saved: true })
    }
    const rows = await sbRest("GET", filter, token)
    return json({ state: rows?.[0]?.state ?? {} })
  }

  if (method === "GET" && path === "/api/files") {
    const dir = url.searchParams.get("dir") || "."
    const files = dir === "." ? (await projects(auth)).map(p => ({ name: p.name, path: p.name, type: "directory", projectId: p.id }))
      : (await fileRows(auth, await projectFor(auth, projectName(dir)))).map(({ content, ...file }) => file)
    return json({ ...workspace, current: dir, files })
  }
  if (method === "GET" && path === "/api/references") {
    const q = (url.searchParams.get("q") || "").toLocaleLowerCase()
    const [allProjects, drafts, finals] = await Promise.all([
      projects(auth),
      sbRest("GET", query("drafts", { user_id: eq(user.id), select: "project_id,updated_at" }), token),
      sbRest("GET", query("finals", { user_id: eq(user.id), select: "project_id,updated_at" }), token),
    ])
    const draftIds = new Set(drafts.map((row: any) => row.project_id))
    const finalIds = new Set(finals.map((row: any) => row.project_id))
    const references = allProjects.flatMap(p => [
      { name: p.name, path: p.name, type: "directory" },
      ...(draftIds.has(p.id) ? [{ name: "draft.md", path: p.name + "/draft.md", type: "markdown" }] : []),
      ...(finalIds.has(p.id) ? [{ name: "final.md", path: p.name + "/final.md", type: "markdown" }] : []),
    ])
    return json({ references: references.filter(r => r.path.toLocaleLowerCase().includes(q)).slice(0, 30) })
  }
  if (method === "GET" && path === "/api/reference") {
    const ref = textField(url.searchParams.get("path"), "引用路径", 200)
    if (ref.includes("/")) return json(await readFile(auth, ref))
    const p = await projectFor(auth, projectName(ref))
    const files = await fileRows(auth, p)
    const content = files.map(f => "# " + f.path + "\n\n" + f.content).join("\n\n")
    if (content.length > 220_000) throw new HttpError("目录内容过大，请单独引用文件", 413)
    return json({ name: p.name, path: p.name, type: "directory", content, fileCount: files.length })
  }
  if (method === "GET" && path === "/api/directories") return json({
    current: ".", parent: ".", home: ".", workspace: ".", directories: (await projects(auth)).map(p => ({ name: p.name, path: p.name })),
  })
  if (method === "PUT" && path === "/api/workspace") throw new HttpError("云端使用个人项目空间，请通过项目列表切换项目", 400)

  if (method === "GET" && path === "/api/settings") return json(publicSettings(await settingsFor(auth)))
  if (method === "PUT" && path === "/api/settings") {
    const body = await bodyOf(req)
    const existing = await settingsFor(auth)
    if (body.providers !== undefined && (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers))) throw new HttpError("API 配置格式无效", 400)
    for (const [name, value] of Object.entries(body.providers ?? {})) {
      if (!providerNames.includes(name as any)) throw new HttpError("未知的服务商", 400)
      const key = textField(value, "API Key", 4096, true).trim()
      // Blank fields preserve stored keys. Explicit null is not accepted.
      if (key) existing.providers[name] = key
    }
    if (body.defaultModel !== undefined) existing.defaultModel = textField(body.defaultModel, "模型", 200, true).trim()
    await sbRest("POST", "user_settings?on_conflict=user_id", token,
      { user_id: user.id, providers: existing.providers, default_model: existing.defaultModel || "", updated_at: now() },
      "resolution=merge-duplicates,return=minimal")
    return json(publicSettings(existing))
  }

  if (method === "GET" && path === "/api/tasks") {
    const params: Record<string, string> = { user_id: eq(user.id), select: "*", order: "created_at.desc", limit: "20" }
    if (url.searchParams.get("projectPath")) params.project_id = eq((await projectFor(auth, projectName(url.searchParams.get("projectPath")))).id)
    const rows = await sbRest("GET", query("writing_tasks", params), token)
    return json({ tasks: rows.map(publicTask) })
  }
  if (method === "GET" && path.startsWith("/api/tasks/")) {
    const id = path.slice("/api/tasks/".length)
    const rows = await sbRest("GET", query("writing_tasks", { user_id: eq(user.id), id: eq(id), select: "*", limit: "1" }), token)
    if (!rows?.[0]) throw new HttpError("任务不存在", 404)
    return json({ task: publicTask(rows[0]) })
  }
  if (method === "POST" && path === "/api/tasks") {
    const body = await bodyOf(req)
    const message = textField(body.message, "消息")
    const project = await projectFor(auth, projectName(body.projectPath))
    const mode = body.mode === undefined ? "chat" : textField(body.mode, "任务类型", 50)
    const modes = ["chat", "pipeline", "write", "edit", "analyze", "fact-check", "super-interviewer", "super-workflow", "research", "extract", "archive"]
    if (!modes.includes(mode)) throw new HttpError("任务类型无效", 400)
    const conversation = body.conversation ?? []
    if (!Array.isArray(conversation) || conversation.some(t => !t || !["user", "assistant"].includes(t.role) || typeof t.content !== "string")) throw new HttpError("对话历史格式无效", 400)
    const settings = await settingsFor(auth)
    const id = body.id === undefined ? crypto.randomUUID() : textField(body.id, "任务 ID", 64)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError("任务 ID 无效", 400)
    const existing = await sbRest("GET", query("writing_tasks", { user_id: eq(user.id), id: eq(id), select: "*", limit: "1" }), token)
    if (existing[0]) {
      if (existing[0].project_id !== project.id) throw new HttpError("任务不属于当前项目", 409)
      return json({ task: publicTask(existing[0]) })
    }
    const request = body.request && typeof body.request === "object" && !Array.isArray(body.request) ? body.request : {}
    if (JSON.stringify(request).length > 500_000) throw new HttpError("任务上下文过大", 400)
    const task: any = { id, user_id: user.id, project_id: project.id, project_name: project.name, mode, status: "running", output: "", error: null, request, created_at: now(), updated_at: now() }
    await sbRest("POST", "writing_tasks", token, task)
    return streamingTask(async () => {
      try {
        task.output = await callWritingModel({ message, conversation: conversation.slice(-12), mode, searchQuery: typeof body.searchQuery === "string" ? body.searchQuery.slice(0, 300) : "" }, settings)
        task.status = "completed"
      } catch (error) {
        task.status = "failed"
        task.error = error instanceof Error ? error.message : "AI 任务失败，请重试"
      }
      task.updated_at = now()
      await sbRest("PATCH", query("writing_tasks", { id: eq(id), user_id: eq(user.id) }), token,
        { status: task.status, output: task.output, error: task.error, updated_at: task.updated_at })
      return { task: publicTask(task) }
    })
  }
  throw new HttpError("接口不存在或不支持此操作", 404)
}

export default async function handler(req: Request): Promise<Response> {
  try { return await route(req) }
  catch (error) {
    return json({ error: error instanceof HttpError ? error.message : "服务处理失败，请稍后重试" }, error instanceof HttpError ? error.status : 500)
  }
}
