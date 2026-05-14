<p align="right">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# editAI

**本地优先的 AI 写作工作台，用于调研、写作、编辑、事实核查和全流程内容生产。**

editAI 是一个本地 Web 写作工具，参考了 newtype OS 的多 Agent 内容生产思路，但它不是 newtype OS CLI 产品。newtype OS 是基于 OpenCode 二次开发的 CLI/TUI 产品；editAI 的定位是浏览器里的个人写作工作台，运行在本地，支持配置模型 Key、浏览本地 Markdown 文件、引入项目上下文，并通过对话完成内容创作。

## editAI 能做什么

- 提供一屏式本地写作工作台，适合个人内容生产。
- 可视化调研、写作、编辑、核查、分析、提取、归档、全流程等模式。
- 支持多轮对话，后续提问会结合前文上下文判断。
- 支持通过左侧文件树或输入框 `@` 指令引用 Markdown 文件和目录。
- 对助手输出的 Markdown 进行渲染，包括标题、列表、表格、引用和代码块。
- 全流程模式支持先生成大纲，用户修改或确认后再继续写作。
- 本地设置存储在 `.newtype/web-settings.json`，以兼容现有运行时结构。

## 当前状态

本项目当前面向个人本地使用。后续可以扩展为 Web 产品，但第一版有意保持数据和写作文件都在本地目录中。

## 环境要求

- [Bun](https://bun.sh/)
- DeepSeek API Key，或通过本地设置配置其他模型供应商
- 一个本地 Markdown 工作目录

## 快速开始

```bash
bun install
cp .env.example .env
bun run web
```

打开：

```text
http://localhost:3899
```

如果默认端口被占用：

```bash
PORT=3900 bun run web
```

## 环境配置

本地使用时，在 `.env` 中配置模型：

```bash
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

不要提交真实 API Key。`.env` 已被 Git 忽略。

## Web 工作台

界面分为三个区域：

- 左侧：本地工作目录、文件树和目录切换。
- 中间：模式切换、Agent 状态、对话和输入框。
- 右侧：Agent 每一步建议的提炼总览，用作写作参考方向。

在输入框中输入 `@` 可以搜索当前工作目录下的 Markdown 文件或目录。选择文件会把该文件作为上下文；选择目录会聚合目录下的 Markdown 内容作为上下文。

## 可用模式

| 模式 | 用途 |
| --- | --- |
| 主编 | 自由对话，并判断应使用哪种创作能力 |
| 调研 | 搜集背景、来源说明和内容角度 |
| 写作 | 生成 Markdown 草稿 |
| 编辑 | 优化结构、段落、句子和措辞 |
| 核查 | 验证事实声明，标记薄弱来源 |
| 分析 | 使用结构化框架拆解问题 |
| 提取 | 清洗和结构化已有内容 |
| 归档 | 组织或检索本地知识材料 |
| 全流程 | 先确认大纲，再完成内容生产 |

## 开发命令

```bash
bun run web        # 启动本地 Web 应用
bun run build      # 构建 CLI、插件、Web 服务和静态资源
bun run typecheck  # TypeScript 类型检查
bun test           # 运行 Bun 测试
bun run clean      # 删除 dist/
```

## 与 newtype OS 的关系

editAI 借鉴了 newtype OS 的多 Agent 内容生产架构，但二者不是同一个产品。editAI 的安装方式、运行方式和主要交互界面都不同。用户应按本 README 作为本地 Web 写作工作台运行，而不是按 `@newtype-os/cli` 或 OpenCode 插件的方式安装。

## 仓库

GitHub：<https://github.com/pengcong2020520/edit-ai>
