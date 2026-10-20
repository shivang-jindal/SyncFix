/**
 * Service container. One instance per process; the services are stateless apart
 * from their database handle.
 */

import type { Permission, Role } from '@syncfix/shared';
import { permissionsForRole } from '@syncfix/shared';
import type { Logger } from 'pino';

import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { DisabledEmailAdapter } from './integrations/email/disabled.js';
import { LogEmailAdapter } from './integrations/email/log.js';
import { SmtpEmailAdapter } from './integrations/email/smtp.js';
import type { EmailAdapter } from './integrations/email/types.js';
import { JobQueue } from './jobs/queue.js';
import { configureSsrfAllowList } from './lib/safe-fetch.js';
import { AuditService } from './services/audit.service.js';
import { AuthService } from './services/auth.service.js';
import { ConnectionService } from './services/connection.service.js';
import { EmailService } from './services/email.service.js';
import { IssueService } from './services/issue.service.js';
import { OrganizationService } from './services/organization.service.js';
import { RepairService } from './services/repair.service.js';
import { ReportService } from './services/report.service.js';
import { RunEngine } from './services/run-engine.service.js';
import { SyncJobService } from './services/sync-job.service.js';
import { WebhookService } from './services/webhook.service.js';

export interface Services {
  config: AppConfig;
  logger: Logger;
  db: AppDatabase;
  audit: AuditService;
  auth: AuthService;
  organizations: OrganizationService;
  connections: ConnectionService;
  syncJobs: SyncJobService;
  issues: IssueService;
  engine: RunEngine;
  repairs: RepairService;
  webhooks: WebhookService;
  reports: ReportService;
  email: EmailService;
  emailAdapter: EmailAdapter;
  jobs: JobQueue;
  permissionsFor: (role: Role) => Permission[];
}

export function createServices(options: {
  db: AppDatabase;
  config: AppConfig;
  logger: Logger;
}): Services {
  const { db, config, logger } = options;

  // Applied once per process. In production this is always an empty list.
  configureSsrfAllowList(config.ssrfAllowHosts);

  const emailAdapter = createEmailAdapter(config);
  const audit = new AuditService(db);
  const jobs = new JobQueue(db);
  const auth = new AuthService(db, config.session.ttlHours);
  const organizations = new OrganizationService(db, audit);

  const connections = new ConnectionService({
    db,
    audit,
    encryptionKey: config.encryptionKey,
  });

  const issues = new IssueService(db, audit);
  const syncJobs = new SyncJobService(db, audit);

  const engine = new RunEngine({ db, logger, connections, issues });

  const repairs = new RepairService({
    db,
    audit,
    issues,
    jobs: syncJobs,
    engine,
    logger,
  });

  const webhooks = new WebhookService({
    db,
    audit,
    encryptionKey: config.encryptionKey,
    appUrl: config.apiUrl,
  });

  const reports = new ReportService({ db, issues, connections });

  const email = new EmailService(
    db,
    emailAdapter,
    config.email.from ?? 'SyncFix <no-reply@syncfix.local>',
  );

  return {
    config,
    logger,
    db,
    audit,
    auth,
    organizations,
    connections,
    syncJobs: syncJobs,
    issues,
    engine,
    repairs,
    webhooks,
    reports,
    email,
    emailAdapter,
    jobs,
    permissionsFor: permissionsForRole,
  };
}

export function createEmailAdapter(config: AppConfig): EmailAdapter {
  switch (config.email.provider) {
    case 'smtp':
      return new SmtpEmailAdapter({
        host: config.email.host!,
        port: config.email.port ?? 587,
        secure: config.email.secure,
        user: config.email.user,
        password: config.email.password,
      });
    case 'log':
      return new LogEmailAdapter(`${process.cwd()}/server/.data/outbox`);
    case 'disabled':
    default:
      return new DisabledEmailAdapter();
  }
}