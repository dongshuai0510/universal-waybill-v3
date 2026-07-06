/** 中文标签映射（状态/类型/动作），前后端一致展示。 */

export const STATUS_LABELS: Record<string, string> = {
  pending: "待审批",
  l1_reviewing: "一级审批中",
  l2_reviewing: "二级审批中",
  executing: "执行中",
  done: "已完成",
  closed_rejected: "已关闭（超重提上限）",
  closed_timeout: "已关闭（超时驳回）",
  closed_fast_release: "已关闭（快速放行）",
};

export const STATUS_TONE: Record<string, string> = {
  pending: "amber",
  l1_reviewing: "blue",
  l2_reviewing: "purple",
  executing: "brand",
  done: "green",
  closed_rejected: "red",
  closed_timeout: "red",
  closed_fast_release: "gray",
};

export const EXCEPTION_LABELS: Record<string, string> = {
  lost: "丢件",
  damaged: "破损",
  rejected: "客户拒收",
  overtime: "超时未签收",
  wrong_address: "收货地址错误",
  quantity_mismatch: "数量不符",
  appearance_damage: "外观破损",
  spec_mismatch: "规格不符",
  label_error: "标签错误",
  batch_abnormal: "批次异常",
};

export const CATEGORY_LABELS: Record<string, string> = {
  logistics: "物流异常",
  qc: "品控异常",
};

export const SOURCE_LABELS: Record<string, string> = {
  manual: "手工上报",
  scan: "扫描自动触发",
};

export const ACTION_LABELS: Record<string, string> = {
  report: "创建工单",
  approve: "审批通过",
  reject: "审批拒绝",
  auto_escalate: "超时自动升级",
  auto_reject: "超时自动驳回",
  fast_release: "误判快速放行",
  reassign: "转交",
  execute: "执行联动",
};

export const DIRECTION_LABELS: Record<string, string> = {
  to_customer: "赔付给客户",
  to_supplier_claim: "向供应商追偿",
};

export const EXECUTION_LABELS: Record<string, string> = {
  claim_payout: "理赔（赔付客户）",
  reship: "重新发货",
  return_inbound: "退货入库",
  reship_no_payout: "仅重新发货（不赔付）",
  release: "放行货物",
  return_supplier: "退回供应商 + 追偿",
  repurchase: "重新采购 + 追偿",
  downgrade: "降级处理 + 追差价",
};

export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s;
}
export function exceptionLabel(s: string): string {
  return EXCEPTION_LABELS[s] ?? s;
}
