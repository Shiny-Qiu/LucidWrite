<p align="right">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# LucidWrite

**带云端同步、用户账号和结构化多阶段写作流程的浏览器 AI 写作工作台。**

LucidWrite 是一个本地运行的 Web 写作工具，通过 AI Agent 引导你完成从选题到终稿的每个阶段。用户账号和所有写作数据（项目、草稿、风格指纹）存储在 Supabase 数据库，并通过行级安全策略（RLS）隔离——每个用户只能看到自己的内容。

## 功能特点

- **结构化写作流程** — 七个顺序阶段：选题交互 → 大纲框架 → 初稿敲定 → 内容精修 → 事实核查 → 质量评分 → 终稿敲定。
- **实时 AI 协作** — 右侧对话实时修改左侧草稿，AI 每次返回完整更新后的文章，不只是片段。
- **用户账号** — 基于 Supabase Auth 的邮箱注册和登录，注册需邮件确认。
- **行级安全存储** — 项目、草稿、终稿、风格指纹均存储于 Supabase，RLS 策略确保用户间数据物理隔离。
- **风格指纹** — 导入历史文章，让 AI 学习并保持你的写作风格。
- **本地工作区** — 通过左侧文件树或 `@` 指令引用本地 Markdown 文件或目录作为上下文。
- **LLM 无关** — 通过环境变量支持 DeepSeek、OpenAI 或任意 OpenAI 兼容接口。

## 环境要求

| 工具 | 版本 | 安装方式 |
|------|------|----------|
| [Bun](https://bun.sh/) | ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| Supabase 项目 | — | [supabase.com](https://supabase.com) |
| LLM API Key | — | DeepSeek / OpenAI / 兼容接口 |

## 快速开始

### 1. 克隆并安装依赖

```bash
git clone https://github.com/Shiny-Qiu/LucidWrite.git
cd LucidWrite
bun install
```

### 2. 配置 Supabase

在 [supabase.com](https://supabase.com) 创建项目后，在 **SQL Editor** 中执行建表脚本：

```bash
# 将 supabase/schema.sql 的全部内容粘贴到 Supabase SQL Editor 中执行
```

脚本会创建五张数据表（`profiles` / `projects` / `drafts` / `finals` / `style_fingerprints`），为所有表开启 RLS，并安装注册时自动创建 profile 的触发器。

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# Supabase（必填）
SUPABASE_URL=https://<project_ref>.supabase.co
SUPABASE_ANON_KEY=sb_publishable_xxxxxxxxxxxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxxxxx

# LLM 模型 — DeepSeek 示例（也支持其他 OpenAI 兼容接口）
EDITAI_LLM_API_KEY=sk-xxxxxxxxxxxx
EDITAI_LLM_BASE_URL=https://api.deepseek.com
EDITAI_LLM_MODEL=deepseek-chat
EDITAI_LLM_MAX_RETRIES=3
EDITAI_LLM_TIMEOUT_MS=60000
```

### 4. 启动

```bash
bun run web
```

打开 **http://localhost:3899**，注册账号后即可开始写作。

## 写作流程

| 阶段 | 说明 |
|------|------|
| 选题交互 | 采访式对话，确定文章角度和核心议题 |
| 大纲框架 | 生成并调整结构化大纲 |
| 初稿敲定 | 基于确认后的大纲生成完整初稿 |
| 内容精修 | AI 内容分析，按需直接修改正文 |
| 事实核查 | 逐条核查，确认后修正正文 |
| 质量评分 | 结构、论据、风格、清晰度全维度评分 |
| 终稿敲定 | 最终微调，保存 `final.md` |

在每个阶段，右侧对话框中的任何指令都可以修改左侧文章。AI 始终返回**完整的更新后文章**，而不是片段。

## 认证流程

```
注册 → Supabase 发送确认邮件
     → 用户点击链接 → 跳回 localhost:3899
     → 前端自动解析 Token → 完成登录

登录 → POST /api/auth/login → 服务端调用 Supabase Auth REST API
     → 返回 JWT → 存储在 localStorage
     → 后续所有请求携带 Authorization: Bearer <JWT>
     → 服务端验证 JWT → RLS 执行每用户数据隔离
```

## 项目结构

```
src/web/
  server.ts        # Hono 服务端：auth 端点 + Supabase 数据库路由
  supabase.ts      # 服务端 Supabase 客户端工厂
  deepseek.ts      # LLM 客户端（DeepSeek / OpenAI 兼容）
  task-runner.ts   # AI 任务执行引擎
  task-prompts.ts  # 各模式 Prompt 模板
  public/
    index.html     # 应用主框架 + 登录注册 UI
    app.js         # 前端状态、认证、API 调用
    styles.css     # 界面样式
supabase/
  schema.sql       # 数据表 + RLS 策略 + 注册触发器
```

## 环境变量说明

| 变量 | 是否必填 | 说明 |
|------|----------|------|
| `SUPABASE_URL` | ✓ | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` | ✓ | 公开 anon key（用于客户端配置接口） |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | 服务角色 key（仅服务端使用，可绕过 RLS） |
| `EDITAI_LLM_API_KEY` | ✓ | LLM API Key |
| `EDITAI_LLM_BASE_URL` | ✓ | LLM 接口地址（OpenAI 兼容） |
| `EDITAI_LLM_MODEL` | ✓ | 模型名称 |
| `EDITAI_LLM_MAX_RETRIES` | — | 失败重试次数（默认 3） |
| `EDITAI_LLM_TIMEOUT_MS` | — | 请求超时毫秒数（默认 60000） |

## 开发命令

```bash
bun run web        # 启动本地 Web 服务
bun run build      # 构建 CLI、插件、Web 服务和静态资源
bun run typecheck  # TypeScript 类型检查
bun test           # 运行测试
bun run clean      # 删除 dist/
```

## 安全说明

- `.env` 和 `.mcp.json` 已加入 `.gitignore`，不会提交到仓库。
- `SUPABASE_SERVICE_ROLE_KEY` 可绕过 RLS，仅在服务端使用，绝不暴露给前端。
- 所有数据表均强制 RLS：每次操作都验证 `auth.uid() = user_id`。
- Supabase Auth 要求邮件确认后才能登录。

## 仓库

GitHub：<https://github.com/Shiny-Qiu/LucidWrite>
