const steps = [
  { id: "topic", label: "选题交互", mode: "super-interviewer" },
  { id: "outline", label: "大纲框架", mode: "pipeline" },
  { id: "draft", label: "初稿敲定", mode: "write" },
  { id: "refine", label: "内容精修", mode: "analyze" },
  { id: "fact", label: "事实核查", mode: "fact-check" },
  { id: "score", label: "质量评分", mode: "super-workflow" },
  { id: "final", label: "终稿敲定", mode: "edit" },
]

const state = {
  currentStep: "topic",
  completedSteps: new Set(),
  workspaceRoot: "",
  notesRoot: "",
  activeProject: null,
  draftPath: "",
  expandedDirs: new Set(["."]),
  attachments: [],
  chat: [],
  pendingTasks: {},
  pollTimer: null,
  draftVersion: 0,
  topicRounds: 0,
  styleFingerprint: "",
  qualityScored: false,
  stageReports: {},
  lastArticleMarkdown: "",
  directoryPickerPath: "",
  mention: { open: false, query: "", start: -1, items: [], activeIndex: 0 },
  session: null,
  cloud: false,
  busy: false,
  advancing: false,
  editorDirty: false,
  savedVersion: 0,
  savedContent: "",
  savedUpdatedAt: undefined,
  saveConflict: false,
  recoveryDrafts: [],
  mentionVersion: 0,
  projectEpoch: 0,
  autosaveTimer: null,
  saveQueue: Promise.resolve(),
  refreshPromise: null,
  appliedTasks: [],
  projectLoading: false,
  supabase: null,
}

async function timedFetch(url, options = {}, timeout = 25000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    // Keep the deadline active while consuming streamed model responses.
    const body = response.body === null ? null : await response.text()
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch {
    throw new Error(controller.signal.aborted ? "请求超时，请重试；未保存的正文仍保留在本机。" : "网络连接失败，请重试。")
  } finally { clearTimeout(timer) }
}

// Refresh once for concurrent requests and retry the original operation once.
async function apiFetch(url, options = {}) {
  const originalSession = state.session
  const send = async (session) => {
    const headers = new Headers(options.headers)
    if (session?.access_token) headers.set("Authorization", "Bearer " + session.access_token)
    return timedFetch(url, { ...options, headers }, url === "/api/tasks" ? 240000 : 25000)
  }
  let response = await send(originalSession)
  if (response.status !== 401 || !originalSession) return response
  if (state.session?.user?.id !== originalSession.user?.id) return response
  if (state.session?.access_token === originalSession.access_token) {
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        if (!originalSession.refresh_token) return false
        const refreshed = await timedFetch("/api/auth/refresh", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: originalSession.refresh_token }),
        })
        const data = await responseData(refreshed)
        if (refreshed.ok && data.access_token) {
          if (state.session === originalSession) saveSession(data)
          return true
        }
        if (refreshed.status !== 401) throw new Error(data.error || "登录服务暂时不可用，请重试")
        return false
      })().finally(() => { state.refreshPromise = null })
    }
    const refreshed = await state.refreshPromise
    if (!refreshed && state.session === originalSession) {
      cacheProject()
      saveSession(null)
      stopPolling()
      setBusy(false)
      showAuthGate()
      $("#loginError").textContent = "登录已过期，请重新登录；未保存的正文已保留在本机。"
      return response
    }
  }
  if (state.session?.user?.id === originalSession.user?.id) response = await send(state.session)
  return response
}

async function responseData(response) {
  try { return await response.json() }
  catch { throw new Error("服务器返回了无效响应，请稍后重试") }
}
async function checkedData(response) {
  const data = await responseData(response)
  if (!response.ok || data.error) {
    const error = new Error(data.error || "操作失败，请重试")
    error.status = response.status
    throw error
  }
  return data
}
function handleError(error) {
  const message = error?.message || "操作失败，请重试"
  setCompactLog(message)
  if (!$("#projectGate").hidden) $("#projectError").textContent = message
}
const safely = (fn) => (...args) => {
  try { return Promise.resolve(fn(...args)).catch(handleError) }
  catch (error) { handleError(error) }
}

const $ = (selector) => document.querySelector(selector)
const appShell = $(".app-shell")
const draftEditor = $("#draftEditor")
const attachmentTray = $("#attachmentTray")
const mentionMenu = $("#mentionMenu")
const composerDropzone = $("#composerDropzone")

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;")
}

function normalizeMarkdown(value = "") {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1].trim() : value
}

function renderInlineMarkdown(value = "") {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

function isTableStart(lines, index) {
  return index + 1 < lines.length && lines[index].includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
}

function renderTable(lines, startIndex) {
  const header = splitTableRow(lines[startIndex])
  const rows = []
  let index = startIndex + 2
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]))
    index++
  }
  return {
    html: `<div class="table-wrap"><table><thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
    nextIndex: index,
  }
}

function renderMarkdown(value = "") {
  const source = normalizeMarkdown(value)
  return source.split(/(```[\s\S]*?```)/g).map((block) => {
    if (block.startsWith("```")) {
      const code = block.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "")
      return `<pre><code>${escapeHtml(code)}</code></pre>`
    }
    const lines = block.split(/\r?\n/)
    const html = []
    let list = []
    let quote = []
    const flushList = () => {
      if (list.length) html.push(`<ul>${list.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`)
      list = []
    }
    const flushQuote = () => {
      if (quote.length) html.push(`<blockquote>${quote.map((item) => `<p>${renderInlineMarkdown(item)}</p>`).join("")}</blockquote>`)
      quote = []
    }
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed) {
        flushList()
        flushQuote()
        continue
      }
      if (isTableStart(lines, i)) {
        flushList()
        flushQuote()
        const table = renderTable(lines, i)
        html.push(table.html)
        i = table.nextIndex - 1
        continue
      }
      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        flushList()
        flushQuote()
        html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`)
        continue
      }
      const quoteLine = trimmed.match(/^>\s?(.+)$/)
      if (quoteLine) {
        flushList()
        quote.push(quoteLine[1])
        continue
      }
      const bullet = trimmed.match(/^[-*]\s+(.+)$/)
      if (bullet) {
        flushQuote()
        list.push(bullet[1])
        continue
      }
      flushList()
      flushQuote()
      html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`)
    }
    flushList()
    flushQuote()
    return html.join("")
  }).join("")
}

const responseSectionHeadings = [
  "对话回复",
  "修改建议",
  "精修报告",
  "核查报告",
  "事实核查报告",
  "质量评分",
  "评分报告",
  "分析建议",
  "采访启发",
  "文章草稿",
  "完整初稿",
  "初稿",
  "完整大纲",
]

function sectionBoundaryPattern(excludeHeading = "") {
  const headings = responseSectionHeadings
    .filter((heading) => heading !== excludeHeading)
    .map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  return `(?=\\n#{1,4}\\s+(?:${headings})\\s*\\n|$)`
}

function getSection(markdown, heading) {
  const source = normalizeMarkdown(markdown)
  const safeHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return source.match(new RegExp(`(?:^|\\n)#{1,4}\\s+${safeHeading}\\s*\\n([\\s\\S]*?)${sectionBoundaryPattern(heading)}`))?.[1]?.trim() || ""
}

function extractMarkdownFence(markdown) {
  const source = markdown.trim()
  const exact = source.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (exact) return exact[1].trim()
  const fences = [...source.matchAll(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  if (!fences.length) return ""
  return fences.sort((a, b) => b.length - a.length)[0]
}

function stripNonArticleSections(markdown) {
  const fenced = extractMarkdownFence(markdown)
  return normalizeMarkdown(fenced || markdown)
    .replace(/(?:^|\n)#{1,4}\s+(对话回复|修改建议|精修报告|核查报告|事实核查报告|质量评分|评分报告|分析建议|采访启发)\s*\n[\s\S]*?(?=\n#{1,4}\s+(?:对话回复|修改建议|精修报告|核查报告|事实核查报告|质量评分|评分报告|分析建议|采访启发|文章草稿|完整初稿|初稿|完整大纲)\s*\n|$)/g, "\n")
    .replace(/(?:^|\n)#{1,4}\s+(文章草稿|完整初稿|初稿|完整大纲)\s*\n/g, "\n")
    .replace(/^\s*(当然|好的|以下是|下面是).{0,80}(完整初稿|初稿|文章|正文|大纲).{0,20}[:：]\s*/i, "")
    .trim()
}

function articleFromOutput(output, pending) {
  // 优先从明确的 ## 文章草稿 等节提取，直接返回，不做额外转换
  const explicit = getSection(output, "文章草稿") || getSection(output, "完整初稿") || getSection(output, "初稿") || getSection(output, "完整大纲")
  if (explicit) return explicit.trim()

  // 右侧对话（chat）：必须有明确节标题才更新左侧，杜绝把 AI 对话文字写进编辑器
  if (pending?.reason !== "stage") return ""

  // stage 任务：兼容旧隐式提取逻辑
  if (!pending?.mayModifyDocument) return ""
  const fenced = extractMarkdownFence(output)
  if (fenced) return fenced.trim()
  const cleaned = stripNonArticleSections(output)
  if (!cleaned) return ""
  if (pending?.step === "outline") return cleaned
  const reportOnly = /^(已完成|建议|评分|核查|分析|这里)/.test(cleaned) && cleaned.length < 260
  return reportOnly ? "" : cleaned
}

function markdownFromEditor(root) {
  const children = (node) => [...node.childNodes].map(serialize).join("")
  const serialize = (node) => {
    if (node.nodeType === 3) return node.textContent.replace(/\u00a0/g, " ")
    if (node.nodeType !== 1) return ""
    const tag = node.tagName.toLowerCase()
    if (["script", "style", "iframe", "object"].includes(tag)) return ""
    if (tag === "br") return "\n"
    if (tag === "pre") {
      const code = node.textContent.replace(/\n$/, "")
      const fence = code.includes("```") ? "````" : "```"
      return "\n\n" + fence + "\n" + code + "\n" + fence + "\n\n"
    }
    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map(row => [...row.children].map(cell => children(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>")))
      if (!rows.length) return ""
      const line = row => "| " + row.join(" | ") + " |"
      return "\n\n" + [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n") + "\n\n"
    }
    if (tag === "ul" || tag === "ol") {
      return "\n\n" + [...node.children].map((li, index) => (tag === "ol" ? (index + 1) + ". " : "- ") + children(li).trim().replace(/\n/g, "\n  ")).join("\n") + "\n\n"
    }
    const content = children(node)
    if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + content.trim() + "\n\n"
    if (tag === "strong" || tag === "b") return "**" + content + "**"
    if (tag === "em" || tag === "i") return "*" + content + "*"
    if (tag === "del" || tag === "s") return "~~" + content + "~~"
    if (tag === "code") return content.includes("`") ? "`` " + content + " ``" : "`" + content + "`"
    if (tag === "a") {
      const href = node.getAttribute("href") || ""
      return /^https?:\/\//i.test(href) ? "[" + content + "](" + href.replace(/\)/g, "%29") + ")" : content
    }
    if (tag === "blockquote") return "\n\n" + content.trim().split("\n").map(line => "> " + line).join("\n") + "\n\n"
    if (tag === "hr") return "\n\n---\n\n"
    if (tag === "p" || tag === "div") return "\n\n" + content + "\n\n"
    return content
  }
  return children(root).replace(/\n{3,}/g, "\n\n").trim()
}

function editorMarkdown() {
  if (state.editorDirty) {
    state.lastArticleMarkdown = markdownFromEditor(draftEditor)
    state.editorDirty = false
  }
  return state.lastArticleMarkdown
}
function setDraftMarkdown(markdown) {
  state.lastArticleMarkdown = normalizeMarkdown(markdown || "")
  state.editorDirty = false
  draftEditor.innerHTML = renderMarkdown(state.lastArticleMarkdown)
  state.draftVersion += 1
}
function invalidateReports() {
  state.stageReports = {}
  state.qualityScored = false
  for (const step of ["refine", "fact", "score", "final"]) state.completedSteps.delete(step)
}
function setBusy(busy) {
  state.busy = busy
  $("#sendButton").disabled = busy || state.advancing
  $("#stageActionButton").disabled = busy || state.advancing
  $("#chooseWorkspace").disabled = busy || state.advancing
  renderProcessSteps()
}
function projectStorageKey(project = state.activeProject) {
  return "lucidwrite_project:" + state.session?.user?.id + ":" + state.workspaceRoot + ":" + project
}
function workflowState() {
  return {
    currentStep: state.currentStep, completedSteps: [...state.completedSteps], chat: state.chat.slice(-40),
    topicRounds: state.topicRounds, qualityScored: state.qualityScored, stageReports: state.stageReports,
    appliedTasks: state.appliedTasks.slice(-100),
  }
}
function cacheProject() {
  if (!state.activeProject || !state.session?.user?.id) return
  try {
    localStorage.setItem(projectStorageKey(), JSON.stringify({
      workflow: workflowState(), content: editorMarkdown(), baseContent: state.savedContent, recoveryDrafts: state.recoveryDrafts,
      unsaved: state.savedVersion !== state.draftVersion, updatedAt: Date.now(),
    }))
  } catch { setCompactLog("浏览器本地备份空间不足，请尽快保存工作稿。") }
}
function restoreWorkflow(saved = {}) {
  state.currentStep = steps.some(step => step.id === saved.currentStep) ? saved.currentStep : "topic"
  state.completedSteps = new Set((Array.isArray(saved.completedSteps) ? saved.completedSteps : []).filter(id => steps.some(step => step.id === id)))
  state.chat = (Array.isArray(saved.chat) ? saved.chat : []).filter(t => t && ["user", "assistant"].includes(t.role) && typeof t.content === "string").slice(-40)
  state.topicRounds = Number.isFinite(saved.topicRounds) ? saved.topicRounds : 0
  state.qualityScored = saved.qualityScored === true
  state.stageReports = saved.stageReports && typeof saved.stageReports === "object" ? saved.stageReports : {}
  state.appliedTasks = Array.isArray(saved.appliedTasks) ? saved.appliedTasks.slice(-100) : []
}
async function persistProgress() {
  cacheProject()
  if (!state.cloud || !state.activeProject) return true
  const response = await apiFetch("/api/project-state", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: state.activeProject, state: workflowState() }),
  })
  await checkedData(response)
  return true
}
function scheduleAutosave() {
  clearTimeout(state.autosaveTimer)
  state.autosaveTimer = setTimeout(() => saveDraft(), 1200)
}

function isDraftEmpty(markdown = editorMarkdown()) {
  const lines = markdown.trim().split(/\r?\n/).filter((line) => line.trim())
  return !markdown.trim() || (lines.length <= 1 && /^#\s+/.test(lines[0] || ""))
}

function currentStep() {
  return steps.find((step) => step.id === state.currentStep) || steps[0]
}

function nextStepId() {
  const index = steps.findIndex((step) => step.id === state.currentStep)
  return steps[Math.min(index + 1, steps.length - 1)]?.id || "final"
}

async function setStep(stepId) {
  if (state.busy || state.advancing || !steps.some(step => step.id === stepId)) return
  const reached = Math.max(steps.findIndex(step => step.id === state.currentStep), ...[...state.completedSteps].map(id => steps.findIndex(step => step.id === id) + 1))
  if (steps.findIndex(step => step.id === stepId) > reached || !await saveDraft()) return
  state.currentStep = stepId
  renderProcessSteps()
  renderStage()
  renderChat()
  await persistProgress()
}

function completeCurrentStep(next = true) {
  state.completedSteps.add(state.currentStep)
  if (next) state.currentStep = nextStepId()
  renderProcessSteps()
  renderStage()
}

function renderProcessSteps() {
  document.querySelectorAll(".process-step").forEach((button) => {
    const id = button.dataset.step
    button.classList.toggle("active", id === state.currentStep)
    button.classList.toggle("done", state.completedSteps.has(id))
    const reached = Math.max(steps.findIndex(step => step.id === state.currentStep), ...[...state.completedSteps].map(done => steps.findIndex(step => step.id === done) + 1))
    button.disabled = state.busy || state.advancing || steps.findIndex(step => step.id === id) > reached
    button.setAttribute("aria-disabled", String(button.disabled))
    button.textContent = steps.find((step) => step.id === id)?.label || id
  })
}

function renderStage() {
  const step = currentStep()
  $("#modeHint").textContent = `当前阶段：${step.label}`
  $("#guidanceTitle").textContent = step.label
  $("#guidanceMeta").textContent = state.activeProject ? "右侧对话会结合当前文章和历史上下文。" : "请先创建或选择项目。"
  const action = $("#stageActionButton")
  $("#saveFinalButton").hidden = state.currentStep !== "final"
  action.hidden = !state.activeProject
  const actionText = {
    topic: "确认选题，生成大纲",
    outline: "确认大纲，生成初稿",
    draft: "确认初稿，进入精修",
    refine: state.stageReports.refine ? "确认精修报告，进入事实核查" : "生成精修报告",
    fact: state.stageReports.fact ? "确认核查报告，进入质量评分" : "生成核查报告",
    score: state.qualityScored ? "手动进入终稿" : "开始质量评分",
    final: "手动敲定终稿",
  }
  action.textContent = actionText[state.currentStep] || "继续"

  const copy = {
    topic: "在右侧与 LucidWrite 进行选题交互，最多 3 轮。确认选题后进入大纲框架。",
    outline: "大纲已生成。可直接修改，也可在右侧调整；确认后生成完整初稿。",
    draft: "初稿已生成。你可以直接修改，确认后进入内容精修。",
    refine: "右侧会生成内容精修报告。如需修改，直接在右侧聊天提出要求。",
    fact: "右侧会生成事实核查报告。如需修改，直接在右侧聊天提出要求。",
    score: "对全文质量评分。合格后进入终稿；不合格也可以手动进入终稿。",
    final: "最后微调后保存 final.md，draft.md 继续保留为工作稿。",
  }
  $("#writingPhaseNotice").textContent = copy[state.currentStep] || ""
}

function setCompactLog(message, busy = false) {
  $("#compactLog").innerHTML = message ? `<span class="${busy ? "working" : ""}"></span>${escapeHtml(message)}` : ""
}

function addChat(role, content) {
  state.chat.push({ role, content, step: state.currentStep, time: new Date().toISOString() })
  state.chat = state.chat.slice(-40)
  renderChat()
}

function renderChat() {
  const panel = $("#historyPanel")
  panel.innerHTML = ""
  if (!state.chat.length) {
    panel.innerHTML = `<div class="empty-history">从这里开始对话。LucidWrite 会根据当前流程自动选择采访、写作、分析、核查或评分能力。</div>`
    return
  }
  for (const item of state.chat) {
    const node = document.createElement("article")
    node.className = `side-message ${item.role}`
    node.innerHTML = `<div class="side-message-meta">${item.role === "user" ? "你" : "LucidWrite"} · ${steps.find((step) => step.id === item.step)?.label || ""}</div><div class="side-message-body">${renderMarkdown(item.content)}</div>`
    panel.appendChild(node)
  }
  panel.scrollTop = panel.scrollHeight
}

function buildAttachmentContext() {
  return state.attachments.map((file) => {
    const type = file.type === "directory" ? "Directory" : "Attachment"
    const source = file.source ? ` source="${file.source}"` : ""
    return `<${type} name="${file.name}"${source}>\n${file.content}\n</${type}>`
  }).join("\n\n")
}

function conversationContext() {
  return state.chat.slice(-16).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.content.length > 6000 ? `${message.content.slice(0, 6000)}\n\n[内容过长，已截断]` : message.content,
  }))
}

// 所有步骤共用的输出格式规则（放在 prompt 末尾，确保 AI 最后看到）
const OUTPUT_FORMAT = `

【输出格式——必须严格执行】
你的回复只能包含以下两种节，不允许在节外写任何内容：

## 对话回复
（写你的解释、分析、建议。不能包含文章正文。）

## 文章草稿
（写完整的修改后文章正文。必须是完整文章，不能只写改动部分。不能混入任何说明性文字。）

规则：
1. 只要本轮对文章做了任何修改，必须输出 ## 文章草稿，且内容是修改后的完整文章。
2. 如果本轮没有修改文章，省略 ## 文章草稿 节。
3. 永远不要把文章内容写在 ## 对话回复 里。
4. 永远不要在节标题外写任何内容。`

function promptForStep(userText) {
  const draft = editorMarkdown()
  const style = state.styleFingerprint ? `<Style_Fingerprint>\n${state.styleFingerprint}\n</Style_Fingerprint>` : ""
  const base = [
    `<Current_Step>${currentStep().label}</Current_Step>`,
    `<User_Instruction>\n${userText || "请继续推进当前阶段。"}\n</User_Instruction>`,
    draft ? `<Current_Draft>\n${draft}\n</Current_Draft>` : "",
    style,
    buildAttachmentContext(),
  ].filter(Boolean).join("\n\n")

  if (state.currentStep === "topic") {
    return `${base}\n\n进行选题交互，最多 3 轮，问题必须结合上下文，不要重复。若信息足够，给出明确选题结论。${OUTPUT_FORMAT}`
  }
  if (state.currentStep === "outline") {
    return `${base}\n\n生成或修改可编辑大纲。大纲内容放在 ## 文章草稿 节返回。${OUTPUT_FORMAT}`
  }
  if (state.currentStep === "draft") {
    return `${base}\n\n根据用户指令生成或修改初稿并润色。修改后的完整文章必须放在 ## 文章草稿 节返回。${OUTPUT_FORMAT}`
  }
  if (state.currentStep === "refine") {
    return `${base}\n\n根据用户指令对文章进行内容精修。若修改了文章，把完整修改后文章放在 ## 文章草稿 节。若只是提供分析建议而不改文章，把分析放在 ## 对话回复 节，省略 ## 文章草稿 节。${OUTPUT_FORMAT}`
  }
  if (state.currentStep === "fact") {
    return `${base}\n\n根据用户指令对文章做事实核查或修正。若修改了文章，把完整修改后文章放在 ## 文章草稿 节。若只是提供核查报告，把报告放在 ## 对话回复 节，省略 ## 文章草稿 节。${OUTPUT_FORMAT}`
  }
  if (state.currentStep === "score") {
    return `${base}\n\n对全文进行质量评分，不修改文章。评分结果放在 ## 对话回复 节，省略 ## 文章草稿 节。${OUTPUT_FORMAT}`
  }
  return `${base}\n\n协助用户完成终稿微调。若修改了文章，把完整修改后文章放在 ## 文章草稿 节。${OUTPUT_FORMAT}`
}

function modeForStep() {
  return currentStep().mode
}

function modeForTask(reason, userText = "") {
  if (reason === "chat" && shouldModifyDocument(userText)) return "edit"
  if (reason !== "stage") return modeForStep()
  const stageModes = {
    topic: "pipeline",
    outline: "write",
    draft: "analyze",
    refine: "analyze",
    fact: "fact-check",
    score: "super-workflow",
    final: "edit",
  }
  return stageModes[state.currentStep] || modeForStep()
}

function shouldModifyDocument(userText) {
  return /修改|改写|润色|优化|调整|重写|精简|扩写|直接改|应用|改一下|改改|改掉|帮我改|改成|更新|替换|删除|加上|增加|补充|修正|完善|重新写|换一种|换个/.test(userText)
}

function stagePrompt() {
  const text = {
    topic: "用户已确认选题，请基于选题交互结论生成大纲框架。",
    outline: "用户已确认大纲，请基于当前大纲生成完整初稿，并进行基础编辑润色。",
    draft: "用户已确认初稿，请进入内容精修阶段，生成精修报告，不要给勾选项。",
    refine: "请基于当前文章生成内容精修报告，不要给勾选项。用户如需修改，会通过右侧聊天继续说明。",
    fact: "请对当前文章进行事实核查，生成核查报告，不要给勾选项。用户如需修改，会通过右侧聊天继续说明。",
    score: "请使用 super-workflow 对当前文章进行质量评分，判断合格或不合格，并给出评分依据。",
    final: "用户选择手动敲定终稿，请保持当前文章内容准备保存为 final.md。",
  }
  return text[state.currentStep] || "请继续推进当前阶段。"
}

function promptForStageTask(userText) {
  const draft = editorMarkdown()
  const style = state.styleFingerprint ? `<Style_Fingerprint>\n${state.styleFingerprint}\n</Style_Fingerprint>` : ""
  const base = [
    `<Current_Step>${currentStep().label}</Current_Step>`,
    `<Stage_Action>\n${userText || stagePrompt()}\n</Stage_Action>`,
    draft ? `<Current_Draft>\n${draft}\n</Current_Draft>` : "",
    style,
    buildAttachmentContext(),
  ].filter(Boolean).join("\n\n")

  if (state.currentStep === "topic") {
    return `${base}\n\n运行 nt pipeline 的大纲框架阶段。根据已确认选题生成可编辑大纲。必须返回：\n## 对话回复\n说明大纲生成完成。\n## 文章草稿\n完整大纲。`
  }
  if (state.currentStep === "outline") {
    return `${base}\n\n运行 nt write 或 pipeline approve 逻辑。基于用户修改后的大纲生成一篇完整初稿，并用 Editor agent 做基础润色。注意：正文必须是一篇完整文章，不是提纲、摘要或说明。必须返回：\n## 对话回复\n说明初稿生成完成。\n## 文章草稿\n完整初稿正文，只包含文章本体。`
  }
  if (state.currentStep === "draft" || state.currentStep === "refine") {
    return `${base}\n\n运行 nt analyze。生成内容精修报告，不要输出勾选项。本次为阶段推进，只给分析报告，不修改正文。必须返回：\n## 对话回复\n说明分析重点。\n## 精修报告\n结构、表达、逻辑、读者价值、风格一致性的详细分析，并给出自然语言修改方向。`
  }
  if (state.currentStep === "fact") {
    return `${base}\n\n运行 nt fact-check。生成事实核查报告，不要输出勾选项。本次为阶段推进，只给核查报告，不修改正文。必须返回：\n## 对话回复\n说明核查重点。\n## 核查报告\n逐条列出事实、风险、可信度、需要补充的来源或更正方向。`
  }
  if (state.currentStep === "score") {
    return `${base}\n\n使用 super-workflow 对全文质量评分。必须返回：\n## 对话回复\n给出是否合格。\n## 质量评分\n总分、分项评分、合格/不合格、原因、改进方向。\n不要返回文章草稿，不要改正文。`
  }
  return `${base}\n\n终稿敲定阶段，返回完整终稿。`
}

function reportFromOutput(output) {
  const sections = [
    ["对话回复", getSection(output, "对话回复")],
    ["精修报告", getSection(output, "精修报告")],
    ["核查报告", getSection(output, "核查报告") || getSection(output, "事实核查报告")],
    ["质量评分", getSection(output, "质量评分") || getSection(output, "评分报告")],
    ["分析建议", getSection(output, "分析建议")],
    ["采访启发", getSection(output, "采访启发")],
  ].filter(([, content]) => content)

  if (sections.length) {
    return sections.map(([heading, content]) => `## ${heading}\n${content}`).join("\n\n")
  }
  return output
}

async function runStepTask(userText, reason = "chat", promptOverride = "") {
  if (!state.activeProject || state.busy || !userText.trim()) return false
  setBusy(true)
  const epoch = state.projectEpoch
  const project = state.activeProject
  const taskId = crypto.randomUUID()
  // Capture before awaiting the request, so edits made in flight remain protected.
  const pending = {
    project, userId: state.session?.user?.id, draft: editorMarkdown(), editVersion: state.draftVersion,
    reason, step: state.currentStep,
    mayModifyDocument: reason === "stage" ? ["topic", "outline"].includes(state.currentStep) : state.currentStep !== "score",
  }
  const conversation = conversationContext()
  const message = promptOverride || (reason === "stage" ? promptForStageTask(userText) : promptForStep(userText))
  const taskMode = modeForTask(reason, userText)
  state.pendingTasks[taskId] = pending
  addChat("user", userText)
  cacheProject()
  setCompactLog(currentStep().label + "处理中...", true)
  const sentAttachments = [...state.attachments]
  try {
    const response = await apiFetch("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: taskId, mode: taskMode, message, context: buildAttachmentContext(), conversation,
        projectPath: project, request: pending,
        searchQuery: pending.step === "fact" ? pending.draft.split("\n").find(line => line.trim())?.replace(/^#+\s*/, "").slice(0, 300) : "",
      }),
    })
    const data = await checkedData(response)
    if (!data.task?.id) throw new Error("服务器未返回有效任务")
    if (epoch !== state.projectEpoch || state.session?.user?.id !== pending.userId) return false
    if (data.task.id !== taskId) {
      delete state.pendingTasks[taskId]
      state.pendingTasks[data.task.id] = pending
    }
    if ($("#promptInput").value.trim() === userText.trim()) $("#promptInput").value = ""
    state.attachments = state.attachments.filter(file => !sentAttachments.includes(file))
    renderAttachments()
    closeMentionMenu()
    await renderTask(data.task)
    if (["queued", "running"].includes(data.task.status)) startPolling(data.task.id)
    return data.task.status !== "failed"
  } catch (error) {
    if (epoch === state.projectEpoch) {
      addChat("assistant", error.message || "任务启动失败")
      handleError(error)
      cacheProject()
    }
    delete state.pendingTasks[taskId]
    return false
  } finally {
    if (epoch === state.projectEpoch && !state.pollTimer) setBusy(false)
  }
}

async function runStageTask() {
  if (!state.activeProject || !await saveDraft()) return false
  if (state.currentStep === "final") return saveFinal()
  return runStepTask(stagePrompt(), "stage")
}

function startPolling(id) {
  stopPolling()
  const epoch = state.projectEpoch
  let failures = 0
  const poll = async () => {
    if (epoch !== state.projectEpoch || !state.pendingTasks[id]) return
    try {
      const response = await apiFetch("/api/tasks/" + encodeURIComponent(id))
      if (response.status === 404) throw new Error("任务不存在，请重试")
      const data = await checkedData(response)
      if (epoch !== state.projectEpoch) return
      failures = 0
      await renderTask(data.task)
    } catch (error) {
      failures++
      if (failures >= 5) {
        stopPolling()
        setBusy(false)
        handleError(error)
        return
      }
    }
    if (epoch === state.projectEpoch && state.pendingTasks[id]) state.pollTimer = setTimeout(poll, 1500)
  }
  state.pollTimer = setTimeout(poll, 1000)
}
function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer)
  state.pollTimer = null
}

async function renderTask(task) {
  const pending = state.pendingTasks[task.id]
  if (!pending || pending.project !== state.activeProject || (task.projectPath && task.projectPath !== state.activeProject) ||
      (pending.userId && pending.userId !== state.session?.user?.id)) return
  if (["queued", "running"].includes(task.status)) {
    setCompactLog((task.label || "AI") + " 正在工作...", true)
    return
  }
  stopPolling()
  delete state.pendingTasks[task.id]
  if (state.appliedTasks.includes(task.id)) { setBusy(false); return }
  state.appliedTasks.push(task.id)
  if (task.status !== "completed" || !task.output?.trim()) {
    addChat("assistant", task.error || "任务未生成内容，请重试")
    setCompactLog(task.error || "任务未生成内容，请重试")
    cacheProject()
    setBusy(false)
    return
  }
  const output = task.output
  const reply = reportFromOutput(output)
  // Use explicit article sections only: reports must never become an article.
  const draft = normalizeMarkdown(getSection(output, "文章草稿") || getSection(output, "完整初稿") || getSection(output, "初稿") || getSection(output, "完整大纲"))
  const unchanged = pending.editVersion === state.draftVersion && (!pending.draft || pending.draft === editorMarkdown())
  const sameStage = pending.step === state.currentStep
  const needsArticle = pending.reason === "stage" && ["topic", "outline"].includes(pending.step)
  let applied = false
  addChat("assistant", reply)
  if (draft && pending.mayModifyDocument && unchanged) {
    setDraftMarkdown(draft)
    invalidateReports()
    applied = true
  } else if (draft && pending.mayModifyDocument) {
    addChat("assistant", "生成时正文已发生变化，保留你的编辑。以下是本轮生成稿，供你复制或比较：\n\n```markdown\n" + draft + "\n```")
    setCompactLog("已保留你的编辑；生成稿在右侧，未自动覆盖。")
  }
  if (needsArticle && !applied) {
    if (!draft) setCompactLog("没有识别到完整正文，当前阶段保持不变，请重试。")
    cacheProject()
    setBusy(false)
    return
  }
  const appliedVersion = state.draftVersion
  if (applied && !await saveDraft()) { setBusy(false); return }
  if (applied && appliedVersion !== state.draftVersion) {
    setCompactLog("保存期间正文有新编辑，阶段保持不变，请确认后继续。")
    setBusy(false)
    return
  }
  if (pending.reason === "stage" && sameStage && unchanged) {
    if (needsArticle) {
      state.completedSteps.add(pending.step)
      state.currentStep = steps[steps.findIndex(step => step.id === pending.step) + 1].id
    } else if (["refine", "fact"].includes(pending.step)) {
      state.stageReports[pending.step] = true
    } else if (pending.step === "score") {
      state.qualityScored = true
      if (/(?:^|\n)\s*(?:\*\*)?总评\s*[:：]\s*(?:\*\*)?合格(?:\s|[。！.!]|\*\*|$)/.test(output)) {
        state.completedSteps.add("score")
        state.currentStep = "final"
      }
    }
  }
  if (pending.reason === "chat" && pending.step === "topic") state.topicRounds += 1
  renderProcessSteps()
  renderStage()
  try { await persistProgress() } catch (error) { handleError(error); setBusy(false); return }
  if (!draft || applied) setCompactLog(applied ? "正文已更新并保存。" : "本轮已完成。")
  setBusy(false)
}

async function saveDraft() {
  if (!state.draftPath || !state.session) return false
  clearTimeout(state.autosaveTimer)
  cacheProject()
  const snapshot = {
    path: state.draftPath, content: editorMarkdown(), project: state.activeProject,
    version: state.draftVersion, epoch: state.projectEpoch, userId: state.session.user?.id,
    workflow: workflowState(), cloud: state.cloud,
  }
  const save = async () => {
    if (state.session?.user?.id !== snapshot.userId) return false
    try {
      const data = await checkedData(await apiFetch("/api/files", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: snapshot.path, content: snapshot.content, expectedUpdatedAt: snapshot.cloud && snapshot.epoch === state.projectEpoch ? state.savedUpdatedAt : undefined }),
      }))
      if (snapshot.epoch === state.projectEpoch) {
        state.savedUpdatedAt = data.updatedAt
        state.saveConflict = false
      }
      if (snapshot.cloud) await checkedData(await apiFetch("/api/project-state", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: snapshot.project, state: snapshot.workflow }),
      }))
      if (snapshot.epoch === state.projectEpoch) {
        state.savedVersion = snapshot.version
        state.savedContent = snapshot.content
        state.savedUpdatedAt = data.updatedAt
        cacheProject()
        setCompactLog(state.draftVersion === snapshot.version ? "已保存到 " + (data.path || snapshot.path) : "已保存上一版本，正在保存新编辑…")
      }
      return true
    } catch (error) {
      if (snapshot.epoch === state.projectEpoch) {
        if (error.status === 409) state.saveConflict = true
        handleError(error)
      }
      return false
    }
  }
  state.saveQueue = state.saveQueue.then(save, save)
  return state.saveQueue
}

async function saveFinal() {
  if (!state.activeProject || !await saveDraft()) return false
  const content = editorMarkdown()
  if (isDraftEmpty(content)) { setCompactLog("终稿内容为空，请先完成正文。"); return false }
  const epoch = state.projectEpoch
  try {
    const data = await checkedData(await apiFetch("/api/files", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: state.activeProject + "/final.md", content }),
    }))
    if (epoch !== state.projectEpoch) return false
    state.completedSteps.add("final")
    await persistProgress()
    renderProcessSteps()
    await renderFileTree()
    setCompactLog("终稿已保存到 " + data.path)
    return true
  } catch (error) { handleError(error); return false }
}

async function advanceStage() {
  if (!state.activeProject || state.busy || state.advancing) return
  state.advancing = true
  setBusy(state.busy)
  try {
    if (state.currentStep !== "topic" && isDraftEmpty()) { setCompactLog("请先完成当前正文，再进入下一阶段。"); return }
    if (state.currentStep === "draft" || (["refine", "fact"].includes(state.currentStep) && state.stageReports[state.currentStep]) ||
        (state.currentStep === "score" && state.qualityScored)) {
      if (!await saveDraft()) return
      state.completedSteps.add(state.currentStep)
      state.currentStep = nextStepId()
      await persistProgress()
      renderProcessSteps()
      renderStage()
      return
    }
    await runStageTask()
  } catch (error) { handleError(error) }
  finally { state.advancing = false; setBusy(state.busy) }
}

async function loadStyleFingerprint() {
  const response = await apiFetch("/api/style-fingerprint")
  const data = await checkedData(response)
  state.styleFingerprint = data.content || ""
  if (!data.configured && !data.skipped) $("#styleDialog").showModal()
}

async function saveStyleFingerprint(event) {
  event.preventDefault()
  const source = $("#styleSourceInput").value.trim()
  if (!source) {
    $("#styleState").textContent = "请先粘贴历史文章，或选择跳过。"
    return
  }
  $("#styleState").textContent = "正在生成风格指纹..."
  const content = `# 用户风格指纹\n\n## 样本文本摘要\n\n以下内容来自用户导入的历史文章，将作为后续写作风格参考。\n\n## 风格样本\n\n${source}`
  const response = await apiFetch("/api/style-fingerprint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
  const data = await response.json()
  if (!response.ok) {
    $("#styleState").textContent = data.error || "保存失败"
    return
  }
  state.styleFingerprint = content
  $("#styleDialog").close()
}

async function skipStyleFingerprint(event) {
  event.preventDefault()
  try {
    await checkedData(await apiFetch("/api/style-fingerprint", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ skipped: true }),
    }))
    state.styleFingerprint = ""
    $("#styleDialog").close()
  } catch (error) { $("#styleState").textContent = error.message }
}

function showProjectGate(show) {
  $("#projectGate").hidden = !show
  $("#writingStage").hidden = show
}

async function loadWorkspace() {
  const data = await checkedData(await apiFetch("/api/workspace"))
  state.cloud = data.mode === "cloud"
  state.workspaceRoot = data.rootDirectory
  state.notesRoot = data.notesDirectory
  $("#currentPath").textContent = data.notesDirectory
  $("#chooseWorkspace").textContent = state.cloud ? "切换 / 创建项目" : "选择工作目录"
  if (state.cloud) $("#projectGate .project-card > p:not(.eyebrow)").textContent = "文章和进度保存在你的云端项目空间，新项目默认生成 draft.md。"
  state.expandedDirs = new Set(["."])
  await renderProjects()
  await renderFileTree()
  await loadStyleFingerprint()
  showProjectGate(!state.activeProject)
}
async function renderProjects() {
  const data = await checkedData(await apiFetch("/api/projects"))
  const list = $("#projectList")
  list.innerHTML = ""
  for (const project of data.projects ?? []) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "project-option"
    button.textContent = project.name
    button.addEventListener("click", safely(() => openProject(project)))
    list.appendChild(button)
  }
}
async function createProject() {
  if (state.projectLoading || state.busy) return
  const name = $("#projectNameInput").value.trim()
  $("#projectError").textContent = ""
  if (!name || name.length > 120 || /^[.]{1,2}$/.test(name) || /[/\\:\x00-\x1f]/.test(name)) {
    $("#projectError").textContent = "请输入有效项目名（不含 /、\\、:，最多 120 字）。"
    return
  }
  const button = $("#createProjectButton")
  button.disabled = true
  state.projectLoading = true
  try {
    const data = await checkedData(await apiFetch("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
    }))
    $("#projectNameInput").value = ""
    await renderProjects()
    await renderFileTree()
    state.projectLoading = false
    await openProject(data.project)
  } catch (error) { $("#projectError").textContent = error.message || "项目创建失败" }
  finally { button.disabled = false; state.projectLoading = false }
}
async function openProject(project) {
  if (state.busy || state.projectLoading) return false
  state.projectLoading = true
  try {
    if (state.activeProject && !state.saveConflict && !await saveDraft()) return false
    cacheProject()
    const targetPath = project.draftPath || project.name + "/draft.md"
    const data = await checkedData(await apiFetch("/api/file?path=" + encodeURIComponent(targetPath)))
    const progress = state.cloud ? await checkedData(await apiFetch("/api/project-state?projectPath=" + encodeURIComponent(project.name))) : { state: {} }
    clearTimeout(state.autosaveTimer)
    stopPolling()
    state.projectEpoch += 1
    state.activeProject = project.name
    state.draftPath = targetPath
    state.pendingTasks = {}
    clearAttachments()
    closeMentionMenu()
    $("#promptInput").value = ""
    let cached = null
    try { cached = JSON.parse(localStorage.getItem(projectStorageKey()) || "null") } catch {}
    restoreWorkflow(state.cloud ? progress.state : cached?.workflow)
    setDraftMarkdown(data.content)
    state.savedContent = data.content
    state.savedUpdatedAt = data.updatedAt
    state.saveConflict = false
    state.savedVersion = state.draftVersion
    state.recoveryDrafts = Array.isArray(cached?.recoveryDrafts) ? cached.recoveryDrafts : []
    if (cached?.unsaved && typeof cached.content === "string") {
      if (cached.baseContent === data.content) {
        setDraftMarkdown(cached.content)
        restoreWorkflow(cached.workflow)
        setCompactLog("已恢复上次未保存的编辑，正在保存。")
        scheduleAutosave()
      } else if (cached.content !== data.content) {
        if (!state.recoveryDrafts.includes(cached.content)) state.recoveryDrafts.push(cached.content)
        setCompactLog("云端正文已有更新，本机恢复副本保留在右侧。")
      }
    }
    for (const content of state.recoveryDrafts) {
      if (!state.chat.some(turn => turn.content.includes(content))) addChat("assistant", "本机恢复副本（当前显示云端版本，可复制下文恢复）：\n\n```markdown\n" + content + "\n```")
    }
    $("#activeProjectName").textContent = project.name
    showProjectGate(false)
    renderProcessSteps()
    renderStage()
    renderChat()
    cacheProject()
    if (state.cloud) await recoverTasks()
    return true
  } catch (error) { handleError(error); return false }
  finally { state.projectLoading = false }
}
async function recoverTasks() {
  const epoch = state.projectEpoch
  const data = await checkedData(await apiFetch("/api/tasks?projectPath=" + encodeURIComponent(state.activeProject)))
  if (epoch !== state.projectEpoch) return
  for (const task of [...(data.tasks || [])].reverse()) {
    if (state.appliedTasks.includes(task.id) || !task.request?.project || task.request.project !== state.activeProject) continue
    if (task.request.userId !== state.session?.user?.id) continue
    const pending = { ...task.request }
    pending.editVersion = pending.draft === editorMarkdown() ? state.draftVersion : -1
    state.pendingTasks[task.id] = pending
    if (["queued", "running"].includes(task.status)) {
      setBusy(true)
      startPolling(task.id)
      break
    }
    await renderTask(task)
  }
}

async function fetchFiles(dir = ".") {
  const response = await apiFetch(`/api/files?dir=${encodeURIComponent(dir)}`)
  return await checkedData(response)
}

async function renderFileTree() {
  const epoch = state.projectEpoch
  const node = await buildTreeNode(".", state.cloud ? "云端项目" : "lucidwrite_note", 0)
  if (epoch !== state.projectEpoch) return
  $("#fileTree").replaceChildren(node)
  $("#currentPath").textContent = state.notesRoot || state.workspaceRoot
}

async function buildTreeNode(dir, label, depth) {
  const container = document.createElement("div")
  container.className = "tree-group"
  const expanded = state.expandedDirs.has(dir)
  container.appendChild(createTreeRow({ name: label, path: dir, type: "directory", depth, expanded }))
  if (!expanded) return container
  const data = await fetchFiles(dir)
  for (const file of data.files ?? []) {
    container.appendChild(file.type === "directory" ? await buildTreeNode(file.path, file.name, depth + 1) : createTreeRow({ ...file, depth: depth + 1 }))
  }
  return container
}

function createTreeRow(file) {
  const button = document.createElement("button")
  button.className = "tree-item"
  button.style.setProperty("--depth", String(file.depth ?? 0))
  button.innerHTML = `<span class="tree-caret"></span><span class="file-name"></span><span class="file-kind"></span>`
  button.querySelector(".tree-caret").textContent = file.type === "directory" ? (file.expanded ? "▾" : "▸") : ""
  button.querySelector(".file-name").textContent = file.name
  button.querySelector(".file-kind").textContent = file.type === "directory" ? "目录" : "MD"
  button.onclick = safely(async () => {
    if (file.type === "directory") {
      state.expandedDirs.has(file.path) ? state.expandedDirs.delete(file.path) : state.expandedDirs.add(file.path)
      await renderFileTree()
    } else {
      await attachWorkspaceFile(file.path)
    }
  })
  return button
}

async function attachWorkspaceFile(path) {
  const epoch = state.projectEpoch
  const userId = state.session?.user?.id
  const response = await apiFetch(`/api/reference?path=${encodeURIComponent(path)}`)
  const data = await checkedData(response)
  if (epoch !== state.projectEpoch || userId !== state.session?.user?.id) return false
  addAttachment({ name: data.name || data.path.split("/").pop(), content: data.content, source: data.path, type: data.type })
  return true
}

function addAttachment(file) {
  const key = file.source || `${file.name}:${file.content.length}`
  if (state.attachments.some((item) => (item.source || `${item.name}:${item.content.length}`) === key)) return
  state.attachments.push(file)
  renderAttachments()
}

function clearAttachments() {
  state.attachments = []
  renderAttachments()
}

function renderAttachments() {
  attachmentTray.innerHTML = ""
  attachmentTray.classList.toggle("has-attachments", state.attachments.length > 0)
  state.attachments.forEach((file, index) => {
    const chip = document.createElement("button")
    chip.className = "attachment-chip"
    chip.type = "button"
    chip.innerHTML = `<span class="file-icon">${file.type === "directory" ? "DIR" : "MD"}</span><span>${escapeHtml(file.name)}</span><span class="chip-remove" aria-hidden="true"><svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`
    chip.addEventListener("click", () => {
      state.attachments.splice(index, 1)
      renderAttachments()
    })
    attachmentTray.appendChild(chip)
  })
}

function getMentionTrigger(text, cursor) {
  const beforeCursor = text.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  return match ? { start: beforeCursor.length - match[2].length - 1, query: match[2] } : null
}

async function updateMentionMenu() {
  const input = $("#promptInput")
  const requestVersion = ++state.mentionVersion
  const trigger = getMentionTrigger(input.value, input.selectionStart)
  if (!trigger) return closeMentionMenu()
  state.mention = { ...state.mention, open: true, query: trigger.query, start: trigger.start, activeIndex: 0 }
  const response = await apiFetch(`/api/references?q=${encodeURIComponent(trigger.query)}`)
  const data = await response.json()
  if (requestVersion !== state.mentionVersion || !state.mention.open) return
  state.mention.items = response.ok ? data.references ?? [] : []
  renderMentionMenu()
}

function renderMentionMenu() {
  mentionMenu.innerHTML = ""
  if (!state.mention.open || !state.mention.items.length) {
    mentionMenu.hidden = true
    return
  }
  mentionMenu.hidden = false
  state.mention.items.slice(0, 10).forEach((item, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "mention-option"
    button.innerHTML = `<span class="file-icon">${item.type === "directory" ? "DIR" : "MD"}</span><span class="mention-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.path)}</small></span>`
    button.addEventListener("mousedown", safely((event) => {
      event.preventDefault()
      return selectMention(index)
    }))
    mentionMenu.appendChild(button)
  })
}

function closeMentionMenu() {
  state.mentionVersion += 1
  state.mention.open = false
  state.mention.items = []
  mentionMenu.hidden = true
}

async function selectMention(index = state.mention.activeIndex) {
  const item = state.mention.items[index]
  if (!item) return
  const input = $("#promptInput")
  const originalText = input.value
  const requestVersion = state.mentionVersion
  if (!await attachWorkspaceFile(item.path) || requestVersion !== state.mentionVersion || input.value !== originalText) return
  const before = input.value.slice(0, state.mention.start)
  const after = input.value.slice(input.selectionStart)
  const label = `@${item.path} `
  input.value = `${before}${label}${after}`
  input.focus()
  input.setSelectionRange(before.length + label.length, before.length + label.length)
  closeMentionMenu()
}

async function handleDroppedFiles(event) {
  event.preventDefault()
  composerDropzone.classList.remove("dragging")
  for (const file of [...(event.dataTransfer?.files || [])]) {
    if (!file.name.endsWith(".md") && !file.type.startsWith("text/")) continue
    addAttachment({ name: file.name, content: await file.text(), source: `drag-drop:${file.name}:${file.size}:${file.lastModified}`, type: "markdown" })
  }
}

async function openDirectoryChooser(path = state.workspaceRoot) {
  if (state.cloud) {
    if (state.busy || (state.activeProject && !state.saveConflict && !await saveDraft())) return
    clearTimeout(state.autosaveTimer)
    cacheProject()
    state.projectEpoch += 1
    state.activeProject = null
    state.draftPath = ""
    state.chat = []
    state.currentStep = "topic"
    state.completedSteps = new Set()
    clearAttachments()
    closeMentionMenu()
    setDraftMarkdown("")
    await renderProjects()
    showProjectGate(true)
    renderStage()
    renderChat()
    renderProcessSteps()
    return
  }
  if (await loadDirectoryChooser(path)) $("#directoryDialog").showModal()
}

async function loadDirectoryChooser(path) {
  const response = await apiFetch(`/api/directories?path=${encodeURIComponent(path)}`)
  const data = await response.json()
  if (!response.ok) { setCompactLog(data.error || "目录读取失败"); return false }
  state.directoryPickerPath = data.current
  $("#directoryCurrent").textContent = data.current
  $("#directoryList").innerHTML = ""
  for (const dir of data.directories ?? []) {
    const button = document.createElement("button")
    button.className = "directory-option"
    button.type = "button"
    button.textContent = dir.name
    button.addEventListener("click", () => loadDirectoryChooser(dir.path))
    $("#directoryList").appendChild(button)
  }
  $("#directoryHome").onclick = (event) => {
    event.preventDefault()
    loadDirectoryChooser(data.home)
  }
  $("#directoryUp").onclick = (event) => {
    event.preventDefault()
    safely(loadDirectoryChooser)(data.parent)
  }
  return true
}

async function switchWorkspace() {
  if (state.busy || (state.activeProject && !await saveDraft())) return
  state.projectEpoch += 1
  const response = await apiFetch("/api/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.directoryPickerPath }),
  })
  const data = await response.json()
  if (!response.ok) return setCompactLog(data.error || "工作目录切换失败")
  state.workspaceRoot = data.rootDirectory
  state.notesRoot = data.notesDirectory
  state.activeProject = null
  state.expandedDirs = new Set(["."])
  $("#directoryDialog").close()
  await loadWorkspace()
}

async function openSettings() {
  $("#settingsDialog").showModal()
  $("#settingsState").textContent = "正在读取设置…"
  try {
    const data = await checkedData(await apiFetch("/api/settings"))
    $("#settingsState").textContent = Object.entries(data.providers || {}).filter(([, value]) => value.configured).map(([name]) => name).join(", ") || "尚未配置 API Key"
    $("#defaultModel").value = data.defaultModel || ""
    for (const input of $("#settingsDialog").querySelectorAll('input[type="password"]')) input.value = ""
  } catch (error) { $("#settingsState").textContent = error.message }
}
async function saveSettings(event) {
  event.preventDefault()
  const button = $("#saveSettings")
  if (button.disabled) return
  button.disabled = true
  $("#settingsState").textContent = "正在保存…"
  try {
    const data = await checkedData(await apiFetch("/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: Object.fromEntries(["deepseek", "openai", "anthropic", "google", "tavily", "firecrawl"].map(name => [name, $("#" + name + "Key").value])),
        defaultModel: $("#defaultModel").value,
      }),
    }))
    $("#settingsState").textContent = "已保存到 " + data.settingsPath
    for (const input of $("#settingsDialog").querySelectorAll('input[type="password"]')) input.value = ""
  } catch (error) { $("#settingsState").textContent = error.message || "保存失败" }
  finally { button.disabled = false }
}

$("#createProjectButton").addEventListener("click", safely(createProject))
$("#projectNameInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) safely(createProject)()
})
$("#sendButton").addEventListener("click", safely(() => runStepTask($("#promptInput").value.trim())))
$("#stageActionButton").addEventListener("click", safely(advanceStage))
$("#saveDraftButton").addEventListener("click", safely(saveDraft))
$("#saveFinalButton").addEventListener("click", safely(saveFinal))
$("#refreshFiles").addEventListener("click", safely(renderFileTree))
$("#chooseWorkspace").addEventListener("click", safely(() => openDirectoryChooser()))
$("#useDirectory").addEventListener("click", (event) => {
  event.preventDefault()
  safely(switchWorkspace)()
})
$("#settingsButton").addEventListener("click", safely(openSettings))
$("#saveSettings").addEventListener("click", safely(saveSettings))
$("#saveStyleButton").addEventListener("click", safely(saveStyleFingerprint))
$("#skipStyleButton").addEventListener("click", safely(skipStyleFingerprint))
$("#toggleLeftPane").addEventListener("click", () => appShell.classList.toggle("left-collapsed"))
$("#toggleRightPane").addEventListener("click", () => appShell.classList.toggle("right-collapsed"))
document.querySelectorAll(".process-step").forEach((button) => button.addEventListener("click", safely(() => setStep(button.dataset.step))))
$("#promptInput").addEventListener("input", safely(updateMentionMenu))
$("#promptInput").addEventListener("click", safely(updateMentionMenu))
$("#promptInput").addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === "Escape") { closeMentionMenu(); return }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    state.mention.open && state.mention.items.length ? safely(selectMention)() : safely(runStepTask)($("#promptInput").value.trim())
  }
})
draftEditor.addEventListener("input", () => {
  state.draftVersion += 1
  state.editorDirty = true
  invalidateReports()
  cacheProject()
  scheduleAutosave()
  renderStage()
})
window.addEventListener("dragover", (event) => {
  event.preventDefault()
  composerDropzone.classList.add("dragging")
})
window.addEventListener("dragleave", () => composerDropzone.classList.remove("dragging"))
window.addEventListener("drop", safely(handleDroppedFiles))

// ── Auth ──────────────────────────────────────────────────────────────────────

// ── Session storage (localStorage, no SDK needed) ─────────────────────────

const SESSION_KEY = "lucidwrite_session"

function saveSession(session) {
  state.session = session
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    state.session = session
  } else {
    localStorage.removeItem(SESSION_KEY)
    state.session = null
  }
}

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// ── Auth UI ────────────────────────────────────────────────────────────────

function showAuthGate() {
  $("#authGate").hidden = false
  $(".app-shell").hidden = true
}

function hideAuthGate() {
  $("#authGate").hidden = true
  $(".app-shell").hidden = false
  const emailEl = $("#userEmail")
  if (emailEl) emailEl.textContent = state.session?.user?.email ?? ""
}

async function loginUser(event) {
  event?.preventDefault()
  const email = $("#loginEmail").value.trim()
  const password = $("#loginPassword").value
  const errEl = $("#loginError")
  errEl.textContent = ""
  errEl.style.color = ""
  if (!email || !password) { errEl.textContent = "请填写邮箱和密码"; return }
  const btn = $("#loginButton")
  if (btn.disabled) return
  btn.disabled = true
  btn.textContent = "登录中…"
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) { errEl.textContent = data.error || "登录失败"; return }
    resetWorkspace()
    saveSession(data)
    hideAuthGate()
    await loadWorkspace()
  } catch (e) {
    errEl.textContent = e?.message || "登录失败，请重试"
  } finally {
    btn.disabled = false
    btn.textContent = "登录"
  }
}

async function registerUser(event) {
  event?.preventDefault()
  const email = $("#registerEmail").value.trim()
  const password = $("#registerPassword").value
  const errEl = $("#registerError")
  errEl.textContent = ""
  errEl.style.color = ""
  if (!email || !password) { errEl.textContent = "请填写邮箱和密码"; return }
  if (password.length < 6) { errEl.textContent = "密码至少需要 6 位"; return }
  const btn = $("#registerButton")
  if (btn.disabled) return
  btn.disabled = true
  btn.textContent = "注册中…"
  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) { errEl.textContent = data.error || "注册失败"; return }
    if (data.access_token) {
      resetWorkspace()
      saveSession(data)
      hideAuthGate()
      await loadWorkspace()
    } else {
      errEl.textContent = data.message || "注册成功！请查收确认邮件，点击链接后登录。"
      errEl.style.color = "var(--lp-text-strong)"
      $("#registerPassword").value = ""
    }
  } catch (e) {
    errEl.textContent = e?.message || "注册失败，请重试"
  } finally {
    btn.disabled = false
    btn.textContent = "注册"
  }
}

function resetWorkspace() {
  clearTimeout(state.autosaveTimer)
  stopPolling()
  state.projectEpoch += 1
  state.pendingTasks = {}
  state.activeProject = null
  state.draftPath = ""
  state.styleFingerprint = ""
  state.saveConflict = false
  state.recoveryDrafts = []
  state.savedUpdatedAt = undefined
  state.chat = []
  state.completedSteps = new Set()
  state.currentStep = "topic"
  state.topicRounds = 0
  state.stageReports = {}
  state.qualityScored = false
  state.appliedTasks = []
  state.advancing = false
  setBusy(false)
  clearAttachments()
  closeMentionMenu()
  setDraftMarkdown("")
  $("#promptInput").value = ""
  $("#projectList").innerHTML = ""
  $("#fileTree").innerHTML = ""
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close()
  for (const input of document.querySelectorAll('input[type="password"]')) input.value = ""
  $("#styleSourceInput").value = ""
  renderChat()
}
async function logout() {
  if (state.activeProject && state.savedVersion !== state.draftVersion) await saveDraft()
  cacheProject()
  resetWorkspace()
  saveSession(null)
  showAuthGate()
}

async function initAuth() {
  const callback = new URLSearchParams(window.location.hash.slice(1))
  if (callback.has("error_description")) {
    history.replaceState(null, "", window.location.pathname)
    throw new Error(callback.get("error_description"))
  }
  // 处理邮件确认跳回（URL hash 含 access_token）
  if (window.location.hash.includes("access_token")) {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const access_token = params.get("access_token")
    const refresh_token = params.get("refresh_token")
    if (access_token) {
      history.replaceState(null, "", window.location.pathname)
      // 验证 token 并获取 user 信息
      const meRes = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${access_token}` } })
      if (meRes.ok) {
        const user = await meRes.json()
        saveSession({ access_token, refresh_token, user })
        return true
      }
    }
  }

  // 从 localStorage 恢复 session
  const saved = loadStoredSession()
  if (!saved?.access_token) return false

  // 验证 token 是否仍有效
  const meRes = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${saved.access_token}` } })
  if (meRes.ok) {
    state.session = saved
    return true
  }

  if (meRes.status !== 401) throw new Error("登录验证暂时不可用，请稍后重试")
  // token 失效，尝试 refresh
  if (saved.refresh_token) {
    try {
      const refreshRes = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: saved.refresh_token }),
      })
      if (refreshRes.ok) {
        const newSession = await refreshRes.json()
        saveSession(newSession)
        return true
      }
      if (refreshRes.status !== 401) throw new Error("登录服务暂时不可用，请稍后重试")
    } catch (error) { throw error }
  }

  saveSession(null)
  return false
}

// Auth tab switching
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"))
    tab.classList.add("active")
    const isLogin = tab.dataset.tab === "login"
    $("#loginForm").hidden = !isLogin
    $("#registerForm").hidden = isLogin
  })
})

$("#loginButton")?.addEventListener("click", loginUser)
$("#loginPassword")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) loginUser(e) })
$("#registerButton")?.addEventListener("click", registerUser)
$("#registerPassword")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) registerUser(e) })
$("#logoutButton")?.addEventListener("click", safely(logout))

// ── Bootstrap ─────────────────────────────────────────────────────────────────

renderProcessSteps()
renderStage()
renderChat()

;(async () => {
  try {
    const authenticated = await initAuth()
    if (authenticated) {
      hideAuthGate()
      await loadWorkspace()
    } else {
      showAuthGate()
    }
  } catch (e) {
    const el = $("#authConfigError")
    if (el) el.textContent = `初始化异常：${e?.message || e}`
    showAuthGate()
  }
})()

window.addEventListener("beforeunload", (event) => {
  cacheProject()
  if (state.activeProject && (state.savedVersion !== state.draftVersion || state.busy)) {
    event.preventDefault()
    event.returnValue = ""
  }
})
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.activeProject) {
    cacheProject()
    if (state.savedVersion !== state.draftVersion) saveDraft()
  }
})

$("#settingsDialog form").addEventListener("submit", (event) => {
  if (event.submitter?.value === "close") return
  safely(saveSettings)(event)
})
$("#editStyleButton")?.addEventListener("click", () => {
  $("#settingsDialog").close()
  $("#styleSourceInput").value = state.styleFingerprint
  $("#styleState").textContent = ""
  $("#styleDialog").showModal()
})

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && state.activeProject) {
    event.preventDefault()
    saveDraft()
  }
})
