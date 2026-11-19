import { describe, expect, it, vi } from 'vitest';
import { RateLimitExceededError } from '../../api/domain/errors.js';
import { redactCredentials } from '../../api/adapters/outbound/logging/stderr-internal-error.logger.js';
import { BLOCKED_SCHEMAS, isBlockedSchema } from '../../api/domain/security/blocked-schemas.js';
import { SlidingWindowRateLimiter as RateLimiter } from '../../api/adapters/outbound/memory/sliding-window.rate-limiter.js';

describe('RateLimiter', () => {
  it('allows maxRequests per window and per user, then recovers', () => {
    let now = 0;
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => now });

    for (let i = 0; i < 3; i++) limiter.consume('u1');
    expect(() => limiter.consume('u1')).toThrow(RateLimitExceededError);
    expect(() => limiter.consume('u2')).not.toThrow();

    now = 60_001;
    expect(() => limiter.consume('u1')).not.toThrow();
  });

  it('is a sliding window, not a fixed one', () => {
    let now = 0;
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1_000, now: () => now });
    limiter.consume('u');
    now = 900;
    limiter.consume('u');
    now = 1_001; // first hit expired, second still inside
    limiter.consume('u');
    expect(() => limiter.consume('u')).toThrow(RateLimitExceededError);
  });
});

describe('blocked schemas', () => {
  it('seguridad is enabled on purpose: no real schema is blocked today', () => {
    expect(BLOCKED_SCHEMAS).not.toContain('seguridad');
    expect(isBlockedSchema('seguridad')).toBe(false);
    expect(isBlockedSchema('stock')).toBe(false);
  });

  it('a schema added to the list blocks every table, case-insensitively', async () => {
    vi.resetModules();
    vi.doMock('../../api/domain/security/blocked-schemas.js', () => ({
      BLOCKED_SCHEMAS: ['secreto'],
      isBlockedSchema: (schema: string) => schema.toLowerCase() === 'secreto',
    }));
    try {
      const { CircuitRegistry } = await import('../../api/domain/circuits/circuit.registry.js');
      const { CircuitLoader } = await import('../../api/adapters/outbound/yaml/circuit.loader.js');
      const registry = CircuitRegistry.fromDefinitions(
        CircuitLoader.parse(
          'circuits:\n  c:\n    description: x\n    tables:\n      - table: secreto.t\n        role: x\n        key_columns: [a]\n',
        ),
      );
      expect(registry.getTable('c', 'secreto.t')?.queryable).toBe(false);
      expect(registry.getTable('c', 'secreto.t')?.denyReasons).toContain('blocked_schema');
    } finally {
      vi.doUnmock('../../api/domain/security/blocked-schemas.js');
      vi.resetModules();
    }
  });
});

describe('redactCredentials', () => {
  it('hides passwords embedded in URLs', () => {
    expect(redactCredentials('failed postgres://mcp_popey_ro:s3cr3t@10.0.0.5:5432/lang')).toBe(
      'failed postgres://mcp_popey_ro:***@10.0.0.5:5432/lang',
    );
    expect(redactCredentials('no secrets here')).toBe('no secrets here');
  });
});

describe('JsonLinesAuditLogger', () => {
  it('writes tool events as type "audit" and admin events as type "admin" to the same file', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonLinesAuditLogger } = await import('../../api/adapters/outbound/audit/json-lines-audit.logger.js');
    const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
    const logger = new JsonLinesAuditLogger(file);
    logger.log({
      timestamp: 't',
      userId: 'u',
      principalKind: 'service',
      role: 'ventas',
      databaseKey: 'lang',
      tool: 'list_circuits',
      durationMs: 1,
      success: true,
    });
    logger.logAdmin({ timestamp: 't', actorUserId: 'bootstrap', action: 'bootstrap_admin', targetUserId: 'a', changedFields: ['admin'], success: true });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['audit', 'admin']);
    expect(lines[0]).toMatchObject({ principalKind: 'service' });
  });
});
