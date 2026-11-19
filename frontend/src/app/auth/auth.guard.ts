import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';
import { isTokenValid } from './jwt-helper';

/** UX guard: without a live token, go to the Auth0 login. The API still checks every request. */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  if (auth.isLoggedIn() && isTokenValid(auth.getToken())) return true;
  auth.login();
  return false;
};
