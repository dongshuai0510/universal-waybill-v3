/**
 * AI 辅助（可选加分项）。
 *
 * 两个能力：
 *  (a) 根据异常描述文本 → 建议异常类型 + 严重度；
 *  (b) 根据历史审批记录 → 建议审批意见（必须说明依据：参考了哪几条历史记录）。
 *
 * 硬性原则（题目要求）：
 *  - 所有 AI 输出必须标注「AI 建议，需人工确认」，不自动执行。
 *  - 建议审批意见必须说明依据，不能是黑箱结论。
 *  - AI 超时/失败不阻塞主流程：默认走本地启发式（heuristic），
 *    仅当配置了 LLM Key 时才尝试调用大模型，失败即回退启发式。
 */
import type { Store } from "./db/driver";
import type { ExceptionCategory, ExceptionType } from "./types";

export interface AiClassifyResult {
  suggestedType: ExceptionType;
  suggestedCategory: ExceptionCategory;
  severity: "low" | "medium" | "high";
  confidence: number;
  basis: string; // 判断依据
  source: "heuristic" | "llm";
  disclaimer: string; // 固定："AI 建议，需人工确认"
}

const DISCLAIMER = "AI 建议，需人工确认";

/** 关键词 → 异常类型 的启发式映射表 */
const LOGISTICS_KEYWORDS: Array<{ kw: string[]; type: ExceptionType; sev: "low" | "medium" | "high" }> = [
  { kw: ["丢", "丢件", "丢失", "找不到", "遗失"], type: "lost", sev: "high" },
  { kw: ["破", "破损", "损坏", "碎", "压坏", "变形"], type: "damaged", sev: "high" },
  { kw: ["拒收", "拒签", "不要了", "退回"], type: "rejected", sev: "medium" },
  { kw: ["超时", "未签收", "迟迟", "太久", "延误"], type: "overtime", sev: "medium" },
  { kw: ["地址", "地址错", "收货地址", "改地址", "错误地址"], type: "wrong_address", sev: "low" },
];

const QC_KEYWORDS: Array<{ kw: string[]; type: ExceptionType; sev: "low" | "medium" | "high" }> = [
  { kw: ["数量", "少了", "多了", "差", "短装", "缺"], type: "quantity_mismatch", sev: "medium" },
  { kw: ["外观", "破损", "刮花", "脏"], type: "appearance_damage", sev: "high" },
  { kw: ["规格", "型号", "尺寸", "不符", "偏差"], type: "spec_mismatch", sev: "medium" },
  { kw: ["标签", "条码", "贴错", "标错"], type: "label_error", sev: "low" },
  { kw: ["批次", "批号", "效期", "过期"], type: "batch_abnormal", sev: "high" },
];

/** 本地启发式分类：关键词匹配，永远可用、零依赖、不阻塞 */
export function heuristicClassify(text: string, category: ExceptionCategory): AiClassifyResult {
  const table = category === "qc" ? QC_KEYWORDS : LOGISTICS_KEYWORDS;
  const hits: string[] = [];
  let best: (typeof table)[number] | null = null;
  for (const entry of table) {
    const matched = entry.kw.filter((k) => text.includes(k));
    if (matched.length > 0) {
      hits.push(`「${matched.join("/")}」→ ${entry.type}`);
      if (!best || matched.length > 0) best = best ?? entry;
    }
  }
  const chosen = best ?? table[0];
  return {
    suggestedType: chosen.type,
    suggestedCategory: category,
    severity: chosen.sev,
    confidence: best ? 0.7 : 0.3,
    basis: best
      ? `命中关键词：${hits.join("；")}`
      : `未命中明确关键词，回退默认类型「${chosen.type}」，请人工确认`,
    source: "heuristic",
    disclaimer: DISCLAIMER,
  };
}

/** 分类入口：优先 LLM（若配置），失败/超时回退启发式，绝不阻塞主流程 */
export async function classifyException(
  text: string,
  category: ExceptionCategory
): Promise<AiClassifyResult> {
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!key) return heuristicClassify(text, category);
  try {
    const llm = await llmClassify(text, category, key);
    return llm ?? heuristicClassify(text, category);
  } catch {
    // LLM 超时/失败：回退启发式，主流程不受影响
    return heuristicClassify(text, category);
  }
}

/** LLM 分类（可选；带 6s 超时；失败返回 null 由上层回退） */
async function llmClassify(
  text: string,
  category: ExceptionCategory,
  apiKey: string
): Promise<AiClassifyResult | null> {
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  const types =
    category === "qc"
      ? "quantity_mismatch, appearance_damage, spec_mismatch, label_error, batch_abnormal"
      : "lost, damaged, rejected, overtime, wrong_address";
  const prompt = `你是物流品控异常分类助手。根据异常描述，从以下类型中选一个最匹配的，并给出严重度(low/medium/high)与判断依据。\n可选类型：${types}\n异常描述：${text}\n只返回 JSON：{"type":"...","severity":"...","basis":"..."}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = j.content?.[0]?.text ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { type: string; severity: string; basis: string };
    return {
      suggestedType: parsed.type as ExceptionType,
      suggestedCategory: category,
      severity: (parsed.severity as "low" | "medium" | "high") || "medium",
      confidence: 0.85,
      basis: `大模型（${model}）判断：${parsed.basis}`,
      source: "llm",
      disclaimer: DISCLAIMER,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 建议审批意见：基于同类历史审批记录，给出参考意见并明确说明依据
 * （参考了哪几条历史记录），不是黑箱。纯本地统计，不依赖外部服务。
 */
export async function suggestApprovalOpinion(
  store: Store,
  input: { category: ExceptionCategory; exceptionType: ExceptionType; amount: number }
): Promise<{ suggestion: string; basis: string; references: string[]; disclaimer: string }> {
  // 取同类型工单的历史审批动作
  const rows = await store.all<{ id: string; action: string; opinion: string; ticket_id: string }>(
    `SELECT ar.id, ar.action, ar.opinion, ar.ticket_id
     FROM approval_records ar
     JOIN tickets t ON t.id = ar.ticket_id
     WHERE t.exception_type = ? AND ar.action IN ('approve','reject')
     ORDER BY ar.created_at DESC LIMIT 10`,
    [input.exceptionType]
  );
  const approves = rows.filter((r) => r.action === "approve").length;
  const rejects = rows.filter((r) => r.action === "reject").length;
  const total = approves + rejects;
  const refs = rows.slice(0, 3).map((r) => `${r.id}（${r.action === "approve" ? "通过" : "拒绝"}）`);

  let suggestion: string;
  if (total === 0) {
    suggestion = "暂无同类历史审批记录，建议人工独立判断";
  } else if (approves >= rejects) {
    suggestion = `建议「通过」：同类「${input.exceptionType}」历史 ${total} 条中 ${approves} 条通过`;
  } else {
    suggestion = `建议「拒绝/复核」：同类「${input.exceptionType}」历史 ${total} 条中 ${rejects} 条被拒`;
  }

  return {
    suggestion,
    basis:
      total === 0
        ? "无历史样本"
        : `统计了最近 ${total} 条同类型（${input.exceptionType}）审批记录：通过 ${approves} / 拒绝 ${rejects}`,
    references: refs,
    disclaimer: DISCLAIMER,
  };
}
