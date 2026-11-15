/** Internal diagnostics go to stderr (pm2 error log), with credentials in URLs redacted. */
export function logInternalError(error: unknown): void {
  const detail = redactCredentials(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.stderr.write(`${JSON.stringify({ type: 'internal_error', timestamp: new Date().toISOString(), detail })}\n`);
}

export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@');
}
