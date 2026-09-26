/**
 * Error codes the web API and the MCP tools both report. They are part of the
 * contract with clients: add a code rather than changing what one means.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "TITLE_REQUIRED"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT"
  | "INVALID_CURSOR"
  | "CONTENT_MISSING"
  | "RATE_LIMITED"
  /** Nothing the caller can fix. Reported for an unexpected server failure. */
  | "INTERNAL";

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
