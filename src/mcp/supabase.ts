import type { McpSupabaseConfig } from "./types"
import type { McpLocalConfig } from "./types-local"

export function createSupabaseMcp(config: McpSupabaseConfig): McpLocalConfig {
  const environment: Record<string, string> = {
    SUPABASE_ACCESS_TOKEN: config.access_token,
  }

  const command = ["npx", "-y", "@supabase/mcp-server-supabase@latest"]

  if (config.project_ref) {
    command.push("--project-ref", config.project_ref)
  }

  if (config.read_only) {
    command.push("--read-only")
  }

  return {
    type: "local",
    command,
    environment,
    enabled: true,
  }
}
