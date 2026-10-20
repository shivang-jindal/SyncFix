import { Navigate, Outlet, RouteObject } from 'react-router-dom';

import { ConnectionsPage } from './pages/Connections';
import { SyncJobsPage } from './pages/SyncJobs';
import { SyncRunsPage } from './pages/SyncRuns';
import { IssuesPage } from './pages/Issues';
import { WebhookEndpointsPage } from './pages/WebhookEndpoints';
import { ReportsPage } from './pages/Reports';
import { OrganizationPage } from './pages/Organization';
import { AppShell } from './components/AppShell';

export const routes: RouteObject[] = [
  {
    path: '/:organizationId',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="connections" replace /> },
      { path: 'connections', element: <ConnectionsPage /> },
      { path: 'sync-jobs', element: <SyncJobsPage /> },
      { path: 'sync-runs', element: <SyncRunsPage /> },
      { path: 'issues', element: <IssuesPage /> },
      { path: 'webhook-endpoints', element: <WebhookEndpointsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'organization', element: <OrganizationPage /> },
    ],
  },
];

export function AppRouter() {
  return <Outlet />;
}