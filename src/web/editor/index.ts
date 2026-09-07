/**
 * LucidWrite document surface · Operate.
 * Inherit the white canvas and quiet controls of the writing workspace.
 * Keep prose central, with persistent formatting, selection tools and block handles.
 * All actions operate on the same saved document; menus remain inside the viewport.
 */
import { Editor, type ChainedCommands, type JSONContent } from "@tiptap/core"
import { EditorState, NodeSelection, type SelectionBookmark } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { blockAt, documentExtensions, documentHtml, findKey, moveBlock, safeUrl, sanitizeHtml, serializeDocument } from "./document"

type Options = {
  element: HTMLElement
  preview: HTMLElement
  shell: HTMLElement
  onChange: (markdown: string) => void
  onSave: () => void
  onReference: (text: string) => void
  onNotice: (message: string) => void
  title: () => string
}
type Insert = { id: string; label: string; hint: string; glyph: string }
const inserts: Insert[] = [
  { id: "paragraph", label: "正文", hint: "普通文本 text", glyph: "T" },
  ...[1, 2, 3, 4, 5, 6].map(level => ({ id: `h${level}`, label: `${level} 级标题`, hint: `heading 标题 ${level}`, glyph: `H${level}` })),
  { id: "bulletList", label: "无序列表", hint: "bullet list 项目符号", glyph: "•" },
  { id: "orderedList", label: "有序列表", hint: "number list 编号", glyph: "1." },
  { id: "taskList", label: "待办事项", hint: "todo checkbox task 任务", glyph: "☑" },
  { id: "blockquote", label: "引用", hint: "quote 引文", glyph: "❞" },
  { id: "callout", label: "高亮块", hint: "callout 提示", glyph: "!" },
  { id: "codeBlock", label: "代码块", hint: "code javascript python", glyph: "</>" },
  { id: "table", label: "表格", hint: "table grid 行列", glyph: "▦" },
  { id: "image", label: "图片", hint: "image photo 上传", glyph: "▧" },
  { id: "link", label: "链接", hint: "link url 网址", glyph: "↗" },
  { id: "horizontalRule", label: "分隔线", hint: "divider 分割线", glyph: "—" },
  { id: "details", label: "折叠块", hint: "collapse toggle details", glyph: "▸" },
  { id: "columns", label: "分栏", hint: "columns 两栏", glyph: "Ⅱ" },
]
const icons: Record<string, string> = {
  undo: '<path d="M3 9h10a7 7 0 0 1 0 14M3 9l5-5M3 9l5 5" transform="translate(0 -3)"/>',
  redo: '<path d="M21 6H11a7 7 0 0 0 0 14M21 6l-5-5M21 6l-5 5"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1)"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  grip: '<path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" stroke-width="3"/>',
  outline: '<path d="M8 5h13M8 12h10M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
  fullscreen: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  left: '<path d="M3 4h18M3 9h12M3 14h18M3 19h12"/>',
  center: '<path d="M3 4h18M6 9h12M3 14h18M6 19h12"/>',
  right: '<path d="M3 4h18M9 9h12M3 14h18M9 19h12"/>',
  justify: '<path d="M3 4h18M3 9h18M3 14h18M3 19h18"/>',
}
const svg = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.more}</svg>`
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

export function create(options: Options) {
  const { element, preview, shell } = options
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => shell.querySelector<T>(selector)!
  const scroll = get("#editorScroll")
  let editor: Editor
  let previewEditor: Editor | null = null
  let previewSource: string | null = null
  let original = ""
  let documentKey: string | null = null
  let revision = 0
  let bookmark: SelectionBookmark | null = null
  let editable = true
  let destroyed = false
  let menuKind = ""
  let slashRange: { from: number; to: number } | null = null
  let slashDismissed = ""
  let choices: Insert[] = []
  let choice = 0
  let activeBlock: ReturnType<typeof blockAt> = null
  let dragged: { from: number; version: number } | null = null
  let dropTarget: number | null = null
  let frame = 0
  const listeners: Array<() => void> = []
  const listen = (target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions) => {
    target.addEventListener(type, fn, options)
    listeners.push(() => target.removeEventListener(type, fn, options))
  }
  const notice = (text: string) => { get("#editorMessage").textContent = text; options.onNotice(text) }
  const guarded = (fn: () => void | Promise<void>) => { try { Promise.resolve(fn()).catch(error => notice(error.message || "操作失败，请重试。")) } catch (error) { notice((error as Error).message) } }
  const makeTool = (id: string, label: string, content: string, action: () => void, parent: HTMLElement, pressed = false) => {
    const button = document.createElement("button")
    button.type = "button"; button.className = "editor-tool"; button.dataset.command = id
    button.title = label; button.setAttribute("aria-label", label)
    if (pressed) button.setAttribute("aria-pressed", "false")
    button.innerHTML = content
    button.addEventListener("mousedown", event => event.preventDefault())
    button.addEventListener("click", () => guarded(action))
    parent.append(button)
    return button
  }
  const toolbar = get("#editorToolbar")
  const popup = document.createElement("div")
  popup.className = "editor-popup"; popup.hidden = true
  popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "编辑菜单")
  const bubble = document.createElement("div")
  bubble.className = "editor-bubble"; bubble.hidden = true; bubble.setAttribute("role", "toolbar"); bubble.setAttribute("aria-label", "选中文字工具栏")
  const gutter = document.createElement("div")
  gutter.className = "editor-gutter"; gutter.hidden = true
  document.body.append(popup, bubble, gutter)
  const divider = () => { const span = document.createElement("span"); span.className = "editor-divider"; toolbar.append(span) }
  const closePopup = (restore = false) => {
    popup.hidden = true; popup.replaceChildren(); popup.onkeydown = null; menuKind = ""; slashRange = null
    if (restore && editable) editor.commands.focus()
  }
  const closeOverlays = () => { closePopup(); bubble.hidden = true; gutter.hidden = true; dragged = null; clearDrop() }
  const anchorPopup = (rect: DOMRect | { left: number; top: number; bottom: number }, width = 270) => {
    popup.hidden = false
    const actual = Math.min(width, window.innerWidth - 24)
    popup.style.width = `${actual}px`
    popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - actual - 12))}px`
    popup.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - Math.min(popup.scrollHeight, 360) - 12))}px`
  }
  const remember = () => { bookmark = editor.state.selection.getBookmark() }
  const chainAtSelection = () => {
    const chain = editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true })
    if (bookmark) { try { const selection = bookmark.resolve(editor.state.doc); chain.setTextSelection({ from: selection.from, to: selection.to }) } catch {} }
    if (slashRange) chain.deleteRange(slashRange)
    return chain
  }
  const command = (id: string, value?: string) => {
    if (!editable) return false
    let chain = chainAtSelection()
    const paragraph: JSONContent = { type: "paragraph" }
    const simple: Record<string, () => ChainedCommands> = {
      undo: () => editor.chain().focus().undo(), redo: () => editor.chain().focus().redo(),
      paragraph: () => chain.setParagraph(), bold: () => chain.toggleBold(), italic: () => chain.toggleItalic(), underline: () => chain.toggleUnderline(),
      strike: () => chain.toggleStrike(), code: () => chain.toggleCode(), superscript: () => chain.toggleSuperscript(), subscript: () => chain.toggleSubscript(),
      bulletList: () => chain.toggleBulletList(), orderedList: () => chain.toggleOrderedList(), taskList: () => chain.toggleTaskList(),
      blockquote: () => chain.toggleBlockquote(), codeBlock: () => chain.toggleCodeBlock(), horizontalRule: () => chain.setHorizontalRule(),
      highlight: () => chain.toggleHighlight({ color: value || "#fff1b8" }),
      clear: () => chain.unsetAllMarks().clearNodes(), indent: () => editor.isActive("taskList") ? chain.sinkListItem("taskItem") : chain.sinkListItem("listItem"),
      outdent: () => editor.isActive("taskList") ? chain.liftListItem("taskItem") : chain.liftListItem("listItem"),
      callout: () => chain.toggleWrap("callout"),
      columns: () => chain.insertContent({ type: "columns", content: [{ type: "column", content: [paragraph] }, { type: "column", content: [paragraph] }] }),
      details: () => chain.insertContent({ type: "details", content: [{ type: "detailsSummary", content: [{ type: "text", text: "点击展开内容" }] }, paragraph] }),
    }
    if (/^h[1-6]$/.test(id)) chain = chain.toggleHeading({ level: Number(id[1]) as 1 | 2 | 3 | 4 | 5 | 6 })
    else if (["left", "center", "right", "justify"].includes(id)) chain = chain.setTextAlign(id)
    else if (id === "color") chain = value ? chain.setColor(value) : chain.unsetColor()
    else if (id === "fontFamily") chain = value ? chain.setFontFamily(value) : chain.unsetFontFamily()
    else if (id === "fontSize") chain = value ? chain.setFontSize(value) : chain.unsetFontSize()
    else if (simple[id]) chain = simple[id]()
    else return false
    closePopup()
    bookmark = null
    return chain.run()
  }

  function menuRow(label: string, action: () => void, hint = "", glyph = "") {
    const button = document.createElement("button")
    button.type = "button"; button.className = "editor-menu-row"
    button.innerHTML = `${glyph ? `<span class="insert-glyph">${escape(glyph)}</span>` : ""}<span>${escape(label)}</span>${hint ? `<small>${escape(hint)}</small>` : ""}`
    button.addEventListener("mousedown", event => event.preventDefault())
    button.addEventListener("click", () => guarded(action)); popup.append(button)
    return button
  }
  function openMenu(kind: string, trigger: HTMLElement) {
    remember(); closePopup(); bubble.hidden = true; menuKind = kind
    if (kind === "insert") {
      const input = document.createElement("input")
      input.className = "editor-menu-search"; input.placeholder = "搜索内容块…"; input.setAttribute("aria-label", "搜索插入内容")
      popup.append(input)
      const draw = () => {
        popup.querySelectorAll(".editor-menu-row,.editor-menu-empty").forEach(row => row.remove())
        choices = inserts.filter(item => `${item.label} ${item.hint}`.toLowerCase().includes(input.value.toLowerCase()))
        choice = 0
        choices.forEach(item => menuRow(item.label, () => insert(item.id), "", item.glyph))
        if (!choices.length) { const empty = document.createElement("p"); empty.className = "editor-menu-empty"; empty.textContent = "没有匹配的内容块"; popup.append(empty) }
      }
      input.addEventListener("input", draw); draw()
      anchorPopup(trigger.getBoundingClientRect()); input.focus()
      return
    }
    if (kind === "align") ["left", "center", "right", "justify"].forEach((id, i) => menuRow(["左对齐", "居中", "右对齐", "两端对齐"][i], () => command(id)))
    if (kind === "more") {
      if (editable) {
        const formats = document.createElement("div"); formats.className = "editor-menu-formats"; popup.append(formats)
        for (const original of [font, size]) {
          const select = original.cloneNode(true) as HTMLSelectElement
          select.value = original.value
          select.addEventListener("change", () => command(original === font ? "fontFamily" : "fontSize", select.value))
          formats.append(select)
        }
        for (const [id, label] of [["strike", "删除线"], ["code", "行内代码"], ["superscript", "上标"], ["subscript", "下标"], ["indent", "增加列表缩进"], ["outdent", "减少列表缩进"], ["clear", "清除格式"]]) menuRow(label, () => command(id))
      }
      menuRow("查找与替换", () => { closePopup(); openFind() }, "⌘/Ctrl F")
      menuRow("文档目录", () => { closePopup(); toggleOutline() })
      menuRow("复制全文", () => { closePopup(); return copyDocument() })
      if (editable) menuRow("导入 Markdown / HTML / 文本", () => { closePopup(); get<HTMLInputElement>("#documentImport").click() })
      menuRow("导出 Markdown", () => { closePopup(); download("md") })
      menuRow("导出 HTML", () => { closePopup(); download("html") })
      menuRow("导出纯文本", () => { closePopup(); download("txt") })
      menuRow("打印 / 导出 PDF", () => { closePopup(); printDocument() })
    }
    anchorPopup(trigger.getBoundingClientRect(), kind === "more" ? 290 : 210)
    popup.querySelector<HTMLButtonElement>("button")?.focus()
  }

  function openColors(trigger: HTMLElement) {
    remember(); closePopup(); menuKind = "colors"; bubble.hidden = true
    for (const [heading, id, palette] of [
      ["文字颜色", "color", ["#1f2329", "#646a73", "#d83931", "#d97706", "#16813d", "#245bdb", "#7c3aed"]],
      ["背景高亮", "highlight", ["#fff1b8", "#fed4a4", "#ffd8d4", "#d9f5d6", "#d6e4ff", "#eadbff", "#e8e8e8"]],
    ] as const) {
      const label = document.createElement("p"); label.className = "editor-menu-label"; label.textContent = heading; popup.append(label)
      const grid = document.createElement("div"); grid.className = "editor-colors"; popup.append(grid)
      for (const color of palette) { const b = makeTool(id, `${heading} ${color}`, id === "color" ? "A" : "", () => command(id, color), grid); b.style[id === "color" ? "color" : "backgroundColor"] = color }
    }
    menuRow("恢复默认文字颜色", () => command("color", ""))
    menuRow("去除背景高亮", () => { chainAtSelection().unsetHighlight().run(); closePopup() })
    anchorPopup(trigger.getBoundingClientRect(), 268)
  }

  function field(label: string, value = "", type = "text") {
    const wrapper = document.createElement("label"); wrapper.className = "editor-field"; wrapper.textContent = label
    const input = document.createElement("input"); input.type = type; input.value = value; input.setAttribute("aria-label", label); wrapper.append(input); popup.append(wrapper)
    return input
  }
  function openForm(kind: string) {
    if (!bookmark) remember()
    const savedSlash = slashRange
    closePopup(); slashRange = savedSlash; menuKind = "form"; bubble.hidden = true
    const heading = document.createElement("p"); heading.className = "editor-menu-label"; heading.textContent = { link: "插入链接", image: "插入图片", table: "插入表格" }[kind] || "插入"; popup.append(heading)
    const error = document.createElement("p"); error.className = "editor-form-error"; error.setAttribute("role", "alert")
    let submit: () => void
    if (kind === "link") {
      const selected = bookmark?.resolve(editor.state.doc) || editor.state.selection
      const text = editor.state.doc.textBetween(selected.from, selected.to)
      const label = field("显示文字", text)
      const url = field("链接地址", editor.getAttributes("link").href || "", "url")
      url.placeholder = "https://…"
      submit = () => {
        const href = safeUrl(url.value)
        if (!href) { error.textContent = "请输入有效的 https://、http:// 或 mailto: 地址。"; return }
        const chain = chainAtSelection().extendMarkRange("link")
        if (label.value && (!text || label.value !== text)) chain.insertContent({ type: "text", text: label.value, marks: [{ type: "link", attrs: { href } }] })
        else chain.setLink({ href })
        chain.run(); bookmark = null; closePopup(true)
      }
      if (editor.isActive("link")) menuRow("移除链接", () => { chainAtSelection().extendMarkRange("link").unsetLink().run(); bookmark = null; closePopup(true) })
    } else if (kind === "image") {
      const url = field("图片地址", "", "url"); url.placeholder = "https://…"
      const alt = field("图片说明")
      menuRow("从电脑上传图片", () => get<HTMLInputElement>("#documentImage").click())
      submit = () => {
        const src = safeUrl(url.value, true)
        if (!src) { error.textContent = "请输入有效图片网址，或从电脑上传。"; return }
        chainAtSelection().setImage({ src, alt: alt.value }).run(); bookmark = null; closePopup(true)
      }
    } else {
      const rows = field("行数", "3", "number"); rows.min = "1"; rows.max = "30"
      const cols = field("列数", "3", "number"); cols.min = "1"; cols.max = "12"
      submit = () => {
        const r = Number(rows.value), c = Number(cols.value)
        if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || r > 30 || c < 1 || c > 12) { error.textContent = "行数为 1–30，列数为 1–12。"; return }
        chainAtSelection().insertTable({ rows: r, cols: c, withHeaderRow: true }).run(); bookmark = null; closePopup(true)
      }
    }
    popup.append(error)
    const actions = document.createElement("div"); actions.className = "editor-form-actions"; popup.append(actions)
    makeTool("cancel", "取消", "取消", () => closePopup(true), actions)
    makeTool("submit", "插入", "确定", submit, actions).classList.add("editor-primary")
    anchorPopup(toolbar.getBoundingClientRect(), 300)
    popup.querySelector<HTMLInputElement>("input")?.focus()
    popup.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit() } }
  }
  function insert(id: string) {
    if (!editable) return
    if (["link", "image", "table"].includes(id)) openForm(id)
    else command(id)
  }

  makeTool("undo", "撤销 · ⌘/Ctrl Z", svg("undo"), () => command("undo"), toolbar)
  makeTool("redo", "重做 · ⌘/Ctrl Shift Z", svg("redo"), () => command("redo"), toolbar)
  divider()
  const blockSelect = document.createElement("select"); blockSelect.className = "editor-block-select"; blockSelect.setAttribute("aria-label", "段落样式")
  for (const [value, label] of [["paragraph", "正文"], ...[1, 2, 3, 4, 5, 6].map(level => [`h${level}`, `${level} 级标题`]), ["blockquote", "引用"], ["codeBlock", "代码块"]]) blockSelect.add(new Option(label, value))
  blockSelect.addEventListener("pointerdown", remember); blockSelect.addEventListener("change", () => command(blockSelect.value)); toolbar.append(blockSelect)
  const font = document.createElement("select"); font.className = "editor-font-select"; font.setAttribute("aria-label", "字体")
  for (const [value, label] of [["", "默认字体"], ["sans-serif", "黑体"], ["serif", "宋体"], ["monospace", "等宽"]]) font.add(new Option(label, value))
  font.addEventListener("pointerdown", remember); font.addEventListener("change", () => command("fontFamily", font.value)); toolbar.append(font)
  const size = document.createElement("select"); size.className = "editor-size-select"; size.setAttribute("aria-label", "字号")
  for (const number of [12, 14, 16, 18, 20, 24, 28, 32]) size.add(new Option(String(number), `${number}px`))
  size.value = "16px"; size.addEventListener("pointerdown", remember); size.addEventListener("change", () => command("fontSize", size.value)); toolbar.append(size)
  divider()
  for (const [id, label, html] of [["bold", "加粗 · ⌘/Ctrl B", "<b>B</b>"], ["italic", "斜体 · ⌘/Ctrl I", "<i>I</i>"], ["underline", "下划线 · ⌘/Ctrl U", "<u>U</u>"], ["strike", "删除线", "<s>S</s>"]]) {
    makeTool(id, label, html, () => command(id), toolbar, true)
    makeTool(id, label, html, () => command(id), bubble, true)
  }
  const colorTool = makeTool("colors", "文字颜色与高亮", '<span class="color-letter">A</span>', () => openColors(colorTool), toolbar)
  makeTool("highlight", "高亮选中文字", "<mark>A</mark>", () => command("highlight"), bubble, true)
  makeTool("link", "插入链接 · ⌘/Ctrl K", svg("link"), () => { remember(); openForm("link") }, bubble)
  makeTool("reference", "将选中文字发到右侧作为 AI 参考", "AI 参考", () => {
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, "\n")
    if (text) options.onReference(text)
    closeOverlays()
  }, bubble)
  const alignTool = makeTool("align", "段落对齐", svg("left"), () => openMenu("align", alignTool), toolbar)
  const insertTool = makeTool("insert", "插入内容块 · /", svg("plus") + "<span>插入</span>", () => openMenu("insert", insertTool), toolbar)
  insertTool.classList.add("editor-labeled")
  const moreTool = makeTool("more", "更多编辑工具", svg("more"), () => openMenu("more", moreTool), toolbar)
  const tableTools = get("#editorTableTools")
  for (const [id, label] of [["addRowBefore", "上方插行"], ["addRowAfter", "下方插行"], ["addColumnBefore", "左侧插列"], ["addColumnAfter", "右侧插列"], ["deleteRow", "删除行"], ["deleteColumn", "删除列"], ["mergeCells", "合并单元格"], ["splitCell", "拆分单元格"], ["toggleHeaderRow", "表头"], ["deleteTable", "删除表格"]]) {
    makeTool(id, label, label, () => { if (editable) { const chain = chainAtSelection(); (chain[id as keyof ChainedCommands] as () => ChainedCommands)().run() } }, tableTools)
  }
  const imageTools = get("#editorImageTools")
  for (const [width, label] of [[240, "小图"], [480, "中图"], [null, "原始宽度"]] as const) makeTool("imageWidth", label, label, () => { if (editable) editor.chain().focus().updateAttributes("image", { width }).run() }, imageTools)
  makeTool("removeImage", "删除图片", "删除图片", () => { if (editable) editor.chain().focus().deleteSelection().run() }, imageTools)

  function updateUI() {
    if (!editor || destroyed) return
    for (const parent of [toolbar, bubble]) for (const button of parent.querySelectorAll<HTMLButtonElement>("button")) {
      const id = button.dataset.command!
      button.disabled = (id !== "more" && !editable) || (id === "undo" && !editor.can().undo()) || (id === "redo" && !editor.can().redo())
      if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", String(editor.isActive(id)))
    }
    for (const select of toolbar.querySelectorAll("select")) select.disabled = !editable
    blockSelect.value = editor.isActive("heading") ? `h${editor.getAttributes("heading").level}` : editor.isActive("codeBlock") ? "codeBlock" : editor.isActive("blockquote") ? "blockquote" : "paragraph"
    font.value = editor.getAttributes("textStyle").fontFamily || ""
    size.value = editor.getAttributes("textStyle").fontSize || "16px"
    alignTool.innerHTML = svg(editor.getAttributes("paragraph").textAlign || editor.getAttributes("heading").textAlign || "left")
    tableTools.hidden = !editable || !editor.isActive("table")
    imageTools.hidden = !editable || !editor.isActive("image")
    for (const button of tableTools.querySelectorAll<HTMLButtonElement>("button")) {
      const can = editor.can()[button.dataset.command as keyof ReturnType<Editor["can"]>] as () => boolean
      button.disabled = !editable || !can()
    }
    const shown = previewEditor || editor
    const text = shown.getText().trim()
    get("#editorCount").textContent = `${text.replace(/\s/g, "").length.toLocaleString()} 字`
    const { from, to } = editor.state.selection
    get("#editorSelectionCount").textContent = editable && from !== to ? `已选 ${editor.state.doc.textBetween(from, to, "").replace(/\s/g, "").length} 字` : ""
    updateOutline()
    updateFindCount()
    schedulePosition()
  }

  function updateSlash() {
    if (!editable || editor.view.composing || menuKind === "form" || !editor.state.selection.empty) return
    const { $from } = editor.state.selection
    if (!$from.parent.isTextblock || editor.isActive("codeBlock")) return
    const before = $from.parent.textBetween(0, $from.parentOffset, "", " ")
    const match = before.match(/^\/([^\s/]{0,30})$/)
    if (!match || before === slashDismissed) { if (menuKind === "slash") closePopup(); return }
    if (menuKind !== "slash") { closePopup(); choice = 0 }
    menuKind = "slash"; slashRange = { from: $from.start(), to: $from.pos }; remember()
    choices = inserts.filter(item => `${item.label} ${item.hint}`.toLowerCase().includes(match[1].toLowerCase()))
    choice = Math.min(choice, Math.max(choices.length - 1, 0))
    popup.replaceChildren()
    choices.forEach((item, i) => { const row = menuRow(item.label, () => insert(item.id), "", item.glyph); row.classList.toggle("is-chosen", i === choice) })
    if (!choices.length) { const p = document.createElement("p"); p.className = "editor-menu-empty"; p.textContent = "没有匹配的内容块"; popup.append(p) }
    const rect = editor.view.coordsAtPos($from.pos)
    anchorPopup({ left: rect.left, top: rect.top, bottom: rect.bottom })
    bubble.hidden = true
  }
  function schedulePosition() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; positionTools() })
  }
  function positionTools() {
    if (!editor || destroyed) return
    const visible = editable && !element.hidden && shell.offsetWidth > 0
    const { from, to, empty } = editor.state.selection
    const rect = scroll.getBoundingClientRect()
    if (visible && !empty && !(editor.state.selection instanceof NodeSelection) && editor.isFocused && popup.hidden && !editor.view.composing) {
      try {
        const start = editor.view.coordsAtPos(from), end = editor.view.coordsAtPos(to)
        if (start.top >= rect.top && start.top < rect.bottom) {
          bubble.hidden = false
          const width = bubble.offsetWidth
          bubble.style.left = `${Math.max(8, Math.min((start.left + end.right - width) / 2, window.innerWidth - width - 8))}px`
          const above = start.top - bubble.offsetHeight - 8
          bubble.style.top = `${above >= rect.top ? above : Math.min(end.bottom + 8, rect.bottom - bubble.offsetHeight - 4)}px`
        } else bubble.hidden = true
      } catch { bubble.hidden = true }
    } else bubble.hidden = true
    if (!visible || !popup.hidden || !activeBlock) { gutter.hidden = true; return }
    const dom = editor.view.nodeDOM(activeBlock.from)
    if (!(dom instanceof HTMLElement)) { gutter.hidden = true; return }
    const nodeRect = dom.getBoundingClientRect()
    gutter.hidden = nodeRect.top < rect.top || nodeRect.top > rect.bottom - 26
    gutter.style.left = `${Math.max(rect.left + 3, nodeRect.left - 48)}px`
    gutter.style.top = `${nodeRect.top + 2}px`
  }

  function updateOutline() {
    const list = get("#editorOutline")
    if (list.hidden) return
    const shown = previewEditor || editor
    list.replaceChildren()
    const heading = document.createElement("strong"); heading.textContent = "文档目录"; list.append(heading)
    shown.state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return
      const button = document.createElement("button"); button.type = "button"; button.textContent = node.textContent || "无标题"
      button.style.paddingLeft = `${8 + (node.attrs.level - 1) * 10}px`
      button.addEventListener("click", () => {
        const dom = shown.view.nodeDOM(pos)
        if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start", behavior: "smooth" })
        if (!previewEditor) shown.commands.setTextSelection(pos + 1)
      })
      list.append(button)
    })
    if (list.children.length === 1) { const p = document.createElement("p"); p.textContent = "添加标题后显示目录"; list.append(p) }
  }
  function toggleOutline() { get("#editorOutline").hidden = !get("#editorOutline").hidden; updateOutline() }
  function openFind() {
    get("#editorFind").hidden = false
    const input = get<HTMLInputElement>("#documentSearch"); input.focus(); input.select()
  }
  function updateFindCount() {
    const found = findKey.getState((previewEditor || editor).state)
    if (found) get("#documentMatches").textContent = found.matches.length ? `${found.index + 1} / ${found.matches.length}` : "0 / 0"
  }
  function search(query = get<HTMLInputElement>("#documentSearch").value, offset = 0) {
    const shown = previewEditor || editor
    const found = findKey.getState(shown.state)!
    const count = found.matches.length
    const index = count ? (found.index + offset + count) % count : 0
    shown.view.dispatch(shown.state.tr.setMeta(findKey, { query, index }))
    const match = findKey.getState(shown.state)!.matches[index]
    if (match) {
      const dom = shown.view.domAtPos(match.from).node
      ;(dom instanceof HTMLElement ? dom : dom.parentElement)?.scrollIntoView({ block: "nearest" })
    }
    updateFindCount()
  }
  function replace(all = false) {
    if (!editable) return
    const found = findKey.getState(editor.state)!
    const matches = all ? found.matches : found.matches.slice(found.index, found.index + 1)
    const value = get<HTMLInputElement>("#documentReplace").value
    if (!matches.length) return
    const tr = closeHistory(editor.state.tr)
    for (const match of [...matches].reverse()) tr.insertText(value, match.from, match.to)
    editor.view.dispatch(tr)
    notice(`已替换 ${matches.length} 处。`)
  }

  function clearDrop() { dropTarget = null; scroll.querySelectorAll(".block-drop-before,.block-drop-after").forEach(node => node.classList.remove("block-drop-before", "block-drop-after")) }
  function blockMenu() {
    if (!activeBlock || !editable) return
    const block = activeBlock
    editor.commands.setTextSelection(Math.min(block.from + 1, block.to - 1)); remember()
    closePopup(); menuKind = "block"
    menuRow("上方插入段落", () => { editor.chain().focus().insertContentAt(block.from, { type: "paragraph" }).run(); closePopup(true) })
    menuRow("下方插入段落", () => { editor.chain().focus().insertContentAt(block.to, { type: "paragraph" }).run(); closePopup(true) })
    menuRow("复制内容块", () => { editor.chain().focus().insertContentAt(block.to, block.node.toJSON()).run(); closePopup(true) })
    menuRow("上移", () => { const previous = block.from > 0 ? blockAt(editor, block.from - 1) : null; if (previous) moveBlock(editor, block.from, previous.from); closePopup(true) })
    menuRow("下移", () => { const next = editor.state.doc.nodeAt(block.to); if (next) moveBlock(editor, block.from, block.to + next.nodeSize); closePopup(true) })
    menuRow("删除内容块", () => { editor.chain().focus().deleteRange({ from: block.from, to: block.to }).run(); closePopup(true) }, "可撤销")
    anchorPopup(gutter.getBoundingClientRect(), 230)
  }
  makeTool("blockInsert", "在下方插入内容块", svg("plus"), () => {
    if (!activeBlock) return
    const at = activeBlock.to
    editor.chain().focus().insertContentAt(at, { type: "paragraph" }).setTextSelection(at + 1).run()
    openMenu("insert", gutter)
  }, gutter)
  const grip = makeTool("blockMenu", "拖动移动内容块，点击打开块菜单", svg("grip"), blockMenu, gutter)
  grip.draggable = true
  grip.addEventListener("dragstart", event => {
    if (!activeBlock || !editable || !event.dataTransfer) { event.preventDefault(); return }
    dragged = { from: activeBlock.from, version: revision }
    event.dataTransfer.setData("application/x-lucid-block", String(activeBlock.from)); event.dataTransfer.effectAllowed = "move"
    const dom = editor.view.nodeDOM(activeBlock.from)
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0)
    bubble.hidden = true
  })
  listen(document, "dragend", () => { dragged = null; clearDrop() })

  async function copyDocument() {
    const shown = previewEditor || editor
    const html = documentHtml(shown), text = shown.getText()
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
    else await navigator.clipboard.writeText(text)
    notice("已复制全文。")
  }
  function download(format: "md" | "html" | "txt") {
    const shown = previewEditor || editor
    const content = format === "md" ? (previewEditor ? previewSource || "" : original) : format === "html" ? exportHtml(shown) : shown.getText()
    const url = URL.createObjectURL(new Blob([content], { type: format === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8" }))
    const a = document.createElement("a"); a.href = url; a.download = `${options.title().replace(/[/\\:*?"<>|]/g, "_") || "文章"}.${format}`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    notice("已导出文档。")
  }
  function exportHtml(shown: Editor) {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(options.title())}</title><style>body{max-width:760px;margin:48px auto;padding:0 24px;font:16px/1.8 system-ui;color:#1f2329}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d3d8;padding:8px}pre{white-space:pre-wrap;background:#f5f6f7;padding:16px}blockquote{border-left:3px solid #ccc;padding-left:16px}aside{background:#f0f4ff;padding:16px}.document-columns{display:flex;gap:24px}.document-column{flex:1;min-width:0}ul[data-type=taskList]{list-style:none;padding-left:0}li[data-type=taskItem]{display:flex;gap:8px}li[data-type=taskItem]>div{flex:1}@media print{body{margin:0}details>*{display:block!important}}</style><body>${documentHtml(shown)}</body></html>`
  }
  function printDocument() {
    const win = window.open("", "_blank")
    if (!win) { notice("浏览器阻止了打印窗口，请允许弹出窗口后重试。"); return }
    win.document.write(exportHtml(previewEditor || editor)); win.document.close()
    win.addEventListener("load", () => { win.focus(); win.print() }, { once: true })
  }
  async function importDocument(file: File) {
    const key = documentKey, version = revision
    if (file.size > 450_000) throw new Error("文档过大，请导入 450 KB 以内的文件。")
    const text = await file.text()
    if (key !== documentKey || !editable || version !== revision) throw new Error("读取文件期间文章已变化，请重新选择文件。")
    const html = /\.html?$/i.test(file.name)
    const content = html ? sanitizeHtml(text) : text
    editor.chain().focus().insertContent(content, { contentType: html ? "html" : "markdown" }).command(({ tr }) => {
      if (serializeDocument(editor, tr.doc).length > 450_000) throw new Error("导入后的文章超出保存容量，请拆分为多个项目。原文已保留。")
      return true
    }).run()
    notice("已在光标处导入文档，可撤销。")
  }
  async function uploadImage(file: File) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片。")
    if (file.size > 12_000_000) throw new Error("图片过大，请选择 12 MB 以内的图片。")
    const key = documentKey, version = revision
    const url = URL.createObjectURL(file)
    let src = ""
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => { const img = new window.Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("无法读取图片")); img.src = url })
      let scale = Math.min(1, 1200 / Math.max(image.width, image.height))
      for (let attempt = 0; attempt < 5; attempt++) {
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale))
        const context = canvas.getContext("2d")!
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        src = canvas.toDataURL("image/webp", 0.82)
        if (src.length < 180_000) break
        scale *= 0.75
      }
    } finally { URL.revokeObjectURL(url) }
    if (key !== documentKey || version !== revision || !editable) throw new Error("读取图片期间文章已变化，请重新插入。")
    if (original.length + src.length > 450_000) throw new Error("图片会超出文章保存容量，请改用图片网址或更小的图片。")
    chainAtSelection().setImage({ src, alt: file.name.replace(/\.[^.]+$/, "") }).run(); bookmark = null; closePopup(true)
    notice("图片已插入，将随工作稿一起保存。")
  }

  editor = new Editor({
    element, extensions: documentExtensions(), content: "", contentType: "markdown",
    editorProps: {
      attributes: { class: "document-content", role: "textbox", "aria-label": "编辑文章草稿", "aria-multiline": "true", spellcheck: "true" },
      transformPastedHTML: sanitizeHtml,
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false
        if (menuKind === "slash") {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault(); choice = choices.length ? (choice + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length : 0
            updateSlash(); popup.querySelector(".is-chosen")?.scrollIntoView({ block: "nearest" }); return true
          }
          if (event.key === "Enter" && choices[choice]) { event.preventDefault(); insert(choices[choice].id); return true }
          if (event.key === "Escape") { slashDismissed = editor.state.selection.$from.parent.textContent; closePopup(); return true }
        }
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
          if (event.key.toLowerCase() === "s") { event.preventDefault(); options.onSave(); return true }
          if (event.key.toLowerCase() === "k") { event.preventDefault(); remember(); openForm("link"); return true }
          if (event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); return true }
        }
        return false
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files || [])]
        if (!files.length || event.clipboardData?.getData("text/html")) return false
        const file = files.find(file => file.type.startsWith("image/"))
        if (file) { event.preventDefault(); remember(); guarded(() => uploadImage(file)); return true }
        return false
      },
      handleDrop: (view, event) => {
        if (dragged) {
          event.preventDefault(); event.stopPropagation()
          if (dragged.version !== revision) notice("拖动期间正文已变化，请重新移动内容块。")
          else if (dropTarget !== null) moveBlock(editor, dragged.from, dropTarget)
          dragged = null; clearDrop(); return true
        }
        const files = [...(event.dataTransfer?.files || [])]
        if (!files.length) return false
        event.preventDefault(); event.stopPropagation()
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        if (pos !== undefined) editor.commands.setTextSelection(pos)
        remember()
        guarded(() => files[0].type.startsWith("image/") ? uploadImage(files[0]) : importDocument(files[0]))
        return true
      },
    },
    onUpdate: () => {
      original = serializeDocument(editor); revision++
      slashDismissed = ""
      options.onChange(original)
      updateSlash(); updateUI()
    },
    onTransaction: ({ transaction }) => { if (bookmark) bookmark = bookmark.map(transaction.mapping); updateUI() },
    onSelectionUpdate: () => { if (menuKind !== "form") bookmark = null; activeBlock = blockAt(editor); updateUI(); if (menuKind === "slash") updateSlash() },
    onFocus: () => { activeBlock = blockAt(editor); updateUI() },
    onBlur: () => schedulePosition(),
  })
  listen(scroll, "pointermove", ((event: PointerEvent) => {
    if (!editable || dragged || !popup.hidden || !element.contains(event.target as Node)) return
    const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (hit) activeBlock = blockAt(editor, hit.pos)
    schedulePosition()
  }) as EventListener)
  listen(scroll, "dragover", ((event: DragEvent) => {
    if (!dragged) return
    event.preventDefault(); event.stopPropagation(); clearDrop()
    const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
    const target = hit ? blockAt(editor, hit.pos) : null
    const dom = target && editor.view.nodeDOM(target.from)
    if (target && dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect(), before = event.clientY < (rect.top + rect.bottom) / 2
      dropTarget = before ? target.from : target.to
      dom.classList.add(before ? "block-drop-before" : "block-drop-after")
    }
  }) as EventListener)
  listen(scroll, "scroll", () => { if (menuKind !== "form") closePopup(); schedulePosition() })
  listen(window, "resize", () => { closePopup(); schedulePosition() })
  listen(document, "mousedown", ((event: MouseEvent) => {
    if (!popup.contains(event.target as Node) && !toolbar.contains(event.target as Node) && !gutter.contains(event.target as Node) && !bubble.contains(event.target as Node)) closePopup()
  }) as EventListener)
  listen(document, "keydown", ((event: KeyboardEvent) => {
    if (!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && shell.contains(document.activeElement)) {
      if (event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); return }
      if (event.key.toLowerCase() === "s" && editable) { event.preventDefault(); options.onSave(); return }
    }
    if (event.key === "Escape" && !popup.hidden) { event.preventDefault(); closePopup(true) }
    if (event.key === "Escape" && shell.classList.contains("editor-fullscreen")) shell.classList.remove("editor-fullscreen")
    if (!popup.hidden && menuKind !== "slash" && menuKind !== "form" && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      const buttons = [...popup.querySelectorAll<HTMLButtonElement>(".editor-menu-row")]
      if (!buttons.length) return
      event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus()
    }
  }) as EventListener)
  listen(get("#documentSearch"), "input", () => search())
  listen(get("#findPrevious"), "click", () => search(undefined, -1))
  listen(get("#findNext"), "click", () => search(undefined, 1))
  listen(get("#replaceOne"), "click", () => replace())
  listen(get("#replaceAll"), "click", () => replace(true))
  listen(get("#closeFind"), "click", () => { get("#editorFind").hidden = true; search(""); editor.commands.focus() })
  listen(get("#documentSearch"), "keydown", ((event: KeyboardEvent) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); search(undefined, event.shiftKey ? -1 : 1) } }) as EventListener)
  listen(get("#documentImport"), "change", (() => { const input = get<HTMLInputElement>("#documentImport"); const file = input.files?.[0]; input.value = ""; if (file) guarded(() => importDocument(file)) }) as EventListener)
  listen(get("#documentImage"), "change", (() => { const input = get<HTMLInputElement>("#documentImage"); const file = input.files?.[0]; input.value = ""; if (file) guarded(() => uploadImage(file)) }) as EventListener)
  listen(get("#editorOutlineToggle"), "click", toggleOutline)
  listen(get("#editorFocusToggle"), "click", () => { shell.classList.toggle("editor-fullscreen"); schedulePosition() })
  listen(get("#editorZoom"), "change", () => { const zoom = Number(get<HTMLSelectElement>("#editorZoom").value); scroll.style.setProperty("--document-zoom", String(zoom)); schedulePosition() })
  listen(shell, "dragover", event => event.stopPropagation())
  listen(shell, "drop", event => event.stopPropagation())
  updateUI()

  return {
    editor,
    getMarkdown: () => original,
    setContent(markdown: string, key: string | null) {
      closeOverlays(); bookmark = null
      const reset = key !== documentKey
      documentKey = key; original = markdown; revision++
      editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false })
      if (reset) editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }))
      updateUI()
      if (reset) { scroll.scrollTop = 0; get("#editorFind").hidden = true; get("#editorMessage").textContent = "" }
    },
    setMode(canEdit: boolean, final: string | null) {
      editable = canEdit && final === null
      if (editor.isEditable !== editable) { editor.setEditable(editable, false); closeOverlays() }
      if (previewSource !== final) {
        previewEditor?.destroy(); previewEditor = null; preview.replaceChildren(); previewSource = final
        if (final !== null) previewEditor = new Editor({ element: preview, extensions: documentExtensions(), content: final, contentType: "markdown", editable: false, editorProps: { attributes: { class: "document-content", "aria-label": "查看已保存的终稿" } } })
      }
      element.hidden = final !== null; preview.hidden = final === null
      get("#editorHint").textContent = final !== null ? "终稿 · 只读" : "输入 / 插入 · ⌘/Ctrl S 保存"
      for (const id of ["documentReplace", "replaceOne", "replaceAll"]) get<HTMLInputElement | HTMLButtonElement>(`#${id}`).disabled = !editable
      updateUI()
    },
    runCommand: command,
    openInsert: () => openMenu("insert", insertTool),
    getHTML: () => documentHtml(editor),
    search,
    replace,
    destroy() { destroyed = true; cancelAnimationFrame(frame); listeners.forEach(remove => remove()); previewEditor?.destroy(); editor.destroy(); popup.remove(); bubble.remove(); gutter.remove() },
  }
}
