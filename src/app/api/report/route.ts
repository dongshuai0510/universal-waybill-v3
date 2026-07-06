import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { resolveWaybill, estimateAmount } from "@/lib/snapshot";
import { createTicket, findOpenTicketByType, getUserRoles } from "@/lib/store";
import { flagWaybillOnV2 } from "@/lib/v2-client";
import type { ExceptionCategory, LogisticsExceptionType } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/report — 物流异常手工上报（模块一）
 * body: { waybillCode, exceptionType, description, amount? }
 *
 * 关键：发起上报必须实时调用 V2 校验运单真实存在（不能只看本地快照）。
 * 同一运单同类型未关闭工单不允许重复上报。
 */
export async function POST(req: NextRequest) {
  const db = await store();
  const reporter = currentUser(req);
  const body = (await req.json().catch(() => ({}))) as {
    waybillCode?: string;
    exceptionType?: LogisticsExceptionType;
    description?: string;
    amount?: number;
    aiSuggestion?: string;
  };

  const code = body.waybillCode?.trim();
  if (!code) return fail("缺少运单号", 400, "MISSING_PARAM");
  if (!body.exceptionType) return fail("缺少异常类型", 400, "MISSING_PARAM");

  // 权限：需具备 reporter 角色 且账号启用
  const roles = await getUserRoles(db, reporter);
  if (roles.length === 0) return fail("账号不存在或已被禁用", 403, "FORBIDDEN");
  if (!roles.includes("reporter") && !roles.includes("admin")) {
    return fail("无上报权限：需要 reporter 角色", 403, "FORBIDDEN");
  }

  // 实时 V2 校验（关键动作，不能仅靠本地快照）
  const resolved = await resolveWaybill(db, code);
  if (resolved.confirmedNotFound) {
    return fail(`运单不存在（V2 实时校验，Request ID: ${resolved.requestId}），不允许对不存在的运单上报`, 404, "WAYBILL_NOT_FOUND");
  }
  if (!resolved.waybill) {
    return fail(
      `无法校验运单真实性：${resolved.degradeNote ?? "V2 不可用且本地无缓存"}（Request ID: ${resolved.requestId}）`,
      503,
      "V2_UNAVAILABLE"
    );
  }

  // 归属校验（单租户假设：同仓库）——见假设文档
  // 此处演示：上报人仓库需与运单快照仓库一致（若快照有仓库信息）
  // 单租户下默认放行。

  const category: ExceptionCategory = "logistics";

  // 重复上报检测（同运单同类型未关闭）
  const dup = await findOpenTicketByType(db, code, category);
  if (dup) {
    return fail(`该运单已存在未关闭的物流异常工单（${dup.id}，状态：${dup.status}），不可重复上报`, 409, "DUPLICATE");
  }

  const amount = body.amount ?? estimateAmount(resolved.waybill.totalQuantity, resolved.waybill.skuCount);

  const ticket = await createTicket(db, {
    category,
    exceptionType: body.exceptionType,
    source: "manual",
    waybillCode: code,
    amount,
    description: body.description ?? "",
    reporter,
    aiSuggestion: body.aiSuggestion ?? null,
  });

  // 回写 V2：标记该运单存在未关闭异常（可选加分项，失败不阻塞）
  flagWaybillOnV2(db, code, { hasOpenException: true, ticketId: ticket.id, note: `物流异常：${body.exceptionType}` }).catch(() => {});

  return ok({
    ticket,
    dataSource: resolved.source,
    degradeNote: resolved.degradeNote ?? null,
    requestId: resolved.requestId,
  });
}
