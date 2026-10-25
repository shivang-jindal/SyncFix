import type { ReactNode } from 'react';
import { Navigate, Outlet, type RouteObject, useNavigate, useParams, useRoutes } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { Button, Card, EmptyState } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import { AcceptInvitationPage } from './pages/AcceptInvitation';
import { ConnectionsPage } from './pages/Connections';
import { CreateOrganizationPage } from './pages/CreateOrganization';
import { ForgotPasswordPage } from './pages/ForgotPassword';
import { IssuesPage } from './pages/Issues';
import { LoginPage } from './pages/Login';
import { NotFoundPage } from './pages/NotFound';
import { OrganizationPage } from './pages/Organization';
import { RegisterPage } from './pages/Register';
import { ReportsPage } from './pages/Reports';
import { ResetPasswordPage } from './pages/ResetPassword';
import { SyncJobsPage } from './pages/SyncJobs';
import { SyncRunsPage } from './pages/SyncRuns';
import { WebhookEndpointsPage } from './pages/WebhookEndpoints';

function FullPageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <span className="text-sm text-ink-muted">Loading SyncFix.</span>
    </div>
  );
}

function FullPageMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <EmptyState title={title} description={description} {...(action ? { action } : {})} />
      </Card>
    </div>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading, memberships } = useSession();

  if (loading) return <FullPageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (memberships.length === 0) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function RequireOrganization({ children }: { children: ReactNode }) {
  const params = useParams();
  const navigate = useNavigate();
  const { memberships, activeOrganizationId, loading } = useSession();
  const organizationId = params.organizationId;

  if (loading) return <FullPageLoading />;
  if (!organizationId) return <Navigate to="/dashboard" replace />;
  if (!memberships.some((membership) => membership.organizationId === organizationId)) {
    return (
      <FullPageMessage
        title="Workspace not available"
        description="You are not a member of this workspace, or it no longer exists."
        action={
          <Button
            variant="primary"
            onClick={() =>
              navigate(
                activeOrganizationId ? `/${activeOrganizationId}/connections` : '/dashboard',
              )
            }
          >
            Go to my workspace
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}

function RedirectToFirstOrganization() {
  const { memberships, loading } = useSession();
  if (loading) return <FullPageLoading />;
  const first = memberships[0];
  if (!first) return <Navigate to="/welcome" replace />;
  return <Navigate to={`/${first.organizationId}/connections`} replace />;
}

function OrganizationLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invitation', element: <AcceptInvitationPage /> },
  {
    path: '/welcome',
    element: (
      <RequireSession>
        <CreateOrganizationPage />
      </RequireSession>
    ),
  },
  {
    path: '/dashboard',
    element: (
      <RequireSession>
        <RedirectToFirstOrganization />
      </RequireSession>
    ),
  },
  {
    path: '/',
    element: (
      <RequireSession>
        <RedirectToFirstOrganization />
      </RequireSession>
    ),
  },
  {
    path: '/:organizationId',
    element: (
      <RequireSession>
        <RequireOrganization>
          <OrganizationLayout />
        </RequireOrganization>
      </RequireSession>
    ),
    children: [
      { index: true, element: <Navigate to="connections" replace /> },
      {
        path: 'dashboard',
        element: <Navigate to="../connections" replace />,
      },
      { path: 'connections', element: <ConnectionsPage /> },
      { path: 'sync-jobs', element: <SyncJobsPage /> },
      { path: 'sync-runs', element: <SyncRunsPage /> },
      { path: 'issues', element: <IssuesPage /> },
      { path: 'webhook-endpoints', element: <WebhookEndpointsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'organization', element: <OrganizationPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];

export function AppRouter() {
  const element = useRoutes(routes);
  return <SessionProvider>{element}</SessionProvider>;
}
