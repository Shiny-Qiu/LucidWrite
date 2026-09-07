import handler from "../../api/index"
import { createServicesFixture } from "./fixtures"

process.env.SUPABASE_URL = "https://fixture.supabase.test"
process.env.SUPABASE_ANON_KEY = "fixture-public-key"
process.env.EDITAI_LLM_API_KEY = "fixture-llm-key"
process.env.EDITAI_LLM_BASE_URL = "https://fixture.model.test"
globalThis.fetch = createServicesFixture().fetcher
const directory = new URL("../../src/web/public/", import.meta.url)
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT || 3917),
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path.startsWith("/api/")) return handler(req)
    const fileName = path === "/" ? "landing.html" : path === "/app" ? "index.html" : path.slice(1)
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return new Response("Not found", { status: 404 })
    const file = Bun.file(new URL(fileName, directory))
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
  },
})
console.log("Isolated UI fixture: " + server.url + "app")
console.log("Test login: writer@example.test / writing-test-123 (no production data or external model calls)")
