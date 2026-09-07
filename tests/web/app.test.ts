import { afterEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { readFileSync } from "node:fs"
const html = readFileSync(new URL("../../src/web/public/index.html", import.meta.url), "utf8")
const source = readFileSync(new URL("../../src/web/public/app.js", import.meta.url), "utf8")
const windows: any[] = []
async function setup(fetcher?: (url: string, init: any) => Promise<Response>) {
  const dom = new JSDOM(html, { url: "http://localhost/app", runScripts: "outside-only" })
  const w: any = dom.window
  windows.push(w)
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent || "" }, set(v) { this.textContent = v }, configurable: true })
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  w.HTMLDialogElement.prototype.close = function () { this.open = false }
  w.Headers = Headers
  w.Response = Response
  w.AbortController = AbortController
  w.fetch = fetcher || (async () => Response.json({ files: [], projects: [], configured: true, state: {}, tasks: [] }))
  w.eval(source + "\nwindow.testApp = {state, editorMarkdown, setDraftMarkdown, renderTask, runStepTask, saveDraft, advanceStage, apiFetch, openProject, logout, renderProcessSteps, selectMention, attachWorkspaceFile};")
  await Promise.resolve()
  const app = w.testApp
  app.state.session = { access_token: "old", refresh_token: "refresh", user: { id: "user-1" } }
  app.state.activeProject = "项目"
  app.state.draftPath = "项目/draft.md"
  return { w, app, editor: w.document.querySelector("#draftEditor") }
}
afterEach(() => { windows.splice(0).forEach(w => w.close()) })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test("opening and saving a Markdown article preserves its original syntax", async () => {
  const { app } = await setup()
  const markdown = "# 标题\n\n**重点** [来源](https://example.com)\n\n1. 第一项\n2. 第二项\n\n> 引文"
  app.setDraftMarkdown(markdown)
  expect(app.editorMarkdown()).toBe(markdown)
})
test("edited rich text preserves heading, emphasis, link and table semantics", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 标题\n\n原文")
  editor.innerHTML = '<h1>新标题</h1><p><strong>重点</strong> <a href="https://example.com">来源</a></p><table><tr><th>项目</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>'
  editor.dispatchEvent(new w.Event("input"))
  const saved = app.editorMarkdown()
  expect(saved).toContain("# 新标题")
  expect(saved).toContain("**重点**")
  expect(saved).toContain("[来源](https://example.com)")
  expect(saved).toContain("| 项目 | 值 |")
})
test("numbered lists retain their structure and starting number after editing and reopening", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 清单\n\n3. 第三步\n4. 第四步\n\n- 提醒")
  expect(editor.querySelector("ol")?.start).toBe(3)
  expect(editor.querySelectorAll("ol > li")).toHaveLength(2)
  editor.querySelector("ol > li:last-child").textContent += "，已修改"
  editor.dispatchEvent(new w.Event("input"))
  const saved = app.editorMarkdown()
  expect(saved).toContain("3. 第三步\n4. 第四步，已修改")
  app.setDraftMarkdown(saved)
  expect(editor.querySelector("ol")?.start).toBe(3)
  expect(editor.querySelector("ul > li")?.textContent).toBe("提醒")
})
test("pasting an article over a heading does not turn pasted paragraphs into headings", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 新项目")
  // Chromium keeps the original heading around the remaining pasted blocks.
  editor.innerHTML = '<h1>文章标题</h1><h1><p>第一段正文。</p><p><strong>重点</strong>仍是正文。</p></h1>'
  editor.dispatchEvent(new w.Event("input"))
  const saved = app.editorMarkdown()
  app.setDraftMarkdown(saved)
  expect(editor.querySelectorAll("h1")).toHaveLength(1)
  expect(editor.querySelector("p")?.textContent).toBe("第一段正文。")
  expect(editor.querySelector("p strong")?.textContent).toBe("重点")
})
test("deleting the whole draft really saves an empty draft", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 原文\n\n应当删除")
  editor.innerHTML = ""
  editor.dispatchEvent(new w.Event("input"))
  expect(app.editorMarkdown()).toBe("")
})
test("AI outline completion cannot overwrite edits made while it was running", async () => {
  const { app } = await setup()
  app.setDraftMarkdown("# 原文")
  app.state.pendingTasks.task = { project: "项目", step: "topic", reason: "stage", mayModifyDocument: true, editVersion: app.state.draftVersion, draft: "# 原文" }
  app.setDraftMarkdown("# 用户刚刚编辑的内容")
  await app.renderTask({ id: "task", status: "completed", output: "## 对话回复\n大纲完成\n## 文章草稿\n# AI 大纲" })
  expect(app.editorMarkdown()).toContain("用户刚刚编辑的内容")
  expect(app.state.currentStep).toBe("topic")
})
test("a stage without an article cannot advance to the next stage", async () => {
  const { app } = await setup()
  app.setDraftMarkdown("# 原文")
  app.state.pendingTasks.task = { project: "项目", step: "outline", reason: "stage", mayModifyDocument: true, editVersion: app.state.draftVersion }
  app.state.currentStep = "outline"
  await app.renderTask({ id: "task", status: "completed", output: "## 对话回复\n模型未生成正文，请重试。" })
  expect(app.state.currentStep).toBe("outline")
})
test("a late result from another project cannot modify the current project", async () => {
  const { app } = await setup()
  app.setDraftMarkdown("# 当前项目")
  app.state.pendingTasks.task = { project: "另一个项目", step: "topic", reason: "chat", mayModifyDocument: true, editVersion: app.state.draftVersion }
  await app.renderTask({ id: "task", status: "completed", projectPath: "另一个项目", output: "## 文章草稿\n# 另一个项目的内容" })
  expect(app.editorMarkdown()).toContain("当前项目")
})
test("a failed save prevents advancing the workflow", async () => {
  const { app } = await setup(async () => Response.json({ error: "数据库不可用" }, { status: 503 }))
  app.setDraftMarkdown("# 文章\n\n正文")
  app.state.currentStep = "draft"
  await app.advanceStage()
  expect(app.state.currentStep).toBe("draft")
})

test("retrying a progress save uses the already saved document revision", async () => {
  let progressAttempts = 0
  const versions: string[] = []
  const { app } = await setup(async (url, init) => {
    if (url === "/api/files") { versions.push(JSON.parse(init.body).expectedUpdatedAt); return Response.json({ updatedAt: "revision-2" }) }
    if (url === "/api/project-state" && ++progressAttempts === 1) return Response.json({ error: "temporary failure" }, { status: 503 })
    return Response.json({})
  })
  app.state.cloud = true
  app.state.savedUpdatedAt = "revision-1"
  app.setDraftMarkdown("# 修改")
  expect(await app.saveDraft()).toBe(false)
  expect(await app.saveDraft()).toBe(true)
  expect(versions).toEqual(["revision-1", "revision-2"])
})

test("a save conflict can reopen the cloud version while keeping local edits in recovery history", async () => {
  const { app } = await setup(async (url) => {
    if (url === "/api/files") return Response.json({ error: "conflict" }, { status: 409 })
    if (url.startsWith("/api/file?")) return Response.json({ content: "# 云端新版", updatedAt: "new" })
    return Response.json({ state: {}, tasks: [] })
  })
  app.state.cloud = true
  app.state.savedContent = "# 原稿"
  app.setDraftMarkdown("# 本机编辑")
  expect(await app.saveDraft()).toBe(false)
  expect(await app.openProject({ name: "项目" })).toBe(true)
  expect(app.editorMarkdown()).toBe("# 云端新版")
  expect(JSON.stringify(app.state.chat)).toContain("# 本机编辑")
})
test("concurrent submissions only start one AI request", async () => {
  let count = 0
  let resolveTask: (response: Response) => void = () => {}
  const { app } = await setup(async (url) => {
    if (url === "/api/tasks") { count++; return new Promise(resolve => { resolveTask = resolve }) }
    return Response.json({ files: [], state: {} })
  })
  const first = app.runStepTask("帮我修改")
  await tick()
  const second = app.runStepTask("帮我修改")
  await tick()
  expect(count).toBe(1)
  resolveTask(Response.json({ task: { id: "test-id", status: "failed", error: "test" } }))
  await Promise.all([first, second])
})
test("the submitted message is durable before a long model request so reloading can recover it", async () => {
  let savedProgress: any
  let releaseTask: (response: Response) => void = () => {}
  const { app } = await setup(async (url, init) => {
    if (url === "/api/project-state") savedProgress = JSON.parse(init.body).state
    if (url === "/api/tasks") return new Promise(resolve => { releaseTask = resolve })
    return Response.json({})
  })
  app.state.cloud = true
  const pending = app.runStepTask("请结合这个新要求继续写作")
  await tick()
  try {
    expect(savedProgress?.chat).toContainEqual(expect.objectContaining({ role: "user", content: "请结合这个新要求继续写作" }))
  } finally {
    releaseTask(Response.json({ task: { id: "test-task", status: "failed", error: "test" } }))
    await pending
  }
})
test("concurrent expired-token requests share one refresh and retry", async () => {
  let refreshes = 0
  const { app } = await setup(async (url, init = {}) => {
    if (url === "/api/auth/refresh") { refreshes++; await tick(); return Response.json({ access_token: "new", refresh_token: "new-refresh", user: { id: "user-1" } }) }
    const headers = new Headers(init.headers)
    return headers.get("Authorization") === "Bearer new" ? Response.json({ ok: true }) : Response.json({ error: "expired" }, { status: 401 })
  })
  const responses = await Promise.all([app.apiFetch("/api/projects"), app.apiFetch("/api/settings")])
  expect(responses.every(r => r.ok)).toBe(true)
  expect(refreshes).toBe(1)
})
test("Chinese IME confirmation does not accidentally send a task", async () => {
  let tasks = 0
  const { w } = await setup(async (url) => { if (url === "/api/tasks") tasks++; return Response.json({ task: { id: "x", status: "failed" } }) })
  const input = w.document.querySelector("#promptInput")
  input.value = "正在输入中文"
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }))
  await tick()
  expect(tasks).toBe(0)
})

test("settings clicks prevent native dialog submission synchronously", async () => {
  const { w } = await setup()
  const event = new w.MouseEvent("click", { bubbles: true, cancelable: true })
  w.document.querySelector("#saveSettings").dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  await tick()
})

test("full cloud workflow creates, writes, refines, checks, scores, saves and reloads", async () => {
  const { default: handler } = await import("../../api/index")
  const { createServicesFixture } = await import("./fixtures")
  const fixture = createServicesFixture()
  const original = globalThis.fetch
  const env = { ...process.env }
  process.env.SUPABASE_URL = "https://fixture.supabase.test"
  process.env.SUPABASE_ANON_KEY = "fixture-anon"
  process.env.EDITAI_LLM_API_KEY = "fixture-llm"
  process.env.EDITAI_LLM_BASE_URL = "https://fixture.model.test"
  globalThis.fetch = fixture.fetcher
  try {
    const { w, app } = await setup(async (url, init = {}) => handler(new Request("http://localhost" + url, init)))
    app.state.activeProject = null
    app.state.draftPath = ""
    app.state.session = fixture.session(fixture.users[0]!)
    app.state.cloud = true
    w.document.querySelector("#projectNameInput").value = "完整验收项目"
    w.document.querySelector("#createProjectButton").click()
    for (let i = 0; i < 100 && !app.state.activeProject; i++) await tick()
    expect(app.state.activeProject).toBe("完整验收项目")
    await app.runStepTask("面向新手，写一篇关于养成写作习惯的文章")
    await app.advanceStage()
    expect(app.state.currentStep).toBe("outline")
    expect(app.editorMarkdown()).toContain("1. 明确目标")
    await app.advanceStage()
    expect(app.state.currentStep).toBe("draft")
    expect(app.editorMarkdown()).toContain("**持续练习**")
    await app.advanceStage()
    expect(app.state.currentStep).toBe("refine")
    await app.advanceStage()
    expect(app.state.stageReports.refine).toBe(true)
    await app.advanceStage()
    expect(app.state.currentStep).toBe("fact")
    await app.advanceStage()
    expect(app.state.stageReports.fact).toBe(true)
    await app.advanceStage()
    expect(app.state.currentStep).toBe("score")
    await app.advanceStage()
    expect(app.state.currentStep).toBe("final")
    await app.advanceStage()
    expect(fixture.db.finals[0]?.content).toBe(app.editorMarkdown())
    expect(fixture.db.projects[0]?.state.currentStep).toBe("final")
    expect(fixture.db.projects[0]?.state.chat.length).toBeGreaterThan(0)
    await app.openProject({ name: "完整验收项目" })
    expect(app.state.currentStep).toBe("final")
    expect(app.state.completedSteps.has("final")).toBe(true)
    expect(app.editorMarkdown()).toBe(fixture.db.finals[0]?.content)
    expect(app.state.busy).toBe(false)
    const other = await handler(new Request("http://localhost/api/projects", { headers: { Authorization: "Bearer " + fixture.session(fixture.users[1]!).access_token } }))
    expect((await other.json()).projects).toHaveLength(0)
  } finally { globalThis.fetch = original; process.env = env }
})

test("failed reference selection preserves typed text and reports the error", async () => {
  const { w, app } = await setup(async () => Response.json({ error: "reference unavailable" }, { status: 503 }))
  const input = w.document.querySelector("#promptInput")
  input.value = "@项"
  input.selectionStart = input.selectionEnd = 2
  app.state.mention = { open: true, items: [{ path: "项目/draft.md" }], start: 0, activeIndex: 0 }
  await expect(app.selectMention()).rejects.toThrow("reference unavailable")
  expect(input.value).toBe("@项")
  expect(app.state.attachments).toHaveLength(0)
})

test("a reference response cannot attach content after switching projects", async () => {
  let resolveReference: (value: Response) => void = () => {}
  const { app } = await setup(async () => new Promise(resolve => { resolveReference = resolve }))
  const loading = app.attachWorkspaceFile("项目/draft.md")
  app.state.projectEpoch++
  app.state.activeProject = "另一个项目"
  resolveReference(Response.json({ path: "项目/draft.md", name: "draft.md", content: "原项目文章" }))
  await loading
  expect(app.state.attachments).toHaveLength(0)
})
