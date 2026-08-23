/**
 * Minimal ambient types for `proper-lockfile`, which ships none.
 *
 * Only the surface the harness actually uses is declared. A wider hand-written
 * definition would be a second source of truth that drifts from the library.
 */
declare module "proper-lockfile" {
  export type LockOptions = {
    stale?: number;
    realpath?: boolean;
    retries?:
      | number
      | { retries?: number; minTimeout?: number; maxTimeout?: number; factor?: number };
    onCompromised?: (err: Error) => void;
  };
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;
}
