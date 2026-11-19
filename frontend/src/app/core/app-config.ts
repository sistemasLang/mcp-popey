import { InjectionToken } from '@angular/core';

/**
 * Public, non-secret settings read at runtime from `config.json` (next to
 * index.html), so one build works for any Auth0 tenant. Nothing here is a
 * secret: the panel is a public OAuth client (code + PKCE, no client secret).
 */
export interface PublicConfig {
  /** Auth0 issuer, e.g. `https://empresa.us.auth0.com/`. */
  issuer: string;
  /** Client id of the Auth0 Single Page Application of the panel. */
  clientId: string;
  /** ADMIN_API_AUDIENCE: the panel asks tokens for the admin API only. */
  audience: string;
}

export const APP_CONFIG = new InjectionToken<PublicConfig>('APP_CONFIG');

export async function loadPublicConfig(fetchFn: typeof fetch = fetch): Promise<PublicConfig> {
  const response = await fetchFn('config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`config.json could not be loaded (HTTP ${response.status})`);
  const config = (await response.json()) as Partial<PublicConfig>;
  for (const key of ['issuer', 'clientId', 'audience'] as const) {
    if (typeof config[key] !== 'string' || config[key] === '') throw new Error(`config.json: "${key}" is required`);
  }
  return config as PublicConfig;
}
