import type { BadgeTone } from './ui';
import { Badge } from './ui';

const TONES: Record<string, BadgeTone> = {
  active: 'success',
  enabled: 'success',
  verified: 'success',
  succeeded: 'success',
  resolved: 'success',
  healthy: 'success',
  configured: 'info',
  running: 'info',
  retrying: 'info',
  queued: 'info',
  partial: 'warning',
  paused: 'warning',
  needs_attention: 'warning',
  warning: 'warning',
  open: 'danger',
  failed: 'danger',
  error: 'danger',
  critical: 'danger',
  disabled: 'neutral',
  skipped: 'neutral',
  not_configured: 'neutral',
  draft: 'neutral',
  unknown: 'neutral',
};

export function humanizeStatus(status: string): string {
  return status
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Status is always label + shape + colour, never colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const key = status.toLowerCase();
  return <Badge tone={TONES[key] ?? 'neutral'}>{humanizeStatus(key)}</Badge>;
}
