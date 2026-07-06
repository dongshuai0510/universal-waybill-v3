/**
 * 扫描品控操作（模块零，考点 7）。
 *
 *  - 扫描录入：必须先通过 V2 接口校验 SKU 归属于真实运单。
 *  - 品控判定：调用 qc-engine 可配置规则；记录命中规则 + 判定依据（可追溯）。
 *  - 品控暂扣：判异常 → 批次锁定 + 自动创建工单（来源=scan）+ 库存 locked。
 *  - 幂等性：同批次存在未关闭品控工单时，重复扫描只追加扫描记录，不新建工单。
 *  - 误判快速放行：仅品控主管可操作，绕过审批直接解锁 + 关闭工单，留痕。
 *
 * 批次锁定与解锁涉及“扫描记录 + 库存 + 工单”多表，用单事务保证一致性。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import type { Ticket, ScanRecord } from "./types";
import { runQc, type ScanInput } from "./qc-engine";
import {
  createTicket,
  findOpenQcTicketByBatch,
  getTicket,
  getUserRoles,
  rowToScan,
} from "./store";

const now = () => new Date().toISOString();

export function batchKeyOf(waybillCode: string, skuCode: string): string {
  return `${waybillCode}::${skuCode}`;
}

export interface ScanResult {
  ok: boolean;
  code?: string;
  message: string;
  verdict?: "pass" | "fail";
  reason?: string;
  scanId?: string;
  ticket?: Ticket | null;
  idempotentHit?: boolean;
}

/**
 * 处理一次扫描。SKU 归属校验由调用方（route）先行完成并传入 skuBelongs。
 * 这里聚焦品控判定 + 暂扣 + 工单 + 幂等。
 */
export async function handleScan(
  store: Store,
  input: {
    waybillCode: string;
    skuCode: string;
    operator: string;
    device?: string;
    qc: ScanInput;
    amount: number;
    aiSuggestion?: string | null;
  }
): Promise<ScanResult> {
  const batchKey = batchKeyOf(input.waybillCode, input.skuCode);

  // 品控判定（可配置规则引擎）
  const verdict = await runQc(store, input.qc);
  const scanId = "sc_" + nanoid(10);
  const ts = now();

  // 通过：直接记录，批次可出库
  if (verdict.verdict === "pass") {
    await store.run(
      `INSERT INTO scan_records
         (id, waybill_code, sku_code, batch_no, operator, device, qc_result,
          matched_rule_id, judge_reason, batch_lock_status, ticket_id, scan_time, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [scanId, input.waybillCode, input.skuCode, batchKey, input.operator, input.device ?? "manual",
       "pass", null, verdict.reason, "shippable", null, ts, ts]
    );
    return { ok: true, message: "品控通过，批次可出库", verdict: "pass", reason: verdict.reason, scanId };
  }

  // 异常：先看幂等 —— 同批次是否已有未关闭品控工单
  const existing = await findOpenQcTicketByBatch(store, batchKey);
  if (existing) {
    // 只追加扫描记录，不新建工单、不重置暂扣
    await store.run(
      `INSERT INTO scan_records
         (id, waybill_code, sku_code, batch_no, operator, device, qc_result,
          matched_rule_id, judge_reason, batch_lock_status, ticket_id, scan_time, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [scanId, input.waybillCode, input.skuCode, batchKey, input.operator, input.device ?? "manual",
       "fail", verdict.matchedRuleId, verdict.reason, "qc_hold", existing.id, ts, ts]
    );
    return {
      ok: true,
      idempotentHit: true,
      message: `该批次已存在未关闭品控工单（${existing.id}），仅追加扫描记录，未重复创建工单`,
      verdict: "fail",
      reason: verdict.reason,
      scanId,
      ticket: existing,
    };
  }

  // 新异常：创建品控工单（来源=scan），破损高危规则强制起始层级
  const ticket = await createTicket(store, {
    category: "qc",
    exceptionType: verdict.subType ?? "quantity_mismatch",
    source: "scan",
    waybillCode: input.waybillCode,
    skuCode: input.skuCode,
    batchKey,
    amount: input.amount,
    description: `扫描自动触发品控异常：${verdict.reason}`,
    reporter: input.operator,
    aiSuggestion: input.aiSuggestion ?? null,
    forceStartLevel: verdict.autoApprovalLevel,
  });

  // 扫描记录 + 库存批次锁定（品控暂扣）单事务
  await store.tx([
    {
      text: `INSERT INTO scan_records
               (id, waybill_code, sku_code, batch_no, operator, device, qc_result,
                matched_rule_id, judge_reason, batch_lock_status, ticket_id, scan_time, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [scanId, input.waybillCode, input.skuCode, batchKey, input.operator, input.device ?? "manual",
               "fail", verdict.matchedRuleId, verdict.reason, "qc_hold", ticket.id, ts, ts],
    },
    {
      // 库存批次锁定：品控暂扣期间该批次不可被其他运单引用
      text: `INSERT INTO inventory (id, sku_code, batch_no, waybill_code, quantity, locked, locked_by_ticket, updated_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO NOTHING`,
      params: ["inv_" + nanoid(8), input.skuCode, batchKey, input.waybillCode, 1, 1, ticket.id, ts],
    },
  ]);

  return {
    ok: true,
    message: "品控异常，批次已暂扣（锁定），已自动创建品控工单",
    verdict: "fail",
    reason: verdict.reason,
    scanId,
    ticket,
  };
}

/** 是否该批次被其他运单锁定（品控暂扣期间不可引用） */
export async function isBatchLocked(store: Store, skuCode: string, batchKey: string): Promise<boolean> {
  const r = await store.get<{ locked: number }>(
    "SELECT locked FROM inventory WHERE sku_code=? AND batch_no=? AND locked=1",
    [skuCode, batchKey]
  );
  return !!r;
}

export async function listScans(store: Store, ticketId: string): Promise<ScanRecord[]> {
  const rows = await store.all<Record<string, unknown>>(
    "SELECT * FROM scan_records WHERE ticket_id = ? ORDER BY scan_time ASC",
    [ticketId]
  );
  return rows.map(rowToScan);
}

export async function listRecentScans(store: Store, limit = 50): Promise<ScanRecord[]> {
  const rows = await store.all<Record<string, unknown>>(
    "SELECT * FROM scan_records ORDER BY scan_time DESC LIMIT ?",
    [limit]
  );
  return rows.map(rowToScan);
}

/**
 * 误判快速放行（仅品控主管）：绕过审批直接解锁批次 + 关闭工单，留痕复核原因。
 * 后端强制校验角色，不允许静默放行。
 */
export async function fastRelease(
  store: Store,
  input: { ticketId: string; operator: string; reason: string; opToken: string }
): Promise<{ ok: boolean; code?: string; message: string }> {
  const roles = await getUserRoles(store, input.operator);
  if (roles.length === 0) return { ok: false, code: "FORBIDDEN", message: "账号不存在或已被禁用" };
  if (!roles.includes("qc_supervisor")) {
    return { ok: false, code: "FORBIDDEN", message: "仅品控主管可执行误判快速放行" };
  }
  if (!input.reason?.trim()) {
    return { ok: false, code: "INVALID", message: "必须填写复核原因（不允许静默放行）" };
  }
  const ticket = await getTicket(store, input.ticketId);
  if (!ticket) return { ok: false, code: "NOT_FOUND", message: "工单不存在" };
  if (ticket.category !== "qc") return { ok: false, code: "INVALID", message: "仅品控工单可快速放行" };
  if (["done", "closed_rejected", "closed_timeout", "closed_fast_release"].includes(ticket.status)) {
    return { ok: false, code: "INVALID_STATE", message: `工单已关闭（${ticket.status}）` };
  }

  const ts = now();
  const apId = "ap_" + nanoid(10);
  try {
    const counts = await store.tx([
      {
        text: `UPDATE tickets SET status='closed_fast_release', version=version+1, updated_at=?, closed_at=?
               WHERE id=? AND status NOT IN ('done','closed_rejected','closed_timeout','closed_fast_release')`,
        params: [ts, ts, input.ticketId],
      },
      {
        text: `INSERT INTO approval_records
                 (id, ticket_id, approver_id, level, action, opinion, result, op_token, from_status, to_status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        params: [apId, input.ticketId, input.operator, null, "fast_release",
                 `品控主管误判快速放行：${input.reason}`, "fast_release", input.opToken, ticket.status, "closed_fast_release", ts],
      },
      { text: `UPDATE scan_records SET batch_lock_status='released' WHERE ticket_id=?`, params: [input.ticketId] },
      { text: `UPDATE inventory SET locked=0, locked_by_ticket=NULL, updated_at=? WHERE locked_by_ticket=?`, params: [ts, input.ticketId] },
    ]);
    if (counts[0] === 0) return { ok: false, code: "CONFLICT", message: "工单已被处理，请刷新" };
  } catch (e) {
    if (/unique|constraint/i.test((e as Error).message)) return { ok: true, message: "已放行（幂等）" };
    throw e;
  }
  return { ok: true, message: "已快速放行，批次解锁，工单关闭（已留痕）" };
}
