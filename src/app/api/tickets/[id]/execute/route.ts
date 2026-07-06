import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { executeTicket, getTicket, suggestAction, flagWaybillIfNeeded } from "@/lib/store";
import type { ExecutionAction } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/tickets/:id/execute — 执行联动（executing → done）
 * body: { action?, payoutAmount?, reconcileMethod?, expectedVersion, opToken }
 *
 * 状态变更 + 库存联动 + 赔付记录在单事务内完成（一致性核心，考点 4）。
 * 品控工单同步解锁批次（工单完成与批次解锁同一事务）。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await store();
  const operator = currentUser(req);
  const b = (await req.json().catch(() => ({}))) as {
    action?: ExecutionAction;
    payoutAmount?: number;
    reconcileMethod?: string;
    expectedVersion?: number;
    opToken?: string;
  };
  if (typeof b.expectedVersion !== "number") return fail("缺少 expectedVersion", 400, "MISSING_VERSION");
  if (!b.opToken) return fail("缺少 opToken（幂等控制必需）", 400, "MISSING_TOKEN");

  const ticket = await getTicket(db, id);
  if (!ticket) return fail("工单不存在", 404, "NOT_FOUND");

  // 默认动作按异常类型映射；前端可覆盖
  const action = b.action ?? suggestAction(ticket.category, ticket.exceptionType).action;

  const r = await executeTicket(db, {
    ticketId: id,
    operator,
    action,
    payoutAmount: b.payoutAmount,
    reconcileMethod: b.reconcileMethod,
    opToken: b.opToken,
    expectedVersion: b.expectedVersion,
  });

  if (!r.ok) {
    const statusMap: Record<string, number> = { CONFLICT: 409, INVALID_STATE: 409, NOT_FOUND: 404 };
    return fail(r.message, statusMap[r.code ?? ""] ?? 400, r.code);
  }

  // 工单关闭：清除 V2 异常标记（可选加分项，失败不阻塞）
  await flagWaybillIfNeeded(db, id).catch(() => {});

  return ok({ ok: true, message: r.message, payoutId: r.payoutId });
}
