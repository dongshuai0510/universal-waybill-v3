import { NextRequest } from "next/server";
import { store, ok } from "@/lib/api";
import { sweepTimeouts, sweepQcHoldTimeouts } from "@/lib/timeout-sweeper";

export const runtime = "nodejs";

/**
 * 超时自动流转触发端点（模块二异常分支）。
 *
 * 两种触发方式：
 *  - Vercel Cron 定时命中（vercel.json 中配置），不依赖人工检查。
 *  - 前端“立即扫描超时”按钮手动触发（演示用）。
 *
 * 幂等：sweeper 内部以“状态 + deadline”为前置条件，重复触发不会重复处理。
 */
export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(_req: NextRequest) {
  const db = await store();
  const approval = await sweepTimeouts(db);
  const qcHold = await sweepQcHoldTimeouts(db);
  return ok({ ok: true, approval, qcHold, sweptAt: new Date().toISOString() });
}
