import type {
  IdentityProviderPort,
  PasswordLink,
  ServiceCredentials,
} from '../../../application/ports/outbound/identity-provider.port.js';
import { IdentityProviderError } from '../../../domain/errors.js';

type Method = Exclude<keyof IdentityProviderPort, 'issuer'>;

interface FakeHuman {
  subject: string;
  email: string;
  blocked: boolean;
}

interface FakeClient {
  subject: string;
  clientId: string;
  secret: string;
  granted: boolean;
}

/** In-process identity provider for tests: records calls and can be told to fail. */
export class FakeIdentityProvider implements IdentityProviderPort {
  readonly calls: Array<{ method: Method; args: unknown[] }> = [];
  readonly humans = new Map<string, FakeHuman>();
  readonly clients = new Map<string, FakeClient>();
  private readonly failing = new Set<Method>();
  private sequence = 0;

  constructor(readonly issuer = 'https://idp.test/') {}

  /** Makes every call to `method` fail until `recover` is called. */
  fail(method: Method): this {
    this.failing.add(method);
    return this;
  }

  recover(method: Method): this {
    this.failing.delete(method);
    return this;
  }

  /** A person created by hand at the provider (e.g. the first admin). */
  addHuman(email: string, subject = `auth0|${email}`): string {
    this.humans.set(subject, { subject, email, blocked: false });
    return subject;
  }

  calledWith(method: Method): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  async createHuman(email: string): Promise<{ subject: string }> {
    this.record('createHuman', email);
    const subject = this.addHuman(email, `auth0|fake-${++this.sequence}`);
    return { subject };
  }

  async issuePasswordLink(subject: string): Promise<PasswordLink> {
    this.record('issuePasswordLink', subject);
    return { url: `https://idp.test/u/reset-verify?ticket=t${++this.sequence}`, expiresAt: new Date('2030-01-01T00:00:00Z') };
  }

  async findHumanByEmail(email: string): Promise<{ subject: string } | null> {
    this.record('findHumanByEmail', email);
    const human = [...this.humans.values()].find((candidate) => candidate.email === email);
    return human ? { subject: human.subject } : null;
  }

  async setHumanBlocked(subject: string, blocked: boolean): Promise<void> {
    this.record('setHumanBlocked', subject, blocked);
    const human = this.humans.get(subject);
    if (human) human.blocked = blocked;
  }

  async createServiceClient(name: string): Promise<ServiceCredentials & { subject: string }> {
    this.record('createServiceClient', name);
    const clientId = `client-${++this.sequence}`;
    const client = { subject: `${clientId}@clients`, clientId, secret: `secret-${this.sequence}`, granted: true };
    this.clients.set(client.subject, client);
    return { subject: client.subject, clientId, clientSecret: client.secret };
  }

  async rotateServiceSecret(subject: string): Promise<ServiceCredentials> {
    this.record('rotateServiceSecret', subject);
    const client = this.client(subject);
    client.secret = `secret-${++this.sequence}`;
    return { clientId: client.clientId, clientSecret: client.secret };
  }

  async revokeServiceClient(subject: string): Promise<void> {
    this.record('revokeServiceClient', subject);
    this.client(subject).granted = false;
  }

  async restoreServiceClient(subject: string): Promise<void> {
    this.record('restoreServiceClient', subject);
    this.client(subject).granted = true;
  }

  private record(method: Method, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failing.has(method)) throw new IdentityProviderError(`identity provider ${method} failed`);
  }

  private client(subject: string): FakeClient {
    const client = this.clients.get(subject);
    if (!client) throw new IdentityProviderError('unknown client');
    return client;
  }
}
