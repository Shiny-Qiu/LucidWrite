/** In-memory external-service fixture. Never contacts production or uses real credentials. */
export function createServicesFixture() {
  const db: Record<string, any[]> = { projects: [], drafts: [], finals: [], style_fingerprints: [], user_settings: [], writing_tasks: [] }
  const users = [
    { id: "11111111-1111-4111-8111-111111111111", email: "writer@example.test" },
    { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" },
  ]
  const session = (user: typeof users[number]) => ({ access_token: "test-" + user.id, refresh_token: "refresh-" + user.id, expires_in: 3600, user })
  const requests: Array<{ url: string; method: string; body: any }> = []
  const fetcher: typeof fetch = (async (input: any, options: any = {}) => {
    const url = new URL(String(input))
    const method = options.method || "GET"
    const body = options.body ? JSON.parse(options.body) : {}
    const headers = new Headers(options.headers)
    requests.push({ url: url.href, method, body })
    const user = users.find(u => headers.get("Authorization") === "Bearer test-" + u.id)
    if (url.hostname === "fixture.supabase.test") {
      if (url.pathname.startsWith("/auth/v1/token") || url.pathname === "/auth/v1/signup") {
        const account = body.refresh_token ? users.find(u => body.refresh_token === "refresh-" + u.id) : users.find(u => u.email === body.email && body.password === "writing-test-123")
        return account ? Response.json(session(account)) : Response.json({ msg: "登录信息错误" }, { status: 400 })
      }
      if (url.pathname === "/auth/v1/user") return user ? Response.json(user) : Response.json({ error: "invalid token" }, { status: 401 })
      if (!user) return Response.json({ message: "unauthorized" }, { status: 401 })
      const table = url.pathname.split("/").pop()!
      if (!(table in db)) return Response.json({ code: "PGRST205" }, { status: 404 })
      const rows = db[table]!
      const matching = rows.filter(row => row.user_id === user.id && [...url.searchParams].every(([key, value]) => !value.startsWith("eq.") || String(row[key]) === value.slice(3)))
      if (method === "GET") {
        let result = [...matching]
        if (url.searchParams.get("order") === "created_at.desc") result.reverse()
        result = result.slice(0, Number(url.searchParams.get("limit")) || result.length)
        return Response.json(result)
      }
      if (method === "DELETE") { db[table] = rows.filter(r => !matching.includes(r)); return new Response(null, { status: 204 }) }
      if (method === "PATCH") { matching.forEach(r => Object.assign(r, body)); return Response.json(matching) }
      if (method === "POST") {
        if (body.user_id !== user.id || (body.project_id && !db.projects!.some(p => p.id === body.project_id && p.user_id === user.id))) return Response.json({ code: "42501" }, { status: 403 })
        const conflictKey = table === "drafts" || table === "finals" ? "project_id" : table === "user_settings" || table === "style_fingerprints" ? "user_id" : "id"
        const existing = table === "projects" ? rows.find(r => r.user_id === user.id && r.name === body.name) : rows.find(r => r[conflictKey] === body[conflictKey])
        if (existing && url.searchParams.get("on_conflict") !== conflictKey) return Response.json({ code: "23505" }, { status: 409 })
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body }
        if (existing) Object.assign(existing, body)
        else rows.push(row)
        return Response.json([existing || row])
      }
    }
    if (url.hostname === "fixture.model.test") {
      const message = body.messages.at(-1).content
      let output = "## 对话回复\n选题建议：从新手读者的实际需求出发，介绍如何养成写作习惯。"
      if (message.includes("<Stage_Action>") && message.includes("<Current_Step>选题交互")) output = "## 对话回复\n大纲已生成。\n\n## 文章草稿\n# 写作习惯\n\n1. 明确目标\n2. 每天练习\n3. 复盘改进"
      else if (message.includes("<Stage_Action>") && message.includes("<Current_Step>大纲框架")) output = "## 对话回复\n初稿已生成。\n\n## 文章草稿\n# 写作习惯\n\n## 明确目标\n\n从每天写一段话开始，逐步建立写作习惯。\n\n## 每天练习\n\n**持续练习**有助于发现自己的表达方式。\n\n## 复盘改进\n\n定期回看文章，记录下一次可以改善的地方。"
      else if (message.includes("<Current_Step>内容精修")) output = "## 对话回复\n精修报告：建议增加具体练习案例，让读者更容易采取行动。"
      else if (message.includes("<Current_Step>事实核查")) output = "## 对话回复\n核查报告：本次未配置联网检索，仅检查文本一致性。文中的经验建议仍需实际验证。"
      else if (message.includes("<Current_Step>质量评分")) output = "## 对话回复\n结构与可读性良好，质量评分：88/100。\n\n总评：合格"
      return Response.json({ choices: [{ message: { content: output }, finish_reason: "stop" }] })
    }
    throw new Error("Fixture blocked external request to " + url.hostname)
  }) as typeof fetch
  return { db, users, session, requests, fetcher }
}
