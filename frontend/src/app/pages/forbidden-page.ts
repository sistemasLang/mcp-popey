import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';

@Component({
  selector: 'app-forbidden-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page card">
      <h1 class="h4">Sin permisos</h1>
      <p>Su cuenta no es administradora de este panel. Pídale acceso a un administrador.</p>
      <button type="button" class="btn btn-outline" (click)="auth.logout()">Cerrar sesión</button>
    </main>
  `,
  styles: `.page { max-width: 560px; margin: 3rem auto; }`,
})
export class ForbiddenPage {
  protected readonly auth = inject(AuthService);
}
