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
import type { PlanId } from './plans.js';
import { getPlanTxLimit } from './plans.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-change-me';

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
  if (user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing') {
    if (!user.subscriptionExpiresAt) return true;
    return new Date(user.subscriptionExpiresAt) > new Date();
  }
  return user.plan === 'trial';
}

export function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    plan: user.plan,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    txLimit: getPlanTxLimit(user.plan, user.customTxLimit),
    customTxLimit: user.customTxLimit ?? null,
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
      upsertUser({ ...existing, role: 'admin', plan: 'pro', subscriptionStatus: 'active' });
    }
    return;
  }

  const admin: UserRecord = {
    id: uuid(),
    email,
    passwordHash: await hashPassword(password),
    role: 'admin',
    plan: 'pro',
    subscriptionStatus: 'active',
    subscriptionExpiresAt: null,
    createdAt: new Date().toISOString()
  };
  upsertUser(admin);
}

export function getUserFromRequest(req: AuthedRequest): UserRecord | undefined {
  if (!req.user) return undefined;
  return findUserById(req.user.sub);
}
