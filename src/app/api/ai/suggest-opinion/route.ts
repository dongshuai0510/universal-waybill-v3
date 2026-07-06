import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { suggestApprovalOpinion } from "@/lib/ai";
import type { ExceptionCategory, ExceptionType } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/ai/suggest-opinion — 基于历史审批记录给出“建议审批意见”
 * body: { category, exceptionType, amount }
 *
 * 必须说明依据（参考了哪几条历史记录），标注“AI 建议，需人工确认”，不阻塞主流程。
 */
export async function POST(req: NextRequest) {
  const db = await store();
  const b = (await req.json().catch(() => ({}))) as {
    category?: ExceptionCategory;
    exceptionType?: ExceptionType;
    amount?: number;
  };
  if (!b.category || !b.exceptionType) {
    return fail("缺少 category / exceptionType", 400, "MISSING_PARAM");
  }
  const r = await suggestApprovalOpinion(db, {
    category: b.category,
    exceptionType: b.exceptionType,
    amount: b.amount ?? 0,
  });
  return ok(r);
}
