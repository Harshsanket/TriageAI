/**
 * Auth wiring for the API host: public endpoints plus the global guard that
 * authenticates bearer tokens and enforces the RBAC matrix.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors.js';
import { isAllowed, ruleFor } from './rbac.js';
import type { AuthService } from './service.js';
import { verifyAccessToken, type Role } from './tokens.js';

export interface Principal {
  userId: string;
  email: string;
  role: Role;
  sessionId: string | null;
  authenticated: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthGuardOptions {
  mode: 'disabled' | 'required';
  jwtSecret: string;
}

const LOCAL_DEVELOPER: Principal = {
  userId: 'local-developer',
  email: 'local@triageai.dev',
  role: 'admin',
  sessionId: null,
  authenticated: false,
};

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export function createAuthGuard(options: AuthGuardOptions) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0] ?? request.url;
    const rule = ruleFor(request.method, path);

    if (options.mode === 'disabled') {
      request.principal = LOCAL_DEVELOPER;
      return;
    }

    const token = bearerToken(request);
    if (!token) {
      if (rule.roles === 'public') {
        request.principal = LOCAL_DEVELOPER;
        return;
      }
      reply.header('www-authenticate', 'Bearer');
      throw new AppError('auth.UNAUTHENTICATED', 'missing bearer token', undefined, 401);
    }

    const claims = await verifyAccessToken(token, { secret: options.jwtSecret });
    request.principal = {
      userId: claims.sub,
      email: claims.email,
      role: claims.role,
      sessionId: claims.sid,
      authenticated: true,
    };

    if (rule.roles !== 'public' && !isAllowed(claims.role, request.method, path)) {
      throw new AppError(
        'auth.FORBIDDEN',
        `role ${claims.role} may not ${request.method} ${path}`,
        { requiredRoles: rule.roles },
        403,
      );
    }
  };
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z
  .string()
  .min(10, 'password must be at least 10 characters')
  .max(200, 'password must be at most 200 characters');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(500) });

const roleSchema = z.enum(['customer', 'agent', 'admin']);

export interface AuthRouteOptions {
  mode: 'disabled' | 'required';
}

export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthService,
  options: AuthRouteOptions,
): void {
  const loginRateLimit = { max: options.mode === 'required' ? 10 : 1000, timeWindow: '1 minute' };

  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: loginRateLimit } },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const session = await service.register(body);
      return reply.status(201).send(session);
    },
  );

  app.post('/api/v1/auth/login', { config: { rateLimit: loginRateLimit } }, async (request) => {
    const body = loginSchema.parse(request.body);
    return service.login(body.email, body.password);
  });

  app.post('/api/v1/auth/refresh', async (request) => {
    const body = refreshSchema.parse(request.body);
    return service.refresh(body.refreshToken);
  });

  app.post('/api/v1/auth/logout', async (request) => {
    const body = z.object({ refreshToken: z.string().min(20).max(500) }).parse(request.body);
    await service.logout(body.refreshToken);
    return { loggedOut: true };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const principal = request.principal;
    if (!principal) throw new AppError('auth.UNAUTHENTICATED', 'missing session', undefined, 401);
    if (!principal.authenticated) {
      return {
        user: {
          id: principal.userId,
          email: principal.email,
          name: 'Local developer',
          role: principal.role,
          createdAt: new Date(0).toISOString(),
        },
        mode: options.mode,
      };
    }
    const user = await service.getById(principal.userId);
    if (!user) throw new AppError('auth.UNAUTHENTICATED', 'user no longer exists', undefined, 401);
    return { user, mode: options.mode };
  });

  app.get('/api/v1/auth/users', async () => ({ users: await service.listUsers() }));

  app.post('/api/v1/auth/users', async (request, reply) => {
    const body = registerSchema.extend({ role: roleSchema.default('agent') }).parse(request.body);
    const actor = request.principal?.email ?? 'system';
    const user = await service.createUser({ ...body, actor });
    return reply.status(201).send({ user });
  });

  app.patch('/api/v1/auth/users/:id/role', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ role: roleSchema }).parse(request.body);
    const principal = request.principal;
    if (!principal) throw new AppError('auth.UNAUTHENTICATED', 'missing session', undefined, 401);
    const user = await service.updateRole(id, body.role, principal.email, principal.userId);
    return { user };
  });
}
