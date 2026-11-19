import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ADMIN_API_PATH } from '../auth/auth.interceptor';
import {
  AdminUser,
  Catalog,
  InviteRequest,
  InviteResponse,
  PasswordLink,
  ServiceAccountRequest,
  ServiceAccountResponse,
  ServiceCredentials,
  UpdateResponse,
  UserPatch,
} from './admin.models';

/** Thin client of /admin/api. Responses with links or secrets are never cached or stored. */
@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly http = inject(HttpClient);

  catalog(): Observable<Catalog> {
    return this.http.get<Catalog>(`${ADMIN_API_PATH}catalog`);
  }

  users(): Observable<AdminUser[]> {
    return this.http.get<{ users: AdminUser[] }>(`${ADMIN_API_PATH}users`).pipe(map((response) => response.users));
  }

  invite(request: InviteRequest): Observable<InviteResponse> {
    return this.http.post<InviteResponse>(`${ADMIN_API_PATH}users`, request);
  }

  issuePasswordLink(userId: string): Observable<PasswordLink> {
    return this.http
      .post<{ passwordLink: PasswordLink }>(`${ADMIN_API_PATH}users/${encodeURIComponent(userId)}/password-link`, {})
      .pipe(map((response) => response.passwordLink));
  }

  update(userId: string, patch: UserPatch): Observable<UpdateResponse> {
    return this.http.patch<UpdateResponse>(`${ADMIN_API_PATH}users/${encodeURIComponent(userId)}`, patch);
  }

  createServiceAccount(request: ServiceAccountRequest): Observable<ServiceAccountResponse> {
    return this.http.post<ServiceAccountResponse>(`${ADMIN_API_PATH}service-accounts`, request);
  }

  rotateServiceSecret(userId: string): Observable<ServiceCredentials> {
    return this.http.post<ServiceCredentials>(
      `${ADMIN_API_PATH}service-accounts/${encodeURIComponent(userId)}/rotate-secret`,
      {},
    );
  }
}
