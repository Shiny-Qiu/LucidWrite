# LucidWrite

> LucidWrite 是一个面向 AI 写作和 AI 编程工作流的多运行时 harness 工程：它同时提供浏览器写作工作台、OpenCode 插件、Claude Code 兼容 hooks、MCP/工具适配、Agent 编排、上下文恢复与 CLI 诊断安装能力。

## 项目真实定位

这个仓库不只是一个浏览器 AI 写作工具。当前代码实际包含两条主要产品线：

1. **LucidWrite Web 写作台**  
   一个本地或 Vercel 可运行的浏览器写作工作台，使用 Hono 提供 API，使用 Supabase 做账号与写作数据存储，使用 DeepSeek/OpenAI-compatible LLM 或 OpenCode SDK 执行写作任务。

2. **OpenCode / Claude Code 增强插件与 CLI**  
   一个面向 OpenCode 的插件工程，提供 hooks、tools、agents、skills、MCP loader、上下文压缩/恢复、后台任务、Google Antigravity 认证、doctor 诊断与安装命令。

因此，理解本项目时不要只看 `src/web/`。真正的工程入口包括：

- `src/index.ts`：OpenCode 插件主入口。
- `src/cli/index.ts`：CLI 主入口。
- `src/web/server.ts`：Web 写作台服务端入口。
- `api/index.ts`：Vercel Edge API 入口。
- `supabase/schema.sql`：Supabase 数据库与 RLS 权限模型。

## 命名说明

项目对外统一称为 **LucidWrite**。文档、注释和界面文案都使用这个名字。

但出于兼容性，源码中仍保留几个**功能性标识符**（它们是包名、命令名、插件名，改动会破坏已发布包和已有安装，因此保持不变）：

- `package.json` 包名：`edit-ai`
- CLI binary：`newtype-profile`（命令行调用仍是 `bunx newtype-profile`）
- OpenCode 插件名 / 发布包名：`oh-my-opencode`（配置里写 `"plugin": ["oh-my-opencode"]`）
- 环境变量前缀：`EDITAI_*`、`NEWTYPE_*`、`DEEPSEEK_*`
- 配置文件名：`newtype-profile.json`；缓存目录：`~/.cache/oh-my-opencode/`

在命令、配置和环境变量处请以上述真实名称为准。

## 核心能力

### Web 写作台

- 邮箱注册/登录，认证由 Supabase Auth 提供。
- 项目、草稿、终稿、风格指纹存储在 Supabase。
- 所有用户数据通过 Supabase RLS 隔离。
- 支持本地 Markdown 工作区引用。
- 支持 DeepSeek、OpenAI 或任意 OpenAI-compatible `/v1/chat/completions` 接口。
- 本地模式下可通过 `@opencode-ai/sdk` 创建 OpenCode session 执行写作任务。
- Vercel 模式下以 serverless/edge 方式同步调用 LLM。

### OpenCode 插件

- 注册工具：background task、chief task、skill、skill_mcp、slashcommand、look_at、interactive_bash 等。
- 注册 hooks：tool before/after、chat message、event、context transform、system transform。
- 支持上下文窗口监控、预防性压缩、动态上下文裁剪、会话恢复、任务续跑、输出截断。
- 支持内置 agents：chief、researcher、fact-checker、archivist、extractor、writer、editor、deputy。
- 支持内置 skills、自定义 skills、Claude skills、OpenCode skills 合并。
- 支持 MCP 配置和 skill MCP 运行时管理。

### CLI

源码中的 CLI 入口是 `src/cli/index.ts`，发布后暴露的 bin 名为 `newtype-profile`，但 help 文案中显示为 `oh-my-opencode`。

主要命令：

- `install`：交互式安装和 OpenCode 配置引导。
- `doctor`：检查安装、配置、认证、依赖、MCP、工具与更新状态。
- `run <message>`：运行 OpenCode 任务，并等待 TODO/后台任务完成。
- `get-local-version`：查看本地版本与更新状态。
- `auth list` / `auth remove`：管理 Google Antigravity 账号。
- `version`：打印版本。

## 技术栈

- Runtime：Bun
- Language：TypeScript / JavaScript
- Web Server：Hono
- AI Runtime：OpenCode SDK、OpenAI-compatible Chat Completions API
- Database/Auth：Supabase + Supabase Auth + RLS
- CLI：commander、@clack/prompts
- Validation：Zod
- MCP：@modelcontextprotocol/sdk
- Code tools：ast-grep、LSP adapters、grep/glob wrappers

## 快速开始：Web 写作台

### 1. 安装依赖

```bash
git clone https://github.com/Shiny-Qiu/LucidWrite.git
cd LucidWrite
bun install
```

### 2. 配置环境变量

复制模板：

```bash
cp .env.example .env
```

当前 `.env.example` 只包含 LLM 与端口相关变量；如果要完整使用账号、项目、草稿和风格指纹功能，还需要手动补充 Supabase 变量：

```env
# Supabase，Web 完整功能必需
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>

# OpenAI-compatible LLM，DeepSeek 示例
EDITAI_LLM_API_KEY=<your-api-key>
EDITAI_LLM_BASE_URL=https://api.deepseek.com
EDITAI_LLM_MODEL=deepseek-chat
EDITAI_LLM_MAX_RETRIES=3
EDITAI_LLM_TIMEOUT_MS=60000

# 兼容旧变量名
DEEPSEEK_API_KEY=<your-api-key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=60000

# Web 端口
PORT=3900

# 可选：指定 Web 工作区根目录
EDITAI_WEB_ROOT=
NEWTYPE_WEB_ROOT=
```

端口规则：

- 如果设置了 `PORT`，优先使用 `PORT`。
- 如果设置了 `EDITAI_WEB_PORT` 或 `NEWTYPE_WEB_PORT`，会作为次级端口来源。
- 如果都未设置，默认端口是 `3899`。
- 仓库当前 `.env.example` 写了 `PORT=3900`，所以按模板启动时通常是 `http://localhost:3900`。

### 3. 初始化 Supabase

在 Supabase 项目的 SQL Editor 中执行：

```sql
-- 复制并执行 supabase/schema.sql 的全部内容
```

该脚本会创建：

- `profiles`
- `projects`
- `drafts`
- `finals`
- `style_fingerprints`

并为这些表启用 Row Level Security，核心策略是 `auth.uid() = user_id`。

### 4. 启动 Web 服务

```bash
bun run web
```

打开终端输出中的地址，例如：

```text
http://localhost:3900
```

## 快速开始：CLI / 插件开发

本地直接运行 CLI：

```bash
bun src/cli/index.ts doctor
bun src/cli/index.ts install
bun src/cli/index.ts run "帮我检查这个项目的配置"
bun src/cli/index.ts get-local-version
bun src/cli/index.ts auth list
```

构建发布产物：

```bash
bun run build
```

构建后主要输出：

- `dist/index.js`：OpenCode 插件入口。
- `dist/google-auth.js`：Google Auth 相关导出。
- `dist/web/server.js`：Web server。
- `dist/cli/index.js`：CLI 入口。
- `dist/public/`：Web 静态资源。
- `dist/oh-my-opencode.schema.json`：配置 schema。

## 开发命令

```bash
bun run web        # 启动 Web 写作台
bun run build      # 构建插件、CLI、Web server 和静态资源
bun run typecheck  # TypeScript 类型检查
bun test           # 运行测试
bun run clean      # 删除 dist/
```

## 主要目录结构

```text
src/
  index.ts                         # OpenCode 插件总装配入口
  plugin-config.ts                 # 用户/项目配置读取与合并
  plugin-state.ts                  # 插件运行时状态

  config/
    schema.ts                      # Zod 配置 schema

  hooks/                           # 生命周期 hooks
    claude-code-hooks/             # Claude Code hook 兼容层
    chief-orchestrator/            # Chief 编排与质量反馈
    preemptive-compaction/         # 预防性上下文压缩
    session-recovery/              # 会话恢复
    memory-system/                 # 记忆提取与存储
    ...                            # 其他 hook

  tools/                           # 模型可调用工具适配器
    chief-task/
    background-task/
    skill/
    skill-mcp/
    lsp/
    grep/
    glob/
    interactive-bash/
    knowledge-base/
    ...

  features/                        # 跨 hook/tool 的服务层
    background-agent/
    skill-mcp-manager/
    opencode-skill-loader/
    claude-code-mcp-loader/
    context-injector/
    builtin-skills/
    builtin-commands/
    ...

  agents/                          # 内置 agent 契约
    chief.ts
    researcher.ts
    writer.ts
    editor.ts
    fact-checker.ts
    archivist.ts
    extractor.ts
    deputy.ts

  mcp/                             # MCP 配置与适配
  auth/antigravity/                # Google Antigravity/OAuth 认证适配
  cli/                             # CLI 命令
  shared/                          # 跨模块公共工具

  web/
    server.ts                      # Hono Web 服务
    task-runner.ts                 # 本地 OpenCode task runner
    deepseek.ts                    # OpenAI-compatible LLM 客户端
    supabase.ts                    # Supabase client 工厂
    settings.ts                    # Web 设置读写
    public/                        # Web 前端静态文件

api/
  index.ts                         # Vercel Edge API 入口

supabase/
  schema.sql                       # 数据表、RLS、注册触发器

script/
  build-schema.ts
  generate-changelog.ts
  package-local.sh
  publish.ts
```

## Web API 摘要

本地 Hono 服务提供的主要 API：

- `GET /api/health`
- `GET /api/config`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/refresh`
- `GET /api/auth/me`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/workspace`
- `PUT /api/workspace`
- `GET /api/style-fingerprint`
- `PUT /api/style-fingerprint`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks`
- `POST /api/tasks/:id/approve`
- `GET /api/files`
- `POST /api/files`
- `GET /api/file`
- `GET /api/references`
- `GET /api/reference`

## 配置文件

插件配置会从两个位置读取并合并：

1. 用户级：`~/.config/opencode/newtype-profile.json` 或 `.jsonc`
2. 项目级：`<project>/.opencode/newtype-profile.json` 或 `.jsonc`

项目级配置会覆盖用户级配置。配置由 `src/config/schema.ts` 校验。

常见配置字段：

```jsonc
{
  "disabled_hooks": [
    "session-notification"
  ],
  "disabled_agents": [],
  "disabled_skills": [],
  "disabled_mcps": [],
  "agents": {
    "writer": {
      "category": "writing",
      "temperature": 0.5
    }
  },
  "categories": {
    "writing": {
      "model": "openai/gpt-4.1",
      "temperature": 0.5
    }
  },
  "claude_code": {
    "mcp": true,
    "commands": true,
    "skills": true,
    "agents": true,
    "hooks": true,
    "plugins": true
  },
  "google_auth": true,
  "auto_update": true,
  "mcp": {}
}
```

## 安全说明

- `SUPABASE_SERVICE_ROLE_KEY` 只能在服务端使用，不要暴露给前端。
- Supabase 表已启用 RLS，用户只能访问自己的记录。
- Web 服务会校验工作区路径，避免任意路径逃逸。
- `.env`、本地工作区数据、账号 token、生成产物不应提交到 Git。
- 插件会注册大量工具和 hooks，首次启用前建议运行 `doctor` 检查环境。

