/**
 * Error codes the web API and the MCP tools both report. They are part of the
 * contract with clients: add a code rather than changing what one means.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  /** The artifact exists and belongs to someone else. Nothing else about it is sent. */
  | "PRIVATE"
  | "INVALID_INPUT"
  | "TITLE_REQUIRED"
  /** A new artifact would share its title with an existing one. */
  | "TITLE_EXISTS"
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
    /** Sent with TITLE_EXISTS: the artifact that already has the title. */
    readonly artifactId?: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
