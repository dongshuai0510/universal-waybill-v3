/**
 * API 路由共享工具：统一 store 获取（含首次初始化）、当前用户解析、JSON 响应。
 *
 * 用户身份（演示用）：通过请求头 x-user-id 传入（前端下拉切换角色）。
 * 真实系统应走登录会话；这里简化以聚焦业务逻辑，但后端仍严格按角色校验权限。
 */
import { NextRequest, NextResponse } from "next/server";
import { lowDb, type Store } from "./db/driver";
import { ensureSeed } from "./seed";

let _inited = false;

/** 获取 store 并保证基础种子（角色/规则/配置）已就绪 */
export async function store(): Promise<Store> {
  const db = await lowDb();
  if (!_inited) {
    await ensureSeed(db);
    _inited = true;
  }
  return db;
}

/** 当前操作用户（演示：来自 x-user-id 头，默认 op_wang） */
export function currentUser(req: NextRequest): string {
  return req.headers.get("x-user-id") || "op_wang";
}

export function ok(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function fail(message: string, status = 400, code?: string): NextResponse {
  return NextResponse.json({ error: code ?? "ERROR", message }, { status });
}
