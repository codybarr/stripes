export type ErrorCode =
  | "unsupported"
  | "permission-canceled"
  | "device-busy"
  | "connection-failed"
  | "operation-in-progress"
  | "disconnected"
  | "invalid-input"
  | "not-ready"
  | "status-unknown"
  | "query-failed"
  | "print-outcome-unknown"

/** Stable codes for application logic; messages are intended for people. */
export class StripesError extends Error {
  override readonly name = "StripesError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function invalid(message: string): never {
  throw new StripesError("invalid-input", message)
}
