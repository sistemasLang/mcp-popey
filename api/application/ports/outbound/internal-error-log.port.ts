/** Reports an unexpected error to operators. Never reaches an MCP client. */
export type InternalErrorLogger = (error: unknown) => void;
