import { NextRequest } from "next/server";
import { lowDb } from "@/lib/db/driver";
import { ensureSeed, seedDemo } from "@/lib/seed";
import { ok, fail } from "@/lib/api";

export const runtime = "nodejs";

/**
 * POST /api/bootstrap — 初始化数据库 + 可选填充演示数据。
 *  body: { demo?: boolean, count?: number }
 * 幂等：重复调用只在数据不足时补数据。
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { demo?: boolean; count?: number };
    const store = await lowDb();
    await ensureSeed(store);
    let created = 0;
    if (body.demo) {
      const existing = await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets");
      if (!existing || existing.n < 200) {
        const r = await seedDemo(store, body.count ?? 220);
        created = r.created;
      }
    }
    return ok({ initialized: true, demoCreated: created });
  } catch (e) {
    return fail((e as Error).message, 500, "BOOTSTRAP_ERROR");
  }
}

/** GET /api/bootstrap — 只做 schema 初始化（首次访问自愈） */
export async function GET() {
  try {
    const store = await lowDb();
    await ensureSeed(store);
    return ok({ initialized: true });
  } catch (e) {
    return fail((e as Error).message, 500, "BOOTSTRAP_ERROR");
  }
}
