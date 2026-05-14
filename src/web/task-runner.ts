import { randomUUID } from "node:crypto"
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk"
import type { ContentMode, ConversationTurn } from "./task-prompts"
import { buildPipelineApprovalPrompt, buildTaskPrompt, getModeLabel } from "./task-prompts"
import { applyProviderEnvironment, loadDotEnv, readSettings } from "./settings"
import { continueDeepSeekPipeline, hasDeepSeekConfig, runDeepSeekTask } from "./deepseek"

type TaskStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed"

export interface CreateTaskInput {
  mode: ContentMode
  message: string
  context?: string
  style?: string
  filePath?: string
  conversation?: ConversationTurn[]
  directory: string
}

export interface TaskEvent {
  time: string
  type: string
  message: string
}

export interface WebTask {
  id: string
  mode: ContentMode
  label: string
  message: string
  status: TaskStatus
  directory: string
  sessionID?: string
  output: string
  error?: string
  events: TaskEvent[]
  createdAt: string
  updatedAt: string
  awaitingApproval?: boolean
}

type RunningTask = WebTask & {
  client?: OpencodeClient
  server?: { close: () => void }
  abortController?: AbortController
}

const POLL_INTERVAL_MS = 500
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

export class WebTaskRunner {
  private tasks = new Map<string, RunningTask>()

  create(input: CreateTaskInput): WebTask {
    const now = new Date().toISOString()
    const task: RunningTask = {
      id: randomUUID(),
      mode: input.mode,
      label: getModeLabel(input.mode),
      message: input.message,
      status: "queued",
      directory: input.directory,
      output: "",
      events: [],
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    void this.run(task, input)
    return this.toPublicTask(task)
  }

  list(): WebTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => this.toPublicTask(task))
  }

  get(id: string): WebTask | undefined {
    const task = this.tasks.get(id)
    return task ? this.toPublicTask(task) : undefined
  }

  async approve(id: string, outline: string): Promise<WebTask | undefined> {
    const task = this.tasks.get(id)
    if (!task || task.status !== "awaiting_approval") {
      return task ? this.toPublicTask(task) : undefined
    }

    this.setStatus(task, "running")
    task.awaitingApproval = false
    this.addEvent(task, "pipeline", "Outline approved. Continuing full pipeline.")

    try {
      loadDotEnv(task.directory)
      if (hasDeepSeekConfig()) {
        this.addEvent(task, "model", "DeepSeek")
        const result = await continueDeepSeekPipeline(outline)
        task.output = result.content
        this.addEvent(task, "model", result.model)
        this.setStatus(task, "completed")
        return this.toPublicTask(task)
      }

      if (!task.client || !task.sessionID) {
        throw new Error("No active OpenCode session found for pipeline approval")
      }

      await task.client.session.promptAsync({
        path: { id: task.sessionID },
        body: {
          parts: [{ type: "text", text: buildPipelineApprovalPrompt(outline) }],
        },
        query: { directory: task.directory },
      })

      await this.waitForSessionIdle(task)
      task.output = await this.getLatestAssistantMessage(task)
      this.setStatus(task, "completed")
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error)
      this.addEvent(task, "error", task.error)
      this.setStatus(task, "failed")
    } finally {
      this.closeRuntime(task)
    }

    return this.toPublicTask(task)
  }

  private async run(task: RunningTask, input: CreateTaskInput): Promise<void> {
    this.setStatus(task, "running")
    this.addEvent(task, "start", `Starting ${task.label}`)

    loadDotEnv(task.directory)
    const settings = readSettings(task.directory)
    applyProviderEnvironment(settings)

    if (hasDeepSeekConfig()) {
      await this.runWithDeepSeek(task, input)
      return
    }

    const abortController = new AbortController()
    task.abortController = abortController

    try {
      const runtime = await createOpencode({ signal: abortController.signal })
      task.client = runtime.client
      task.server = runtime.server

      const sessionRes = await runtime.client.session.create({
        body: { title: `editAI: ${task.label}` },
      })
      const sessionID = sessionRes.data?.id
      if (!sessionID) {
        throw new Error("Failed to create OpenCode session")
      }

      task.sessionID = sessionID
      this.addEvent(task, "session", `Session ${sessionID}`)

      const events = await runtime.client.event.subscribe()
      void this.processEvents(task, events.stream)

      await runtime.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: "chief",
          parts: [{ type: "text", text: buildTaskPrompt(input) }],
        },
        query: { directory: task.directory },
      })

      await this.waitForSessionIdle(task)
      task.output = await this.getLatestAssistantMessage(task)

      if (task.mode === "pipeline") {
        task.awaitingApproval = true
        this.setStatus(task, "awaiting_approval")
        this.addEvent(task, "approval", "Waiting for outline approval.")
        return
      }

      this.setStatus(task, "completed")
      this.closeRuntime(task)
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error)
      this.addEvent(task, "error", task.error)
      this.setStatus(task, "failed")
      this.closeRuntime(task)
    }
  }

  private async runWithDeepSeek(task: RunningTask, input: CreateTaskInput): Promise<void> {
    try {
      this.addEvent(task, "model", "DeepSeek")
      const result = await runDeepSeekTask(input)
      task.output = result.content
      this.addEvent(task, "model", result.model)

      if (task.mode === "pipeline") {
        task.awaitingApproval = true
        this.setStatus(task, "awaiting_approval")
        this.addEvent(task, "approval", "Waiting for outline approval.")
        return
      }

      this.setStatus(task, "completed")
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error)
      this.addEvent(task, "error", task.error)
      this.setStatus(task, "failed")
    }
  }

  private async processEvents(task: RunningTask, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const raw of stream) {
        const event = raw as { type?: string; properties?: Record<string, unknown> }
        if (!event.type) continue
        const props = event.properties ?? {}
        const sessionID = props.sessionID ?? (props.info as { sessionID?: string } | undefined)?.sessionID
        if (task.sessionID && sessionID && sessionID !== task.sessionID) continue

        if (event.type === "message.updated") {
          const info = props.info as { role?: string } | undefined
          if (info?.role === "assistant" && typeof props.content === "string") {
            task.output = props.content
            this.touch(task)
          }
          continue
        }

        if (event.type === "tool.execute") {
          const name = typeof props.name === "string" ? props.name : "tool"
          this.addEvent(task, "tool", name)
          continue
        }

        if (event.type === "session.error") {
          this.addEvent(task, "error", String(props.error ?? "Session error"))
          continue
        }

        if (event.type === "session.idle" || event.type === "session.status") {
          this.touch(task)
        }
      }
    } catch {
      // The stream closes when the OpenCode server is closed.
    }
  }

  private async waitForSessionIdle(task: RunningTask): Promise<void> {
    if (!task.client || !task.sessionID) return
    const start = Date.now()

    while (Date.now() - start < IDLE_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      const statusResult = await task.client.session.status()
      const statuses = (statusResult.data ?? {}) as Record<string, { type: string }>
      const status = statuses[task.sessionID]
      if (!status || status.type === "idle") return
    }

    throw new Error("Timed out waiting for task completion")
  }

  private async getLatestAssistantMessage(task: RunningTask): Promise<string> {
    if (!task.client || !task.sessionID) return task.output
    const messagesResult = await task.client.session.messages({ path: { id: task.sessionID } })
    const messages = ((messagesResult as { data?: unknown }).data ?? messagesResult) as Array<{
      info?: { role?: string; time?: { created?: number } }
      parts?: Array<{ type?: string; text?: string }>
    }>
    const latest = messages
      .filter((message) => message.info?.role === "assistant")
      .sort((a, b) => (b.info?.time?.created ?? 0) - (a.info?.time?.created ?? 0))[0]
    const text = latest?.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()
    return text || task.output
  }

  private addEvent(task: RunningTask, type: string, message: string): void {
    task.events.push({ time: new Date().toISOString(), type, message })
    task.events = task.events.slice(-80)
    this.touch(task)
  }

  private setStatus(task: RunningTask, status: TaskStatus): void {
    task.status = status
    this.touch(task)
  }

  private touch(task: RunningTask): void {
    task.updatedAt = new Date().toISOString()
  }

  private closeRuntime(task: RunningTask): void {
    task.abortController?.abort()
    task.server?.close()
    task.client = undefined
    task.server = undefined
    task.abortController = undefined
  }

  private toPublicTask(task: RunningTask): WebTask {
    const { client: _client, server: _server, abortController: _abortController, ...publicTask } = task
    return { ...publicTask, events: [...publicTask.events] }
  }
}
