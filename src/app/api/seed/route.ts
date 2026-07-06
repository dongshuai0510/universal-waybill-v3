import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { seedDemo } from "@/lib/seed";
import { getTicketStats } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/seed — 生成 ≥200 条演示工单（模块四规模化验证）。
 * 幂等保护：已有足够工单时不重复生成，除非 body.force=true。
 */
export async function POST(req: NextRequest) {
  const db = await store();
  const b = (await req.json().catch(() => ({}))) as { force?: boolean; count?: number };
  const stats = await getTicketStats(db);
  if ((stats.total ?? 0) >= 200 && !b.force) {
    return ok({ ok: true, skipped: true, message: `已有 ${stats.total} 条工单，跳过生成（force=true 可强制）`, stats });
  }
  try {
    const r = await seedDemo(db, b.count ?? 220);
    const after = await getTicketStats(db);
    return ok({ ok: true, created: r.created, stats: after });
  } catch (e) {
    return fail((e as Error).message, 500, "SEED_FAILED");
  }
}
