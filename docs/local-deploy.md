# editAI 本地部署说明

这是一份简易部署说明，适合把 editAI 发给其他人后在本地运行。

## 1. 安装 Bun

先确认电脑已安装 Bun：

```bash
bun --version
```

如果没有安装，可参考 Bun 官网安装方式：https://bun.sh/

## 2. 解压项目

解压收到的压缩包后进入项目目录：

```bash
cd edit-ai
```

## 3. 安装依赖

```bash
bun install
```

## 4. 配置模型

复制环境变量模板：

```bash
cp .env.example .env
```

打开 `.env`，填写自己的模型配置。DeepSeek 示例：

```bash
DEEPSEEK_API_KEY=你的 API Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
PORT=3900
```

如果 DeepSeek 繁忙，也可以使用其他 OpenAI-compatible 服务：

```bash
EDITAI_LLM_API_KEY=你的 API Key
EDITAI_LLM_BASE_URL=服务商的 Base URL
EDITAI_LLM_MODEL=模型名称
```

## 5. 启动

```bash
bun run web
```

浏览器打开：

```text
http://localhost:3900
```

## 6. 使用说明

- 首次进入会要求创建文章项目。
- 项目内容保存在本地工作目录的 `editai_note/` 下。
- 用户历史文章风格指纹保存在 `.editai/` 下。
- `.env`、`editai_note/`、`.editai/` 都是本地数据，不要上传或发给别人。

## 7. 重新打包

如果需要重新生成给他人的本地部署包：

```bash
script/package-local.sh
```

默认输出到 `output/` 目录，也可以指定输出目录：

```bash
script/package-local.sh /tmp
```
