import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { fastRelease } from "@/lib/scan";
import { nanoid } from "nanoid";

export const runtime = "nodejs";

/** POST /api/tickets/[id]/fast-release — 品控主管误判快速放行（仅 qc_supervisor） */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await store();
  const user = currentUser(req);
  let body: { reason?: string; opToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail("请求体解析失败", 400);
  }
  const r = await fastRelease(s, {
    ticketId: id,
    operator: user,
    reason: body.reason ?? "",
    opToken: body.opToken || "fr_" + nanoid(10),
  });
  if (!r.ok) return fail(r.message, r.code === "FORBIDDEN" ? 403 : r.code === "CONFLICT" ? 409 : 400, r.code);
  return ok(r);
}
