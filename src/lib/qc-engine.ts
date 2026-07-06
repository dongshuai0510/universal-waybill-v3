/**
 * 品控规则引擎（考点 7）。
 *
 * 设计理念延续 V2 的“规则引擎而非硬编码”：
 *  - 触发条件（数量差异阈值 / 破损等级 / 规格偏差范围等）存于 qc_rules 表，后台可配置。
 *  - 引擎按优先级遍历启用规则，命中即判定异常，并记录“命中规则 ID + 判定依据”，可追溯。
 *  - 规则决定：异常子类型、严重度、是否自动创建工单、自动进入哪级审批。
 *
 * 绝不出现 `if (diffPct > 10)` 这类硬编码；阈值全部来自规则行。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import type { QcRule, QcExceptionType, ApprovalLevel } from "./types";

export interface ScanInput {
  /** 应发数量（来自运单 SKU 明细） */
  expectedQty: number;
  /** 实到数量（扫描录入） */
  actualQty: number;
  /** 破损等级 0-5（0 无破损） */
  damageLevel: number;
  /** 规格偏差百分比（0 表示完全符合） */
  specDeviationPct: number;
  /** 标签是否异常 */
  labelError: boolean;
  /** 批次是否异常（如效期/批号不符） */
  batchError: boolean;
}

export interface QcVerdictResult {
  verdict: "pass" | "fail";
  matchedRuleId: string | null;
  subType: QcExceptionType | null;
  severity: "low" | "medium" | "high" | null;
  autoCreateTicket: boolean;
  autoApprovalLevel: ApprovalLevel;
  reason: string;
}

/** 计算数量差异百分比（绝对值） */
function qtyDiffPct(input: ScanInput): number {
  if (input.expectedQty <= 0) return input.actualQty > 0 ? 0 : 100;
  return Math.abs((input.actualQty - input.expectedQty) / input.expectedQty) * 100;
}

/** 评估单条规则是否命中，命中则给出判定依据文本 */
function evalRule(rule: QcRule, input: ScanInput): { hit: boolean; reason: string } {
  switch (rule.conditionType) {
    case "quantity_diff_pct": {
      const diff = qtyDiffPct(input);
      const hit = diff >= rule.threshold;
      return {
        hit,
        reason: `数量差异 ${diff.toFixed(1)}% ${hit ? "≥" : "<"} 阈值 ${rule.threshold}%（应发 ${input.expectedQty}，实到 ${input.actualQty}）`,
      };
    }
    case "damage_level": {
      const hit = input.damageLevel >= rule.threshold;
      return { hit, reason: `破损等级 ${input.damageLevel} ${hit ? "≥" : "<"} 阈值 ${rule.threshold}` };
    }
    case "spec_deviation": {
      const hit = input.specDeviationPct >= rule.threshold;
      return { hit, reason: `规格偏差 ${input.specDeviationPct}% ${hit ? "≥" : "<"} 阈值 ${rule.threshold}%` };
    }
    case "label_flag": {
      const hit = input.labelError;
      return { hit, reason: hit ? "标签异常标记为真" : "标签正常" };
    }
    case "batch_flag": {
      const hit = input.batchError;
      return { hit, reason: hit ? "批次异常标记为真" : "批次正常" };
    }
    default:
      return { hit: false, reason: "未知规则类型" };
  }
}

/** 读取启用的品控规则（按优先级 priority 升序，值越小越先评估） */
export async function loadQcRules(store: Store): Promise<QcRule[]> {
  const rows = await store.all<Record<string, unknown>>(
    "SELECT * FROM qc_rules WHERE enabled = 1 ORDER BY priority ASC, created_at ASC"
  );
  return rows.map(rowToRule);
}

export function rowToRule(r: Record<string, unknown>): QcRule {
  const cond = JSON.parse((r.condition_json as string) || "{}");
  return {
    id: r.id as string,
    name: (r.description as string) || (r.sub_type as string),
    exceptionSubtype: r.sub_type as QcExceptionType,
    conditionType: cond.conditionType,
    threshold: Number(cond.threshold ?? 0),
    severity: r.severity as "low" | "medium" | "high",
    autoCreateTicket: Number(r.auto_create_ticket) === 1,
    autoApprovalLevel: (Number(r.auto_approval_level) as ApprovalLevel) || 1,
    enabled: Number(r.enabled) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.created_at),
  };
}

/**
 * 执行品控判定：按优先级遍历规则，命中第一条即判异常。
 * 全部未命中 → 通过。返回命中规则、判定依据（可追溯）。
 */
export async function runQc(store: Store, input: ScanInput): Promise<QcVerdictResult> {
  const rules = await loadQcRules(store);
  const trace: string[] = [];
  for (const rule of rules) {
    const { hit, reason } = evalRule(rule, input);
    trace.push(`[规则 ${rule.id}/${rule.exceptionSubtype}] ${reason}`);
    if (hit) {
      return {
        verdict: "fail",
        matchedRuleId: rule.id,
        subType: rule.exceptionSubtype,
        severity: rule.severity,
        autoCreateTicket: rule.autoCreateTicket,
        autoApprovalLevel: rule.autoApprovalLevel,
        reason: `命中品控规则「${rule.name}」：${reason}`,
      };
    }
  }
  return {
    verdict: "pass",
    matchedRuleId: null,
    subType: null,
    severity: null,
    autoCreateTicket: false,
    autoApprovalLevel: 1,
    reason: `品控通过：所有启用规则均未命中（评估 ${rules.length} 条）`,
  };
}

/** 默认品控规则集（首次初始化时写入；后台可增删改） */
export function defaultQcRules(): Array<{
  subType: QcExceptionType;
  description: string;
  condition: { conditionType: QcRule["conditionType"]; threshold: number };
  severity: "low" | "medium" | "high";
  autoApprovalLevel: ApprovalLevel;
  priority: number;
}> {
  return [
    {
      subType: "quantity_mismatch",
      description: "数量不符：实到与应发差异 ≥ 5%",
      condition: { conditionType: "quantity_diff_pct", threshold: 5 },
      severity: "medium",
      autoApprovalLevel: 1,
      priority: 10,
    },
    {
      subType: "appearance_damage",
      description: "外观破损：破损等级 ≥ 3 级",
      condition: { conditionType: "damage_level", threshold: 3 },
      severity: "high",
      autoApprovalLevel: 2,
      priority: 20,
    },
    {
      subType: "spec_mismatch",
      description: "规格不符：规格偏差 ≥ 10%",
      condition: { conditionType: "spec_deviation", threshold: 10 },
      severity: "medium",
      autoApprovalLevel: 1,
      priority: 30,
    },
    {
      subType: "label_error",
      description: "标签错误：标签异常标记",
      condition: { conditionType: "label_flag", threshold: 1 },
      severity: "low",
      autoApprovalLevel: 1,
      priority: 40,
    },
    {
      subType: "batch_abnormal",
      description: "批次异常：批号/效期异常标记",
      condition: { conditionType: "batch_flag", threshold: 1 },
      severity: "high",
      autoApprovalLevel: 2,
      priority: 50,
    },
  ];
}

/** 写入一条品控规则 */
export async function insertQcRule(
  store: Store,
  rule: {
    subType: QcExceptionType;
    description: string;
    condition: { conditionType: QcRule["conditionType"]; threshold: number };
    severity: "low" | "medium" | "high";
    autoApprovalLevel: ApprovalLevel;
    priority: number;
    autoCreateTicket?: boolean;
  }
): Promise<string> {
  const id = "qr_" + nanoid(8);
  await store.run(
    `INSERT INTO qc_rules
       (id, sub_type, description, condition_json, severity, auto_create_ticket,
        auto_approval_level, enabled, priority, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      rule.subType,
      rule.description,
      JSON.stringify(rule.condition),
      rule.severity,
      rule.autoCreateTicket === false ? 0 : 1,
      rule.autoApprovalLevel,
      1,
      rule.priority,
      new Date().toISOString(),
    ]
  );
  return id;
}
