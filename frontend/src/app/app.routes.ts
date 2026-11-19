import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';
import { rolGuard } from './auth/rol.guard';

export const routes: Routes = [
  {
    path: '',
    canActivate: [authGuard, rolGuard],
    loadComponent: () => import('./admin/users-page').then((m) => m.UsersPage),
  },
  {
    path: 'forbidden',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/forbidden-page').then((m) => m.ForbiddenPage),
  },
  { path: '**', redirectTo: '' },
];
