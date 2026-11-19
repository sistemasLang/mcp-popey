import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { AdminUser } from '../admin.models';

/** Presentational: lists users and emits actions. No HTTP here. */
@Component({
  selector: 'app-user-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table class="users">
      <thead>
        <tr>
          <th>Usuario</th>
          <th>Tipo</th>
          <th>Admin</th>
          <th>Rol</th>
          <th>Tenant</th>
          <th>Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        @for (user of users(); track user.id) {
          <tr [class.is-disabled]="!user.enabled">
            <td>{{ user.label }}</td>
            <td>{{ user.kind === 'human' ? 'Persona' : 'Servicio' }}</td>
            <td>{{ user.admin ? 'Sí' : '—' }}</td>
            <td>{{ user.role ?? 'sin acceso al MCP' }}</td>
            <td>{{ user.databaseKey ?? '—' }}</td>
            <td [class.text-ok]="user.enabled" [class.text-error]="!user.enabled">
              {{ user.enabled ? 'Habilitado' : 'Deshabilitado' }}
            </td>
            <td class="users__actions">
              <button type="button" class="btn btn-outline" [disabled]="busy()" (click)="edit.emit(user)">Editar</button>
              @if (user.kind === 'human') {
                <button type="button" class="btn btn-outline" [disabled]="busy() || !user.enabled" (click)="passwordLink.emit(user)">
                  Nuevo link
                </button>
              } @else {
                <button type="button" class="btn btn-outline" [disabled]="busy()" (click)="rotateSecret.emit(user)">
                  Rotar secreto
                </button>
              }
            </td>
          </tr>
        } @empty {
          <tr><td colspan="7" class="text-muted">No hay usuarios.</td></tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    .users { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--color-border-subtle); }
    th { color: var(--color-text-muted); font-weight: 600; }
    tr.is-disabled td:not(:last-child) { color: var(--color-text-disabled); }
    .users__actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
  `,
})
export class UserTableComponent {
  readonly users = input.required<AdminUser[]>();
  readonly busy = input(false);
  readonly edit = output<AdminUser>();
  readonly passwordLink = output<AdminUser>();
  readonly rotateSecret = output<AdminUser>();
}
