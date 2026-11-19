import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Catalog, ServiceAccountRequest } from '../admin.models';
import { SERVICE_NAME_PATTERN } from './access-validators';

/** Presentational: create an M2M service account (e.g. n8n). Role and tenant are mandatory. */
@Component({
  selector: 'app-service-account-form',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card" [formGroup]="form" (ngSubmit)="submit()">
      <h2 class="h5">Crear cuenta de servicio</h2>
      <p class="text-muted">Para procesos sin persona (n8n). Recibe client id y secreto para <code>client_credentials</code>.</p>
      <label class="form-field">
        <span class="form-label">Nombre</span>
        <input class="input" formControlName="name" placeholder="n8n-reportes" autocomplete="off" />
        @if (form.controls.name.touched && form.controls.name.invalid) {
          <span class="form-error">2 a 64 caracteres: minúsculas, números, punto, guion o guion bajo.</span>
        }
      </label>
      <div class="form-row">
        <label class="form-field">
          <span class="form-label">Rol</span>
          <select class="select" formControlName="role">
            <option value="" disabled>Elegir…</option>
            @for (role of catalog().roles; track role) {
              <option [value]="role">{{ role }}</option>
            }
          </select>
        </label>
        <label class="form-field">
          <span class="form-label">Tenant</span>
          <select class="select" formControlName="databaseKey">
            <option value="" disabled>Elegir…</option>
            @for (key of catalog().databaseKeys; track key) {
              <option [value]="key">{{ key }}</option>
            }
          </select>
        </label>
      </div>
      <button type="submit" class="btn btn-primary" [disabled]="form.invalid || busy()">Crear</button>
    </form>
  `,
  styles: `.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }`,
})
export class ServiceAccountFormComponent {
  readonly catalog = input.required<Catalog>();
  readonly busy = input(false);
  readonly submitted = output<ServiceAccountRequest>();

  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.pattern(SERVICE_NAME_PATTERN)]],
    role: ['', Validators.required],
    databaseKey: ['', Validators.required],
  });

  protected submit(): void {
    if (this.form.invalid) return;
    this.submitted.emit(this.form.getRawValue());
    this.form.reset();
  }
}
