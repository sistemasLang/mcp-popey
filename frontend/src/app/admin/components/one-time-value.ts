import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { OneTimeValue } from '../admin.models';

/**
 * Shows a password link or a client secret ONCE. The value lives only in
 * this component's input: it is never written to storage, and once
 * dismissed it cannot be shown again (a new one must be issued).
 */
@Component({
  selector: 'app-one-time-value',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card one-time" role="alert">
      <h2 class="h5">{{ item().title }}</h2>
      <p class="text-muted">Se muestra una sola vez. Cópielo ahora y entréguelo por un canal confiable.</p>
      @if (item().detail) {
        <p>{{ item().detail }}</p>
      }
      <div class="one-time__row">
        <input class="input" readonly [value]="item().value" aria-label="Valor de un solo uso" />
        <button type="button" class="btn btn-secondary" (click)="copy()">{{ copied() ? 'Copiado' : 'Copiar' }}</button>
      </div>
      @if (item().expiresAt) {
        <p class="text-body-sm text-muted">Vence: {{ item().expiresAt | date: 'dd/MM/yyyy HH:mm' }}</p>
      }
      <button type="button" class="btn btn-outline" (click)="dismissed.emit()">Ya lo copié</button>
    </section>
  `,
  styles: `
    .one-time { margin-bottom: 1.5rem; border-color: var(--color-primary); }
    .one-time__row { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  `,
})
export class OneTimeValueComponent {
  readonly item = input.required<OneTimeValue>();
  readonly dismissed = output<void>();
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.item().value);
    this.copied.set(true);
  }
}
