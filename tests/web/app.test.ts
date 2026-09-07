import { afterEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { readFileSync } from "node:fs"
const html = readFileSync(new URL("../../src/web/public/index.html", import.meta.url), "utf8")
const source = readFileSync(new URL("../../src/web/public/app.js", import.meta.url), "utf8")
const editorSource = readFileSync(new URL("../../src/web/public/editor.js", import.meta.url), "utf8")
const windows: any[] = []
async function setup(fetcher?: (url: string, init: any) => Promise<Response>) {
  const dom = new JSDOM(html, { url: "http://localhost/app", runScripts: "outside-only", pretendToBeVisual: true })
  const w: any = dom.window
  windows.push(w)
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent || "" }, set(v) { this.textContent = v }, configurable: true })
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  w.HTMLDialogElement.prototype.close = function () { this.open = false }
  w.Headers = Headers
  w.Response = Response
  w.AbortController = AbortController
  w.ClipboardEvent = w.Event
  w.Range.prototype.getClientRects = () => []
  w.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 })
  w.HTMLElement.prototype.scrollIntoView = () => {}
  w.scrollBy = () => {}
  w.fetch = fetcher || (async () => Response.json({ files: [], projects: [], configured: true, state: {}, tasks: [] }))
  w.eval(editorSource + "\nwindow.LucidEditor = LucidEditor;")
  w.eval(source + "\nwindow.testApp = {state, richEditor, editorMarkdown, setDraftMarkdown, renderTask, runStepTask, saveDraft, advanceStage, apiFetch, openProject, openCloudFile, createTreeRow, saveFinal, logout, renderProcessSteps, selectMention, attachWorkspaceFile, requestDeleteProject, confirmDeleteProject};")
  await Promise.resolve()
  const app = w.testApp
  app.state.session = { access_token: "old", refresh_token: "refresh", user: { id: "user-1" } }
  app.state.activeProject = "项目"
  app.state.draftPath = "项目/draft.md"
  app.richEditor.setMode(true, null)
  return { w, app, editor: w.document.querySelector("#draftEditor") }
}
afterEach(() => { windows.splice(0).forEach(w => { w.testApp?.richEditor.destroy(); w.close() }) })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test("formatting controls preserve their selection and rich attributes through save and reopening", async () => {
  let persisted = ""
  const { w, app, editor } = await setup(async (url, init) => {
    if (url === "/api/files") persisted = JSON.parse(init.body).content
    return Response.json({ path: "项目/draft.md", updatedAt: "v2" })
  })
  app.setDraftMarkdown("# 标题\n\n需要保留颜色和下划线")
  const tiptap = app.richEditor.editor
  tiptap.commands.setTextSelection({ from: 5, to: 15 })
  w.document.querySelector('#editorToolbar [data-command="bold"]').click()
  w.document.querySelector('#editorToolbar [data-command="underline"]').click()
  app.richEditor.runCommand("color", "#245bdb")
  app.richEditor.runCommand("center")
  app.richEditor.runCommand("fontSize", "20px")
  await app.saveDraft()
  expect(persisted).toContain("<u>")
  expect(persisted).toContain("text-align: center")
  const before = tiptap.getHTML()
  app.setDraftMarkdown(persisted)
  expect(tiptap.getHTML()).toBe(before)
  expect(editor.querySelector("u strong, strong u")).not.toBeNull()
})

test("tables keep merged cells and column widths after reload, and table buttons perform real operations", async () => {
  const { w, app, editor } = await setup()
  const tiptap = app.richEditor.editor
  tiptap.commands.setContent('<table><colgroup><col style="width: 120px"><col style="width: 180px"></colgroup><tr><th colspan="2" colwidth="120,180">合并表头</th></tr><tr><td>甲</td><td>乙</td></tr></table>', { contentType: "html" })
  const saved = app.editorMarkdown()
  const before = tiptap.getJSON()
  app.setDraftMarkdown(saved)
  expect(tiptap.getJSON()).toEqual(before)
  expect(editor.querySelector("th")?.colSpan).toBe(2)
  let pos = 0
  tiptap.state.doc.descendants((node: any, at: number) => { if (node.isText && node.text === "甲") pos = at })
  tiptap.commands.setTextSelection(pos)
  expect(w.document.querySelector("#editorTableTools").hidden).toBe(false)
  w.document.querySelector('[data-command="addRowAfter"]').click()
  expect(editor.querySelectorAll("tr")).toHaveLength(3)
  tiptap.commands.undo()
  expect(editor.querySelectorAll("tr")).toHaveLength(2)
})

test("code containing backticks and Markdown headings survives saving and reopening", async () => {
  let persisted = ""
  const { app } = await setup(async (url, init) => {
    if (url === "/api/files") persisted = JSON.parse(init.body).content
    return Response.json({ updatedAt: "v2" })
  })
  const tiptap = app.richEditor.editor
  tiptap.commands.setContent({ type: "doc", content: [
    { type: "codeBlock", attrs: { language: "markdown" }, content: [{ type: "text", text: "```md\n# Code, not a heading\n```\n~~~\n<example>" }] },
    { type: "paragraph", content: [{ type: "text", text: "a `backtick` example", marks: [{ type: "code" }] }] },
  ] })
  const before = tiptap.getJSON()
  await app.saveDraft()
  app.setDraftMarkdown(persisted)
  expect(tiptap.getJSON()).toEqual(before)
})

test("folding a block stays collapsed, saves its state and remains undoable", async () => {
  const { app, editor } = await setup()
  app.setDraftMarkdown('<details open><summary>摘要</summary><p>保留正文</p></details>')
  const details = editor.querySelector("details")
  details.querySelector("summary").click()
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(details.open).toBe(false)
  expect(app.richEditor.editor.state.doc.firstChild.attrs.open).toBe(false)
  const saved = app.editorMarkdown()
  expect(saved).toContain("保留正文")
  expect(app.richEditor.editor.commands.undo()).toBe(true)
  expect(editor.querySelector("details").open).toBe(true)
  app.setDraftMarkdown(saved)
  expect(editor.querySelector("details").open).toBe(false)
})

test("import rejects a document that would exceed total save capacity without changing the draft", async () => {
  const { w, app } = await setup()
  app.setDraftMarkdown("a".repeat(300_000))
  const original = app.editorMarkdown()
  const input = w.document.querySelector("#documentImport")
  Object.defineProperty(input, "files", { configurable: true, value: [{ name: "large.md", size: 300_000, text: async () => "b".repeat(300_000) }] })
  input.dispatchEvent(new w.Event("change"))
  await tick()
  expect(app.editorMarkdown()).toBe(original)
  expect(w.document.querySelector("#editorMessage").textContent).toContain("超出保存容量")
})

test("task lists, callouts, folding blocks, columns and embedded images round-trip without losing content", async () => {
  const { app } = await setup()
  const tiptap = app.richEditor.editor
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] })
  tiptap.commands.setContent({ type: "doc", content: [
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("已经完成")] }] },
    { type: "callout", content: [paragraph("保留提示")] },
    { type: "details", content: [{ type: "detailsSummary", content: [{ type: "text", text: "展开详情" }] }, paragraph("折叠内容")] },
    { type: "columns", content: [{ type: "column", content: [paragraph("左栏")] }, { type: "column", content: [paragraph("右栏")] }] },
    { type: "image", attrs: { src: "data:image/png;base64,aGVsbG8=", alt: "本地图片", width: 240 } },
  ] })
  const before = tiptap.getJSON(), saved = app.editorMarkdown()
  app.setDraftMarkdown(saved)
  expect(tiptap.getJSON()).toEqual(before)
  expect(saved).toContain("[x] 已经完成")
})

test("slash menu supports filtering and keyboard insertion while respecting Chinese composition", async () => {
  const { w, app } = await setup()
  app.setDraftMarkdown("")
  const tiptap = app.richEditor.editor
  tiptap.commands.insertContent("/table")
  const menu = w.document.querySelector(".editor-popup")
  expect(menu.hidden).toBe(false)
  expect(menu.textContent).toContain("表格")
  tiptap.view.dom.dispatchEvent(new w.CompositionEvent("compositionstart", { bubbles: true }))
  const composing = new w.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })
  tiptap.view.dom.dispatchEvent(composing)
  expect(menu.querySelector('input[aria-label="行数"]')).toBeNull()
  tiptap.view.dom.dispatchEvent(new w.CompositionEvent("compositionend", { bubbles: true }))
  // ProseMirror suppresses the IME-confirming Enter for 500 ms on Safari.
  await new Promise(resolve => setTimeout(resolve, 520))
  tiptap.view.dom.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  expect(menu.querySelector('input[aria-label="行数"]')).not.toBeNull()
  menu.querySelector('[data-command="submit"]').click()
  expect(tiptap.getHTML()).toContain("<table")
  expect(tiptap.getText()).not.toContain("/table")
  w.document.querySelector('[data-command="addRowAfter"]').click()
  expect(tiptap.view.dom.querySelectorAll("tr")).toHaveLength(4)
  tiptap.commands.undo()
  expect(tiptap.view.dom.querySelectorAll("tr")).toHaveLength(3)
})

test("find and replace matches across inline formatting and replaces all in one undoable edit", async () => {
  const { w, app } = await setup()
  app.setDraftMarkdown("# 标题\n\n苹果**很好**吃，苹果很好吃。")
  const before = app.richEditor.editor.getJSON()
  app.richEditor.search("苹果很好吃")
  expect(w.document.querySelector("#documentMatches").textContent).toBe("1 / 2")
  w.document.querySelector("#documentReplace").value = "梨也不错"
  app.richEditor.replace(true)
  expect(app.richEditor.editor.getText()).toContain("梨也不错，梨也不错。")
  expect(app.richEditor.editor.commands.undo()).toBe(true)
  expect(app.richEditor.editor.getJSON()).toEqual(before)
  const focusButton = w.document.querySelector("#editorFocusToggle")
  focusButton.focus()
  const shortcut = new w.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true })
  focusButton.dispatchEvent(shortcut)
  expect(shortcut.defaultPrevented).toBe(true)
  expect(w.document.activeElement).toBe(w.document.querySelector("#documentSearch"))
})

test("block menus move complete formatted paragraphs and preserve content on undo", async () => {
  const { w, app } = await setup()
  app.setDraftMarkdown("甲\n\n**乙**\n\n丙")
  const tiptap = app.richEditor.editor
  const before = tiptap.getJSON()
  tiptap.commands.setTextSelection(4)
  w.document.querySelector('.editor-gutter [data-command="blockMenu"]').click()
  const up = [...w.document.querySelectorAll(".editor-menu-row")].find((button: any) => button.textContent === "上移") as any
  up.click()
  expect(tiptap.state.doc.firstChild.textContent).toBe("乙")
  expect(tiptap.state.doc.firstChild.firstChild.marks[0].type.name).toBe("bold")
  tiptap.commands.undo()
  expect(tiptap.getJSON()).toEqual(before)
})

test("undo history is isolated between projects, and the saved final renders rich formatting read-only", async () => {
  const { app, w } = await setup()
  app.setDraftMarkdown("# 第一篇")
  app.richEditor.editor.commands.insertContent("编辑")
  expect(app.richEditor.editor.can().undo()).toBe(true)
  app.state.activeProject = "另一篇"
  app.setDraftMarkdown("# 第二篇")
  expect(app.richEditor.editor.can().undo()).toBe(false)
  app.richEditor.setMode(true, '<p style="text-align: center;"><u>终稿格式</u></p>')
  expect(w.document.querySelector("#filePreview u").textContent).toBe("终稿格式")
  expect(w.document.querySelector('#filePreview [contenteditable="true"]')).toBeNull()
  expect(app.richEditor.runCommand("bold")).toBe(false)
  expect(app.editorMarkdown()).toBe("# 第二篇")
})

test("rich clipboard HTML keeps visible formatting while removing executable markup and unsafe links", async () => {
  const { app, editor } = await setup()
  app.setDraftMarkdown("")
  app.richEditor.editor.view.pasteHTML('<p onclick="alert(1)"><span style="color: rgb(36, 91, 219)">粘贴颜色</span> <u>下划线</u><a href="javascript:alert(1)">坏链接</a></p><script>alert(1)</script><iframe src="https://example.com"></iframe>')
  expect(editor.querySelector("u")?.textContent).toBe("下划线")
  expect(editor.querySelector("span[style]")?.style.color).toBe("rgb(36, 91, 219)")
  expect(editor.querySelector("script,iframe,[onclick],a[href^='javascript:']")).toBeNull()
  const saved = app.editorMarkdown()
  app.setDraftMarkdown(saved)
  expect(editor.querySelector("span[style]")?.style.color).toBe("rgb(36, 91, 219)")
})

test("AI requests omit embedded image bytes and restore their placeholders in the returned article", async () => {
  let message = "", saved = ""
  const src = "data:image/png;base64," + "a".repeat(220_000)
  const { app, editor } = await setup(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    if (url === "/api/files") saved = body.content
    if (url === "/api/tasks") {
      message = body.message
      return Response.json({ task: { id: body.id, status: "completed", output: '## 对话回复\n已修改。\n## 文章草稿\n# 修改后的文章\n\n![保留图片](https://lucidwrite.invalid/embedded-image/1)' } })
    }
    return Response.json({ updatedAt: "v2" })
  })
  app.setDraftMarkdown(`# 原图文\n\n![保留图片](${src})`)
  expect(await app.runStepTask("润色这篇文章，保留图片")).toBe(true)
  expect(message).not.toContain("data:image")
  expect(message.length).toBeLessThan(5000)
  expect(editor.querySelector("img")?.getAttribute("src")).toBe(src)
  expect(saved).toContain(src)
})

test("the project trash button asks for confirmation and cancel or Escape never deletes", async () => {
  const requests: string[] = []
  const { w, app } = await setup(async (url, init) => { requests.push(init?.method || "GET"); return Response.json({}) })
  app.state.cloud = true
  app.setDraftMarkdown("# 保留正文")
  const row = app.createTreeRow({ name: "待删除 <文章>", path: "待删除 <文章>", type: "directory", depth: 1, projectId: "target-id" })
  w.document.querySelector("#fileTree").append(row)
  row.querySelector(".tree-delete").click()
  expect(w.document.querySelector("#deleteProjectDialog").open).toBe(true)
  expect(w.document.querySelector("#deleteProjectDescription").textContent).toContain("待删除 <文章>")
  expect(w.document.activeElement.id).toBe("cancelDeleteProject")
  expect(app.state.activeProject).toBe("项目")
  w.document.querySelector("#cancelDeleteProject").click()
  expect(w.document.querySelector("#deleteProjectDialog").open).toBe(false)
  row.querySelector(".tree-delete").click()
  w.document.querySelector("#deleteProjectDialog").dispatchEvent(new w.Event("cancel", { cancelable: true }))
  expect(app.state.deleteTarget).toBeNull()
  expect(requests).not.toContain("DELETE")
  expect(app.editorMarkdown()).toBe("# 保留正文")
})

test("deleting the active project waits for prior saves then clears its editor, history, preview and cache", async () => {
  const deletes: any[] = []
  const { w, app } = await setup(async (url, init) => {
    if (init?.method === "DELETE") { deletes.push(JSON.parse(init.body)); return Response.json({ deleted: true, id: "project-id" }) }
    return Response.json({ projects: [], files: [] })
  })
  app.state.cloud = true
  app.setDraftMarkdown("# 待删除正文")
  app.state.chat = [{ role: "user", content: "旧对话" }]
  app.state.previewFile = { path: "项目/final.md", content: "终稿" }
  app.state.completedSteps.add("topic")
  app.state.recoveryDrafts = [{ content: "旧副本" }]
  app.state.expandedDirs.add("项目")
  w.localStorage.setItem("lucidwrite_project:user-1::项目", "old cache")
  let release = () => {}
  app.state.saveQueue = new Promise<void>(resolve => { release = resolve })
  app.requestDeleteProject({ path: "项目", projectId: "project-id" })
  const pending = app.confirmDeleteProject()
  await tick()
  expect(deletes).toHaveLength(0)
  expect(await app.saveDraft()).toBe(false)
  expect(await app.openProject({ name: "另一个项目" })).toBe(false)
  expect(await app.runStepTask("写作")).toBe(false)
  expect(w.document.querySelector("#confirmDeleteProject").disabled).toBe(true)
  release()
  expect(await pending).toBe(true)
  expect(deletes).toEqual([{ name: "项目", id: "project-id" }])
  expect(app.state.activeProject).toBeNull()
  expect(app.state.previewFile).toBeNull()
  expect(app.state.chat).toHaveLength(0)
  expect(app.state.recoveryDrafts).toHaveLength(0)
  expect(app.state.completedSteps.size).toBe(0)
  expect(app.editorMarkdown()).toBe("")
  expect(w.localStorage.getItem("lucidwrite_project:user-1::项目")).toBeNull()
  expect(w.document.querySelector("#projectGate").hidden).toBe(false)
  expect(w.document.querySelector("#filePreview").textContent).toBe("")
  expect(w.document.querySelector("#deleteProjectDialog").open).toBe(false)
})

test("deleting another project keeps the current article and removes only matching attachments", async () => {
  const { w, app } = await setup(async (url, init) => init?.method === "DELETE" ? Response.json({ deleted: true, id: "other-id" }) : Response.json({ projects: [], files: [] }))
  app.state.cloud = true
  app.setDraftMarkdown("# 当前正文")
  app.state.chat = [{ role: "user", content: "当前对话" }]
  app.state.savedVersion = app.state.draftVersion
  app.state.attachments = [{ source: "旧项目/final.md" }, { source: "旧项目二/draft.md" }]
  app.requestDeleteProject({ path: "旧项目", projectId: "other-id" })
  expect(await app.confirmDeleteProject()).toBe(true)
  expect(app.editorMarkdown()).toBe("# 当前正文")
  expect(app.state.chat[0].content).toBe("当前对话")
  expect(app.state.activeProject).toBe("项目")
  expect(app.state.attachments).toEqual([{ source: "旧项目二/draft.md" }])
})

test("delete failure keeps the project and allows retry; refresh failure after deletion is not reported as a failed delete", async () => {
  let failDelete = true
  const { w, app } = await setup(async (url, init) => {
    if (init?.method === "DELETE") return failDelete ? Response.json({ error: "暂时无法删除" }, { status: 502 }) : Response.json({ deleted: true, id: "project-id" })
    return Response.json({ error: "离线" }, { status: 502 })
  })
  app.state.cloud = true
  app.setDraftMarkdown("# 保留正文")
  app.requestDeleteProject({ path: "项目", projectId: "project-id" })
  expect(await app.confirmDeleteProject()).toBe(false)
  expect(app.editorMarkdown()).toBe("# 保留正文")
  expect(app.state.activeProject).toBe("项目")
  expect(w.document.querySelector("#deleteProjectDialog").open).toBe(true)
  expect(w.document.querySelector("#deleteProjectError").textContent).toBe("暂时无法删除")
  expect(w.document.querySelector("#confirmDeleteProject").disabled).toBe(false)
  failDelete = false
  expect(await app.confirmDeleteProject()).toBe(true)
  expect(app.state.activeProject).toBeNull()
  expect(w.document.querySelector("#compactLog").textContent).toContain("已删除「项目」，列表刷新失败")
})

test("clicking a cloud draft opens its article and project history rather than attaching a reference", async () => {
  const requests: string[] = []
  const { w, app, editor } = await setup(async (url) => {
    requests.push(url)
    if (url.startsWith("/api/file?")) return Response.json({ content: "# 打开的文章\n\n正文", updatedAt: "v1" })
    return Response.json({ state: { currentStep: "draft", chat: [{ role: "user", content: "项目对话" }] }, tasks: [] })
  })
  app.state.cloud = true
  app.state.activeProject = null
  const row = app.createTreeRow({ path: "另一项目/draft.md", name: "draft.md", type: "markdown" })
  await row.onclick({ target: row })
  expect(editor.textContent).toContain("打开的文章")
  expect(w.document.querySelector("#writingStage").hidden).toBe(false)
  expect(app.state.activeProject).toBe("另一项目")
  expect(app.state.currentStep).toBe("draft")
  expect(app.state.chat[0].content).toBe("项目对话")
  expect(app.state.attachments).toHaveLength(0)
  expect(requests.some(url => url.startsWith("/api/reference?"))).toBe(false)
})

test("a project name opens its draft while the folder caret only expands or collapses", async () => {
  let reads = 0
  const { app } = await setup(async (url) => {
    if (url.startsWith("/api/file?")) { reads++; return Response.json({ content: "# 项目正文" }) }
    return Response.json({ files: [], state: {}, tasks: [] })
  })
  app.state.cloud = true
  const row = app.createTreeRow({ path: "另一个项目", name: "另一个项目", type: "directory", depth: 1 })
  await row.onclick({ target: row.querySelector(".tree-caret") })
  expect(app.state.activeProject).toBe("项目")
  expect(reads).toBe(0)
  await row.onclick({ target: row.querySelector(".file-name") })
  expect(app.state.activeProject).toBe("另一个项目")
  expect(app.state.expandedDirs.has("另一个项目")).toBe(true)
  expect(app.editorMarkdown()).toContain("项目正文")
})

test("final-file preview preserves the working draft, blocks edits and still allows explicit references", async () => {
  const writes: any[] = []
  const { w, app, editor } = await setup(async (url, init) => {
    if (url === "/api/files") writes.push(JSON.parse(init.body))
    if (url.startsWith("/api/file?")) return Response.json({ content: "# 已保存的终稿\n\n终稿内容" })
    if (url.startsWith("/api/reference?")) return Response.json({ path: "项目/final.md", content: "终稿内容", type: "markdown" })
    return Response.json({ state: {}, tasks: [] })
  })
  app.state.cloud = true
  app.setDraftMarkdown("# 尚在编辑的工作稿\n\n工作稿内容")
  expect(await app.openCloudFile("项目/final.md")).toBe(true)
  expect(w.document.querySelector("#filePreview").textContent).toContain("已保存的终稿")
  expect(editor.hidden).toBe(true)
  expect(app.editorMarkdown()).toContain("尚在编辑的工作稿")
  expect(app.state.attachments).toHaveLength(0)
  expect(await app.runStepTask("修改文章")).toBe(false)
  expect(await app.saveFinal()).toBe(false)
  await app.saveDraft()
  expect(writes.every(write => write.path === "项目/draft.md" && write.content.includes("工作稿内容"))).toBe(true)
  expect(w.document.querySelector("#sendButton").disabled).toBe(true)
  await app.attachWorkspaceFile("项目/final.md")
  expect(app.state.attachments[0].content).toBe("终稿内容")
  w.document.querySelector("#saveDraftButton").click()
  await tick()
  expect(editor.hidden).toBe(false)
  expect(editor.textContent).toContain("尚在编辑的工作稿")
  expect(w.document.querySelector("#filePreview").hidden).toBe(true)
  expect(w.document.querySelector("#sendButton").disabled).toBe(false)
})

test("a missing final leaves the working article visible and reports a failed open", async () => {
  const { w, app, editor } = await setup(async () => Response.json({ error: "文件不存在" }, { status: 404 }))
  app.state.cloud = true
  app.setDraftMarkdown("# 保留工作稿")
  app.state.savedVersion = app.state.draftVersion
  const row = app.createTreeRow({ path: "项目/final.md", name: "final.md", type: "markdown" })
  await row.onclick({ target: row })
  expect(editor.hidden).toBe(false)
  expect(app.editorMarkdown()).toBe("# 保留工作稿")
  expect(w.document.querySelector("#compactLog").textContent).toContain("文件不存在")
  expect(app.state.projectLoading).toBe(false)
})

test("a final-file response arriving after logout cannot restore the old article", async () => {
  let respond: (response: Response) => void = () => {}
  const { w, app } = await setup(async (url) => url.startsWith("/api/file?") ? new Promise(resolve => { respond = resolve }) : Response.json({}))
  app.state.cloud = true
  app.setDraftMarkdown("# 工作稿")
  app.state.savedVersion = app.state.draftVersion
  const opening = app.openCloudFile("项目/final.md")
  await tick()
  await app.logout()
  respond(Response.json({ content: "# 旧账号终稿" }))
  expect(await opening).toBe(false)
  expect(w.document.querySelector("#filePreview").textContent).toBe("")
  expect(app.state.previewFile).toBeNull()
})

test("reopening and saving a style sample does not add generated text to the sample", async () => {
  const writes: string[] = []
  const { w, app } = await setup(async (url, init) => {
    if (url === "/api/style-fingerprint" && init?.method === "PUT") writes.push(JSON.parse(init.body).content)
    return Response.json({ configured: true, files: [], projects: [] })
  })
  const sample = "句子简短，用具体例子说明问题。\n\n保留作者自己的表达。"
  app.state.styleFingerprint = sample
  for (let i = 0; i < 2; i++) {
    w.document.querySelector("#editStyleButton").click()
    expect(w.document.querySelector("#styleSourceInput").value).toBe(sample)
    w.document.querySelector("#saveStyleButton").click()
    await tick()
  }
  expect(writes).toEqual([sample, sample])
})

test("opening and saving a Markdown article preserves its original syntax", async () => {
  const { app } = await setup()
  const markdown = "# 标题\n\n**重点** [来源](https://example.com)\n\n1. 第一项\n2. 第二项\n\n> 引文"
  app.setDraftMarkdown(markdown)
  expect(app.editorMarkdown()).toBe(markdown)
})
test("edited rich text preserves heading, emphasis, link and table semantics", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 标题\n\n原文")
  app.richEditor.editor.commands.setContent('<h1>新标题</h1><p><strong>重点</strong> <a href="https://example.com">来源</a></p><table><tr><th>项目</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>', { contentType: "html" })
  const saved = app.editorMarkdown()
  expect(saved).toContain("# 新标题")
  expect(saved).toContain("**重点**")
  expect(saved).toContain("[来源](https://example.com)")
  app.setDraftMarkdown(saved)
  expect(editor.querySelector("table")?.textContent).toBe("项目值A1")
})
test("numbered lists retain their structure and starting number after editing and reopening", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 清单\n\n3. 第三步\n4. 第四步\n\n- 提醒")
  expect(editor.querySelector("ol")?.start).toBe(3)
  expect(editor.querySelectorAll("ol > li")).toHaveLength(2)
  let end = 0
  app.richEditor.editor.state.doc.descendants((node: any, pos: number) => { if (node.isText && node.text === "第四步") end = pos + node.nodeSize })
  app.richEditor.editor.commands.insertContentAt(end, "，已修改")
  const saved = app.editorMarkdown()
  expect(saved).toContain("3. 第三步\n4. 第四步，已修改")
  app.setDraftMarkdown(saved)
  expect(editor.querySelector("ol")?.start).toBe(3)
  expect(editor.querySelector("ul > li")?.textContent).toBe("提醒")
})
test("pasting an article over a heading does not turn pasted paragraphs into headings", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 新项目")
  app.richEditor.editor.commands.selectAll()
  app.richEditor.editor.view.pasteHTML('<h1>文章标题</h1><p>第一段正文。</p><p><strong>重点</strong>仍是正文。</p>')
  const saved = app.editorMarkdown()
  app.setDraftMarkdown(saved)
  expect(editor.querySelectorAll("h1")).toHaveLength(1)
  expect(editor.querySelector("p")?.textContent).toBe("第一段正文。")
  expect(editor.querySelector("p strong")?.textContent).toBe("重点")
})
test("deleting the whole draft really saves an empty draft", async () => {
  const { w, app, editor } = await setup()
  app.setDraftMarkdown("# 原文\n\n应当删除")
  app.richEditor.editor.commands.clearContent()
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

test("full cloud workflow creates, writes, refines, checks, scores, saves, reloads and deletes", async () => {
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
    const projectId = fixture.db.projects[0]!.id
    w.document.querySelector(".tree-delete").click()
    expect(app.state.deleteTarget.id).toBe(projectId)
    expect(await app.confirmDeleteProject()).toBe(true)
    for (const table of ["projects", "drafts", "finals", "writing_tasks"]) expect(fixture.db[table]).toHaveLength(0)
    expect(w.document.querySelector(".tree-delete")).toBeNull()
    expect(w.document.querySelector("#projectList").children).toHaveLength(0)
    expect((await (await app.apiFetch("/api/references")).json()).references).toHaveLength(0)
    expect(w.localStorage.getItem(`lucidwrite_project:${fixture.users[0]!.id}::完整验收项目`)).toBeNull()
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
