import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Catalog, InviteRequest } from '../admin.models';
import { roleWithTenant } from './access-validators';

/** Presentational: invite a person. The panel never asks for nor sees a password. */
@Component({
  selector: 'app-invite-form',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card" [formGroup]="form" (ngSubmit)="submit()">
      <h2 class="h5">Invitar persona</h2>
      <p class="text-muted">No se envía ningún mail: al invitar se genera un link para que la persona elija su contraseña.</p>
      <label class="form-field">
        <span class="form-label">Email</span>
        <input class="input" type="email" formControlName="email" autocomplete="off" />
      </label>
      <label class="form-field form-field--inline">
        <input type="checkbox" formControlName="admin" />
        <span>Administrador del panel</span>
      </label>
      <div class="form-row">
        <label class="form-field">
          <span class="form-label">Rol</span>
          <select class="select" formControlName="role">
            <option value="">Sin acceso al MCP</option>
            @for (role of catalog().roles; track role) {
              <option [value]="role">{{ role }}</option>
            }
          </select>
        </label>
        <label class="form-field">
          <span class="form-label">Tenant</span>
          <select class="select" formControlName="databaseKey">
            <option value="">—</option>
            @for (key of catalog().databaseKeys; track key) {
              <option [value]="key">{{ key }}</option>
            }
          </select>
        </label>
      </div>
      @if (form.hasError('roleWithTenant')) {
        <p class="form-error">Elija rol y tenant juntos, o ninguno de los dos.</p>
      }
      <button type="submit" class="btn btn-primary" [disabled]="form.invalid || busy()">Invitar</button>
    </form>
  `,
  styles: `
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .form-field--inline { flex-direction: row; align-items: center; gap: 0.5rem; }
  `,
})
export class InviteFormComponent {
  readonly catalog = input.required<Catalog>();
  readonly busy = input(false);
  readonly submitted = output<InviteRequest>();

  protected readonly form = inject(NonNullableFormBuilder).group(
    {
      email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
      admin: [false],
      role: [''],
      databaseKey: [''],
    },
    { validators: roleWithTenant },
  );

  protected submit(): void {
    if (this.form.invalid) return;
    const { email, admin, role, databaseKey } = this.form.getRawValue();
    this.submitted.emit({ email, admin, ...(role ? { role, databaseKey } : {}) });
    this.form.reset();
  }
}
