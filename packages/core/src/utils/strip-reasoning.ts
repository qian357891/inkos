/**
 * Reasoning/thinking 标签剥离。
 *
 * 部分 LLM（MiniMax-M2.7 / MiniMax-M3 / DeepSeek-R1 等）在启用 thinking 模式后，
 * 会把内部推理过程以原始 XML 标签（`###、`<reasoning>`、`<thinking>`）
 * 塞进 assistant `content` 字段，而不是通过结构化 `reasoning_content` 字段返回。
 * 由于 inkos 的下游 parser（architect 的 5 段 SECTION 切片、writer 的
 * parseCreativeOutput、planner 的 parseMemo）都只看 content 字段，thinking
 * 标签会让：
 *
 * 1. 第一个 SECTION 误并入 thinking 块剩余内容
 * 2. 未闭合标签被 SSE 切片截断时，整个输出解析错位
 *
 * 解决方案：在每个 agent 的 parser 入口前过一道 strip。OpenAI o-series、
 * Anthropic Claude extended thinking 等走专属 reasoning_content 字段的
 * provider 不受影响（本工具什么都不做），属于防御性的纯字符串预处理。
 *
 * 影响面：本工具纯函数，无副作用，行为可逆（无 reasoning 内容时是 identity）。
 * Architect / Writer / Planner 三个 agent 已经接入；后续如果新 agent 也消费
 * 模型 content，照这个 pattern 加即可。
 *
 * 已知标签：
 * - `###（MiniMax-M2.7 / MiniMax-M3 / DeepSeek-R1）
 * - `<thinking>...</thinking>`（Anthropic Claude 风格，但 Claude 不走这条路径）
 * - `<reasoning>...</reasoning>`（OpenAI 风格部分实现）
 *
 * 未闭合标签处理：从开标签到字符串末尾都剥掉，理由是被 SSE 切片时
 * 一个 thinking 过程经常会跨多个 chunk，没闭合就等于内容是 thinking。
 */

/**
 * 支持的开标签。匹配时大小写不敏感。
 */
const REASONING_OPEN_TAGS = ["think", "thinking", "reasoning"] as const;

/**
 * 匹配一个可能带属性的标签，包括自闭合：`<tag>`、`<tag attr=v>`、`<tag/>`、`<tag attr=v/>`。
 * group(1) 是属性 + `>` 或 `/>`。
 */
function openingTagPattern(tag: string): RegExp {
  return new RegExp(`<${tag}\\b[^>]*>`, "gi");
}

/**
 * 闭合的 reasoning 块（贪心 + 懒惰组合）：先把所有闭合块剥掉。
 * 闭标签也允许有属性、可以有空白。
 */
function stripClosedBlocks(content: string): string {
  let result = content;
  for (const tag of REASONING_OPEN_TAGS) {
    // 闭标签不强制尺寸：吃换行 + 多行内容；闭标签允许属性。
    const closedPattern = new RegExp(
      `<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\b[^>]*>`,
      "gi",
    );
    result = result.replace(closedPattern, "");
  }
  return result;
}

/**
 * 未闭合的 opening tag：被 SSE 中途切片时经常出现。
 * 处理策略：从开标签出现位置到字符串末尾都剥掉，整个内容视作 thinking。
 * 例如：
 *   "<thinking>思考片段……还没闭合"
 * 应该被剥成空。
 */
function stripTrailingReasoning(content: string): string {
  let result = content;
  for (const tag of REASONING_OPEN_TAGS) {
    // 注意：这里保留闭标签形状的 greediness。但只对未闭合的做剥离，
    // 所以闭标签成对的已经在 stripClosedBlocks 里先剥了。
    const trailingPattern = new RegExp(
      `<${tag}\\b[^>]*>[\\s\\S]*$`,
      "i",
    );
    result = result.replace(trailingPattern, "");
  }
  return result;
}

export function stripReasoning(content: string): string {
  if (!content) return content;
  // 顺序很重要：先把所有成对闭合块剥掉；如果还有开标签，说明是未闭合，
  // 把开标签到末尾整个剥掉。最后 trim，避免开头残留换行。
  return stripTrailingReasoning(stripClosedBlocks(content)).trim();
}
