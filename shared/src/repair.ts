/**
 * Repair types shared between server and client (Part D / D5).
 */

export type RepairKind = 'retry' | 'replay' | 'skip' | 'resolve';

export interface RepairContext {
  organizationId: string;
  actorUserId: string;
  /** True when the actor holds `issue.repair.destructive`. */
  mayRepairDestructively: boolean;
  requestId: string | null;
  ipAddress: string | null;
}

export interface RepairResult {
  attemptId: string;
  status: 'succeeded' | 'failed' | 'rejected';
  message: string;
  runId: string | null;
}