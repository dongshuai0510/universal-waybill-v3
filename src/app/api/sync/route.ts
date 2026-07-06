import { NextRequest } from "next/server";
import { store, ok } from "@/lib/api";
import { fetchWaybills, v2Meta } from "@/lib/v2-client";
import { upsertSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";

/**
 * GET /api/sync — 接口状态/同步监控（模块五）
 *   返回：最近同步时间、成功率、最近接口调用日志（含 Request ID）、V2 配置。
 * POST /api/sync — 主动触发一次运单列表同步（刷新本地快照）。
 */
export async function GET() {
  const db = await store();

  const logs = await db.all<Record<string, unknown>>(
    `SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 50`
  );
  const agg = await db.get<{ total: number; ok: number }>(
    `SELECT COUNT(*) AS total, SUM(success) AS ok FROM sync_log`
  );
  const last = await db.get<{ created_at: string }>(
    `SELECT created_at FROM sync_log WHERE success=1 ORDER BY created_at DESC LIMIT 1`
  );
  const total = Number(agg?.total) || 0;
  const okCount = Number(agg?.ok) || 0;

  return ok({
    v2: v2Meta,
    lastSuccessSyncAt: last?.created_at ?? null,
    successRate: total > 0 ? Math.round((okCount / total) * 1000) / 10 : null,
    totalCalls: total,
    successCalls: okCount,
    logs: logs.map((l) => ({
      requestId: l.request_id,
      api: l.api_name,
      method: l.method,
      params: l.params_summary,
      statusCode: l.status_code,
      success: Number(l.success) === 1,
      durationMs: l.duration_ms,
      errorCode: l.error_code,
      errorMessage: l.error_message,
      createdAt: l.created_at,
    })),
  });
}

export async function POST() {
  const db = await store();
  const r = await fetchWaybills(db, { page: 1, pageSize: 100 });
  let synced = 0;
  if (r.ok && r.data) {
    for (const w of r.data.waybills) {
      await upsertSnapshot(db, w, "v2-live");
      synced++;
    }
  }
  return ok({
    ok: r.ok,
    synced,
    requestId: r.meta.requestId,
    degraded: !r.ok,
    message: r.ok
      ? `已从 V2 同步 ${synced} 条运单快照`
      : `V2 不可用（${r.meta.errorCode ?? "未知"}），同步失败，可继续使用本地缓存`,
    meta: r.meta,
  });
}
