import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import type { Request, Response, NextFunction } from 'express';
import {
  findUserByEmail,
  findUserById,
  upsertUser,
  type UserRecord,
  type UserRole
} from './store.js';
import { ADMIN_INCLUDED_UNITS, getPlanIncludedUnits, type PlanId } from './plans.js';

export const DEV_JWT_SECRET = 'dev-only-change-me';

export function resolveJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === 'production';
  const isInsecure = !configured || configured === DEV_JWT_SECRET;

  if (isProduction && isInsecure) {
    throw new Error(
      'JWT_SECRET must be set to a strong secret in production. ' +
        'Refusing to start with an unset or default JWT_SECRET.'
    );
  }

  if (isInsecure) {
    console.warn(
      '[auth] JWT_SECRET is unset or using the insecure dev default — DO NOT use this in production.'
    );
    return DEV_JWT_SECRET;
  }

  return configured;
}

const JWT_SECRET = resolveJwtSecret();

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  plan: PlanId;
}

export interface AuthedRequest extends Request {
  user?: AuthTokenPayload;
}

export function signToken(user: UserRecord): string {
  const payload: AuthTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    plan: user.plan
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function adminMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function isSubscriptionActive(user: UserRecord): boolean {
  if (user.role === 'admin') return true;
  // The free `local` tier is always "active" (no subscription required).
  if (user.plan === 'local') return true;
  if (user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing') {
    if (!user.subscriptionExpiresAt) return true;
    return new Date(user.subscriptionExpiresAt) > new Date();
  }
  return false;
}

export function publicUser(user: UserRecord) {
  const isAdmin = user.role === 'admin';
  const plan: PlanId = isAdmin ? 'enterprise' : user.plan;
  const includedUnits = isAdmin
    ? ADMIN_INCLUDED_UNITS
    : getPlanIncludedUnits(user.plan, user.customIncludedUnits, user.overageBlocks);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    plan,
    subscriptionStatus: isAdmin ? 'active' : user.subscriptionStatus,
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    includedUnits,
    customIncludedUnits: user.customIncludedUnits ?? null,
    overageBlocks: user.overageBlocks ?? null,
    subscriptionActive: isSubscriptionActive(user)
  };
}

export async function ensureAdminUser(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD?.trim();
  if (!email || !password) return;

  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      upsertUser({
        ...existing,
        role: 'admin',
        plan: 'enterprise',
        subscriptionStatus: 'active',
        customIncludedUnits: ADMIN_INCLUDED_UNITS
      });
    }
    return;
  }

  const admin: UserRecord = {
    id: uuid(),
    email,
    passwordHash: await hashPassword(password),
    role: 'admin',
    plan: 'enterprise',
    subscriptionStatus: 'active',
    customIncludedUnits: ADMIN_INCLUDED_UNITS,
    subscriptionExpiresAt: null,
    createdAt: new Date().toISOString()
  };
  upsertUser(admin);
}

export function getUserFromRequest(req: AuthedRequest): UserRecord | undefined {
  if (!req.user) return undefined;
  return findUserById(req.user.sub);
}
