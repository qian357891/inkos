/**
 * MiniMax
 *
 * - 官网：https://www.minimax.io/
 * - 控制台 / API key：https://platform.minimaxi.com/user-center/basic-information/interface-key
 * - API 文档：https://platform.minimaxi.com/document/platform%20introduction
 * - 模型列表：https://platform.minimaxi.com/document/text
 *
 * inkos 用 MiniMax 官方 OpenAI-compatible Chat 接入：
 * https://api.minimaxi.com/v1/chat/completions
 * MiniMax 没有公开的 /models 端点，模型清单只能按官方文档手维护。
 *
 * 关于 stream 默认值：v1.6.2 之前 transportDefaults 是 { stream: false }，这是 8af863ea
 * 从 anthropic-messages 阶段沿留下来的兜底——当时为了绕开 OpenAI 兼容的工具调用不稳。
 * 现在 endpoint 已经迁回 OpenAI 兼容且补了 `compat.requiresAssistantAfterToolResult`，
 * 1.4 万字长章节在 sync 模式下网络抖动就会触发 PartialResponseError，整章从头重写。
 * 改成 { stream: true } 后依赖 SSE 增量解析，单次 timeout 风险大幅下降，Studio UI
 * 也能看到渐进写章节过程。用户依然可以用 inkos.json/INKOS_LLM_STREAM=false 手动覆盖。
 *
 * 关于 compat：MiniMax M2/M2.7 走 OpenAI-compatible chat completions，遇到 tool_call
 * 历史结尾会拒绝；和 deepseek 一样需要 requiresAssistantAfterToolResult=true 桥接。
 */
import type { InkosEndpoint } from "../types.js";

export const MINIMAX: InkosEndpoint = {
  id: "minimax",
  label: "MiniMax",
  group: "china",
  api: "openai-completions",
  baseUrl: "https://api.minimaxi.com/v1",
  checkModel: "MiniMax-M2.7",
  transportDefaults: { stream: true },
  compat: { requiresAssistantAfterToolResult: true },
  temperatureRange: [0, 1],
  defaultTemperature: 0.9,
  writingTemperature: 0.9,
models: [
    { id: "MiniMax-M3", maxOutput: 131072, contextWindowTokens: 1_000_000, enabled: true, releasedAt: "2026-07-01" },
    { id: "MiniMax-M2.7", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2026-03-18" },
    { id: "MiniMax-M2.7-highspeed", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2026-03-18" },
    { id: "MiniMax-M2.5", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2026-02-12" },
    { id: "MiniMax-M2.5-highspeed", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2026-02-12" },
    { id: "M2-her", maxOutput: 2048, contextWindowTokens: 65536, enabled: true, releasedAt: "2026-01-23" },
    { id: "MiniMax-M2.1", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2025-12-23" },
    { id: "MiniMax-M2.1-highspeed", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2025-12-23" },
    { id: "MiniMax-M2", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2025-10-27" },
    { id: "MiniMax-M2-Stable", maxOutput: 131072, contextWindowTokens: 204800, enabled: true, releasedAt: "2025-10-27" },
    { id: "MiniMax-M1", maxOutput: 40000, contextWindowTokens: 1000192, enabled: true, releasedAt: "2025-06-16" },
    { id: "MiniMax-Text-01", maxOutput: 40000, contextWindowTokens: 1000192, enabled: true, releasedAt: "2025-01-15" },
    ],
};
