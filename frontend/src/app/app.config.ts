import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideOAuthClient } from 'angular-oauth2-oidc';

import { routes } from './app.routes';
import { authInterceptor } from './auth/auth.interceptor';
import { AuthService } from './auth/auth.service';
import { APP_CONFIG, PublicConfig } from './core/app-config';

export function appConfig(config: PublicConfig): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      { provide: APP_CONFIG, useValue: config },
      provideOAuthClient(),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideAppInitializer(() => inject(AuthService).init()),
      provideRouter(routes),
    ],
  };
}
