# API 自动重试（st-api-auto-retry）

SillyTavern UI 扩展：**仅**在主对话回复生成失败时（上游 API 可重试错误，如 Custom OpenAI 的 **524** `openai_error`、以及 502 / 503 / 429 / 超时等），以及 HTTP 200 空回复，自动或经确认后重试。

**不管**扩展更新、翻译、资源拉取、设置、角色卡、存档、主题、世界书等其它网络请求。

**作者：** molot23  
**版本：** 1.4.0

---

## 安装

在 SillyTavern → **扩展** → **为当前用户安装扩展（Install Extension）** 中粘贴：

```text
https://github.com/molot23/st-api-auto-retry
```

安装后刷新页面，在扩展设置中找到 **「API 自动重试」**。已安装用户可在扩展列表中更新，或删除后按上述 URL 重装。

---

## 功能概览（v1.4.0 · 空回复重试）

- 谨慎劫持 `window.fetch`，**仅**对下列 SillyTavern 服务端「主对话 generate」路径介入（精确 pathname 白名单）：
  - `/api/backends/chat-completions/generate`
  - `/api/backends/text-completions/generate`
  - `/api/backends/kobold/generate`
  - `/api/backends/koboldhorde/generate`
  - `/api/novelai/generate`
- **不重试 quiet 旁路生成**（请求体 `type: "quiet"`）；主对话 `normal` / `continue` / `regenerate` / `swipe` 等会重试。
- **正文识别可重试错误**（不仅看 HTTP 状态码）：SillyTavern 服务端常把上游 524 包装成浏览器侧 HTTP 500/200，错误只出现在 message/body。
- **空回复重试（v1.4.0）**：HTTP 200 且未被识别为 API 错误时，若助手内容为空则按可重试失败处理（标签「空回复」），走同一套确认 / 气泡 / 退避重试。
  - 非流式 JSON：检查 `choices` 为空、`choices[0].message.content` 缺失/null/空白、或 text-completion 的 `choices[0].text` 空白；已有 `error` 字段的不重复计为空回复；带 `tool_calls` / `function_call` 的不算空。
  - 流式 SSE：在现有 `response.clone().text()` 缓冲整段流之后解析 `data:` 行并累加 delta/content；若 `Content-Type` 为 `text/event-stream` 或正文为 SSE，可在**流结束后**判定空回复。不会在流中途提前截断。若 clone/读流失败则可能漏检（见下方限制）。
  - 用户中止 / abort / cancelled 标记不会当空回复重试。
- **重试状态气泡（v1.3.0）**：首次可重试失败时，向当前对话插入**一条**助手/系统错误气泡，显示简短中文失败原因、重试进度与下次重试时间；同一条气泡在重试过程中原地更新，不叠加多条。
  - **成功**：移除该气泡（chat 数组 + DOM），再把成功的 `Response` 交还给等待中的 ST fetch，由 ST 正常渲染回复。
  - **全部失败 / 用户取消确认**：保留该气泡并改写为最终失败或「已取消重试」文案；优先以 `AbortError` 结束本次生成，避免 ST 再叠一条 `[API 错误]`，并做尾部去重兜底。
- 支持「重试前手动确认」（调试默认开启）与指数退避。
- 重试前物化请求 body（字符串 / ArrayBuffer），避免 ReadableStream 只能读一次。

---

## 设置说明

| 设置 | 默认 | 说明 |
|------|------|------|
| **启用扩展** | 开 | 总开关 |
| **重试前手动确认** | **开** | 每次重试前弹出确认框；拒绝后状态气泡改为「已取消重试」并中止 |
| **空回复也重试** | **开** | HTTP 200 但模型未返回有效助手内容时，按可重试错误处理（「空回复」） |
| **最大重试次数** | `3` | 首次失败后最多再试几次 |
| **基础延迟毫秒** | `2000` | 重试前等待时间 |
| **指数退避** | 开 | 延迟 = 基础延迟 × 2^(次数−1) |
| **可重试 HTTP 状态码** | `408,429,500,502,503,504,524` | 逗号分隔；正文命中 524/openai_error 等时即使状态码不在列表也会重试 |

作用范围**始终**为上表白名单对话 generate 接口。设置通过 SillyTavern 的 `extensionSettings` 持久化。

---

## 状态气泡示例

```text
[API自动重试]
原因：524 / openai_error
进度：将重试 1/3
下次重试：约 2 秒后（12:34:56）
```

确认开启时：

```text
[API自动重试]
原因：524 / openai_error
进度：等待确认是否重试 1/3
确认后延迟：约 2 秒后（12:34:56）
```

全部失败后保留：

```text
[API自动重试]
原因：524 / openai_error
状态：已重试 3/3 次后仍失败
已保留此错误气泡（不再自动重试）
```

---

## 「重试前手动确认」如何工作

1. 主对话 generate 失败，且 HTTP 状态码或响应正文判定为可重试。
2. 插入/更新状态气泡；Toast：`API 失败，等待确认重试…`
3. 弹出确认框（错误摘要、识别标签、重试序号、延迟、URL）。
4. **同意** → 气泡改为「将重试 n/m」+ 下次时间，延迟后再次请求。  
   **拒绝** → 气泡改为「已取消重试」，`AbortError` 结束，避免重复错误气泡。
5. 达到最大次数 → 气泡改为最终失败文案并保留；`AbortError` 结束 + 去重兜底。

调试稳定后，建议关闭「重试前手动确认」。

---

## 关于 524 与重复计费风险

部分上游 / 反代在 **524**（或网关超时）时，**请求可能已在上游开始计费或占配额**，客户端重试会导致**重复扣费 / 重复占用**。请：

- 先用「重试前手动确认」观察失败频率与错误内容；
- 确认你的供应商对超时/524 的计费规则后再长期开启自动重试；
- 按需收紧状态码列表或降低最大重试次数。

---

## 提示文案（Toast / 气泡）

- `API 失败，等待确认重试…`
- `正在重试 2/3`
- `已达最大重试次数`
- `已取消重试`
- 聊天气泡：`[API自动重试]` + 原因 / 进度 / 下次重试 / 最终状态

---

## 开发说明

- `manifest.json` → 入口 `index.js`，样式 `style.css`，`loading_order: 100`
- 通过 `SillyTavern.getContext()` 使用 `chat`、`addOneMessage`、`updateMessageBlock`、`deleteMessage`、`saveChat`（即 `saveChatConditional`）管理状态气泡
- 气泡带 `extra.type = st_api_auto_retry_placeholder`、`is_system: true`，并在支持时设置 `symbols.ignore`，避免进入后续提示词；成功返回前先移除气泡，以免干扰 swipe / `saveReply` 的 last-message 判定
- 保留原始 `fetch` 引用；仅对启用状态 + 白名单对话 generate 路径生效

---

## 空回复检测说明

判定发生在 HTTP/正文错误模式**未**命中之后，且「空回复也重试」开启时：

1. **非流式 JSON（完整支持）**：OpenAI chat `choices[0].message.content`、text completion `choices[0].text`、空 `choices` 数组。
2. **流式 SSE（有条件支持）**：与现有正文错误检测相同，先 `clone()` 再读完整 body；流结束后解析 SSE 累加内容。浏览器仍可从原始 Response 读流（tee）。**不会**在首个空 chunk 时立刻重试。
3. **限制**：若响应无法 clone、或流在缓冲前失败，可能无法识别空回复；非 OpenAI 形态的后端格式（如部分 Kobold/NovelAI 包装）若不含 `choices`，不会被当成空回复。

示例气泡原因行：`原因：空回复`。

---

## 许可

MIT License — 见 [LICENSE](./LICENSE)
