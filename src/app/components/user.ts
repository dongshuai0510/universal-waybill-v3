"use client";
/**
 * 演示用“当前身份”管理：存 localStorage，随每个 fetch 带上 x-user-id 头。
 * 真实系统走登录会话；这里为聚焦业务逻辑做简化，但后端仍严格按角色校验。
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "v3-user-id";

/** 演示用户（与后端 seed 默认用户一致），用于顶部角色切换器 */
export const USERS: Array<{ id: string; name: string }> = [
  { id: "op_wang", name: "王操作（上报人 · 仓库操作员）" },
  { id: "op_li", name: "李操作（上报人 · 仓库操作员）" },
  { id: "appr_zhang", name: "张审批（一级审批人）" },
  { id: "appr_zhao", name: "赵审批（二级审批人）" },
  { id: "qc_chen", name: "陈品控（品控主管 + 一级审批）" },
  { id: "admin_sys", name: "系统管理员（可配置/可审批）" },
  { id: "appr_disabled", name: "已离职审批人（禁用演示）" },
];

export function getUserId(): string {
  if (typeof window === "undefined") return "op_wang";
  return localStorage.getItem(KEY) || "op_wang";
}

export function setUserId(id: string) {
  localStorage.setItem(KEY, id);
  window.dispatchEvent(new Event("v3-user-changed"));
}

export function useUserId(): [string, (id: string) => void] {
  const [id, setId] = useState("op_wang");
  useEffect(() => {
    setId(getUserId());
    const h = () => setId(getUserId());
    window.addEventListener("v3-user-changed", h);
    return () => window.removeEventListener("v3-user-changed", h);
  }, []);
  const update = useCallback((v: string) => setUserId(v), []);
  return [id, update];
}

/** 别名：返回当前用户 id（只读） */
export function useUser(): { userId: string; setUserId: (id: string) => void } {
  const [id, update] = useUserId();
  return { userId: id, setUserId: update };
}

/** 带身份头的 fetch 封装 */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", getUserId());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

export async function apiJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await api(path, init);
  return (await res.json()) as T;
}

/** 生成幂等操作令牌 */
export function opToken(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
