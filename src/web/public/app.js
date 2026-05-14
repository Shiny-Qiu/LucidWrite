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
  supabase: null,
}

// API fetch wrapper — automatically attaches the auth token
async function apiFetch(url, options = {}) {
  const token = state.session?.access_token
  const headers = { ...options.headers }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(url, { ...options, headers })
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
      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
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

function editorMarkdown() {
  return draftEditor.innerText.trim() || state.lastArticleMarkdown.trim()
}

function setDraftMarkdown(markdown) {
  state.lastArticleMarkdown = stripNonArticleSections(markdown || "")
  draftEditor.innerHTML = renderMarkdown(markdown || "")
  state.draftVersion += 1
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

function setStep(stepId) {
  const targetIndex = steps.findIndex((step) => step.id === stepId)
  const currentIndex = steps.findIndex((step) => step.id === state.currentStep)
  if (targetIndex === -1 || targetIndex !== currentIndex) return
  state.currentStep = stepId
  renderProcessSteps()
  renderStage()
  renderChat()
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
    button.disabled = id !== state.currentStep
    button.setAttribute("aria-disabled", id !== state.currentStep ? "true" : "false")
    button.innerHTML = `${state.completedSteps.has(id) ? "✓ " : ""}${steps.find((step) => step.id === id)?.label || id}`
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
    outline: "点击主按钮会基于已确认选题生成大纲。可直接修改，也可在右侧要求 LucidWrite 协助调整。",
    draft: "点击主按钮会基于确认后的大纲生成初稿。你可以直接修改，确认后进入内容精修。",
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
  if (!state.activeProject) return
  const draft = editorMarkdown()
  addChat("user", userText || "继续推进当前阶段")
  setCompactLog(`${currentStep().label}处理中...`, true)

  const taskMode = modeForTask(reason, userText)
  const taskPrompt = promptOverride || (reason === "stage" ? promptForStageTask(userText) : promptForStep(userText))
  const response = await apiFetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: taskMode,
      message: taskPrompt,
      context: buildAttachmentContext(),
      conversation: conversationContext(),
      projectPath: state.activeProject,
    }),
  })
  const data = await response.json()
  if (!response.ok) {
    setCompactLog(data.error || "任务启动失败")
    addChat("assistant", data.error || "任务启动失败")
    return
  }
  $("#promptInput").value = ""
  clearAttachments()
  // Chat 对话始终允许修改正文——由 AI 决定是否返回 ## 文章草稿，前端负责应用
  const mayModifyDocument = reason === "stage" && ["topic", "outline"].includes(state.currentStep) || reason === "chat"
  state.pendingTasks[data.task.id] = { draft, editVersion: state.draftVersion, reason, step: state.currentStep, mayModifyDocument }
  renderTask(data.task)
  if (data.task.status === "queued" || data.task.status === "running") startPolling(data.task.id)
}

async function runStageTask() {
  if (!state.activeProject) return
  await saveDraft()
  if (state.currentStep === "final") {
    await saveFinal()
    return
  }
  await runStepTask(stagePrompt(), "stage")
}

function startPolling(id) {
  stopPolling()
  state.pollTimer = setInterval(async () => {
    const response = await apiFetch(`/api/tasks/${id}`)
    if (!response.ok) return
    const data = await response.json()
    renderTask(data.task)
  }, 1000)
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer)
  state.pollTimer = null
}

function renderTask(task) {
  if (task.status === "queued" || task.status === "running") {
    setCompactLog(`${task.label} 正在工作...`, true)
    return
  }
  stopPolling()
  const pending = state.pendingTasks[task.id]
  delete state.pendingTasks[task.id]
  if (task.status === "failed") {
    addChat("assistant", task.error || "任务失败")
    setCompactLog(task.error || "任务失败")
    return
  }

  const output = task.output || ""
  const reply = reportFromOutput(output)
  const draft = articleFromOutput(output, pending)
  const canApplyStageDraft = pending?.reason === "stage" && ["topic", "outline"].includes(pending.step)

  // AI 显式在 ## 文章草稿 等节返回了内容 → 无论 mayModifyDocument 都应用
  const hasExplicitArticle = Boolean(
    getSection(output, "文章草稿") || getSection(output, "完整初稿") ||
    getSection(output, "初稿") || getSection(output, "完整大纲")
  )
  const canUpdate = draft && (hasExplicitArticle || pending?.mayModifyDocument)

  if (canUpdate && (pending.editVersion === state.draftVersion || canApplyStageDraft)) {
    setDraftMarkdown(draft)
    setCompactLog("正文已根据本轮任务更新。")
  } else if (canUpdate && pending.editVersion !== state.draftVersion) {
    setCompactLog("已生成修改稿，但检测到你刚刚继续编辑了正文，未自动覆盖。")
  } else if (pending?.reason === "stage" && pending?.step === "outline" && !draft) {
    setCompactLog("初稿生成完成，但没有识别到可写入正文的文章内容。请在右侧继续要求生成完整初稿。")
  }
  addChat("assistant", reply)
  if (pending?.reason === "stage" && !["refine", "fact", "score"].includes(pending.step)) {
    state.completedSteps.add(pending.step)
    state.currentStep = nextStepId()
    renderProcessSteps()
    renderStage()
  }
  if (pending?.reason === "stage" && pending.step === "score") {
    state.qualityScored = true
    renderStage()
  }
  if (pending?.reason === "stage" && ["refine", "fact"].includes(pending.step)) {
    state.stageReports[pending.step] = true
    renderStage()
  }
  const qualityPassed = !/不合格|未通过|不通过/.test(output) && /合格|通过|score\s*[:：]?\s*(?:[8-9]\d|100)/i.test(output)
  if (pending?.reason === "stage" && pending.step === "score" && qualityPassed) {
    state.completedSteps.add("score")
    state.currentStep = "final"
    renderProcessSteps()
    renderStage()
  }
  if (!pending?.mayModifyDocument) setCompactLog("已完成，右侧已给出建议；正文未自动修改。")
}

async function saveDraft() {
  if (!state.draftPath) return
  const response = await apiFetch("/api/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.draftPath, content: editorMarkdown() }),
  })
  const data = await response.json()
  setCompactLog(response.ok ? `已保存到 ${data.path}` : data.error || "保存失败")
  if (response.ok) await renderFileTree()
}

async function saveFinal() {
  if (!state.activeProject) return
  await saveDraft()
  const content = editorMarkdown()
  if (!content.trim()) {
    setCompactLog("终稿内容为空，已阻止保存。请先确认正文内容。")
    return
  }
  const response = await apiFetch("/api/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `${state.activeProject}/final.md`, content }),
  })
  const data = await response.json()
  setCompactLog(response.ok ? `终稿已保存到 ${data.path}` : data.error || "终稿保存失败")
  if (response.ok) {
    state.completedSteps.add("final")
    renderProcessSteps()
    await renderFileTree()
  }
}

async function advanceStage() {
  if (!state.activeProject) return
  if (state.currentStep === "draft") {
    await saveDraft()
    state.completedSteps.add("draft")
    state.currentStep = "refine"
    renderProcessSteps()
    renderStage()
    return
  }
  if (["refine", "fact"].includes(state.currentStep) && state.stageReports[state.currentStep]) {
    await saveDraft()
    state.completedSteps.add(state.currentStep)
    state.currentStep = nextStepId()
    renderProcessSteps()
    renderStage()
    return
  }
  if (state.currentStep === "score" && state.qualityScored) {
    await saveDraft()
    state.completedSteps.add("score")
    state.currentStep = "final"
    renderProcessSteps()
    renderStage()
    return
  }
  await runStageTask()
}

async function loadStyleFingerprint() {
  const response = await apiFetch("/api/style-fingerprint")
  const data = await response.json()
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
  await apiFetch("/api/style-fingerprint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skipped: true }),
  })
  $("#styleDialog").close()
}

function showProjectGate(show) {
  $("#projectGate").hidden = !show
  $("#writingStage").hidden = show
}

async function loadWorkspace() {
  const response = await apiFetch("/api/workspace")
  const data = await response.json()
  state.workspaceRoot = data.rootDirectory
  state.notesRoot = data.notesDirectory
  $("#currentPath").textContent = data.notesDirectory
  state.expandedDirs = new Set(["."])
  await renderProjects()
  await renderFileTree()
  await loadStyleFingerprint()
  showProjectGate(!state.activeProject)
}

async function renderProjects() {
  const response = await apiFetch("/api/projects")
  const data = await response.json()
  const list = $("#projectList")
  list.innerHTML = ""
  for (const project of data.projects ?? []) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "project-option"
    button.textContent = project.name
    button.addEventListener("click", () => openProject(project))
    list.appendChild(button)
  }
}

async function createProject() {
  const name = $("#projectNameInput").value.trim()
  $("#projectError").textContent = ""
  const response = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })
  const data = await response.json()
  if (!response.ok) {
    $("#projectError").textContent = data.error || "项目创建失败"
    return
  }
  await renderProjects()
  await renderFileTree()
  await openProject(data.project)
}

async function openProject(project) {
  state.activeProject = project.name
  state.draftPath = project.draftPath || `${project.path}/draft.md`
  state.completedSteps = new Set()
  state.currentStep = "topic"
  state.chat = []
  state.qualityScored = false
  state.stageReports = {}
  state.lastArticleMarkdown = ""
  $("#activeProjectName").textContent = project.name
  const response = await apiFetch(`/api/file?path=${encodeURIComponent(state.draftPath)}`)
  const data = await response.json()
  setDraftMarkdown(response.ok ? data.content : `# ${project.name}\n\n`)
  showProjectGate(false)
  renderProcessSteps()
  renderStage()
  renderChat()
}

async function fetchFiles(dir = ".") {
  const response = await apiFetch(`/api/files?dir=${encodeURIComponent(dir)}`)
  return await response.json()
}

async function renderFileTree() {
  const tree = $("#fileTree")
  tree.innerHTML = ""
  tree.appendChild(await buildTreeNode(".", "lucidwrite_note", 0))
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
  button.onclick = async () => {
    if (file.type === "directory") {
      state.expandedDirs.has(file.path) ? state.expandedDirs.delete(file.path) : state.expandedDirs.add(file.path)
      await renderFileTree()
    } else {
      await attachWorkspaceFile(file.path)
    }
  }
  return button
}

async function attachWorkspaceFile(path) {
  const response = await apiFetch(`/api/reference?path=${encodeURIComponent(path)}`)
  const data = await response.json()
  if (!response.ok) return setCompactLog(data.error || "文件读取失败")
  addAttachment({ name: data.name || data.path.split("/").pop(), content: data.content, source: data.path, type: data.type })
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
    chip.innerHTML = `<span class="file-icon">${file.type === "directory" ? "DIR" : "MD"}</span><span>${escapeHtml(file.name)}</span><b>×</b>`
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
  const trigger = getMentionTrigger(input.value, input.selectionStart)
  if (!trigger) return closeMentionMenu()
  state.mention = { ...state.mention, open: true, query: trigger.query, start: trigger.start, activeIndex: 0 }
  const response = await apiFetch(`/api/references?q=${encodeURIComponent(trigger.query)}`)
  const data = await response.json()
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
    button.addEventListener("mousedown", (event) => {
      event.preventDefault()
      selectMention(index)
    })
    mentionMenu.appendChild(button)
  })
}

function closeMentionMenu() {
  state.mention.open = false
  state.mention.items = []
  mentionMenu.hidden = true
}

async function selectMention(index = state.mention.activeIndex) {
  const item = state.mention.items[index]
  if (!item) return
  await attachWorkspaceFile(item.path)
  const input = $("#promptInput")
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
  await loadDirectoryChooser(path)
  $("#directoryDialog").showModal()
}

async function loadDirectoryChooser(path) {
  const response = await apiFetch(`/api/directories?path=${encodeURIComponent(path)}`)
  const data = await response.json()
  if (!response.ok) return setCompactLog(data.error || "目录读取失败")
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
    loadDirectoryChooser(data.parent)
  }
}

async function switchWorkspace() {
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
  const response = await apiFetch("/api/settings")
  const data = await response.json()
  $("#settingsState").textContent = Object.entries(data.providers).filter(([, value]) => value.configured).map(([name]) => name).join(", ") || "No keys configured"
  $("#defaultModel").value = data.defaultModel || ""
  $("#settingsDialog").showModal()
}

async function saveSettings(event) {
  event.preventDefault()
  const response = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providers: {
        deepseek: $("#deepseekKey").value,
        openai: $("#openaiKey").value,
        anthropic: $("#anthropicKey").value,
        google: $("#googleKey").value,
        tavily: $("#tavilyKey").value,
        firecrawl: $("#firecrawlKey").value,
      },
      defaultModel: $("#defaultModel").value,
    }),
  })
  const data = await response.json()
  $("#settingsState").textContent = response.ok ? `Saved to ${data.settingsPath}` : "Save failed"
}

$("#createProjectButton").addEventListener("click", createProject)
$("#projectNameInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") createProject()
})
$("#sendButton").addEventListener("click", () => runStepTask($("#promptInput").value.trim()))
$("#stageActionButton").addEventListener("click", advanceStage)
$("#saveDraftButton").addEventListener("click", saveDraft)
$("#saveFinalButton").addEventListener("click", saveFinal)
$("#refreshFiles").addEventListener("click", renderFileTree)
$("#chooseWorkspace").addEventListener("click", () => openDirectoryChooser())
$("#useDirectory").addEventListener("click", (event) => {
  event.preventDefault()
  switchWorkspace()
})
$("#settingsButton").addEventListener("click", openSettings)
$("#saveSettings").addEventListener("click", saveSettings)
$("#saveStyleButton").addEventListener("click", saveStyleFingerprint)
$("#skipStyleButton").addEventListener("click", skipStyleFingerprint)
$("#toggleLeftPane").addEventListener("click", () => appShell.classList.toggle("left-collapsed"))
$("#toggleRightPane").addEventListener("click", () => appShell.classList.toggle("right-collapsed"))
document.querySelectorAll(".process-step").forEach((button) => button.addEventListener("click", () => setStep(button.dataset.step)))
$("#promptInput").addEventListener("input", updateMentionMenu)
$("#promptInput").addEventListener("click", updateMentionMenu)
$("#promptInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    state.mention.open ? selectMention() : runStepTask($("#promptInput").value.trim())
  }
})
draftEditor.addEventListener("input", () => {
  state.draftVersion += 1
  state.lastArticleMarkdown = draftEditor.innerText.trim() || state.lastArticleMarkdown
})
window.addEventListener("dragover", (event) => {
  event.preventDefault()
  composerDropzone.classList.add("dragging")
})
window.addEventListener("dragleave", () => composerDropzone.classList.remove("dragging"))
window.addEventListener("drop", handleDroppedFiles)

// ── Auth ──────────────────────────────────────────────────────────────────────

// ── Session storage (localStorage, no SDK needed) ─────────────────────────

const SESSION_KEY = "lucidwrite_session"

function saveSession(session) {
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
  const password = $("#loginPassword").value.trim()
  const errEl = $("#loginError")
  errEl.textContent = ""
  errEl.style.color = ""
  if (!email || !password) { errEl.textContent = "请填写邮箱和密码"; return }
  const btn = $("#loginButton")
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
  const password = $("#registerPassword").value.trim()
  const errEl = $("#registerError")
  errEl.textContent = ""
  errEl.style.color = ""
  if (!email || !password) { errEl.textContent = "请填写邮箱和密码"; return }
  if (password.length < 6) { errEl.textContent = "密码至少需要 6 位"; return }
  const btn = $("#registerButton")
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
      saveSession(data)
      hideAuthGate()
      await loadWorkspace()
    } else {
      errEl.textContent = data.message || "注册成功！请查收确认邮件，点击链接后登录。"
      errEl.style.color = "var(--accent)"
      $("#registerPassword").value = ""
    }
  } catch (e) {
    errEl.textContent = e?.message || "注册失败，请重试"
  } finally {
    btn.disabled = false
    btn.textContent = "注册"
  }
}

async function logout() {
  saveSession(null)
  state.activeProject = null
  state.chat = []
  state.completedSteps = new Set()
  state.currentStep = "topic"
  showAuthGate()
}

async function initAuth() {
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
    } catch {}
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
$("#loginPassword")?.addEventListener("keydown", (e) => { if (e.key === "Enter") loginUser(e) })
$("#registerButton")?.addEventListener("click", registerUser)
$("#registerPassword")?.addEventListener("keydown", (e) => { if (e.key === "Enter") registerUser(e) })
$("#logoutButton")?.addEventListener("click", logout)

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
