import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { reassignTicket, getUserRoles } from "@/lib/store";

export const runtime = "nodejs";

/**
 * POST /api/tickets/:id/reassign — 审批人离职/禁用兜底：转交他人
 * body: { newAssignee, reason }
 * 权限：需 admin 或 approver 角色（避免任意人转交）。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await store();
  const operator = currentUser(req);
  const roles = await getUserRoles(db, operator);
  if (!roles.some((r) => ["admin", "approver_l1", "approver_l2", "qc_supervisor"].includes(r))) {
    return fail("无权转交工单", 403, "FORBIDDEN");
  }
  const b = (await req.json().catch(() => ({}))) as { newAssignee?: string; reason?: string };
  if (!b.newAssignee) return fail("缺少 newAssignee", 400, "MISSING_PARAM");
  if (!b.reason?.trim()) return fail("必须填写转交原因（留痕）", 400, "MISSING_REASON");

  const r = await reassignTicket(db, {
    ticketId: id,
    newAssignee: b.newAssignee,
    operator,
    reason: b.reason,
  });
  if (!r.ok) return fail(r.message, 400, r.code);
  return ok({ ok: true, message: r.message });
}
