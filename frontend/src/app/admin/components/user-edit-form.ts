import { ChangeDetectionStrategy, Component, effect, inject, input, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { AdminUser, Catalog, UserPatch } from '../admin.models';
import { roleWithTenant } from './access-validators';

/** Presentational: edit admin / role + tenant / enabled. Emits only what changed. */
@Component({
  selector: 'app-user-edit-form',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card" [formGroup]="form" (ngSubmit)="submit()">
      <h2 class="h5">Editar {{ user().label }}</h2>
      @if (user().kind === 'human') {
        <label class="form-field form-field--inline">
          <input type="checkbox" formControlName="admin" />
          <span>Administrador del panel</span>
        </label>
      }
      <label class="form-field form-field--inline">
        <input type="checkbox" formControlName="enabled" />
        <span>Habilitado (deshabilitar corta el acceso al instante)</span>
      </label>
      <div class="form-row">
        <label class="form-field">
          <span class="form-label">Rol</span>
          <select class="select" formControlName="role">
            @if (user().kind === 'human') {
              <option value="">Sin acceso al MCP</option>
            }
            @for (role of catalog().roles; track role) {
              <option [value]="role">{{ role }}</option>
            }
          </select>
        </label>
        <label class="form-field">
          <span class="form-label">Tenant</span>
          <select class="select" formControlName="databaseKey">
            @if (user().kind === 'human') {
              <option value="">—</option>
            }
            @for (key of catalog().databaseKeys; track key) {
              <option [value]="key">{{ key }}</option>
            }
          </select>
        </label>
      </div>
      @if (form.hasError('roleWithTenant')) {
        <p class="form-error">Elija rol y tenant juntos, o ninguno de los dos.</p>
      }
      <div class="actions">
        <button type="submit" class="btn btn-primary" [disabled]="form.invalid || form.pristine || busy()">Guardar</button>
        <button type="button" class="btn btn-outline" (click)="cancelled.emit()">Cancelar</button>
      </div>
    </form>
  `,
  styles: `
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .form-field--inline { flex-direction: row; align-items: center; gap: 0.5rem; }
    .actions { display: flex; gap: 0.5rem; }
  `,
})
export class UserEditFormComponent {
  readonly user = input.required<AdminUser>();
  readonly catalog = input.required<Catalog>();
  readonly busy = input(false);
  readonly saved = output<UserPatch>();
  readonly cancelled = output<void>();

  protected readonly form = inject(NonNullableFormBuilder).group(
    { admin: [false], enabled: [true], role: [''], databaseKey: [''] },
    { validators: roleWithTenant },
  );

  constructor() {
    effect(() => {
      const user = this.user();
      this.form.reset({ admin: user.admin, enabled: user.enabled, role: user.role ?? '', databaseKey: user.databaseKey ?? '' });
    });
  }

  protected submit(): void {
    if (this.form.invalid) return;
    const user = this.user();
    const value = this.form.getRawValue();
    const patch: UserPatch = {};
    if (value.admin !== user.admin) patch.admin = value.admin;
    if (value.enabled !== user.enabled) patch.enabled = value.enabled;
    if ((value.role || null) !== user.role || (value.databaseKey || null) !== user.databaseKey) {
      patch.role = value.role || null;
      patch.databaseKey = value.databaseKey || null;
    }
    if (Object.keys(patch).length > 0) this.saved.emit(patch);
  }
}
