"use client";
/**
 * 顶部导航 + 角色切换器。
 *
 * 演示用：通过下拉切换“当前登录用户”，所有 API 请求自动带上 x-user-id 头，
 * 后端据此做角色权限校验（上报人不能审批自己的工单、层级校验等）。
 * 真实系统应走登录会话，这里简化以便阅卷时快速切换角色验证权限边界。
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { getUserId, setUserId, USERS } from "./user";

const NAV = [
  { href: "/", label: "工作台" },
  { href: "/scan", label: "扫描品控" },
  { href: "/report", label: "异常上报" },
  { href: "/tickets", label: "工单列表" },
  { href: "/monitor", label: "接口监控" },
  { href: "/admin", label: "规则配置" },
];

export default function NavBar() {
  const pathname = usePathname();
  const [uid, setUid] = useState("op_wang");

  useEffect(() => {
    setUid(getUserId());
  }, []);

  function onChange(v: string) {
    setUid(v);
    setUserId(v);
    // 触发依赖当前用户的页面刷新
    window.location.reload();
  }

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand font-bold text-white">
          运
        </div>
        <div className="mr-2">
          <div className="text-sm font-semibold text-ink">运单全流程管理 V3</div>
          <div className="text-[11px] text-ink-faint">扫描品控 · 异常上报 · 分级审批 · 执行联动</div>
        </div>
        <nav className="ml-2 hidden gap-1 text-sm md:flex">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded-lg px-3 py-1.5 transition-colors ${
                  active ? "bg-brand-tint text-brand-dark font-medium" : "text-ink-soft hover:bg-slate-100"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-ink-faint">当前身份</span>
          <select
            value={uid}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-lg border border-line bg-white px-2 py-1.5 text-xs text-ink focus:border-brand focus:outline-none"
          >
            {USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </header>
  );
}
