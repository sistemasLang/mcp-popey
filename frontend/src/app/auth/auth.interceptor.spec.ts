import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { authInterceptor, isAdminApiRequest } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('isAdminApiRequest', () => {
  const base = 'https://mcp.empresa.com/admin/';
  const origin = 'https://mcp.empresa.com';

  it('accepts only same-origin /admin/api/ URLs', () => {
    expect(isAdminApiRequest('/admin/api/users', base, origin)).toBe(true);
    expect(isAdminApiRequest('https://mcp.empresa.com/admin/api/catalog', base, origin)).toBe(true);
  });

  it.each([
    'https://evil.example/admin/api/users',
    '//evil.example/admin/api/users',
    'https://mcp.empresa.com.evil.example/admin/api/users',
    '/mcp',
    '/admin/apix/users',
    'https://mcp.empresa.com/api/login',
    'config.json',
  ])('rejects %s', (url) => {
    expect(isAdminApiRequest(url, base, origin)).toBe(false);
  });
});

describe('authInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  const auth = { getToken: vi.fn(() => 'ACCESS-TOKEN'), login: vi.fn() };

  beforeEach(() => {
    auth.login.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('adds the bearer token to /admin/api/ requests', () => {
    http.get('/admin/api/users').subscribe();
    expect(backend.expectOne('/admin/api/users').request.headers.get('Authorization')).toBe('Bearer ACCESS-TOKEN');
  });

  it.each(['https://evil.example/admin/api/users', '/mcp', 'config.json'])('never sends the token to %s', (url) => {
    http.get(url).subscribe();
    expect(backend.expectOne(url).request.headers.has('Authorization')).toBe(false);
  });

  it('a 401 from the API starts a new login', () => {
    http.get('/admin/api/users').subscribe({ error: () => undefined });
    backend.expectOne('/admin/api/users').flush(null, { status: 401, statusText: 'Unauthorized' });
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it('a 403 does not loop into login', () => {
    http.get('/admin/api/users').subscribe({ error: () => undefined });
    backend.expectOne('/admin/api/users').flush(null, { status: 403, statusText: 'Forbidden' });
    expect(auth.login).not.toHaveBeenCalled();
  });
});
