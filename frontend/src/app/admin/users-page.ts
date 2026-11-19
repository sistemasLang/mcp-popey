import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AdminApiService } from './admin-api.service';
import { AdminUser, Catalog, InviteRequest, OneTimeValue, ServiceAccountRequest, UserPatch } from './admin.models';
import { InviteFormComponent } from './components/invite-form';
import { OneTimeValueComponent } from './components/one-time-value';
import { ServiceAccountFormComponent } from './components/service-account-form';
import { UserEditFormComponent } from './components/user-edit-form';
import { UserTableComponent } from './components/user-table';

/**
 * Container: owns state and talks to AdminApiService; children only render
 * and emit. Links and secrets are kept in a signal until dismissed, never in
 * storage, and cannot be shown again afterwards.
 */
@Component({
  selector: 'app-users-page',
  imports: [UserTableComponent, InviteFormComponent, ServiceAccountFormComponent, UserEditFormComponent, OneTimeValueComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      <h1 class="h3">Usuarios</h1>

      @if (oneTime(); as item) {
        <app-one-time-value [item]="item" (dismissed)="oneTime.set(null)" />
      }
      @if (notice(); as message) {
        <p class="alert alert--ok">{{ message }}</p>
      }
      @if (error(); as message) {
        <p class="alert alert--error">{{ message }}</p>
      }

      @if (editing(); as user) {
        @if (catalog(); as catalog) {
          <app-user-edit-form [user]="user" [catalog]="catalog" [busy]="busy()" (saved)="save(user, $event)" (cancelled)="editing.set(null)" />
        }
      }

      <section class="card">
        <app-user-table
          [users]="users()"
          [busy]="busy()"
          (edit)="editing.set($event)"
          (passwordLink)="issuePasswordLink($event)"
          (rotateSecret)="rotateSecret($event)"
        />
      </section>

      @if (catalog(); as catalog) {
        <div class="forms">
          <app-invite-form [catalog]="catalog" [busy]="busy()" (submitted)="invite($event)" />
          <app-service-account-form [catalog]="catalog" [busy]="busy()" (submitted)="createServiceAccount($event)" />
        </div>
      }
    </main>
  `,
  styles: `
    .page { max-width: 1100px; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
    .forms { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; }
  `,
})
export class UsersPage implements OnInit {
  private readonly api = inject(AdminApiService);

  protected readonly users = signal<AdminUser[]>([]);
  protected readonly catalog = signal<Catalog | null>(null);
  protected readonly editing = signal<AdminUser | null>(null);
  protected readonly oneTime = signal<OneTimeValue | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.run(async () => {
      this.catalog.set(await firstValueFrom(this.api.catalog()));
      await this.reload();
    });
  }

  protected invite(request: InviteRequest): Promise<void> {
    return this.run(async () => {
      const result = await firstValueFrom(this.api.invite(request));
      if (result.passwordLink) {
        this.oneTime.set({
          title: `Link para ${result.user.label}`,
          detail: 'Con este link la persona elige su contraseña.',
          value: result.passwordLink.url,
          expiresAt: result.passwordLink.expiresAt,
        });
      } else {
        this.error.set(`Se creó ${result.user.label}, pero no se pudo generar el link. Genere uno nuevo desde la tabla.`);
      }
      await this.reload();
    });
  }

  protected issuePasswordLink(user: AdminUser): Promise<void> {
    return this.run(async () => {
      const link = await firstValueFrom(this.api.issuePasswordLink(user.id));
      this.oneTime.set({
        title: `Nuevo link para ${user.label}`,
        detail: 'Sirve también si la persona olvidó su contraseña.',
        value: link.url,
        expiresAt: link.expiresAt,
      });
    });
  }

  protected save(user: AdminUser, patch: UserPatch): Promise<void> {
    return this.run(async () => {
      const result = await firstValueFrom(this.api.update(user.id, patch));
      this.editing.set(null);
      if (result.warning) {
        this.error.set('El cambio se guardó, pero Auth0 no respondió. El acceso al MCP ya está cortado; reintente más tarde.');
      } else {
        this.notice.set(`${result.user.label} actualizado.`);
      }
      await this.reload();
    });
  }

  protected createServiceAccount(request: ServiceAccountRequest): Promise<void> {
    return this.run(async () => {
      const result = await firstValueFrom(this.api.createServiceAccount(request));
      this.oneTime.set({
        title: `Secreto de ${result.user.label}`,
        detail: `Client id: ${result.clientId}`,
        value: result.clientSecret,
      });
      await this.reload();
    });
  }

  protected rotateSecret(user: AdminUser): Promise<void> {
    if (!confirm(`¿Rotar el secreto de ${user.label}? El anterior deja de funcionar.`)) return Promise.resolve();
    return this.run(async () => {
      const result = await firstValueFrom(this.api.rotateServiceSecret(user.id));
      this.oneTime.set({ title: `Nuevo secreto de ${user.label}`, detail: `Client id: ${result.clientId}`, value: result.clientSecret });
    });
  }

  private async reload(): Promise<void> {
    this.users.set(await firstValueFrom(this.api.users()));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await action();
    } catch (error) {
      this.error.set(messageOf(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const apiError = (error.error as { error?: { code?: string; message?: string } } | null)?.error;
    if (apiError?.code === 'LAST_ADMIN') return 'Tiene que quedar al menos un administrador habilitado.';
    if (error.status === 403) return 'No tiene permisos de administrador.';
    if (apiError?.message) return apiError.message;
  }
  return 'Ocurrió un error inesperado.';
}
