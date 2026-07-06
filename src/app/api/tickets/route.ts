import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { listTickets, getTicketStats } from "@/lib/store";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";

/** GET /api/tickets — 工单列表（筛选 + 分页 + 统计 + 即将超时标记） */
export async function GET(req: NextRequest) {
  try {
    const s = await store();
    const sp = new URL(req.url).searchParams;
    const page = Math.max(1, Number(sp.get("page") ?? 1));
    const pageSize = Math.min(100, Number(sp.get("pageSize") ?? 20));
    const { tickets, total } = await listTickets(s, {
      status: sp.get("status") || undefined,
      category: sp.get("category") || undefined,
      source: sp.get("source") || undefined,
      waybillCode: sp.get("waybillCode") || undefined,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const stats = await getTicketStats(s);
    const cfg = await getConfig(s);
    const now = Date.now();
    // 即将超时标记：剩余时间小于 nearTimeoutMinutes
    const enriched = tickets.map((t) => {
      let nearTimeout = false;
      let overdue = false;
      if (t.deadlineAt && ["pending", "l1_reviewing", "l2_reviewing"].includes(t.status)) {
        const remain = new Date(t.deadlineAt).getTime() - now;
        overdue = remain <= 0;
        nearTimeout = !overdue && remain < cfg.nearTimeoutMinutes * 60_000;
      }
      return { ...t, nearTimeout, overdue };
    });
    return ok({ tickets: enriched, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), stats });
  } catch (e) {
    return fail((e as Error).message, 500, "INTERNAL_ERROR");
  }
}
