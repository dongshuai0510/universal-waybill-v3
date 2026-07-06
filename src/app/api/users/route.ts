import { NextRequest } from "next/server";
import { store, ok, fail } from "@/lib/api";
import { listUsers } from "@/lib/store";

export const runtime = "nodejs";

/** GET /api/users — 角色演示用户列表（前端下拉切换身份） */
export async function GET(_req: NextRequest) {
  try {
    const s = await store();
    const users = await listUsers(s);
    return ok({ users });
  } catch (e) {
    return fail((e as Error).message, 500, "INTERNAL_ERROR");
  }
}
