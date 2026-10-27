/** AppShell: sidebar, header, organization switcher, profile menu. */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { classNames } from '../lib/format';
import { useSession } from '../lib/session';
import { Button } from './ui';
import { ThemeToggle } from './ThemeToggle';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
}

const NAV: NavItem[] = [
  {
    to: '/connections',
    label: 'Connections',
    icon: <Icon path="M5 4h4v4H5zM11 12h4v4h-4zM9 6h3a2 2 0 0 1 2 2v4" />,
  },
  {
    to: '/sync-jobs',
    label: 'Sync jobs',
    icon: <Icon path="M4 5h4l2 3h6M4 15h4l2-3h6M13 5l3 3-3 3M13 12l3 3-3 3" />,
  },
  {
    to: '/sync-runs',
    label: 'Sync runs',
    icon: <Icon path="M10 3a7 7 0 1 1-7 7M10 6v4l3 2M3 6v4h4" />,
  },
  {
    to: '/issues',
    label: 'Issues',
    icon: <Icon path="M10 3 2.5 16h15L10 3ZM10 8v3M10 13.5v.5" />,
  },
  {
    to: '/webhook-endpoints',
    label: 'Webhooks',
    icon: <Icon path="M7 4a3 3 0 0 1 5.2 2H16v4M13 16a3 3 0 0 1-5.2-2H4v-4M5 7l2 2M15 13l-2-2" />,
  },
  { to: '/reports', label: 'Reports', icon: <Icon path="M4 16V9M8 16V5M12 16v-4M16 16V7" /> },
  {
    to: '/organization',
    label: 'Organization',
    icon: <Icon path="M4 16V5h6v11M10 16V8h6v8M3 16h14M6 7h2M6 10h2M6 13h2M12 11h2M12 14h2" />,
  },
];

function Icon({ path }: { path: string }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppShell({ children }: { children?: React.ReactNode }) {
  const { activeOrganization, activeOrganizationId, memberships, signOut, user, switchOrganization } = useSession();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const base = `/${activeOrganizationId}`;

  const navigation = (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 p-2">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={`${base}${item.to}`}
          end={false}
          className={({ isActive }) =>
            classNames(
              'flex items-center gap-3 rounded-sm border border-transparent px-3 py-2 text-[12px] font-bold no-underline uppercase tracking-wide transition-colors',
              isActive ? 'border-brand-300 bg-brand-50 text-brand-700' : 'text-ink-muted hover:border-line-strong hover:bg-white hover:text-ink',
            )
          }
        >
          {item.icon}
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-surface-sunken">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r-2 border-ink bg-white lg:flex">
        <Brand organizationName={activeOrganization?.organizationName ?? 'SyncFix'} />
        {navigation}
        <footer className="border-t border-line p-4 text-xs text-ink-subtle">
          SyncFix keeps CRM, billing and support records in sync. It never overwrites a mapped
          destination field without a rule.
        </footer>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b-2 border-ink bg-white px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            aria-expanded={mobileNavOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span className="sr-only">{mobileNavOpen ? 'Close navigation' : 'Open navigation'}</span>
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </Button>

          <OrganizationSwitcher
            memberships={memberships}
            activeId={activeOrganizationId}
            onSwitch={(id) => void switchOrganization(id)}
          />

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <ProfileMenu
              name={user?.displayName ?? ''}
              email={user?.email ?? ''}
              settingsHref={`${base}/organization`}
              onSignOut={() => void signOut()}
            />
          </div>
        </header>

        {mobileNavOpen ? (
          <div id="mobile-nav" className="border-b border-line bg-white lg:hidden">
            {navigation}
          </div>
        ) : null}

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-5 py-8 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand({ organizationName }: { organizationName: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-sm bg-ink text-white">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true"><path d="M5 7h8a3 3 0 0 1 3 3v1M19 17h-8a3 3 0 0 1-3-3v-1M13 5l3 3-3 3M11 13l-3 3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-ink">SYNC_FIX</span>
        <span className="block truncate text-xs text-brand-700">{organizationName} :: CONTROL</span>
      </span>
    </div>
  );
}

function OrganizationSwitcher({
  memberships,
  activeId,
  onSwitch,
}: {
  memberships: Array<{ organizationId: string; organizationName: string; role: string }>;
  activeId: string | null;
  onSwitch: (organizationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = memberships.find((membership) => membership.organizationId === activeId);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (memberships.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-line-strong bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-surface-sunken"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="max-w-[10rem] truncate">{active?.organizationName ?? 'Select organization'}</span>
        <svg className="h-3 w-3 text-ink-subtle" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul role="listbox" className="card absolute left-0 top-full z-40 mt-1 w-64 p-1 shadow-[var(--shadow-pop)]">
          {memberships.map((membership) => (
            <li key={membership.organizationId}>
              <button
                type="button"
                role="option"
                aria-selected={membership.organizationId === activeId}
                className={classNames(
                  'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px]',
                  membership.organizationId === activeId
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink hover:bg-surface-sunken',
                )}
                onClick={() => {
                  setOpen(false);
                  onSwitch(membership.organizationId);
                }}
              >
                <span className="truncate">{membership.organizationName}</span>
                <span className="ml-2 shrink-0 text-xs text-ink-subtle capitalize">{membership.role}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProfileMenu({
  name,
  email,
  settingsHref,
  onSignOut,
}: {
  name: string;
  email: string;
  settingsHref: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink hover:bg-surface-sunken"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700">
          {(name || email || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:block">{name || email}</span>
      </button>
      {open ? (
        <div role="menu" className="card absolute right-0 top-full z-40 mt-1 w-56 p-1 shadow-[var(--shadow-pop)]">
          <div className="px-3 py-2">
            <p className="truncate text-[13px] font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-ink-subtle">{email}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link role="menuitem" to={settingsHref} className="block rounded-md px-3 py-2 text-[13px] text-ink no-underline hover:bg-surface-sunken">
            Profile settings
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={onSignOut}
            className="block w-full rounded-md px-3 py-2 text-left text-[13px] text-ink hover:bg-surface-sunken"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}