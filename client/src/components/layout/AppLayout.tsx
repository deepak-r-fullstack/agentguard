import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Bot, Building2, Inbox, KeyRound, LogOut, Plug, Menu, ScrollText, ShieldCheck, SlidersHorizontal, History, X } from "lucide-react";
import { useAuthStore } from "utils/store/authStore";
import { useActionStats } from "utils/hooks/useAgentGuardQueries";
import { UserRole } from "utils/types";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Inbox;
  roles?: UserRole[];
  showsPending?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/approvals", label: "Approvals", icon: Inbox, showsPending: true },
  { to: "/activity", label: "Activity", icon: History },
  { to: "/rules", label: "Rules", icon: SlidersHorizontal },
  { to: "/playground", label: "Try an agent", icon: Bot, roles: ["admin", "manager"] },
  { to: "/company", label: "Company data", icon: Building2 },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/agents", label: "Agent keys", icon: KeyRound, roles: ["admin"] },
  { to: "/connections", label: "Connections", icon: Plug, roles: ["admin"] },
];

const ROLE_LABEL: Record<UserRole, string> = { admin: "Admin", manager: "Manager", auditor: "Auditor" };

export const AppLayout = () => {
  const { user, signOut } = useAuthStore();
  const { data: stats } = useActionStats();
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = stats?.pendingApprovals || 0;

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role)));

  const navigation = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {visibleItems.map(({ to, label, icon: Icon, showsPending }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => setMenuOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActive ? "bg-brand-tint text-brand" : "text-ink-soft hover:bg-ink/5 hover:text-ink"
            }`
          }
        >
          <Icon className="h-4 w-4" aria-hidden />
          <span className="flex-1">{label}</span>
          {showsPending && pending > 0 && (
            <span className="rounded-full bg-waiting px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${pending} waiting`}>
              {pending}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const account = user && (
    <div className="border-t border-line pt-4">
      <p className="text-sm font-semibold">{user.name}</p>
      <p className="text-xs text-ink-faint">
        {ROLE_LABEL[user.role]} at {user.workspaceName}
      </p>
      <button
        type="button"
        onClick={signOut}
        className="mt-3 inline-flex items-center gap-2 text-sm text-ink-soft hover:text-ink"
      >
        <LogOut className="h-4 w-4" aria-hidden /> Sign out
      </button>
    </div>
  );

  const brand = (
    <div className="flex items-center gap-2">
      <ShieldCheck className="h-6 w-6 text-brand" aria-hidden />
      <span className="text-lg font-semibold tracking-tight">AgentGuard</span>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-line bg-sheet px-4 py-6 lg:flex lg:sticky lg:top-0 lg:h-screen">
        <div className="flex flex-col gap-8">
          {brand}
          {navigation}
        </div>
        {account}
      </aside>

      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-line bg-sheet px-4 py-3 lg:hidden">
        {brand}
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" className="rounded-md p-2 hover:bg-ink/5">
          <Menu className="h-5 w-5" />
          {pending > 0 && <span className="sr-only">{pending} approvals waiting</span>}
        </button>
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="drawer-enter absolute right-0 top-0 flex h-full w-72 flex-col justify-between bg-sheet px-4 py-5">
            <div className="flex flex-col gap-6">
              <div className="flex items-center justify-between">
                {brand}
                <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close menu" className="rounded-md p-2 hover:bg-ink/5">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {navigation}
            </div>
            {account}
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-10">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
};
