import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { resolveWaybill } from "@/lib/snapshot";

export const runtime = "nodejs";

/**
 * GET /api/waybill?code=XXX
 * 实时解析运单：调 V2 校验存在性 + 详情；V2 挂了降级本地快照并标注来源。
 * 返回 dataSource（v2-live / v2-cache）供前端明确标注数据来源。
 */
export async function GET(req: NextRequest) {
  const code = new URL(req.url).searchParams.get("code")?.trim();
  if (!code) return fail("缺少运单号 code", 400, "MISSING_PARAM");
  const db = await store();
  const r = await resolveWaybill(db, code);
  if (r.source === "not_found") {
    return fail(
      r.degradeNote ?? `运单不存在或校验失败：${code}（Request ID: ${r.requestId}）`,
      404,
      "WAYBILL_NOT_FOUND"
    );
  }
  return ok({
    waybill: r.waybill,
    dataSource: r.source,
    requestId: r.requestId,
    degradeNote: r.degradeNote ?? null,
  });
}
