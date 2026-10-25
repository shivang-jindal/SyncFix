/**
 * Organization-scoped API helper.
 *
 * Every tenant route lives under `/:organizationId`, so the pages never have
 * to interpolate the id themselves (and cannot accidentally call the API
 * without it).
 */

import { useParams } from 'react-router-dom';

import { api } from './api';

export interface OrgApi {
  base: string;
  get: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  del: <T>(path: string) => Promise<T>;
}

export function useOrgApi(): OrgApi {
  const { organizationId } = useParams();
  const base = `/${organizationId ?? ''}`;
  return {
    base,
    get: <T,>(path: string, signal?: AbortSignal) => api.get<T>(`${base}${path}`, signal),
    post: <T,>(path: string, body?: unknown) => api.post<T>(`${base}${path}`, body),
    patch: <T,>(path: string, body?: unknown) => api.patch<T>(`${base}${path}`, body),
    del: <T,>(path: string) => api.del<T>(`${base}${path}`),
  };
}
