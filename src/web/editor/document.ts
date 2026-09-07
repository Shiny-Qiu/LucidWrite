import { Editor, Extension, Node, mergeAttributes, type JSONContent } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import Image from "@tiptap/extension-image"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import Placeholder from "@tiptap/extension-placeholder"
import { TextStyleKit } from "@tiptap/extension-text-style"
import TextAlign from "@tiptap/extension-text-align"
import Highlight from "@tiptap/extension-highlight"
import Subscript from "@tiptap/extension-subscript"
import Superscript from "@tiptap/extension-superscript"
import { Markdown } from "@tiptap/markdown"
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import DOMPurify from "dompurify"

export function safeUrl(value: string, image = false) {
  const url = value.trim()
  if (image && /^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(url)) return url
  if (/^https?:\/\/[^\s<>"']+$/i.test(url) || (!image && /^mailto:[^\s<>"']+$/i.test(url))) return url
  return ""
}

export function sanitizeHtml(html: string) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "video", "audio"],
    FORBID_ATTR: ["srcset"],
    ADD_ATTR: ["data-type", "data-checked", "data-callout", "data-columns", "data-column", "data-details", "data-summary"],
  })
}

const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  parseHTML: () => [{ tag: 'aside[data-callout]' }],
  renderHTML: ({ HTMLAttributes }) => ["aside", mergeAttributes(HTMLAttributes, { "data-callout": "true", class: "document-callout" }), 0],
})
const Columns = Node.create({
  name: "columns", group: "block", content: "column{2,3}", isolating: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: () => ["div", { "data-columns": "true", class: "document-columns" }, 0],
})
const Column = Node.create({
  name: "column", content: "block+", isolating: true,
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: () => ["div", { "data-column": "true", class: "document-column" }, 0],
})
const DetailsSummary = Node.create({
  name: "detailsSummary", content: "inline*", defining: true,
  parseHTML: () => [{ tag: "summary" }], renderHTML: () => ["summary", {}, 0],
})
const Details = Node.create({
  name: "details", group: "block", content: "detailsSummary block+", defining: true,
  addAttributes: () => ({ open: { default: true, parseHTML: element => element.hasAttribute("open"), renderHTML: attrs => attrs.open ? { open: "" } : {} } }),
  parseHTML: () => [{ tag: "details" }],
  renderHTML: ({ HTMLAttributes }) => ["details", mergeAttributes(HTMLAttributes, { "data-details": "true" }), 0],
  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      let node = initial
      const dom = document.createElement("details")
      dom.dataset.details = "true"; dom.open = node.attrs.open
      const toggle = () => {
        if (!editor.isEditable || editor.isDestroyed || dom.open === node.attrs.open) return
        const pos = getPos()
        if (typeof pos === "number") editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, { ...node.attrs, open: dom.open }))
      }
      dom.addEventListener("toggle", toggle)
      return {
        dom, contentDOM: dom,
        update(next) {
          if (next.type !== node.type) return false
          node = next
          if (dom.open !== node.attrs.open) dom.open = node.attrs.open
          return true
        },
        ignoreMutation: mutation => mutation.type === "attributes" && mutation.target === dom && mutation.attributeName === "open",
        destroy: () => dom.removeEventListener("toggle", toggle),
      }
    }
  },
})
const DocumentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: { default: null, parseHTML: element => safeUrl(element.getAttribute("src") || "", true), renderHTML: attrs => ({ src: safeUrl(attrs.src || "", true) }) },
      width: { default: null, parseHTML: element => /^\d{1,4}$/.test(element.getAttribute("width") || "") ? Number(element.getAttribute("width")) : null },
    }
  },
}).configure({ allowBase64: true })

export type Match = { from: number; to: number }
export function findMatches(doc: PMNode, query: string): Match[] {
  if (!query) return []
  const matches: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, "", " ").toLocaleLowerCase()
    const needle = query.toLocaleLowerCase()
    for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) matches.push({ from: pos + 1 + index, to: pos + 1 + index + needle.length })
    return false
  })
  return matches
}
export const findKey = new PluginKey<{ query: string; index: number; matches: Match[] }>("lucid-find")
const Find = Extension.create({
  name: "documentFind",
  addProseMirrorPlugins: () => [new Plugin({
    key: findKey,
    state: {
      init: () => ({ query: "", index: 0, matches: [] as Match[] }),
      apply(tr, previous) {
        const meta = tr.getMeta(findKey)
        const query = meta?.query ?? previous.query
        const matches = tr.docChanged || meta ? findMatches(tr.doc, query) : previous.matches
        return { query, matches, index: Math.max(0, Math.min(meta?.index ?? previous.index, matches.length - 1)) }
      },
    },
    props: { decorations(state) {
      const found = findKey.getState(state)!
      return DecorationSet.create(state.doc, found.matches.map((match, index) => Decoration.inline(match.from, match.to, { class: index === found.index ? "find-match find-current" : "find-match" })))
    } },
  })],
})

export function documentExtensions() {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: true, isAllowedUri: url => Boolean(safeUrl(url)) } }),
    Table.configure({ resizable: true, allowTableNodeSelection: true }), TableRow, TableCell, TableHeader,
    DocumentImage, TaskList, TaskItem.configure({ nested: true }),
    TextStyleKit, TextAlign.configure({ types: ["heading", "paragraph"] }),
    Highlight.configure({ multicolor: true }), Subscript, Superscript,
    Callout, Columns, Column, Details, DetailsSummary, Find,
    Placeholder.configure({ placeholder: "输入文字，或输入 / 插入内容块", includeChildren: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
  ]
}

// Standard blocks remain readable Markdown. Rich blocks use schema-generated HTML,
// which the Markdown extension parses back through the same schema on reopening.
// This keeps colors, alignment, merged cells and nested blocks in the existing file.
function needsHtml(node: JSONContent): boolean {
  if (["table", "callout", "columns", "details", "codeBlock"].includes(node.type || "")) return true
  if (node.type === "image" && node.attrs?.width) return true
  if (Object.entries(node.attrs || {}).some(([key, value]) => value != null && ["textAlign", "color", "backgroundColor", "fontFamily", "fontSize", "lineHeight"].includes(key))) return true
  if (node.marks?.some(mark => ["textStyle", "underline", "highlight", "subscript", "superscript", "code"].includes(mark.type))) return true
  return node.content?.some(needsHtml) || false
}
export function serializeDocument(editor: Editor, doc = editor.state.doc) {
  const serializer = DOMSerializer.fromSchema(editor.schema)
  const blocks: string[] = []
  doc.forEach(node => {
    const json = node.toJSON()
    if (needsHtml(json)) {
      const holder = document.createElement("div")
      holder.append(serializer.serializeNode(node))
      blocks.push(holder.innerHTML)
    } else blocks.push(editor.markdown!.serialize({ type: "doc", content: [json] }))
  })
  return blocks.join("\n\n").trim()
}

export function documentHtml(editor: Editor) { return sanitizeHtml(editor.getHTML()) }

export function blockAt(editor: Editor, pos = editor.state.selection.from) {
  const resolved = editor.state.doc.resolve(Math.max(0, Math.min(pos, editor.state.doc.content.size)))
  const from = resolved.depth ? resolved.before(1) : resolved.pos
  const node = editor.state.doc.nodeAt(from)
  return node ? { from, to: from + node.nodeSize, node } : null
}

export function moveBlock(editor: Editor, from: number, target: number) {
  const node = editor.state.doc.nodeAt(from)
  if (!node || target < 0 || target > editor.state.doc.content.size || (target >= from && target <= from + node.nodeSize)) return false
  const tr = closeHistory(editor.state.tr).delete(from, from + node.nodeSize)
  tr.insert(target > from ? target - node.nodeSize : target, node)
  editor.view.dispatch(tr.scrollIntoView())
  return true
}
