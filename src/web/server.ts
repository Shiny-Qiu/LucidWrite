#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { Hono } from "hono"
import type { Context } from "hono"
import { WebTaskRunner } from "./task-runner"
import type { ContentMode, ConversationTurn } from "./task-prompts"
import { loadDotEnv, readSettings, toPublicSettings, writeSettings, type WebSettings } from "./settings"
import { createSupabaseUser, getPublicConfig, isSupabaseConfigured } from "./supabase"

const app = new Hono()
const runner = new WebTaskRunner()
loadDotEnv(process.cwd())

const initialRootDirectory = resolve(process.env.EDITAI_WEB_ROOT ?? process.env.NEWTYPE_WEB_ROOT ?? process.cwd())
let workspaceDirectory = initialRootDirectory
const publicDirectory = resolve(import.meta.dir, "public")
const port = Number(process.env.PORT ?? process.env.EDITAI_WEB_PORT ?? process.env.NEWTYPE_WEB_PORT ?? 3899)
const NOTE_DIRECTORY_NAME = "editai_note"
const EDITAI_DIRECTORY_NAME = ".editai"

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
}

const ignoredDirectoryNames = new Set(["node_modules", "dist", ".git"])
const MAX_REFERENCE_FILES = 60
const MAX_REFERENCE_BYTES = 220_000

function isInsideRoot(path: string): boolean {
  const rel = relative(workspaceDirectory, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function getNotesDirectory(): string {
  const notesDirectory = join(workspaceDirectory, NOTE_DIRECTORY_NAME)
  mkdirSync(notesDirectory, { recursive: true })
  return notesDirectory
}

function getEditaiDirectory(): string {
  const directory = join(workspaceDirectory, EDITAI_DIRECTORY_NAME)
  mkdirSync(directory, { recursive: true })
  return directory
}

function getStyleFingerprintPath(): string {
  return join(getEditaiDirectory(), "style-fingerprint.md")
}

function getStyleStatusPath(): string {
  return join(getEditaiDirectory(), "style-status.json")
}

function isInsideNotes(path: string): boolean {
  const notesDirectory = getNotesDirectory()
  const rel = relative(notesDirectory, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function resolveWorkspacePath(inputPath = "."): string {
  const resolved = resolve(workspaceDirectory, inputPath)
  if (!isInsideRoot(resolved)) {
    throw new Error("Path is outside the workspace")
  }
  return resolved
}

function resolveNotesPath(inputPath = "."): string {
  const resolved = resolve(getNotesDirectory(), inputPath)
  if (!isInsideNotes(resolved)) {
    throw new Error("Path is outside editai_note")
  }
  return resolved
}

function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "Project name is required"
  if (trimmed === "." || trimmed === "..") return "Project name cannot be . or .."
  if (/[/:\\]/.test(trimmed)) return "Project name cannot contain /, :, or \\"
  if (/[\x00-\x1f]/.test(trimmed)) return "Project name contains unsupported characters"
  return undefined
}

function normalizeDirectoryInput(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "")
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2))
  return trimmed
}

async function readJson<T>(c: { req: { json: () => Promise<T> } }): Promise<T> {
  return await c.req.json()
}

async function getAuthUser(c: Context) {
  if (!isSupabaseConfigured()) return null
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return null
  const token = authHeader.slice(7)
  try {
    const supabase = createSupabaseUser(token)
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return null
    return { user, supabase }
  } catch {
    return null
  }
}

async function collectMarkdownFiles(directory: string, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_REFERENCE_FILES) return files
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (files.length >= MAX_REFERENCE_FILES) break
    if (entry.name.startsWith(".")) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue
      await collectMarkdownFiles(fullPath, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath)
    }
  }
  return files
}

async function readReference(inputPath: string): Promise<{
  path: string
  name: string
  type: "markdown" | "directory"
  content: string
  fileCount?: number
}> {
  const resolved = resolveNotesPath(inputPath)
  const fileStat = await stat(resolved)

  if (fileStat.isFile()) {
    if (extname(resolved) !== ".md") throw new Error("Only Markdown files are supported")
    return {
      path: relative(getNotesDirectory(), resolved),
      name: resolved.split("/").pop() ?? "Markdown",
      type: "markdown",
      content: await readFile(resolved, "utf-8"),
    }
  }

  if (!fileStat.isDirectory()) throw new Error("Path is not a file or directory")

  const markdownFiles = await collectMarkdownFiles(resolved)
  let totalBytes = 0
  const sections: string[] = []
  for (const file of markdownFiles) {
    const content = await readFile(file, "utf-8")
    const nextBytes = new TextEncoder().encode(content).byteLength
    if (totalBytes + nextBytes > MAX_REFERENCE_BYTES) {
      sections.push(`\n[目录内容已截断，超过 ${Math.round(MAX_REFERENCE_BYTES / 1000)}KB 上下文限制。]`)
      break
    }
    totalBytes += nextBytes
    sections.push(`<File path="${relative(getNotesDirectory(), file)}">\n${content.trim()}\n</File>`)
  }

  return {
    path: relative(getNotesDirectory(), resolved) || ".",
    name: resolved.split("/").pop() || getNotesDirectory(),
    type: "directory",
    content: sections.join("\n\n"),
    fileCount: markdownFiles.length,
  }
}

async function collectReferenceEntries(directory: string, query: string, entries: Array<{
  name: string
  path: string
  type: "directory" | "markdown"
}> = []): Promise<typeof entries> {
  if (entries.length >= 120) return entries
  const children = await readdir(directory, { withFileTypes: true })
  for (const child of children) {
    if (entries.length >= 120) break
    if (child.name.startsWith(".")) continue
    const fullPath = join(directory, child.name)
    const relPath = relative(getNotesDirectory(), fullPath) || "."
    if (child.isDirectory()) {
      if (ignoredDirectoryNames.has(child.name)) continue
      if (!query || child.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
        entries.push({ name: child.name, path: relPath, type: "directory" })
      }
      await collectReferenceEntries(fullPath, query, entries)
      continue
    }
    if (child.isFile() && child.name.endsWith(".md")) {
      if (!query || child.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
        entries.push({ name: child.name, path: relPath, type: "markdown" })
      }
    }
  }
  return entries
}

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    settingsPath: join(initialRootDirectory, ".newtype", "web-settings.json"),
  })
})

app.get("/api/config", (c) => {
  try {
    return c.json(getPublicConfig())
  } catch {
    return c.json({ supabaseUrl: null, supabaseAnonKey: null })
  }
})

// ── Auth endpoints (server-side, no client SDK needed) ─────────────────────

app.post("/api/auth/login", async (c) => {
  const body = await readJson<{ email?: string; password?: string }>(c)
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
  const body = await readJson<{ email?: string; password?: string }>(c)
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
  const body = await readJson<{ refresh_token?: string }>(c)
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
  return c.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, user: data.user })
})

app.get("/api/auth/me", async (c) => {
  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)
  return c.json({ id: auth.user.id, email: auth.user.email })
})

app.get("/api/settings", (c) => {
  const settings = readSettings(initialRootDirectory)
  return c.json(toPublicSettings(initialRootDirectory, settings))
})

app.put("/api/settings", async (c) => {
  const body = await readJson<Partial<WebSettings>>(c)
  const existing = readSettings(initialRootDirectory)
  const merged: WebSettings = {
    providers: {
      ...existing.providers,
      ...Object.fromEntries(
        Object.entries(body.providers ?? {}).filter(([, value]) => typeof value === "string" && value.length > 0)
      ),
    },
    defaultModel: body.defaultModel ?? existing.defaultModel,
    agentModels: {
      ...existing.agentModels,
      ...(body.agentModels ?? {}),
    },
  }
  writeSettings(initialRootDirectory, merged)
  return c.json(toPublicSettings(initialRootDirectory, merged))
})

app.get("/api/workspace", (c) => {
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    initialRootDirectory,
  })
})

app.put("/api/workspace", async (c) => {
  const body = await readJson<{ path?: string }>(c)
  if (!body.path?.trim()) {
    return c.json({ error: "path is required" }, 400)
  }

  const nextPath = resolve(normalizeDirectoryInput(body.path))
  if (!existsSync(nextPath)) {
    return c.json({ error: "Directory does not exist" }, 400)
  }

  const nextStat = await stat(nextPath)
  if (!nextStat.isDirectory()) {
    return c.json({ error: "Path is not a directory" }, 400)
  }

  workspaceDirectory = nextPath
  return c.json({ rootDirectory: workspaceDirectory, notesDirectory: getNotesDirectory() })
})

app.get("/api/style-fingerprint", async (c) => {
  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const { data } = await auth.supabase
    .from("style_fingerprints")
    .select("content, skipped")
    .eq("user_id", auth.user.id)
    .single()

  return c.json({
    configured: Boolean(data?.content?.trim() && !data?.skipped),
    skipped: data?.skipped ?? false,
    content: data?.content ?? "",
    path: "supabase:style_fingerprints",
  })
})

app.put("/api/style-fingerprint", async (c) => {
  const body = await readJson<{ content?: string; skipped?: boolean }>(c)

  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  if (body.skipped) {
    await auth.supabase
      .from("style_fingerprints")
      .upsert({ user_id: auth.user.id, content: "", skipped: true, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    return c.json({ configured: false, skipped: true })
  }

  if (!body.content?.trim()) return c.json({ error: "content is required" }, 400)

  await auth.supabase
    .from("style_fingerprints")
    .upsert({ user_id: auth.user.id, content: body.content.trim(), skipped: false, updated_at: new Date().toISOString() }, { onConflict: "user_id" })

  return c.json({ configured: true, skipped: false, path: "supabase:style_fingerprints" })
})

app.get("/api/projects", async (c) => {
  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const { data: projects, error } = await auth.supabase
    .from("projects")
    .select("id, name, created_at")
    .order("name", { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    projects: (projects ?? []).map((p) => ({
      name: p.name,
      path: p.name,
      draftPath: `${p.name}/draft.md`,
      hasDraft: true,
    })),
  })
})

app.post("/api/projects", async (c) => {
  const body = await readJson<{ name?: string; initialContent?: string }>(c)
  const name = body.name?.trim() ?? ""
  const validationError = validateProjectName(name)
  if (validationError) return c.json({ error: validationError }, 400)

  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const { data: project, error } = await auth.supabase
    .from("projects")
    .insert({ name, user_id: auth.user.id })
    .select("id, name")
    .single()

  if (error) {
    if (error.code === "23505") return c.json({ error: "Project already exists" }, 409)
    return c.json({ error: error.message }, 500)
  }

  const initialContent = body.initialContent?.trim()
  const draftContent = initialContent ? `${initialContent}\n` : `# ${name}\n\n`

  await auth.supabase.from("drafts").insert({
    project_id: project.id,
    user_id: auth.user.id,
    content: draftContent,
  })

  // Create local directory for task runner working files
  mkdirSync(resolveNotesPath(name), { recursive: true })

  return c.json({
    project: {
      name,
      path: name,
      draftPath: `${name}/draft.md`,
    },
  }, 201)
})

app.get("/api/directories", async (c) => {
  const requested = c.req.query("path")
  const dirPath = requested
    ? resolve(normalizeDirectoryInput(requested))
    : workspaceDirectory

  if (!existsSync(dirPath)) {
    return c.json({ error: "Directory does not exist" }, 400)
  }

  const dirStat = await stat(dirPath)
  if (!dirStat.isDirectory()) {
    return c.json({ error: "Path is not a directory" }, 400)
  }

  const entries = await readdir(dirPath, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: join(dirPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return c.json({
    current: dirPath,
    parent: dirname(dirPath),
    home: homedir(),
    workspace: workspaceDirectory,
    directories,
  })
})

app.get("/api/tasks", (c) => c.json({ tasks: runner.list() }))

app.get("/api/tasks/:id", (c) => {
  const task = runner.get(c.req.param("id"))
  if (!task) return c.json({ error: "Task not found" }, 404)
  return c.json({ task })
})

app.post("/api/tasks", async (c) => {
  const body = await readJson<{
    mode?: ContentMode
    message?: string
    context?: string
    style?: string
    filePath?: string
    conversation?: ConversationTurn[]
    projectPath?: string
  }>(c)

  if (!body.message?.trim()) {
    return c.json({ error: "Message is required" }, 400)
  }

  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const mode = body.mode ?? "chat"
  // Task runner always uses local FS; create the directory if it doesn't exist yet
  const taskDirectory = body.projectPath ? resolveNotesPath(body.projectPath) : getNotesDirectory()
  mkdirSync(taskDirectory, { recursive: true })
  const taskStat = await stat(taskDirectory)
  if (!taskStat.isDirectory()) return c.json({ error: "Project path is not a directory" }, 400)
  const task = runner.create({
    mode,
    message: body.message,
    context: body.context,
    style: body.style,
    filePath: body.filePath,
    conversation: Array.isArray(body.conversation) ? body.conversation : [],
    directory: taskDirectory,
  })
  return c.json({ task }, 201)
})

app.post("/api/tasks/:id/approve", async (c) => {
  const body = await readJson<{ outline?: string }>(c)
  if (!body.outline?.trim()) {
    return c.json({ error: "Outline is required" }, 400)
  }
  const task = await runner.approve(c.req.param("id"), body.outline)
  if (!task) return c.json({ error: "Task not found or not awaiting approval" }, 404)
  return c.json({ task })
})

app.get("/api/files", async (c) => {
  const dirParam = c.req.query("dir") ?? "."
  const dir = resolveNotesPath(dirParam)
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !(entry.isDirectory() && ignoredDirectoryNames.has(entry.name)))
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".md"))
    .map((entry) => {
      const fullPath = join(dir, entry.name)
      return {
        name: entry.name,
        path: relative(getNotesDirectory(), fullPath) || ".",
        type: entry.isDirectory() ? "directory" : "markdown",
      }
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    current: relative(getNotesDirectory(), dir) || ".",
    files,
  })
})

app.get("/api/file", async (c) => {
  const filePath = c.req.query("path")
  if (!filePath) return c.json({ error: "path query is required" }, 400)

  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const parts = filePath.split("/")
  if (parts.length < 2) return c.json({ error: "Invalid path format: use projectName/draft.md" }, 400)
  const projectName = parts[0]
  const fileName = parts[parts.length - 1]

  const { data: project } = await auth.supabase
    .from("projects")
    .select("id")
    .eq("name", projectName)
    .single()

  if (!project) return c.json({ error: "Project not found" }, 404)

  if (fileName === "draft.md") {
    const { data: draft } = await auth.supabase
      .from("drafts")
      .select("content")
      .eq("project_id", project.id)
      .single()
    return c.json({ path: filePath, content: draft?.content ?? `# ${projectName}\n\n` })
  }

  if (fileName === "final.md") {
    const { data: final } = await auth.supabase
      .from("finals")
      .select("content")
      .eq("project_id", project.id)
      .single()
    if (!final) return c.json({ error: "Final not found" }, 404)
    return c.json({ path: filePath, content: final.content })
  }

  return c.json({ error: "Only draft.md and final.md are supported" }, 400)
})

app.get("/api/references", async (c) => {
  const query = (c.req.query("q") ?? "").trim().toLowerCase()
  const entries = await collectReferenceEntries(getNotesDirectory(), query)
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    references: entries
      .sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path))
      .slice(0, 80),
  })
})

app.get("/api/reference", async (c) => {
  const referencePath = c.req.query("path")
  if (!referencePath) return c.json({ error: "path query is required" }, 400)
  try {
    return c.json(await readReference(referencePath))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post("/api/files", async (c) => {
  const body = await readJson<{ path?: string; content?: string }>(c)
  if (!body.path?.trim()) return c.json({ error: "path is required" }, 400)
  if (body.content === undefined) return c.json({ error: "content is required" }, 400)

  const auth = await getAuthUser(c)
  if (!auth) return c.json({ error: "Unauthorized" }, 401)

  const parts = body.path.split("/")
  if (parts.length < 2) return c.json({ error: "Invalid path: use projectName/draft.md" }, 400)
  const projectName = parts[0]
  const rawFileName = parts[parts.length - 1]
  const fileName = rawFileName.endsWith(".md") ? rawFileName : `${rawFileName}.md`

  if (fileName !== "draft.md" && fileName !== "final.md") {
    return c.json({ error: "Only draft.md and final.md can be saved" }, 400)
  }

  const { data: project } = await auth.supabase
    .from("projects")
    .select("id")
    .eq("name", projectName)
    .single()

  if (!project) return c.json({ error: "Project not found" }, 404)

  const table = fileName === "draft.md" ? "drafts" : "finals"
  const { error } = await auth.supabase
    .from(table)
    .upsert(
      { project_id: project.id, user_id: auth.user.id, content: body.content, updated_at: new Date().toISOString() },
      { onConflict: "project_id" },
    )

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ path: body.path })
})

app.get("*", async (c) => {
  const requestPath = new URL(c.req.url).pathname
  const normalized = requestPath === "/" ? "/index.html" : requestPath
  const filePath = resolve(publicDirectory, `.${normalized}`)
  const rel = relative(publicDirectory, filePath)

  if (rel.startsWith("..") || !existsSync(filePath)) {
    const indexPath = join(publicDirectory, "index.html")
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }

  return new Response(Bun.file(filePath), {
    headers: { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" },
  })
})

console.log(`editAI running at http://localhost:${port}`)
console.log(`Workspace: ${workspaceDirectory}`)

Bun.serve({
  port,
  fetch: app.fetch,
})
