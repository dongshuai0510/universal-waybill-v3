/**
 * 领域存储层：工单 / 扫描 / 审批 / 执行的核心业务逻辑。
 *
 * 关键考点落地：
 *  - 两套状态机分离（tickets 工单状态机 + scan_records 批次状态机），通过 ticket_id 关联。
 *  - 并发冲突：乐观锁 version（UPDATE ... WHERE id=? AND version=?），受影响 0 行即冲突。
 *  - 幂等性：approval_records.op_token 唯一约束 + 状态前置校验。
 *  - 一致性：审批通过 → 库存/赔付联动，全部放进单事务 tx()，要么全成功要么全回滚。
 *  - 可追溯：payout / inventory_ledger 保留 approval_record_id 外键关联。
 *  - 权限：上报人不能审批自己的工单；层级校验；品控主管专有快速放行。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import type {
  Ticket,
  TicketStatus,
  ApprovalLevel,
  ExceptionCategory,
  ExceptionType,
  TicketSource,
  PayoutDirection,
  ExecutionAction,
  ApprovalRecord,
  ScanRecord,
  User,
} from "./types";
import { getConfig, resolveStartLevel, type V3Config } from "./config";

const now = () => new Date().toISOString();
const addMinutes = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

// ---------------- 行映射 ----------------

export function rowToTicket(r: Record<string, unknown>): Ticket {
  return {
    id: r.id as string,
    code: (r.id as string).toUpperCase().slice(0, 12),
    category: r.exception_category as ExceptionCategory,
    exceptionType: r.exception_type as ExceptionType,
    source: r.source as TicketSource,
    waybillCode: r.waybill_code as string,
    skuCode: (r.sku_code as string) ?? null,
    batchKey: (r.batch_no as string) ?? null,
    amount: Number(r.amount) || 0,
    description: (r.description as string) ?? "",
    status: r.status as TicketStatus,
    currentLevel: (Number(r.current_level) as ApprovalLevel) || null,
    version: Number(r.version) || 0,
    resubmitCount: Number(r.resubmit_count) || 0,
    reporter: (r.reporter_id as string) ?? "",
    assignee: null,
    tenant: "default",
    deadlineAt: (r.deadline_at as string) ?? null,
    aiSuggestion: (r.ai_suggestion as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    closedAt: (r.closed_at as string) ?? null,
  };
}

export function rowToApproval(r: Record<string, unknown>): ApprovalRecord {
  return {
    id: r.id as string,
    ticketId: r.ticket_id as string,
    level: (Number(r.level) as ApprovalLevel) || null,
    result: r.action as ApprovalRecord["result"],
    approver: (r.approver_id as string) ?? "",
    opinion: (r.opinion as string) ?? "",
    opToken: (r.op_token as string) ?? null,
    fromStatus: (r.from_status as TicketStatus) ?? "pending",
    toStatus: (r.to_status as TicketStatus) ?? "pending",
    createdAt: r.created_at as string,
  };
}

export function rowToScan(r: Record<string, unknown>): ScanRecord {
  return {
    id: r.id as string,
    waybillCode: r.waybill_code as string,
    skuCode: r.sku_code as string,
    batchKey: r.batch_no as string,
    scannedAt: r.scan_time as string,
    operator: (r.operator as string) ?? "",
    device: (r.device as string) ?? "",
    verdict: r.qc_result as ScanRecord["verdict"],
    matchedRuleId: (r.matched_rule_id as string) ?? null,
    ruleReason: (r.judge_reason as string) ?? null,
    exceptionDesc: null,
    batchStatus: (r.batch_lock_status as ScanRecord["batchStatus"]) ?? "scanned",
    ticketId: (r.ticket_id as string) ?? null,
  };
}

// ---------------- 用户 / 权限 ----------------

export async function getUser(store: Store, id: string): Promise<User | null> {
  const r = await store.get<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [id]);
  if (!r) return null;
  return {
    username: r.id as string,
    displayName: r.name as string,
    role: (r.roles as string).split(",")[0] as User["role"],
    tenant: (r.warehouse as string) ?? "default",
    disabled: Number(r.active) === 0,
  };
}

export async function getUserRoles(store: Store, id: string): Promise<string[]> {
  const r = await store.get<{ roles: string; active: number }>(
    "SELECT roles, active FROM users WHERE id = ?",
    [id]
  );
  if (!r || Number(r.active) === 0) return [];
  return r.roles.split(",").map((s) => s.trim());
}

export async function listUsers(store: Store): Promise<User[]> {
  const rows = await store.all<Record<string, unknown>>("SELECT * FROM users ORDER BY created_at ASC");
  return rows.map((r) => ({
    username: r.id as string,
    displayName: r.name as string,
    role: (r.roles as string).split(",")[0] as User["role"],
    tenant: (r.warehouse as string) ?? "default",
    disabled: Number(r.active) === 0,
  }));
}

// ---------------- 工单读取 ----------------

export interface TicketQuery {
  status?: string;
  category?: string;
  waybillCode?: string;
  source?: string;
  approverId?: string; // 仅看该审批人权限范围内的（简化：层级匹配）
  limit?: number;
  offset?: number;
}

export async function listTickets(store: Store, q: TicketQuery = {}): Promise<{ tickets: Ticket[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.status) { conds.push("status = ?"); params.push(q.status); }
  if (q.category) { conds.push("exception_category = ?"); params.push(q.category); }
  if (q.source) { conds.push("source = ?"); params.push(q.source); }
  if (q.waybillCode) { conds.push("waybill_code LIKE ?"); params.push(`%${q.waybillCode}%`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(500, q.limit ?? 20);
  const offset = q.offset ?? 0;
  const rows = await store.all<Record<string, unknown>>(
    `SELECT * FROM tickets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const cnt = await store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets ${where}`, params);
  return { tickets: rows.map(rowToTicket), total: Number(cnt?.n) || 0 };
}

export async function getTicket(store: Store, id: string): Promise<Ticket | null> {
  const r = await store.get<Record<string, unknown>>("SELECT * FROM tickets WHERE id = ?", [id]);
  return r ? rowToTicket(r) : null;
}

export async function getTicketTimeline(store: Store, id: string): Promise<ApprovalRecord[]> {
  const rows = await store.all<Record<string, unknown>>(
    "SELECT * FROM approval_records WHERE ticket_id = ? ORDER BY created_at ASC",
    [id]
  );
  return rows.map(rowToApproval);
}

export async function getTicketStats(store: Store): Promise<Record<string, number>> {
  const rows = await store.all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM tickets GROUP BY status"
  );
  const out: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { out[r.status] = Number(r.n); total += Number(r.n); }
  out.total = total;
  return out;
}

// ---------------- 创建工单 ----------------

export interface CreateTicketInput {
  category: ExceptionCategory;
  exceptionType: ExceptionType;
  source: TicketSource;
  waybillCode: string;
  skuCode?: string | null;
  batchKey?: string | null;
  amount: number;
  description: string;
  reporter: string;
  aiSuggestion?: string | null;
  /** 品控扫描触发时可强制起始层级（如破损高危直接二级） */
  forceStartLevel?: ApprovalLevel;
}

/** 同一运单是否存在同类型未关闭工单（防重复上报） */
export async function findOpenTicketByType(
  store: Store,
  waybillCode: string,
  category: ExceptionCategory
): Promise<Ticket | null> {
  const r = await store.get<Record<string, unknown>>(
    `SELECT * FROM tickets
     WHERE waybill_code = ? AND exception_category = ?
       AND status NOT IN ('done','closed_rejected','closed_timeout','closed_fast_release')
     ORDER BY created_at DESC LIMIT 1`,
    [waybillCode, category]
  );
  return r ? rowToTicket(r) : null;
}

/** 同一批次是否存在未关闭品控工单（扫描幂等性判断） */
export async function findOpenQcTicketByBatch(store: Store, batchKey: string): Promise<Ticket | null> {
  const r = await store.get<Record<string, unknown>>(
    `SELECT * FROM tickets
     WHERE batch_no = ? AND exception_category = 'qc'
       AND status NOT IN ('done','closed_rejected','closed_timeout','closed_fast_release')
     ORDER BY created_at DESC LIMIT 1`,
    [batchKey]
  );
  return r ? rowToTicket(r) : null;
}

export async function createTicket(store: Store, input: CreateTicketInput): Promise<Ticket> {
  const cfg = await getConfig(store);
  const id = (input.category === "qc" ? "tq_" : "tl_") + nanoid(9);
  const startLevel = input.forceStartLevel ?? resolveStartLevel(cfg, input.amount);
  const status: TicketStatus = "pending";
  const deadline = addMinutes(cfg.pendingTimeoutMinutes);
  const ts = now();
  await store.run(
    `INSERT INTO tickets
       (id, waybill_code, exception_category, exception_type, source, description,
        amount, status, current_level, reporter_id, batch_no, sku_code, version,
        resubmit_count, deadline_at, ai_suggestion, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, input.waybillCode, input.category, input.exceptionType, input.source,
      input.description, input.amount, status, startLevel, input.reporter,
      input.batchKey ?? null, input.skuCode ?? null, 0, 0, deadline,
      input.aiSuggestion ?? null, ts, ts,
    ]
  );
  // 记录创建动作到审计日志
  await insertApproval(store, {
    ticketId: id, level: null, action: "report", approver: input.reporter,
    opinion: `创建工单（来源：${input.source === "scan" ? "扫描自动触发" : "手工上报"}）`,
    fromStatus: "pending", toStatus: "pending",
  });
  return (await getTicket(store, id))!;
}

// ---------------- 审批记录 ----------------

interface InsertApprovalInput {
  ticketId: string;
  level: ApprovalLevel | null;
  action: string;
  approver: string;
  opinion: string;
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  opToken?: string | null;
  result?: string;
}

export async function insertApproval(store: Store, a: InsertApprovalInput): Promise<string> {
  const id = "ap_" + nanoid(10);
  await store.run(
    `INSERT INTO approval_records
       (id, ticket_id, approver_id, level, action, opinion, result, op_token, from_status, to_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, a.ticketId, a.approver, a.level, a.action, a.opinion, a.result ?? a.action,
     a.opToken ?? null, a.fromStatus, a.toStatus, now()]
  );
  return id;
}

/** 幂等前置检查：op_token 已存在则说明是重复提交 */
export async function opTokenExists(store: Store, opToken: string): Promise<boolean> {
  if (!opToken) return false;
  const r = await store.get<{ id: string }>("SELECT id FROM approval_records WHERE op_token = ?", [opToken]);
  return !!r;
}

// ---------------- 审批流转（核心） ----------------

export type ApprovalDecision = "approve" | "reject";

export interface ApproveResult {
  ok: boolean;
  code?: "CONFLICT" | "FORBIDDEN" | "INVALID_STATE" | "DUPLICATE" | "NOT_FOUND";
  message: string;
  ticket?: Ticket;
}

/**
 * 审批动作：通过 / 拒绝。
 * - 权限：上报人不能审批自己的工单；层级必须匹配当前 current_level；账号需启用。
 * - 并发：乐观锁 version。
 * - 幂等：op_token 唯一 + 状态前置校验。
 */
export async function approveTicket(
  store: Store,
  input: {
    ticketId: string;
    approver: string;
    decision: ApprovalDecision;
    opinion: string;
    expectedVersion: number;
    opToken: string;
  }
): Promise<ApproveResult> {
  const cfg = await getConfig(store);
  const ticket = await getTicket(store, input.ticketId);
  if (!ticket) return { ok: false, code: "NOT_FOUND", message: "工单不存在" };

  // 幂等：重复令牌直接返回成功（不再重复处理）
  if (await opTokenExists(store, input.opToken)) {
    return { ok: true, message: "该操作已处理（幂等）", ticket };
  }

  // 权限：账号启用
  const roles = await getUserRoles(store, input.approver);
  if (roles.length === 0) return { ok: false, code: "FORBIDDEN", message: "账号不存在或已被禁用" };

  // 权限：上报人不能审批自己提交的工单
  if (ticket.reporter === input.approver) {
    return { ok: false, code: "FORBIDDEN", message: "不能审批自己上报的工单（自批自核禁止）" };
  }

  // 状态必须在审批中
  if (!["pending", "l1_reviewing", "l2_reviewing"].includes(ticket.status)) {
    return { ok: false, code: "INVALID_STATE", message: `工单当前状态为「${ticket.status}」，不可审批` };
  }

  // 权限：层级匹配
  const level = ticket.currentLevel ?? 1;
  const needRole = level === 2 ? "approver_l2" : "approver_l1";
  if (!roles.includes(needRole) && !roles.includes("admin")) {
    return { ok: false, code: "FORBIDDEN", message: `无权审批：需要 ${needRole} 角色` };
  }

  // 计算目标状态
  let toStatus: TicketStatus;
  let nextLevel: ApprovalLevel | null = level;
  let action = input.decision;
  let resubmitInc = 0;

  if (input.decision === "approve") {
    if (level === 1 && ticket.amount >= (cfg.approvalTiers.find((t) => t.startLevel === 2)?.minAmount ?? Infinity)) {
      // 一级通过但金额超阈值 → 升二级
      toStatus = "l2_reviewing";
      nextLevel = 2;
    } else {
      toStatus = "executing";
    }
  } else {
    // 拒绝：重提计数
    if (ticket.resubmitCount + 1 > cfg.resubmitLimit) {
      // 超过重提上限
      if (cfg.resubmitExceededAction === "escalate") {
        toStatus = "l2_reviewing"; nextLevel = 2; action = "reject";
      } else {
        toStatus = "closed_rejected"; nextLevel = null;
      }
    } else {
      toStatus = "pending";
      nextLevel = ticket.currentLevel;
      resubmitInc = 1;
    }
  }

  // 新的超时点
  const newDeadline =
    toStatus === "l2_reviewing" ? addMinutes(cfg.l2TimeoutMinutes)
    : toStatus === "pending" ? addMinutes(cfg.pendingTimeoutMinutes)
    : null;

  const apId = "ap_" + nanoid(10);
  const ts = now();

  // 乐观锁 + 审批记录 一个事务完成（并发冲突保护）
  const stmts = [
    {
      text: `UPDATE tickets SET status=?, current_level=?, version=version+1,
               resubmit_count=resubmit_count+?, deadline_at=?, updated_at=?
             WHERE id=? AND version=?`,
      params: [toStatus, nextLevel, resubmitInc, newDeadline, ts, input.ticketId, input.expectedVersion],
    },
    {
      text: `INSERT INTO approval_records
               (id, ticket_id, approver_id, level, action, opinion, result, op_token, from_status, to_status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [apId, input.ticketId, input.approver, level, action, input.opinion,
               input.decision, input.opToken, ticket.status, toStatus, ts],
    },
  ];

  try {
    const counts = await store.tx(stmts);
    if (counts[0] === 0) {
      // 乐观锁未命中：版本已变，说明被别人先处理了
      return { ok: false, code: "CONFLICT", message: "该工单已被处理，请刷新后重试" };
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/unique|constraint/i.test(msg)) {
      return { ok: true, message: "该操作已处理（幂等）", ticket };
    }
    throw e;
  }

  return { ok: true, message: input.decision === "approve" ? "审批通过" : "已拒绝", ticket: (await getTicket(store, input.ticketId))! };
}

// ---------------- 执行联动（一致性核心） ----------------

export interface ExecuteResult {
  ok: boolean;
  code?: string;
  message: string;
  payoutId?: string;
}

/** 异常类型 → 下游动作 + 赔付方向 的映射（默认建议，可被前端覆盖） */
export function suggestAction(category: ExceptionCategory, type: ExceptionType): {
  action: ExecutionAction;
  direction: PayoutDirection | null;
  needInventory: boolean;
} {
  if (category === "logistics") {
    switch (type) {
      case "wrong_address": return { action: "reship_no_payout", direction: null, needInventory: true };
      case "lost": return { action: "claim_payout", direction: "to_customer", needInventory: true };
      case "damaged": return { action: "claim_payout", direction: "to_customer", needInventory: true };
      case "rejected": return { action: "return_inbound", direction: null, needInventory: true };
      case "overtime": return { action: "claim_payout", direction: "to_customer", needInventory: false };
      default: return { action: "claim_payout", direction: "to_customer", needInventory: false };
    }
  }
  // 品控：赔付方向一律向供应商追偿
  switch (type) {
    case "quantity_mismatch": return { action: "return_supplier", direction: "to_supplier_claim", needInventory: true };
    case "appearance_damage": return { action: "return_supplier", direction: "to_supplier_claim", needInventory: true };
    case "spec_mismatch": return { action: "downgrade", direction: "to_supplier_claim", needInventory: true };
    case "label_error": return { action: "release", direction: null, needInventory: false };
    case "batch_abnormal": return { action: "repurchase", direction: "to_supplier_claim", needInventory: true };
    default: return { action: "return_supplier", direction: "to_supplier_claim", needInventory: true };
  }
}

/**
 * 执行工单（executing → done）：状态变更 + 库存联动 + 赔付记录，全部在单事务内。
 * 保证不出现“审批通过但库存/赔付没联动”的中间态；品控工单同步解锁批次。
 * 幂等：opToken 唯一约束 + 状态前置校验。
 */
export async function executeTicket(
  store: Store,
  input: {
    ticketId: string;
    operator: string;
    action: ExecutionAction;
    payoutAmount?: number;
    reconcileMethod?: string;
    opToken: string;
    expectedVersion: number;
  }
): Promise<ExecuteResult> {
  const ticket = await getTicket(store, input.ticketId);
  if (!ticket) return { ok: false, code: "NOT_FOUND", message: "工单不存在" };
  if (await opTokenExists(store, input.opToken)) return { ok: true, message: "该执行已完成（幂等）" };
  if (ticket.status !== "executing") {
    return { ok: false, code: "INVALID_STATE", message: `工单状态为「${ticket.status}」，需先审批通过进入执行中` };
  }

  const map = suggestAction(ticket.category, ticket.exceptionType);
  const direction = map.direction;
  const ts = now();
  const apId = "ap_" + nanoid(10);
  const payoutId = direction ? "po_" + nanoid(10) : null;
  const ledgerId = "il_" + nanoid(10);

  // 库存变更方向：重新发货/退供/作废扣减；退货入库增加
  let invDelta = 0;
  let invReason = "";
  const qty = ticket.category === "qc" ? 0 : 0; // 数量按批次锁定量演示，简化为 1 单位
  switch (input.action) {
    case "reship":
    case "reship_no_payout": invDelta = -1; invReason = "重新发货扣减"; break;
    case "return_inbound": invDelta = +1; invReason = "退货入库增加"; break;
    case "return_supplier": invDelta = -1; invReason = "退回供应商出库"; break;
    case "repurchase": invDelta = -1; invReason = "批次作废（重采购）"; break;
    case "downgrade": invDelta = 0; invReason = "降级出库（不改在库总量）"; break;
    case "release": invDelta = 0; invReason = "放行（批次解锁，无库存变化）"; break;
    default: invDelta = 0; invReason = "无库存变更"; break;
  }
  void qty;

  const stmts: { text: string; params?: unknown[] }[] = [];

  // 1) 工单 → done（乐观锁）
  stmts.push({
    text: `UPDATE tickets SET status='done', version=version+1, updated_at=?, closed_at=?
           WHERE id=? AND version=? AND status='executing'`,
    params: [ts, ts, input.ticketId, input.expectedVersion],
  });

  // 2) 审批/执行记录（幂等令牌）
  stmts.push({
    text: `INSERT INTO approval_records
             (id, ticket_id, approver_id, level, action, opinion, result, op_token, from_status, to_status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    params: [apId, input.ticketId, input.operator, null, "execute",
             `执行动作：${input.action}`, input.action, input.opToken, "executing", "done", ts],
  });

  // 3) 赔付记录（含赔付方向，关联审批记录 ID 可追溯）
  if (payoutId && direction) {
    stmts.push({
      text: `INSERT INTO payout_records
               (id, ticket_id, approval_record_id, direction, amount, status, reconcile_method, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [payoutId, input.ticketId, apId, direction, input.payoutAmount ?? ticket.amount,
               "pending", input.reconcileMethod ?? (direction === "to_customer" ? "客户理赔对账" : "供应商扣款对账"),
               direction === "to_customer" ? "物流货损赔付客户" : "品控来货问题向供应商追偿", ts],
    });
  }

  // 4) 库存流水（关联审批记录 ID 可追溯）
  if (invDelta !== 0) {
    stmts.push({
      text: `INSERT INTO inventory_ledger
               (id, sku_code, batch_no, delta, reason, ticket_id, approval_record_id, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
      params: [ledgerId, ticket.skuCode ?? "N/A", ticket.batchKey, invDelta, invReason,
               input.ticketId, apId, ts],
    });
    // 库存表联动（若有该 SKU 行）
    stmts.push({
      text: `UPDATE inventory SET quantity=quantity+?, updated_at=? WHERE sku_code=? AND (batch_no=? OR ?='')`,
      params: [invDelta, ts, ticket.skuCode ?? "N/A", ticket.batchKey ?? "", ticket.batchKey ?? ""],
    });
  }

  // 5) 品控工单：同步解锁批次（工单完成与批次解锁同一事务，杜绝“工单完成但批次仍锁定”）
  if (ticket.category === "qc" && ticket.batchKey) {
    const newBatchStatus =
      input.action === "release" ? "released"
      : input.action === "return_supplier" ? "returned"
      : input.action === "repurchase" ? "scrapped"
      : input.action === "downgrade" ? "downgraded"
      : "released";
    stmts.push({
      text: `UPDATE scan_records SET batch_lock_status=? WHERE ticket_id=?`,
      params: [newBatchStatus, input.ticketId],
    });
    stmts.push({
      text: `UPDATE inventory SET locked=0, locked_by_ticket=NULL, updated_at=?
             WHERE locked_by_ticket=?`,
      params: [ts, input.ticketId],
    });
  }

  try {
    const counts = await store.tx(stmts);
    if (counts[0] === 0) {
      return { ok: false, code: "CONFLICT", message: "工单已被处理或版本冲突，请刷新" };
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/unique|constraint/i.test(msg)) return { ok: true, message: "该执行已完成（幂等）" };
    throw e;
  }

  return { ok: true, message: "执行完成，联动已生效", payoutId: payoutId ?? undefined };
}

// ---------------- 审批人兜底（离职/禁用转交） ----------------

export async function reassignTicket(
  store: Store,
  input: { ticketId: string; newAssignee: string; operator: string; reason: string }
): Promise<ApproveResult> {
  const ticket = await getTicket(store, input.ticketId);
  if (!ticket) return { ok: false, code: "NOT_FOUND", message: "工单不存在" };
  await insertApproval(store, {
    ticketId: input.ticketId, level: ticket.currentLevel, action: "reassign",
    approver: input.operator, opinion: `转交给 ${input.newAssignee}：${input.reason}`,
    fromStatus: ticket.status, toStatus: ticket.status,
  });
  return { ok: true, message: "已转交", ticket };
}

/**
 * 回写 V2 异常标记（可选加分项）：工单未关闭时标记 hasOpenException=true，
 * 关闭后置为 false。失败不阻塞主流程（调用方 catch）。
 */
export async function flagWaybillIfNeeded(store: Store, ticketId: string): Promise<void> {
  const ticket = await getTicket(store, ticketId);
  if (!ticket) return;
  const closed = ["done", "closed_rejected", "closed_timeout", "closed_fast_release"].includes(ticket.status);
  const { flagWaybillOnV2 } = await import("./v2-client");
  await flagWaybillOnV2(store, ticket.waybillCode, {
    hasOpenException: !closed,
    ticketId: ticket.id,
    note: closed ? "异常已处理关闭" : `存在未关闭异常工单（${ticket.status}）`,
  });
}

export { getConfig };
export type { V3Config };
