# API 自动重试（st-api-auto-retry）

SillyTavern UI 扩展：**仅**在主对话回复生成失败时（上游 API 可重试错误，如 Custom OpenAI 的 **524** `openai_error`、以及 502 / 503 / 429 / 超时等），自动或经确认后重试。

**不管**扩展更新、翻译、资源拉取、设置、角色卡、存档、主题、世界书等其它网络请求。

**作者：** molot23  
**版本：** 1.2.0

---

## 安装

在 SillyTavern → **扩展** → **为当前用户安装扩展（Install Extension）** 中粘贴：

```text
https://github.com/molot23/st-api-auto-retry
```

安装后刷新页面，在扩展设置中找到 **「API 自动重试」**。已安装用户可在扩展列表中更新，或删除后按上述 URL 重装。

---

## 功能概览（v1.2.0 · 仅对话生成）

- 谨慎劫持 `window.fetch`，**仅**对下列 SillyTavern 服务端「主对话 generate」路径介入（精确 pathname 白名单，不再用 openai / openrouter / custom 等模糊关键词）：
  - `/api/backends/chat-completions/generate`
  - `/api/backends/text-completions/generate`
  - `/api/backends/kobold/generate`
  - `/api/backends/koboldhorde/generate`
  - `/api/novelai/generate`
- **不重试 quiet 旁路生成**（请求体 `type: "quiet"`，如 `generateQuietPrompt` / 总结等）；主对话 `normal` / `continue` / `regenerate` 等会重试。
- **正文识别可重试错误**（不仅看 HTTP 状态码）：SillyTavern 服务端常把上游 524 包装成浏览器侧 HTTP 500/200，错误只出现在 message/body（例如 `Custom OpenAI endpoint failed with status 524: openai_error`）。扩展会 `clone()` 响应体匹配这些模式后再决定是否重试。
- 对可重试 HTTP 状态码、正文匹配、以及网络层 `TypeError`（断连 / 失败）执行重试。
- **不会**在用户取消（`AbortError`）时重试。
- 支持「重试前手动确认」（调试默认开启）与指数退避。
- 最终失败或用户取消时，在返回给 ST 的错误正文（及聊天中的 `[API 错误]` 消息）追加中文状态行，例如：  
  `[API自动重试] 状态：已重试 2/3 次后仍失败（识别到 524 / openai_error）`
- **已移除**：全局 toast `MutationObserver`、宽泛的 `eventSource` 备份钩子、以及会匹配过多 URL 的 `GENERATION_PATH_HINTS` 列表。
- 重试前物化请求 body（字符串 / ArrayBuffer），避免 ReadableStream 只能读一次。

---

## 设置说明

| 设置 | 默认 | 说明 |
|------|------|------|
| **启用扩展** | 开 | 总开关 |
| **重试前手动确认** | **开** | 每次重试前弹出确认框（SillyTavern Popup / `callGenericPopup`，不可用时回退 `window.confirm`），展示错误摘要；只有点同意才继续重试。关闭后不询问、直接自动重试 |
| **最大重试次数** | `3` | 首次失败后最多再试几次 |
| **基础延迟毫秒** | `2000` | 重试前等待时间 |
| **指数退避** | 开 | 延迟 = 基础延迟 × 2^(次数−1) |
| **可重试 HTTP 状态码** | `408,429,500,502,503,504,524` | 逗号分隔，可自行增删；正文命中 524/openai_error 等时即使状态码不在列表也会重试 |

「仅拦截生成相关请求」开关已移除：作用范围**始终**为上表白名单对话 generate 接口。

设置通过 SillyTavern 的 `extensionSettings` 持久化。

---

## 「重试前手动确认」如何工作

1. 主对话 generate 请求失败，且 **HTTP 状态码**或**响应正文**判定为可重试（含包装后的 524）。
2. Toast 提示：`API 失败，等待确认重试…`
3. 弹出确认框，内容含 HTTP 状态 / 错误正文摘要、识别标签、即将进行的重试序号、延迟与 URL。
4. **同意** → Toast `正在重试 n/m`，等待延迟后再次请求。  
   **拒绝** → 取消重试，返回带状态后缀的失败结果（或抛出原网络错误）。
5. 达到最大次数 → Toast `已达最大重试次数`，返回带状态后缀的错误响应。

调试稳定后，建议关闭「重试前手动确认」，以免每次弹窗打断。

---

## 关于 524 与重复计费风险

部分上游 / 反代在 **524**（或网关超时）时，**请求可能已在上游开始计费或占配额**，客户端重试会导致**重复扣费 / 重复占用**。请：

- 先用「重试前手动确认」观察失败频率与错误内容；
- 确认你的供应商对超时/524 的计费规则后再长期开启自动重试；
- 按需收紧状态码列表或降低最大重试次数。

---

## 提示文案（Toast / 聊天）

- `API 失败，等待确认重试…`
- `正在重试 2/3`
- `已达最大重试次数`
- `已取消重试`
- 聊天/错误正文后缀：`[API自动重试] 状态：已重试 n/m 次后仍失败（识别到 …）` 或 `用户取消重试（已失败 n 次）`

---

## 开发说明

- `manifest.json` → 入口 `index.js`，样式 `style.css`，`loading_order: 100`
- 保留原始 `fetch` 引用；仅对启用状态 + 白名单对话 generate 路径生效
- 设置面板注入到 `#extensions_settings2`（或 `#extensions_settings`）

---

## 许可

MIT License — 见 [LICENSE](./LICENSE)
