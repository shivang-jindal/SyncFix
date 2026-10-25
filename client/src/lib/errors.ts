import { ApiError } from './api';

/** Turns any thrown value into a sentence a person can act on. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const first = Object.values(error.fields)[0];
    if (first && first.length > 0) return first[0]!;
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}
