import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AdminApiService } from '../admin/admin-api.service';

/**
 * UX guard: asks the API whether this identity is an admin (403 = no) and
 * sends non-admins to /forbidden. Bypassing it in the browser gains nothing:
 * every /admin/api call is authorized by the server.
 */
export const rolGuard: CanActivateFn = () => {
  const api = inject(AdminApiService);
  const router = inject(Router);
  return api.catalog().pipe(
    map(() => true),
    catchError((error: unknown) =>
      of(error instanceof HttpErrorResponse && error.status === 403 ? router.createUrlTree(['/forbidden']) : true),
    ),
  );
};
