import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { checkSkuBelongs } from "@/lib/v2-client";
import { resolveWaybill, estimateAmount } from "@/lib/snapshot";
import { handleScan, listRecentScans } from "@/lib/scan";
import { getUserRoles } from "@/lib/store";
import type { ScanInput } from "@/lib/qc-engine";

export const runtime = "nodejs";

/** GET /api/scan — 最近扫描记录 */
export async function GET() {
  const db = await store();
  const scans = await listRecentScans(db, 50);
  return ok({ scans });
}

/**
 * POST /api/scan — 扫描录入 + 品控判定（模块零）
 * body: { waybillCode, skuCode, expectedQty?, actualQty?, damageLevel?, specDeviationPct?, labelError?, batchError?, device? }
 *
 * 必须先通过 V2 接口校验 SKU 归属于真实运单。
 */
export async function POST(req: NextRequest) {
  const db = await store();
  const operator = currentUser(req);
  const b = (await req.json().catch(() => ({}))) as {
    waybillCode?: string;
    skuCode?: string;
    expectedQty?: number;
    actualQty?: number;
    damageLevel?: number;
    specDeviationPct?: number;
    labelError?: boolean;
    batchError?: boolean;
    device?: string;
    aiSuggestion?: string;
  };

  const code = b.waybillCode?.trim();
  const skuCode = b.skuCode?.trim();
  if (!code || !skuCode) return fail("缺少运单号或 SKU 编码", 400, "MISSING_PARAM");

  const roles = await getUserRoles(db, operator);
  if (roles.length === 0) return fail("账号不存在或已被禁用", 403, "FORBIDDEN");

  // 1) 实时校验 SKU 归属于该运单（V2 接口）
  const skuRes = await checkSkuBelongs(db, code, skuCode);
  if (!skuRes.ok) {
    if (skuRes.meta.statusCode === 404) {
      return fail(`运单不存在（Request ID: ${skuRes.meta.requestId}）`, 404, "WAYBILL_NOT_FOUND");
    }
    return fail(
      `SKU 归属校验失败：V2 不可用（${skuRes.meta.errorCode}，Request ID: ${skuRes.meta.requestId}）`,
      503,
      "V2_UNAVAILABLE"
    );
  }
  if (!skuRes.data?.belongs) {
    return fail(`该 SKU「${skuCode}」不属于运单「${code}」，拒绝扫描（防止扫到无关货物）`, 422, "SKU_NOT_IN_WAYBILL");
  }

  // 运单金额（用于品控工单分级）
  const resolved = await resolveWaybill(db, code);
  const amount = resolved.waybill
    ? estimateAmount(resolved.waybill.totalQuantity, resolved.waybill.skuCount)
    : 1000;

  // 2) 品控判定 + 暂扣 + 工单（可配置规则引擎）
  const expectedQty = b.expectedQty ?? skuRes.data.matchedSku?.quantity ?? 0;
  const qc: ScanInput = {
    expectedQty,
    actualQty: b.actualQty ?? expectedQty,
    damageLevel: b.damageLevel ?? 0,
    specDeviationPct: b.specDeviationPct ?? 0,
    labelError: !!b.labelError,
    batchError: !!b.batchError,
  };

  const result = await handleScan(db, {
    waybillCode: code,
    skuCode,
    operator,
    device: b.device,
    qc,
    amount,
    aiSuggestion: b.aiSuggestion ?? null,
  });

  return ok({ ...result, skuBelongs: true, requestId: skuRes.meta.requestId });
}
