import { describe, expect, it, vi } from 'vitest';
import { RateLimitExceededError } from '../../src/errors/app-errors.js';
import { redactCredentials } from '../../src/errors/error-mapper.js';
import { BLOCKED_SCHEMAS, isBlockedSchema } from '../../src/security/blocked-schemas.js';
import { RateLimiter } from '../../src/security/rate-limiter.js';

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
    vi.doMock('../../src/security/blocked-schemas.js', () => ({
      BLOCKED_SCHEMAS: ['secreto'],
      isBlockedSchema: (schema: string) => schema.toLowerCase() === 'secreto',
    }));
    try {
      const { CircuitRegistry } = await import('../../src/circuits/circuit.registry.js');
      const { CircuitLoader } = await import('../../src/circuits/circuit.loader.js');
      const registry = CircuitRegistry.fromDefinitions(
        CircuitLoader.parse(
          'circuits:\n  c:\n    description: x\n    tables:\n      - table: secreto.t\n        role: x\n        key_columns: [a]\n',
        ),
      );
      expect(registry.getTable('c', 'secreto.t')?.queryable).toBe(false);
      expect(registry.getTable('c', 'secreto.t')?.denyReasons).toContain('blocked_schema');
    } finally {
      vi.doUnmock('../../src/security/blocked-schemas.js');
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
