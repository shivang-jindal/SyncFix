/**
 * Field mapping and transformation (Part D / D4.6, D9).
 *
 * A mapping is DATA, never code: it names one key from the `TRANSFORM_TYPES`
 * allow-list plus a small, closed JSON config. There is no evaluator, no
 * expression parser and no `eval` anywhere in this file, so a user cannot
 * smuggle JavaScript through a "mapping expression"
 * (Part D / D9: "Never run arbitrary code from field-mapping expressions").
 */

import {
  ALLOWED_TRANSFORM_CONFIG_KEYS,
  REQUIRED_TRANSFORM_CONFIG,
  syncMappingInputSchema,
  type FieldType,
  type SyncMappingInput,
  type TransformType,
} from '@syncfix/shared';

import { badRequest } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Value access                                                               */
/* -------------------------------------------------------------------------- */

/** Reads a dotted path with optional `[]` indexes from a plain object. */
export function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Writes a dotted path, creating intermediate objects. Never evaluates code. */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return;

  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/* -------------------------------------------------------------------------- */
/* Type conversion                                                            */
/* -------------------------------------------------------------------------- */

export interface ConversionResult {
  ok: boolean;
  value: unknown;
  /** Operator-facing explanation when `ok` is false. */
  message?: string;
}

export function convertValue(value: unknown, target: FieldType): ConversionResult {
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }
  switch (target) {
    case 'string':
      if (typeof value === 'object') return { ok: true, value: JSON.stringify(value) };
      return { ok: true, value: String(value) };

    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[\s,_]/g, ''));
      if (!Number.isFinite(numeric)) {
        return { ok: false, value: null, message: `"${String(value).slice(0, 60)}" is not a number.` };
      }
      return { ok: true, value: numeric };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      const text = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(text)) return { ok: true, value: true };
      if (['false', '0', 'no', 'n', 'off', ''].includes(text)) return { ok: true, value: false };
      return { ok: false, value: null, message: `"${String(value).slice(0, 60)}" is not a boolean.` };
    }

    case 'date': {
      const parsed = parseDate(value);
      if (!parsed) return { ok: false, value: null, message: `"${String(value).slice(0, 60)}" is not a date.` };
      return { ok: true, value: parsed.slice(0, 10) };
    }

    case 'datetime': {
      const parsed = parseDate(value);
      if (!parsed) {
        return { ok: false, value: null, message: `"${String(value).slice(0, 60)}" is not a timestamp.` };
      }
      return { ok: true, value: parsed };
    }

    case 'json':
      if (typeof value === 'string') {
        try {
          return { ok: true, value: JSON.parse(value) };
        } catch {
          return { ok: false, value: null, message: 'Value is not valid JSON.' };
        }
      }
      return { ok: true, value };

    default:
      return { ok: true, value };
  }
}

function parseDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    // Seconds vs milliseconds.
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Transform allow-list                                                       */
/* -------------------------------------------------------------------------- */

/** Thrown for a transform that cannot be applied; carries a safe message. */
export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

export function applyTransform(
  value: unknown,
  transformType: TransformType,
  config: Record<string, unknown>,
): unknown {
  const text = (input: unknown): string | null =>
    input === null || input === undefined ? null : typeof input === 'string' ? input : String(input);

  switch (transformType) {
    case 'none':
      return value;

    case 'trim':
      return text(value)?.trim() ?? null;

    case 'uppercase':
      return text(value)?.toUpperCase() ?? null;

    case 'lowercase':
      return text(value)?.toLowerCase() ?? null;

    case 'to_number':
      return convertValue(value, 'number');

    case 'to_integer': {
      const numeric = convertValue(value, 'number');
      if (!numeric.ok) return numeric;
      if (numeric.value === null) return null;
      return { ok: true, value: Math.trunc(numeric.value as number) };
    }

    case 'to_boolean':
      return convertValue(value, 'boolean');

    case 'to_iso_date':
      return convertValue(value, 'date');

    case 'to_iso_datetime':
      return convertValue(value, 'datetime');

    case 'prefix': {
      const prefix = String(config.value ?? '');
      return `${prefix}${text(value) ?? ''}`;
    }

    case 'suffix': {
      const suffix = String(config.value ?? '');
      return `${text(value) ?? ''}${suffix}`;
    }

    case 'concat': {
      const secondary = readPath(value, String(config.secondaryPath ?? ''));
      const separator = String(config.separator ?? '');
      return `${text(value) ?? ''}${separator}${text(secondary) ?? ''}`;
    }

    case 'default_if_empty': {
      const isEmpty =
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim() === '');
      return isEmpty ? (config.value ?? null) : value;
    }

    case 'split_first': {
      const delimiter = String(config.delimiter ?? ',');
      const input = text(value);
      if (input === null) return null;
      const index = input.indexOf(delimiter);
      return index === -1 ? input : input.slice(0, index);
    }

    case 'json_path': {
      if (value === null || value === undefined) return null;
      return readPath(value, String(config.path ?? ''));
    }

    case 'template': {
      // Only `{{field}}` substitution of the SOURCE payload is supported.
      // The template itself is a literal string, never evaluated.
      const template = String(config.template ?? '');
      return template.replace(/\{\{\s*([A-Za-z0-9_.[\]]+)\s*\}\}/g, (_match, field: string) => {
        const replaced = readPath(value, field);
        return replaced === null || replaced === undefined ? '' : String(replaced);
      });
    }

    case 'null_to_empty_string':
      return value === null || value === undefined ? '' : value;

    case 'truncate': {
      const max = Number(config.maxLength ?? 255);
      const input = text(value);
      if (input === null) return null;
      if (!Number.isFinite(max) || max <= 0) return input;
      return input.slice(0, Math.trunc(max));
    }

    default:
      throw new TransformError(`Unknown transform "${String(transformType)}".`);
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping validation                                                         */
/* -------------------------------------------------------------------------- */

export interface MappingIssue {
  index: number;
  destinationPath: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface MappingValidationResult {
  valid: boolean;
  issues: MappingIssue[];
  /** Destination fields that are not covered by any mapping. */
  uncoveredFields: string[];
}

/**
 * Validates a set of mappings before they are activated (Part D / D4.6).
 * Every problem is returned as structured data so the UI can point at the
 * exact row instead of failing with a generic message.
 */
export function validateMappings(input: {
  mappings: SyncMappingInput[];
  /** Field names observed on a real sample, when available. */
  sampleSourceFields?: string[];
  requiredDestinationFields?: string[];
}): MappingValidationResult {
  const issues: MappingIssue[] = [];
  const destinations = new Set<string>();
  const covered = new Set<string>();
  const mappedSources = new Set<string>();

  input.mappings.forEach((mapping, index) => {
    const parsed = syncMappingInputSchema.safeParse(mapping);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          index,
          destinationPath: mapping.destinationPath ?? '(unnamed)',
          severity: 'error',
          message: `${issue.path.join('.') || 'mapping'}: ${issue.message}`,
        });
      }
      return;
    }

    if (destinations.has(parsed.data.destinationPath)) {
      issues.push({
        index,
        destinationPath: parsed.data.destinationPath,
        severity: 'error',
        message: 'Two mappings write to the same destination field.',
      });
    }
    destinations.add(parsed.data.destinationPath);
    mappedSources.add(parsed.data.sourcePath);

    if (parsed.data.required && parsed.data.defaultValue === undefined) {
      issues.push({
        index,
        destinationPath: parsed.data.destinationPath,
        severity: 'warning',
        message: 'Marked required with no default. Records without this field will fail.',
      });
    }

    for (const key of Object.keys(parsed.data.transformConfig)) {
      if (!ALLOWED_TRANSFORM_CONFIG_KEYS.has(key)) {
        issues.push({
          index,
          destinationPath: parsed.data.destinationPath,
          severity: 'error',
          message: `"${key}" is not a recognised transform option. Arbitrary code is never evaluated.`,
        });
      }
    }
    for (const required of REQUIRED_TRANSFORM_CONFIG[parsed.data.transformType] ?? []) {
      if (parsed.data.transformConfig[required] === undefined) {
        issues.push({
          index,
          destinationPath: parsed.data.destinationPath,
          severity: 'error',
          message: `The ${parsed.data.transformType} transform needs a "${required}" option.`,
        });
      }
    }
  });

  if (input.mappings.length === 0) {
    issues.push({
      index: -1,
      destinationPath: '(none)',
      severity: 'error',
      message: 'At least one field mapping is required before a job can run.',
    });
  }

  const sample = input.sampleSourceFields ?? [];
  if (sample.length > 0) {
    for (const field of sample) {
      if (!mappedSources.has(field)) covered.add(field);
    }
    if (covered.size > 0) {
      issues.push({
        index: -1,
        destinationPath: '(unmapped source fields)',
        severity: 'warning',
        message: `${covered.size} field(s) present in the sample are not mapped and will not be written: ${[...covered].slice(0, 10).join(', ')}.`,
      });
    }
  }

  for (const field of input.requiredDestinationFields ?? []) {
    if (!destinations.has(field)) {
      issues.push({
        index: -1,
        destinationPath: field,
        severity: 'error',
        message: `"${field}" is required by the destination but no mapping writes to it.`,
      });
    }
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    uncoveredFields: [...covered].sort(),
  };
}

/** Normalises a mapping for the engine: config is a plain, closed object. */
export function normalizeMapping(mapping: SyncMappingInput) {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(mapping.transformConfig ?? {})) {
    if (ALLOWED_TRANSFORM_CONFIG_KEYS.has(key)) config[key] = mapping.transformConfig[key];
  }
  return {
    sourcePath: mapping.sourcePath,
    destinationPath: mapping.destinationPath,
    sourceType: mapping.sourceType,
    destinationType: mapping.destinationType,
    transformType: mapping.transformType,
    transformConfig: config,
    required: mapping.required,
    defaultValue: mapping.defaultValue,
  };
}

/** Runs one mapping against a source payload, returning the destination value. */
export function applyMapping(
  source: Record<string, unknown>,
  mapping: ReturnType<typeof normalizeMapping>,
): ConversionResult {
  const raw = readPath(source, mapping.sourcePath);
  const transformed = applyTransform(raw, mapping.transformType, mapping.transformConfig);
  if (transformed !== null && typeof transformed === 'object' && 'ok' in (transformed as object)) {
    const conversion = transformed as ConversionResult;
    if (!conversion.ok) {
      return { ok: false, value: null, message: conversion.message ?? 'Transform failed.' };
    }
    return convertValue(conversion.value, mapping.destinationType);
  }
  return convertValue(transformed, mapping.destinationType);
}

export function assertMappingInput(value: unknown): SyncMappingInput {
  const parsed = syncMappingInputSchema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : 'mapping';
      (fields[key] ??= []).push(issue.message);
    }
    throw badRequest('That field mapping is not valid.', fields);
  }
  return parsed.data;
}