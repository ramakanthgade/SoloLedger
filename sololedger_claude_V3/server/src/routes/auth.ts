import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import {
  authMiddleware,
  ensureAdminUser,
  hashPassword,
  publicUser,
  signToken,
  verifyPassword,
  type AuthedRequest
} from '../auth.js';
import { findUserByEmail, upsertUser, type UserRecord } from '../store.js';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  await ensureAdminUser();

  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'Valid email and password (8+ chars) required' });
    return;
  }
  if (findUserByEmail(email)) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }

  const user: UserRecord = {
    id: uuid(),
    email,
    passwordHash: await hashPassword(password),
    role: 'subscriber',
    plan: 'starter',
    subscriptionStatus: 'active',
    subscriptionExpiresAt: null,
    createdAt: new Date().toISOString()
  };
  upsertUser(user);

  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

authRouter.post('/login', async (req, res) => {
  await ensureAdminUser();

  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const user = findUserByEmail(email);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

authRouter.get('/me', authMiddleware, (req: AuthedRequest, res) => {
  const user = findUserByEmail(req.user!.email);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: publicUser(user) });
});
