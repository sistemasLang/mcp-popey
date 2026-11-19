import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export const ADMIN_API_PATH = '/admin/api/';

/** Same origin and under /admin/api/: the only requests that may carry the token. */
export function isAdminApiRequest(url: string, baseUri = document.baseURI, origin = window.location.origin): boolean {
  try {
    const target = new URL(url, baseUri);
    return target.origin === origin && target.pathname.startsWith(ADMIN_API_PATH);
  } catch {
    return false;
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isAdminApiRequest(req.url)) return next(req);

  const auth = inject(AuthService);
  const token = auth.getToken();
  const authReq = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authReq).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401) auth.login();
      return throwError(() => err);
    }),
  );
};
