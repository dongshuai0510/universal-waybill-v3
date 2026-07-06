/**
 * V3 自有数据库 Schema（独立于 V2）。
 *
 * 设计原则：为了让同一套 SQL 同时跑在 SQLite（本地）与 Postgres（Neon 部署），
 * 布尔统一用 INTEGER 0/1，时间统一用 TEXT（ISO8601 字符串，字典序即时间序）。
 *
 * 十张表 + 配置表：
 *   users               角色与账号（含禁用状态，用于审批人兜底）
 *   waybill_snapshot    运单本地只读快照（接口同步自 V2，禁止在此改运单状态）
 *   sync_log            接口同步日志（每次调用 V2 的链路追踪，含 Request ID）
 *   tickets             异常工单（工单状态机）
 *   approval_records    审批记录（每次审批动作，含幂等令牌）
 *   payout_records      赔付记录（含"赔付方向"字段，关联 approval_record 可追溯）
 *   inventory           库存（批次锁定，品控暂扣期间不可被其他运单引用）
 *   inventory_ledger    库存流水（每次变更可反查触发它的审批记录，可追溯）
 *   scan_records        扫描记录（扫描批次状态机，与工单表 1:N，通过 ticket_id 关联）
 *   qc_rules            品控规则（可配置触发条件，不硬编码）
 *   config              全局配置（审批阈值 / 各类超时 / 重提上限，后台可调）
 */

const TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  roles         TEXT NOT NULL,          -- 逗号分隔：reporter,approver_l1,approver_l2,qc_supervisor,admin
  warehouse     TEXT,                   -- 所属仓库（归属校验；单租户假设下多为同一仓）
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waybill_snapshot (
  external_code   TEXT PRIMARY KEY,
  receiver_store  TEXT,
  receiver_name   TEXT,
  receiver_phone  TEXT,
  receiver_address TEXT,
  total_quantity  REAL NOT NULL DEFAULT 0,
  sku_count       INTEGER NOT NULL DEFAULT 0,
  skus_json       TEXT NOT NULL DEFAULT '[]',
  warehouse       TEXT,
  data_source     TEXT NOT NULL DEFAULT 'v2-live',  -- v2-live / v2-cache
  synced_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL,
  api_name       TEXT NOT NULL,
  method         TEXT NOT NULL,
  params_summary TEXT,
  status_code    INTEGER,
  success        INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  error_code     TEXT,
  error_message  TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id                 TEXT PRIMARY KEY,
  waybill_code       TEXT NOT NULL,
  exception_category TEXT NOT NULL,   -- logistics / qc
  exception_type     TEXT NOT NULL,   -- 丢件/破损/... 或 数量不符/外观破损/...
  source             TEXT NOT NULL,   -- scan（扫描自动触发）/ manual（手工上报）
  description        TEXT,
  amount             REAL NOT NULL DEFAULT 0,   -- 涉及金额（决定审批层级）
  status             TEXT NOT NULL,   -- pending/l1_reviewing/l2_reviewing/executing/done/rejected/auto_rejected/closed
  current_level      INTEGER NOT NULL DEFAULT 1,
  reporter_id        TEXT,
  batch_no           TEXT,            -- 品控工单关联批次
  sku_code           TEXT,
  version            INTEGER NOT NULL DEFAULT 0,   -- 乐观锁（并发冲突保护）
  resubmit_count     INTEGER NOT NULL DEFAULT 0,
  deadline_at        TEXT,            -- 当前环节超时时间点
  ai_suggestion      TEXT,            -- AI 建议（需人工确认，仅参考）
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  closed_at          TEXT
);

CREATE TABLE IF NOT EXISTS approval_records (
  id             TEXT PRIMARY KEY,
  ticket_id      TEXT NOT NULL,
  approver_id    TEXT,
  level          INTEGER,
  action         TEXT NOT NULL,   -- approve/reject/auto_escalate/auto_reject/fast_release/reassign/report/execute
  opinion        TEXT,
  result         TEXT,
  op_token       TEXT UNIQUE,     -- 幂等令牌：同一动作重复提交只生成一条
  from_status    TEXT,
  to_status      TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_records (
  id                 TEXT PRIMARY KEY,
  ticket_id          TEXT NOT NULL,
  approval_record_id TEXT NOT NULL,   -- 可追溯：反查触发赔付的审批
  direction          TEXT NOT NULL,   -- to_customer（赔付客户）/ to_supplier（向供应商追偿）
  amount             REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending/settled
  reconcile_method   TEXT,
  note               TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id               TEXT PRIMARY KEY,
  sku_code         TEXT NOT NULL,
  batch_no         TEXT NOT NULL,
  waybill_code     TEXT,
  quantity         REAL NOT NULL DEFAULT 0,
  locked           INTEGER NOT NULL DEFAULT 0,   -- 品控暂扣 = 批次锁定
  locked_by_ticket TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id                 TEXT PRIMARY KEY,
  sku_code           TEXT NOT NULL,
  batch_no           TEXT,
  delta              REAL NOT NULL,
  reason             TEXT NOT NULL,
  ticket_id          TEXT,
  approval_record_id TEXT,   -- 可追溯：反查触发库存变更的审批
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_records (
  id                TEXT PRIMARY KEY,
  waybill_code      TEXT NOT NULL,
  sku_code          TEXT NOT NULL,
  batch_no          TEXT NOT NULL,
  operator          TEXT,
  device            TEXT,
  qc_result         TEXT NOT NULL,   -- pass / fail
  matched_rule_id   TEXT,            -- 命中的品控规则（可追溯）
  judge_reason      TEXT,            -- 判定依据
  batch_lock_status TEXT,            -- unlocked / locked
  ticket_id         TEXT,            -- 异常时非空（1:N 关联工单）
  scan_time         TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qc_rules (
  id                  TEXT PRIMARY KEY,
  sub_type            TEXT NOT NULL,   -- 数量不符/外观破损/规格不符/标签错误/批次异常
  description         TEXT,
  condition_json      TEXT NOT NULL,   -- 可配置触发条件（阈值），不硬编码
  severity            TEXT NOT NULL,   -- low/medium/high
  auto_create_ticket  INTEGER NOT NULL DEFAULT 1,
  auto_approval_level INTEGER NOT NULL DEFAULT 1,
  enabled             INTEGER NOT NULL DEFAULT 1,
  priority            INTEGER NOT NULL DEFAULT 100,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_waybill ON tickets(waybill_code);
CREATE INDEX IF NOT EXISTS idx_tickets_deadline ON tickets(deadline_at);
CREATE INDEX IF NOT EXISTS idx_approval_ticket ON approval_records(ticket_id);
CREATE INDEX IF NOT EXISTS idx_scan_waybill_sku ON scan_records(waybill_code, sku_code, batch_no);
CREATE INDEX IF NOT EXISTS idx_synclog_created ON sync_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_synclog_rid ON sync_log(request_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku_batch ON inventory(sku_code, batch_no);
CREATE INDEX IF NOT EXISTS idx_payout_ticket ON payout_records(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ticket ON inventory_ledger(ticket_id);
`;

/** SQLite：一次性 exec 全部（支持多语句） */
export const SCHEMA_SQLITE = TABLES + INDEXES;

/** Neon：拆成单条语句数组，逐条 execute（http 驱动不支持多语句） */
export const SCHEMA_NEON_STMTS: string[] = [...TABLES.split(";"), ...INDEXES.split(";")]
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
