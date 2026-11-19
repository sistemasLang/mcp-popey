import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { loadPublicConfig } from './app/core/app-config';

loadPublicConfig()
  .then((config) => bootstrapApplication(App, appConfig(config)))
  .catch((err: unknown) => {
    console.error(err);
    document.body.textContent = 'The admin panel could not start: check config.json.';
  });
