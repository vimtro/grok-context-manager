/** Typed errors with stable codes; CLI maps them to exit codes and MCP to tool errors. */
export type GcmErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'INTEGRITY'
  | 'APPROVAL_REQUIRED'
  | 'INVALID_STATE'
  | 'LIMIT_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

export class GcmError extends Error {
  constructor(
    public readonly code: GcmErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'GcmError';
  }
}

export const EXIT_CODES: Record<GcmErrorCode, number> = {
  VALIDATION: 2,
  NOT_FOUND: 3,
  FORBIDDEN: 6,
  CONFLICT: 7,
  INTEGRITY: 4,
  APPROVAL_REQUIRED: 5,
  INVALID_STATE: 7,
  LIMIT_EXCEEDED: 2,
  PROVIDER_UNAVAILABLE: 8,
  INTERNAL: 1,
};

export function isGcmError(e: unknown): e is GcmError {
  return e instanceof GcmError;
}
