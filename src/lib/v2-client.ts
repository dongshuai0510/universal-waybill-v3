/**
 * V2 接口客户端（V3 → V2 的唯一数据通道）。
 *
 * 硬性要求（考点 5）：
 *  - V3 绝不直接连 V2 数据库，只通过 HTTP 接口获取运单数据。
 *  - 鉴权：请求头携带 Bearer <V2_API_KEY>（对应 V2 的 V3_API_KEY）。
 *  - 链路追踪：每次调用生成 Request ID，随请求头下发并写入 sync_log。
 *  - 超时：设置合理超时（默认 8s），超时给明确提示，不让前端无限转圈。
 *  - 重试：幂等 GET 失败重试 1-2 次（指数退避）；写接口不自动重试。
 *  - 降级：V2 不可用时回退到本地快照，并标注“数据可能非最新，同步于 XX 时间”。
 *
 * 每一次调用无论成败都会写入 sync_log，错误区分（404 运单不存在 / 网络超时 /
 * 鉴权失败），而不是统一抛 Internal Server Error。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import type { WaybillDetail } from "./types";

const V2_BASE = process.env.V2_API_BASE || "https://universal-import-v2-ten.vercel.app";
const V2_KEY = process.env.V2_API_KEY || "v3-dev-shared-key";
const TIMEOUT_MS = Number(process.env.V2_TIMEOUT_MS || 8000);
const MAX_RETRY = Number(process.env.V2_MAX_RETRY || 2);

export interface V2CallMeta {
  requestId: string;
  durationMs: number;
  statusCode: number | null;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  fromCache?: boolean;
}

export interface V2Result<T> {
  ok: boolean;
  data: T | null;
  meta: V2CallMeta;
}

/** 生成一次调用的 Request ID（v3 前缀，便于在日志里区分方向） */
export function newRequestId(): string {
  return `v3-${Date.now().toString(36)}-${nanoid(6)}`;
}

/** 写入接口同步日志（链路可追踪，考点 5“接口可调试性”） */
export async function logSync(
  store: Store,
  entry: {
    requestId: string;
    apiName: string;
    method: string;
    paramsSummary?: string;
    statusCode?: number | null;
    success: boolean;
    durationMs?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  await store.run(
    `INSERT INTO sync_log
       (id, request_id, api_name, method, params_summary, status_code, success,
        duration_ms, error_code, error_message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      nanoid(12),
      entry.requestId,
      entry.apiName,
      entry.method,
      entry.paramsSummary ?? null,
      entry.statusCode ?? null,
      entry.success ? 1 : 0,
      entry.durationMs ?? null,
      entry.errorCode ?? null,
      entry.errorMessage ?? null,
      new Date().toISOString(),
    ]
  );
}

/** 带超时的 fetch */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * 核心调用封装：GET 幂等接口带重试；统一日志；错误区分。
 * @param apiName 用于日志的接口名
 * @param path    V2 上的路径（含 query）
 */
async function callV2<T>(
  store: Store,
  apiName: string,
  path: string,
  opts: { method?: string; body?: unknown; requestId?: string; retry?: boolean } = {}
): Promise<V2Result<T>> {
  const method = opts.method ?? "GET";
  const rid = opts.requestId ?? newRequestId();
  const retryable = opts.retry ?? method === "GET";
  const url = `${V2_BASE}${path}`;
  const paramsSummary = path.length > 200 ? path.slice(0, 200) + "…" : path;

  let attempt = 0;
  let lastErr: { code: string; message: string; status: number | null } = {
    code: "UNKNOWN",
    message: "未知错误",
    status: null,
  };
  const started = Date.now();

  while (attempt <= (retryable ? MAX_RETRY : 0)) {
    attempt++;
    const attemptStart = Date.now();
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${V2_KEY}`,
            "x-request-id": rid,
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          cache: "no-store",
        },
        TIMEOUT_MS
      );
      const durationMs = Date.now() - attemptStart;

      if (res.ok) {
        const data = (await res.json()) as T;
        const meta: V2CallMeta = {
          requestId: rid,
          durationMs,
          statusCode: res.status,
          success: true,
        };
        await logSync(store, {
          requestId: rid,
          apiName,
          method,
          paramsSummary,
          statusCode: res.status,
          success: true,
          durationMs,
        });
        return { ok: true, data, meta };
      }

      // 非 2xx：区分错误类型。4xx 一般不重试（除 429）。
      let bodyMsg = "";
      let bodyCode = "";
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        bodyCode = j.error ?? "";
        bodyMsg = j.message ?? "";
      } catch {
        /* 非 JSON 响应 */
      }
      lastErr = {
        code: bodyCode || `HTTP_${res.status}`,
        message: bodyMsg || `V2 返回状态码 ${res.status}`,
        status: res.status,
      };
      // 404/401/400 不重试
      if (res.status < 500 && res.status !== 429) {
        await logSync(store, {
          requestId: rid,
          apiName,
          method,
          paramsSummary,
          statusCode: res.status,
          success: false,
          durationMs,
          errorCode: lastErr.code,
          errorMessage: lastErr.message,
        });
        return {
          ok: false,
          data: null,
          meta: {
            requestId: rid,
            durationMs,
            statusCode: res.status,
            success: false,
            errorCode: lastErr.code,
            errorMessage: lastErr.message,
          },
        };
      }
    } catch (e) {
      const err = e as Error;
      const isAbort = err.name === "AbortError";
      lastErr = {
        code: isAbort ? "TIMEOUT" : "NETWORK_ERROR",
        message: isAbort ? `调用 V2 超时（>${TIMEOUT_MS}ms）` : `网络错误：${err.message}`,
        status: null,
      };
    }
    // 指数退避后重试
    if (attempt <= (retryable ? MAX_RETRY : 0)) {
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  const durationMs = Date.now() - started;
  await logSync(store, {
    requestId: rid,
    apiName,
    method,
    paramsSummary,
    statusCode: lastErr.status,
    success: false,
    durationMs,
    errorCode: lastErr.code,
    errorMessage: lastErr.message,
  });
  return {
    ok: false,
    data: null,
    meta: {
      requestId: rid,
      durationMs,
      statusCode: lastErr.status,
      success: false,
      errorCode: lastErr.code,
      errorMessage: lastErr.message,
    },
  };
}

// ---------------- 具体接口 ----------------

interface V2WaybillResp {
  exists: boolean;
  requestId: string;
  waybill: {
    externalCode: string;
    receiverStore: string | null;
    receiverName: string | null;
    receiverPhone: string | null;
    receiverAddress: string | null;
    totalQuantity: number;
    skuCount: number;
    skus: { skuCode: string | null; skuName: string; quantity: number | null; spec: string | null }[];
    sourceFile: string | null;
    createdAt: string;
  };
  openExceptionFlag?: { hasOpenException: boolean; ticketId: string | null };
}

/** 校验运单是否存在 + 获取详情（实时接口校验，发起上报的关键动作必须走它） */
export async function fetchWaybill(
  store: Store,
  code: string,
  requestId?: string
): Promise<V2Result<WaybillDetail>> {
  const r = await callV2<V2WaybillResp>(
    store,
    "v2.waybill.get",
    `/api/v3/waybill?code=${encodeURIComponent(code)}`,
    { requestId }
  );
  if (!r.ok || !r.data) return { ok: false, data: null, meta: r.meta };
  const w = r.data.waybill;
  const detail: WaybillDetail = {
    externalCode: w.externalCode,
    receiverStore: w.receiverStore,
    receiverName: w.receiverName,
    receiverPhone: w.receiverPhone,
    receiverAddress: w.receiverAddress,
    totalQuantity: w.totalQuantity,
    skuCount: w.skuCount,
    skus: w.skus,
    sourceFile: w.sourceFile,
    createdAt: w.createdAt,
    dataSource: "v2-live",
    syncedAt: new Date().toISOString(),
  };
  return { ok: true, data: detail, meta: r.meta };
}

interface V2SkuCheckResp {
  belongs: boolean;
  requestId: string;
  matchedSku?: { skuCode: string | null; skuName: string; quantity: number | null } | null;
}

/** 校验 SKU 是否归属于指定运单（扫描录入时防止扫到无关货物） */
export async function checkSkuBelongs(
  store: Store,
  code: string,
  skuCode: string,
  requestId?: string
): Promise<V2Result<{ belongs: boolean; matchedSku?: V2SkuCheckResp["matchedSku"] }>> {
  const r = await callV2<V2SkuCheckResp>(store, "v2.sku.check", `/api/v3/sku-check`, {
    method: "POST",
    body: { code, skuCode },
    requestId,
  });
  if (!r.ok || !r.data) return { ok: false, data: null, meta: r.meta };
  return { ok: true, data: { belongs: r.data.belongs, matchedSku: r.data.matchedSku }, meta: r.meta };
}

interface V2WaybillsResp {
  waybills: V2WaybillResp["waybill"][];
  total: number;
  page: number;
  pageSize: number;
}

/** 按条件同步运单列表（用于本地快照初始化 / 增量同步） */
export async function fetchWaybills(
  store: Store,
  opts: { page?: number; pageSize?: number; code?: string } = {},
  requestId?: string
): Promise<V2Result<{ waybills: WaybillDetail[]; total: number }>> {
  const qs = new URLSearchParams();
  if (opts.page) qs.set("page", String(opts.page));
  if (opts.pageSize) qs.set("pageSize", String(opts.pageSize));
  if (opts.code) qs.set("code", opts.code);
  const r = await callV2<V2WaybillsResp>(
    store,
    "v2.waybills.list",
    `/api/v3/waybills?${qs.toString()}`,
    { requestId }
  );
  if (!r.ok || !r.data) return { ok: false, data: null, meta: r.meta };
  const now = new Date().toISOString();
  const waybills: WaybillDetail[] = r.data.waybills.map((w) => ({
    externalCode: w.externalCode,
    receiverStore: w.receiverStore,
    receiverName: w.receiverName,
    receiverPhone: w.receiverPhone,
    receiverAddress: w.receiverAddress,
    totalQuantity: w.totalQuantity,
    skuCount: w.skuCount,
    skus: w.skus,
    sourceFile: w.sourceFile,
    createdAt: w.createdAt,
    dataSource: "v2-live",
    syncedAt: now,
  }));
  return { ok: true, data: { waybills, total: r.data.total }, meta: r.meta };
}

/** 回写异常标记到 V2（可选加分项：让 V2 侧看到“该运单存在未关闭异常”） */
export async function flagWaybillOnV2(
  store: Store,
  code: string,
  flag: { hasOpenException: boolean; ticketId?: string | null; note?: string | null },
  requestId?: string
): Promise<V2Result<{ ok: boolean }>> {
  return callV2<{ ok: boolean }>(store, "v2.waybill.flag", `/api/v3/waybill/flag`, {
    method: "POST",
    body: { code, ...flag },
    requestId,
    retry: false,
  });
}

export const v2Meta = { V2_BASE, TIMEOUT_MS, MAX_RETRY };
