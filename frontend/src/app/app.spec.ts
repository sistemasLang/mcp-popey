import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { AuthService } from './auth/auth.service';
import { decodeJwtPayload, isTokenValid } from './auth/jwt-helper';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { isLoggedIn: () => true, userLabel: () => 'ana@empresa.com', logout: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('shows the signed-in admin and a logout button', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ana@empresa.com');
    expect(text).toContain('Cerrar sesión');
  });
});

describe('jwt-helper (UX only)', () => {
  const token = (payload: object) => `x.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.y`;

  it('decodes the payload and checks exp', () => {
    expect(decodeJwtPayload(token({ sub: 'auth0|1', exp: 2_000_000_000 }))?.sub).toBe('auth0|1');
    expect(isTokenValid(token({ exp: 2_000_000_000 }), 1_000)).toBe(true);
    expect(isTokenValid(token({ exp: 1 }), 5_000)).toBe(false);
  });

  it('garbage is not valid', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(isTokenValid(null)).toBe(false);
  });
});
