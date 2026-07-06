import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { getTicket, getTicketTimeline } from "@/lib/store";
import { listScans } from "@/lib/scan";
import { readSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";

/** GET /api/tickets/:id — 工单详情 + 审计时间线 + 关联扫描 + 运单快照来源标注 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await store();
  const ticket = await getTicket(db, id);
  if (!ticket) return fail("工单不存在", 404, "NOT_FOUND");

  const [timeline, scans, snapshot] = await Promise.all([
    getTicketTimeline(db, id),
    listScans(db, id),
    readSnapshot(db, ticket.waybillCode),
  ]);

  // 关联赔付/库存流水（可追溯展示）
  const payouts = await db.all<Record<string, unknown>>(
    "SELECT * FROM payout_records WHERE ticket_id = ? ORDER BY created_at ASC",
    [id]
  );
  const ledger = await db.all<Record<string, unknown>>(
    "SELECT * FROM inventory_ledger WHERE ticket_id = ? ORDER BY created_at ASC",
    [id]
  );

  return ok({
    ticket,
    timeline,
    scans,
    payouts,
    ledger,
    waybill: snapshot
      ? {
          ...snapshot,
          dataSourceLabel:
            snapshot.tenant && snapshot.syncedAt
              ? `本地快照，同步于 ${snapshot.syncedAt}`
              : "本地快照",
        }
      : null,
  });
}
