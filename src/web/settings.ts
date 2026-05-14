import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface ProviderSettings {
  deepseek?: string
  openai?: string
  anthropic?: string
  google?: string
  tavily?: string
  firecrawl?: string
}

export interface WebSettings {
  providers: ProviderSettings
  defaultModel?: string
  agentModels?: Record<string, string>
}

export interface PublicWebSettings {
  providers: Record<keyof ProviderSettings, { configured: boolean }>
  defaultModel?: string
  agentModels?: Record<string, string>
  settingsPath: string
}

const providerEnv: Record<keyof ProviderSettings, string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  firecrawl: ["FIRECRAWL_API_KEY"],
}

let envLoaded = false

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function loadDotEnv(directory: string): void {
  if (envLoaded) return
  envLoaded = true

  const envPath = join(directory, ".env")
  if (!existsSync(envPath)) return

  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const equalsIndex = trimmed.indexOf("=")
    if (equalsIndex === -1) continue

    const key = trimmed.slice(0, equalsIndex).trim()
    const value = unquote(trimmed.slice(equalsIndex + 1))
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

export function getSettingsPath(directory: string): string {
  return join(directory, ".newtype", "web-settings.json")
}

export function readSettings(directory: string): WebSettings {
  const settingsPath = getSettingsPath(directory)
  if (!existsSync(settingsPath)) {
    return { providers: {}, agentModels: {} }
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Partial<WebSettings>
    return {
      providers: parsed.providers ?? {},
      defaultModel: parsed.defaultModel,
      agentModels: parsed.agentModels ?? {},
    }
  } catch {
    return { providers: {}, agentModels: {} }
  }
}

export function writeSettings(directory: string, settings: WebSettings): void {
  const settingsPath = getSettingsPath(directory)
  mkdirSync(join(directory, ".newtype"), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
}

export function toPublicSettings(directory: string, settings: WebSettings): PublicWebSettings {
  const providers = {
    deepseek: { configured: Boolean(settings.providers.deepseek || process.env.DEEPSEEK_API_KEY) },
    openai: { configured: Boolean(settings.providers.openai || process.env.OPENAI_API_KEY) },
    anthropic: { configured: Boolean(settings.providers.anthropic || process.env.ANTHROPIC_API_KEY) },
    google: {
      configured: Boolean(
        settings.providers.google ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_API_KEY
      ),
    },
    tavily: { configured: Boolean(settings.providers.tavily || process.env.TAVILY_API_KEY) },
    firecrawl: { configured: Boolean(settings.providers.firecrawl || process.env.FIRECRAWL_API_KEY) },
  }

  return {
    providers,
    defaultModel: settings.defaultModel,
    agentModels: settings.agentModels,
    settingsPath: getSettingsPath(directory),
  }
}

export function applyProviderEnvironment(settings: WebSettings): void {
  for (const [provider, envNames] of Object.entries(providerEnv) as Array<[keyof ProviderSettings, string[]]>) {
    const value = settings.providers[provider]?.trim()
    if (!value) continue
    for (const envName of envNames) {
      process.env[envName] = value
    }
  }
}
