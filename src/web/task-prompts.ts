export type ContentMode =
  | "chat"
  | "research"
  | "write"
  | "edit"
  | "fact-check"
  | "analyze"
  | "extract"
  | "archive"
  | "pipeline"
  | "super-interviewer"
  | "super-analyst"
  | "super-workflow"

export interface BuildPromptInput {
  mode: ContentMode
  message: string
  context?: string
  style?: string
  filePath?: string
  conversation?: ConversationTurn[]
}

export interface ConversationTurn {
  role: "user" | "assistant"
  content: string
}

const modeLabels: Record<ContentMode, string> = {
  chat: "Chief conversation",
  research: "nt research",
  write: "nt write",
  edit: "nt edit",
  "fact-check": "nt fact-check",
  analyze: "nt analyze",
  extract: "nt extract",
  archive: "nt archive",
  pipeline: "nt pipeline",
  "super-interviewer": "/super-interviewer",
  "super-analyst": "/super-analyst",
  "super-workflow": "/super-workflow",
}

function addSharedContext(input: BuildPromptInput): string {
  const parts: string[] = []
  if (input.conversation?.length) {
    parts.push(`<Conversation_History>\n${formatConversation(input.conversation)}\n</Conversation_History>`)
  }
  if (input.context?.trim()) {
    parts.push(`<User_Context>\n${input.context.trim()}\n</User_Context>`)
  }
  if (input.filePath?.trim()) {
    parts.push(`Target file: ${input.filePath.trim()}`)
  }
  if (input.style?.trim()) {
    parts.push(`Requested style: ${input.style.trim()}`)
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : ""
}

function formatConversation(turns: ConversationTurn[]): string {
  return turns
    .filter((turn) => turn.content.trim())
    .slice(-12)
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}:\n${trimForPrompt(turn.content.trim(), 6000)}`)
    .join("\n\n---\n\n")
}

function trimForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n\n[Content truncated for context length]`
}

export function buildTaskPrompt(input: BuildPromptInput): string {
  const message = input.message.trim()
  const context = addSharedContext(input)

  switch (input.mode) {
    case "research":
      return `You are running the web equivalent of \`nt research [topic]\`.

Research the topic below through the editAI agent workflow. Use researcher for external intelligence and fact-checker for source verification when factual claims or dated information appear.

Deliver Markdown with: executive summary, key findings, source notes, potential content angles, gaps, and quality scores.

Topic:
${message}${context}`

    case "write":
      return `You are running the web equivalent of \`nt write [topic]\`.

Create a complete Markdown draft from the topic and any supplied context. Use writer for drafting. If the draft contains factual claims, route verification before final delivery.

Return only the useful Markdown deliverable plus a short quality note.

Topic or brief:
${message}${context}`

    case "edit":
      return `You are running the web equivalent of \`nt edit [file]\`.

Edit the supplied content in four passes: structure, paragraph flow, sentence clarity, and word choice. Preserve the author's intent and voice. If factual statements look suspicious, flag them for fact-checking instead of silently changing them.

Return the revised Markdown and a concise change summary.

Editing request:
${message}${context}`

    case "fact-check":
      return `You are running the web equivalent of \`nt fact-check [topic]\`.

Identify factual claims, verify them against reliable sources, assess credibility, and flag unverifiable or incorrect claims.

Deliver Markdown with claim-by-claim verdicts, evidence, sources, caveats, and quality scores.

Topic or content to verify:
${message}${context}`

    case "analyze":
      return `You are running the web equivalent of \`nt analyze [topic]\`.

Analyze the topic with appropriate structured frameworks. Use Chief-level reasoning, and delegate research if external information is needed.

Deliver Markdown with framing, framework analysis, key insights, risks, implications, and recommended next steps.

Topic:
${message}${context}`

    case "extract":
      return `You are running the web equivalent of \`nt extract\`.

Extract the useful content from the supplied text or Markdown. Preserve structure, headings, links, tables, and important details. Mark unclear or missing sections explicitly.

Return clean Markdown.

Extraction request:
${message}${context}`

    case "archive":
      return `You are running the web equivalent of \`nt archive <action>\`.

Use the archivist workflow for local knowledge-base retrieval, storage, or organization. Infer the archive action from the user's request: search, store, get, list, or organize.

Return Markdown with the action taken, relevant results, file paths when applicable, and recommended follow-up.

Archive request:
${message}${context}`

    case "pipeline":
      return buildPipelineOutlinePrompt(input)

    case "super-interviewer":
      return `Use the \`super-interviewer\` skill for this writing workspace request.

Call and follow: skill({ name: "super-interviewer" })

Act as an interviewing writing partner. Base every question and suggestion on the current article, project context, and conversation history. Avoid generic questions and do not repeat questions already asked.

The user's current article is the source of truth. If the user gives a revision instruction, revise the article according to that instruction while preserving the user's existing content, structure, facts, and voice unless the instruction explicitly asks to change them. Do not drop paragraphs simply because you are asking interview questions.

Return Markdown with two clearly separated sections:

## 采访启发
List focused questions, prompts, and thinking directions for the user. This section will be shown in the right sidebar.

## 文章草稿
Return the complete current article after applying the user's latest instruction. If no revision is needed, return the complete current article unchanged. This section replaces the main editable draft, so it must not omit user-written content.

User request:
${message}${context}`

    case "super-analyst":
      return `Use the \`super-analyst\` skill for this writing workspace request.

Call and follow: skill({ name: "super-analyst" })

Analyze the user's article as a writing analyst. Focus on structure, argument, reader value, missing evidence, clarity, and revision opportunities. Ground every point in the current article and project context.

The user's current article is the source of truth. If the user gives a revision instruction, apply it to the article while preserving the user's existing content, structure, facts, and voice unless the instruction explicitly asks to change them.

Return Markdown with two clearly separated sections:

## 分析建议
List concise, actionable analysis for the right sidebar.

## 文章草稿
Return the complete current article after applying the user's latest instruction. If no revision is needed, return the complete current article unchanged. This section replaces the main editable draft, so it must not omit user-written content.

User request:
${message}${context}`

    case "super-workflow":
      return `Use the \`super-workflow\` skill for this writing workspace request.

Call and follow: skill({ name: "super-workflow" })

Evaluate the full article quality as a writing workflow reviewer. Return Markdown with:

## 质量评分
Score the article on clarity, structure, originality, evidence, reader value, style consistency, and completion. Include an overall score out of 100 and mark whether it is 合格 or 不合格.

## 修改建议
List actionable improvements if the score is not sufficient.

## 文章草稿
Return the complete current article unchanged unless the user explicitly asked for a rewrite.

User request:
${message}${context}`

    case "chat":
    default:
      return `You are Chief in the editAI web writing workspace. Treat this as a conversation with a personal content creation platform user. Select the right editAI mode internally when helpful.

When the user is starting from an empty article, first clarify the writing goal if necessary. If there is enough information, coordinate the appropriate expert agents internally and produce a first Markdown draft. If the prompt asks for an initial draft, return a clear \`## 文章草稿\` section containing the complete editable draft.

User message:
${message}${context}`
  }
}

export function buildPipelineOutlinePrompt(input: BuildPromptInput): string {
  return `You are starting the web equivalent of \`nt pipeline [topic]\`, but this first step is OUTLINE APPROVAL ONLY.

Do not write the final article yet. Build a content production plan for the topic below:
1. Working title
2. Target audience and angle
3. Proposed outline
4. Research questions
5. Fact-check risks
6. Suggested output file name

End with a clear note that the user can revise or approve this outline before drafting.

Topic:
${input.message.trim()}${addSharedContext(input)}`
}

export function buildPipelineApprovalPrompt(outline: string): string {
  return `The user has approved or revised the pipeline outline below.

Continue the full editAI content pipeline now:
Research -> Analyze -> Write -> Fact-check -> Edit.

Use the approved outline as the source of truth. Return the final Markdown deliverable, source notes, fact-check summary, quality scores, and a suggested file path.

Approved outline:
${outline.trim()}`
}

export function getModeLabel(mode: ContentMode): string {
  return modeLabels[mode] ?? mode
}
