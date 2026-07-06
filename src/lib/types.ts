/**
 * V3 运单全流程管理系统 —— 领域模型类型定义。
 *
 * 设计要点（对应考点 3/4/7）：
 *  - 两套状态机分离：工单状态机（tickets.status）与扫描批次状态机（scan_records.batch_status），
 *    通过 scan_records.ticket_id 关联，不合并为同一张表。
 *  - 赔付记录含“赔付方向”字段（payout_records.direction）：物流异常=赔付客户，品控异常=向供应商追偿。
 *  - 库存变更 / 赔付记录均保留触发它们的审批记录 ID（approval_record_id），保证可追溯不断链。
 */

// ============ 异常类型 ============

/** 物流类异常（发货后，手工上报） */
export type LogisticsExceptionType =
  | "lost" // 丢件
  | "damaged" // 破损
  | "rejected" // 客户拒收
  | "overtime" // 超时未签收
  | "wrong_address"; // 收货地址错误

/** 品控类异常（发货前，扫描自动触发） */
export type QcExceptionType =
  | "quantity_mismatch" // 数量不符
  | "appearance_damage" // 外观破损
  | "spec_mismatch" // 规格不符
  | "label_error" // 标签错误
  | "batch_abnormal"; // 批次异常

export type ExceptionType = LogisticsExceptionType | QcExceptionType;

/** 异常大类：决定赔付方向、下游动作、触发源 */
export type ExceptionCategory = "logistics" | "qc";

/** 工单来源：手工上报 / 扫描自动触发 */
export type TicketSource = "manual" | "scan";

// ============ 工单状态机 ============

/**
 * 工单状态机（物流类与品控类共用同一套审批流转）：
 * pending → l1_reviewing → (金额超阈值) → l2_reviewing → executing → done
 *   拒绝：l1/l2 → pending（可重提，有次数上限）→ 超过上限 → closed_rejected
 *   超时：pending/l1/l2 → 超时自动升级 l2 或自动驳回 closed_timeout（见假设文档）
 */
export type TicketStatus =
  | "pending" // 待审批
  | "l1_reviewing" // 一级审批中
  | "l2_reviewing" // 二级审批中
  | "executing" // 执行中
  | "done" // 已完成
  | "closed_rejected" // 超过重提上限，关闭
  | "closed_timeout" // 超时自动驳回，关闭
  | "closed_fast_release"; // 品控主管误判快速放行，关闭

/** 审批层级 */
export type ApprovalLevel = 1 | 2;

/** 审批动作结果 */
export type ApprovalResult = "approve" | "reject" | "auto_escalate" | "auto_reject" | "fast_release" | "reassign";

// ============ 扫描批次状态机（品控专有，与工单状态机分离） ============

/**
 * 扫描批次状态机：
 * scanned → (品控通过) shippable
 *         → (品控异常) qc_hold（批次锁定，禁止出库）
 *              → 工单执行动作后：released（放行解锁）/ returned（退供）/ scrapped（作废重采）/ downgraded（降级出库）
 *              → 或品控主管快速放行：released
 */
export type BatchStatus =
  | "scanned" // 扫描录入
  | "shippable" // 可出库（品控通过）
  | "qc_hold" // 品控暂扣（锁定）
  | "released" // 放行解锁
  | "returned" // 退回供应商
  | "scrapped" // 作废（重采购）
  | "downgraded"; // 降级出库

/** 品控判定结果 */
export type QcVerdict = "pass" | "fail";

// ============ 执行动作 ============

/** 物流异常下游动作 */
export type LogisticsAction =
  | "claim_payout" // 理赔（赔付客户）
  | "reship" // 重新发货（扣库存）
  | "return_inbound" // 退货入库（加库存）
  | "reship_no_payout"; // 仅重新发货，不赔付（如地址错误）

/** 品控异常下游动作 */
export type QcAction =
  | "release" // 放行货物（批次解锁，无赔付）
  | "return_supplier" // 退回供应商 + 向供应商追偿
  | "repurchase" // 重新采购 + 向供应商追偿
  | "downgrade"; // 降级处理（降价出库，追偿差价）

export type ExecutionAction = LogisticsAction | QcAction;

/** 赔付方向：核心区分字段 */
export type PayoutDirection =
  | "to_customer" // 赔付给客户（物流货损理赔）
  | "to_supplier_claim"; // 向供应商追偿（品控来货质量问题）

// ============ 角色 ============

export type Role =
  | "reporter" // 上报人（仓库操作员）
  | "approver_l1" // 一级审批人
  | "approver_l2" // 二级审批人
  | "qc_supervisor" // 品控主管（可误判快速放行）
  | "admin"; // 管理员（配置规则/阈值）

// ============ 表实体 ============

export interface WaybillSnapshot {
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  totalQuantity: number;
  skuCount: number;
  skusJson: WaybillSku[];
  amount: number; // 运单金额（用于分级审批阈值判断；来自 V2 或按数量估算）
  tenant: string; // 归属租户/仓库（单租户假设下为 default）
  syncedAt: string; // 来源接口同步时间
}

export interface WaybillSku {
  skuCode: string | null;
  skuName: string;
  quantity: number | null;
  spec: string | null;
}

/** 从 V2 接口获取的运单详情（实时或降级缓存） */
export interface WaybillDetail {
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  totalQuantity: number;
  skuCount: number;
  skus: WaybillSku[];
  sourceFile: string | null;
  createdAt: string;
  /** 数据来源：实时获取自 V2 / 使用本地缓存 */
  dataSource: "v2-live" | "v2-cache";
  syncedAt: string;
}

export interface SyncLog {
  id: string;
  requestId: string;
  api: string;
  paramsSummary: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface Ticket {
  id: string;
  code: string; // 人类可读工单号 TQ/TL-xxxx
  category: ExceptionCategory;
  exceptionType: ExceptionType;
  source: TicketSource;
  waybillCode: string;
  skuCode: string | null;
  batchKey: string | null; // 品控批次键（waybillCode + skuCode）
  amount: number; // 涉及金额（决定审批层级）
  description: string;
  status: TicketStatus;
  currentLevel: ApprovalLevel | null;
  version: number; // 乐观锁版本号（并发冲突控制）
  resubmitCount: number; // 已重提次数
  reporter: string; // 上报人
  assignee: string | null; // 当前处理人
  tenant: string;
  deadlineAt: string | null; // 当前环节超时时间点
  aiSuggestion: string | null; // AI 建议（需人工确认）
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  ticketId: string;
  level: ApprovalLevel | null;
  result: ApprovalResult;
  approver: string;
  opinion: string;
  opToken: string | null; // 幂等操作令牌
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  createdAt: string;
}

export interface PayoutRecord {
  id: string;
  ticketId: string;
  approvalRecordId: string; // 可追溯：由哪次审批触发
  direction: PayoutDirection;
  amount: number;
  status: "pending" | "settled";
  reconcileMethod: string; // 对账方式
  createdAt: string;
}

export interface InventoryItem {
  skuCode: string;
  skuName: string;
  onHand: number; // 在库
  locked: number; // 品控暂扣锁定数量
  updatedAt: string;
}

export interface InventoryLog {
  id: string;
  skuCode: string;
  delta: number;
  reason: string;
  approvalRecordId: string | null; // 可追溯
  ticketId: string | null;
  createdAt: string;
}

export interface ScanRecord {
  id: string;
  waybillCode: string;
  skuCode: string;
  batchKey: string;
  scannedAt: string;
  operator: string;
  device: string;
  verdict: QcVerdict;
  matchedRuleId: string | null;
  ruleReason: string | null; // 判定依据（可追溯）
  exceptionDesc: string | null;
  batchStatus: BatchStatus;
  ticketId: string | null; // 异常时非空
}

export interface QcRule {
  id: string;
  name: string;
  exceptionSubtype: QcExceptionType;
  /** 触发条件（可配置，不硬编码）：由 conditionType + 阈值组成 */
  conditionType: "quantity_diff_pct" | "damage_level" | "spec_deviation" | "label_flag" | "batch_flag";
  threshold: number; // 数量差异%、破损等级等
  severity: "low" | "medium" | "high";
  autoCreateTicket: boolean;
  autoApprovalLevel: ApprovalLevel; // 自动进入哪级审批
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalConfig {
  id: string;
  /** 金额阈值：低于 l1Threshold 走一级；≥ 则一级通过后升二级 */
  l1MaxAmount: number; // ≤ 此金额一级审批即可终审
  l2Threshold: number; // ≥ 此金额必须二级审批
  approvalTimeoutMin: number; // 审批超时（分钟）
  qcHoldTimeoutMin: number; // 品控暂扣超时（分钟，独立且更短）
  resubmitLimit: number; // 重提次数上限
  timeoutAction: "escalate" | "reject"; // 超时后升级还是驳回
  updatedAt: string;
}

export interface User {
  username: string;
  displayName: string;
  role: Role;
  tenant: string;
  disabled: boolean;
}
