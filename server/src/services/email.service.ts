/**
 * Email outbox (Part D / D4.8 "notify configured users").
 *
 * SyncFix only uses email for issue notifications and invitations, and only when
 * an operator has configured a real provider. Status vocabulary:
 *
 *   queued -> accepted  (the provider took the message for delivery)
 *          -> failed     (the provider rejected it, permanently or temporarily)
 *
 * "accepted" is never reported as "delivered": SMTP does not report delivery.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { emailMessages, emailTemplates } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { EmailAdapter } from '../integrations/email/types.js';

export interface QueueResult {
  messageId: string;
  deduplicated: boolean;
}

export class EmailService {
  private readonly db: AppDatabase;
  private readonly adapter: EmailAdapter;
  private readonly fromAddress: string;

  constructor(db: AppDatabase, adapter: EmailAdapter, fromAddress: string) {
    this.db = db;
    this.adapter = adapter;
    this.fromAddress = fromAddress;
  }

  get provider(): EmailAdapter {
    return this.adapter;
  }

  get from(): string {
    return this.fromAddress;
  }

  async seedTemplates(organizationId: string): Promise<void> {
    const existing = await this.db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(eq(emailTemplates.organizationId, organizationId))
      .limit(1);
    if (existing[0]) return;
    await this.db.insert(emailTemplates).values(
      [
        {
          type: 'invitation',
          subject: 'You have been invited to join an organization on SyncFix',
          bodyHtml: '<p>{{inviterName}} invited you to join {{organizationName}} as {{role}}.</p>',
        },
        {
          type: 'issue_opened',
          subject: 'SyncFix: {{severity}} issue on {{jobName}}',
          bodyHtml: '<p>{{issueSummary}}</p>',
        },
        {
          type: 'run_failed',
          subject: 'SyncFix: run failed on {{jobName}}',
          bodyHtml: '<p>{{runSummary}}</p>',
        },
      ].map((template) => ({ organizationId, ...template })),
    );
  }

  /** Persists a message without sending it. Returns `deduplicated` on replay. */
  async queue(input: {
    organizationId: string | null;
    templateType: string;
    to: string;
    subject: string;
    bodyText: string;
    idempotencyKey?: string | null;
  }): Promise<QueueResult> {
    if (input.idempotencyKey) {
      const existing = await this.db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(eq(emailMessages.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) return { messageId: existing[0].id, deduplicated: true };
    }

    const inserted = await this.db
      .insert(emailMessages)
      .values({
        organizationId: input.organizationId,
        templateType: input.templateType,
        toAddress: input.to,
        fromAddress: this.fromAddress,
        subject: input.subject,
        bodyText: input.bodyText,
        status: 'queued',
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: emailMessages.id });

    const row = inserted[0];
    if (!row) return { messageId: '', deduplicated: true };
    return { messageId: row.id, deduplicated: false };
  }

  async deliver(messageId: string): Promise<{
    status: 'sent' | 'failed';
    retryable: boolean;
    message: string;
    providerMessageId: string | null;
  }> {
    const rows = await this.db.select().from(emailMessages).where(eq(emailMessages.id, messageId)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('Email message');

    const result = await this.adapter.send({
      to: row.toAddress,
      from: row.fromAddress,
      subject: row.subject,
      text: row.bodyText ?? '',
      idempotencyKey: row.idempotencyKey ?? undefined,
    });

    if (result.accepted) {
      await this.db
        .update(emailMessages)
        .set({
          status: 'sent',
          providerMessageId: result.providerMessageId ?? null,
          sentAt: new Date(),
          failureCode: null,
          safeFailureMessage: null,
        })
        .where(eq(emailMessages.id, messageId));
      return {
        status: 'sent',
        retryable: false,
        message: result.message,
        providerMessageId: result.providerMessageId ?? null,
      };
    }

    const retryable = result.failureCode === 'temporary' || result.failureCode === 'provider_error';
    await this.db
      .update(emailMessages)
      .set({
        status: 'failed',
        failureCode: result.failureCode ?? 'provider_error',
        safeFailureMessage: result.message.slice(0, 300),
      })
      .where(eq(emailMessages.id, messageId));

    return { status: 'failed', retryable, message: result.message, providerMessageId: null };
  }

  /** Queues one message to many recipients with a shared idempotency key. */
  async queueToMany(input: {
    organizationId: string;
    templateType: string;
    recipients: string[];
    subject: string;
    bodyText: string;
    idempotencyKey: string;
  }): Promise<{ queued: number; deduplicated: number; sent: number }> {
    let queued = 0;
    let deduplicated = 0;
    let sent = 0;
    for (const recipient of [...new Set(input.recipients)]) {
      const result = await this.queue({
        organizationId: input.organizationId,
        templateType: input.templateType,
        to: recipient,
        subject: input.subject,
        bodyText: input.bodyText,
        idempotencyKey: `${input.idempotencyKey}:${recipient}`,
      });
      if (result.deduplicated) {
        deduplicated += 1;
        continue;
      }
      queued += 1;
      const delivery = await this.deliver(result.messageId);
      if (delivery.status === 'sent') sent += 1;
    }
    return { queued, deduplicated, sent };
  }

  async outbox(organizationId: string, limit = 50) {
    return this.db
      .select({
        id: emailMessages.id,
        templateType: emailMessages.templateType,
        toAddress: emailMessages.toAddress,
        subject: emailMessages.subject,
        status: emailMessages.status,
        providerMessageId: emailMessages.providerMessageId,
        failureCode: emailMessages.failureCode,
        safeFailureMessage: emailMessages.safeFailureMessage,
        sentAt: emailMessages.sentAt,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, organizationId))
      .orderBy(desc(emailMessages.createdAt))
      .limit(Math.min(limit, 200));
  }

  async stats(organizationId: string) {
    const rows = await this.db
      .select({ status: emailMessages.status, count: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, organizationId))
      .groupBy(emailMessages.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async listTemplates(organizationId: string) {
    return this.db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.organizationId, organizationId))
      .orderBy(emailTemplates.type);
  }

  async templateFor(organizationId: string, type: string) {
    const rows = await this.db
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.organizationId, organizationId), eq(emailTemplates.type, type)))
      .limit(1);
    return rows[0] ?? null;
  }
}