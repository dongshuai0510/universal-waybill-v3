import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { approveTicket, flagWaybillIfNeeded } from "@/lib/store";

export const runtime = "nodejs";

/**
 * POST /api/tickets/:id/approve — 审批（通过/拒绝）
 * body: { decision: "approve"|"reject", opinion, expectedVersion, opToken }
 *
 * 权限：上报人不能审批自己的工单；层级必须匹配；账号需启用（后端强制校验）。
 * 并发：乐观锁 version。幂等：opToken 唯一 + 状态前置校验。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await store();
  const approver = currentUser(req);
  const b = (await req.json().catch(() => ({}))) as {
    decision?: "approve" | "reject";
    opinion?: string;
    expectedVersion?: number;
    opToken?: string;
  };
  if (b.decision !== "approve" && b.decision !== "reject") {
    return fail("decision 必须是 approve 或 reject", 400, "MISSING_PARAM");
  }
  if (typeof b.expectedVersion !== "number") {
    return fail("缺少 expectedVersion（并发控制必需）", 400, "MISSING_VERSION");
  }
  if (!b.opToken) return fail("缺少 opToken（幂等控制必需）", 400, "MISSING_TOKEN");

  const r = await approveTicket(db, {
    ticketId: id,
    approver,
    decision: b.decision,
    opinion: b.opinion ?? "",
    expectedVersion: b.expectedVersion,
    opToken: b.opToken,
  });

  if (!r.ok) {
    const statusMap: Record<string, number> = {
      CONFLICT: 409,
      FORBIDDEN: 403,
      INVALID_STATE: 409,
      NOT_FOUND: 404,
      DUPLICATE: 200,
    };
    return fail(r.message, statusMap[r.code ?? ""] ?? 400, r.code);
  }

  // 异常处理中：回写 V2 标记（可选加分项，失败不阻塞）
  await flagWaybillIfNeeded(db, id).catch(() => {});

  return ok({ ok: true, message: r.message, ticket: r.ticket });
}
