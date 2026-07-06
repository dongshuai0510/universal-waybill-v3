import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { classifyException, suggestApprovalOpinion } from "@/lib/ai";
import type { ExceptionCategory, ExceptionType } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/ai/classify — AI 辅助（可选加分项）
 *  mode=classify: { text, category } → 建议异常类型 + 严重度 + 依据
 *  mode=opinion:  { category, exceptionType, amount } → 建议审批意见 + 依据 + 参考记录
 *
 * 所有返回均带 disclaimer「AI 建议，需人工确认」。
 * AI 失败/超时不阻塞：classify 内部已回退启发式。
 */
export async function POST(req: NextRequest) {
  const db = await store();
  const b = (await req.json().catch(() => ({}))) as {
    mode?: "classify" | "opinion";
    text?: string;
    category?: ExceptionCategory;
    exceptionType?: ExceptionType;
    amount?: number;
  };
  const mode = b.mode ?? "classify";
  const category: ExceptionCategory = b.category === "qc" ? "qc" : "logistics";

  if (mode === "opinion") {
    if (!b.exceptionType) return fail("缺少 exceptionType", 400, "MISSING_PARAM");
    const r = await suggestApprovalOpinion(db, {
      category,
      exceptionType: b.exceptionType,
      amount: b.amount ?? 0,
    });
    return ok({ mode, ...r });
  }

  if (!b.text?.trim()) return fail("缺少 text（异常描述）", 400, "MISSING_PARAM");
  const r = await classifyException(b.text, category);
  return ok({ mode, ...r });
}
