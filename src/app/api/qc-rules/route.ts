import { NextRequest } from "next/server";
import { store, currentUser, ok, fail } from "@/lib/api";
import { loadQcRules, insertQcRule } from "@/lib/qc-engine";
import { getUserRoles } from "@/lib/store";
import type { QcRule, QcExceptionType, ApprovalLevel } from "@/lib/types";

export const runtime = "nodejs";

/** GET /api/qc-rules — 列出启用的品控规则（可配置项，非硬编码） */
export async function GET() {
  const db = await store();
  const rules = await loadQcRules(db);
  return ok({ rules });
}

/** POST /api/qc-rules — 新增品控规则（仅 admin / qc_supervisor） */
export async function POST(req: NextRequest) {
  const db = await store();
  const roles = await getUserRoles(db, currentUser(req));
  if (!roles.includes("admin") && !roles.includes("qc_supervisor")) {
    return fail("仅管理员或品控主管可配置品控规则", 403, "FORBIDDEN");
  }
  const b = (await req.json().catch(() => ({}))) as {
    subType?: QcExceptionType;
    description?: string;
    conditionType?: QcRule["conditionType"];
    threshold?: number;
    severity?: "low" | "medium" | "high";
    autoApprovalLevel?: ApprovalLevel;
    priority?: number;
  };
  if (!b.subType || !b.conditionType || typeof b.threshold !== "number") {
    return fail("缺少参数 subType / conditionType / threshold", 400, "MISSING_PARAM");
  }
  const id = await insertQcRule(db, {
    subType: b.subType,
    description: b.description ?? `${b.subType} 规则`,
    condition: { conditionType: b.conditionType, threshold: b.threshold },
    severity: b.severity ?? "medium",
    autoApprovalLevel: b.autoApprovalLevel ?? 1,
    priority: b.priority ?? 100,
  });
  return ok({ ok: true, id });
}
