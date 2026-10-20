/**
 * Default email templates.
 *
 * `{{placeholder}}` substitution is a plain string replacement from a closed
 * context map. No expression is evaluated.
 */

export interface TemplateContext {
  [key: string]: string | number | null;
}

export const DEFAULT_TEMPLATES: Array<{
  type: string;
  subject: string;
  bodyHtml: string;
}> = [
  {
    type: 'invitation',
    subject: 'You have been invited to join {{organizationName}} on SyncFix',
    bodyHtml:
      '<p>{{inviterName}} invited you to join {{organizationName}} as {{role}}.</p><p>Accept the invitation: {{acceptUrl}}</p>',
  },
  {
    type: 'issue_opened',
    subject: 'SyncFix: {{severity}} issue on {{jobName}}',
    bodyHtml:
      '<p>A {{severity}} {{issueType}} issue was recorded on job "{{jobName}}".</p><p>{{issueSummary}}</p>',
  },
  {
    type: 'run_failed',
    subject: 'SyncFix: run failed on {{jobName}}',
    bodyHtml: '<p>A scheduled run of "{{jobName}}" failed.</p><p>{{runSummary}}</p>',
  },
];

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function renderTemplate(template: string, context: TemplateContext, html: boolean): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = context[key];
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (!html) return text;
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  });
}

export function renderPlainText(html: string, context: TemplateContext): string {
  return renderTemplate(html, context, false);
}