"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  count?: number;
}

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  const links = (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={i.href}>
          <Link
            href={i.href}
            onClick={() => setOpen(false)}
            aria-current={active(i.href) ? "page" : undefined}
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${active(i.href) ? "bg-stone-900 font-medium text-white" : "text-stone-700 hover:bg-stone-100"}`}
          >
            <span>{i.label}</span>
            {!!i.count && (
              <span className={`tabular rounded-full px-1.5 text-xs ${active(i.href) ? "bg-white/20 text-white" : "bg-brand-100 text-brand-700"}`}>{i.count}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <button type="button" className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm lg:hidden" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
        Menu
      </button>
      <nav aria-label="Main" className="hidden lg:block">
        {links}
      </nav>
      {open && (
        <nav id="mobile-nav" aria-label="Main" className="absolute left-0 right-0 top-14 z-20 border-b border-stone-200 bg-white p-3 shadow-lg lg:hidden">
          {links}
        </nav>
      )}
    </>
  );
}
