/**
 * Result/error helpers — a tiny tagged-union for fallible operations so
 * connectors and analyzers can return failures without throwing.
 *
 * OWNED BY: Wave 1 (Lead-approval required to change).
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E = Error> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = Error>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Returns the value or throws the error. Use only at trust boundaries. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error
    ? result.error
    : new Error(String(result.error));
}

/** Returns the value or a fallback if the result is an error. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Wraps a possibly-throwing sync function into a Result. */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Wraps a possibly-rejecting async function into a Result. */
export async function tryCatchAsync<T>(
  fn: () => Promise<T>,
): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
