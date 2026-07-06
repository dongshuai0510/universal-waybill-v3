import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { getConfig, saveConfig, type V3Config } from "@/lib/config";
import { getUserRoles } from "@/lib/store";

export const runtime = "nodejs";

/** GET /api/config — 读取可配置项（审批阈值/超时/重提上限） */
export async function GET() {
  const db = await store();
  const cfg = await getConfig(db);
  return ok({ config: cfg });
}

/** PUT /api/config — 更新配置（仅 admin，后台可调阈值，非改代码） */
export async function PUT(req: NextRequest) {
  const db = await store();
  const roles = await getUserRoles(db, currentUser(req));
  if (!roles.includes("admin")) {
    return fail("仅管理员可修改配置", 403, "FORBIDDEN");
  }
  const body = (await req.json().catch(() => ({}))) as Partial<V3Config>;
  const current = await getConfig(db);
  const merged: V3Config = { ...current, ...body };
  await saveConfig(db, merged);
  return ok({ ok: true, config: merged });
}
