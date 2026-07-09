import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ensureAdminUser } from './auth.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { configRouter } from './routes/config.js';
import { proxyRouter } from './routes/proxy.js';
import { billingRouter, handleStripeWebhook } from './routes/billing.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.some((o) => origin.endsWith(o.replace('https://', '')))) {
        cb(null, true);
        return;
      }
      cb(null, allowedOrigins[0]);
    },
    credentials: true
  })
);

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sololedger-api' });
});

app.use('/api/auth', authRouter);
app.use('/api/config', configRouter);
app.use('/api/admin', adminRouter);
app.use('/api/proxy', proxyRouter);
app.use('/api/billing', billingRouter);

void ensureAdminUser()
  .then(() => {
    app.listen(port, () => {
      console.log(`SoloLedger API listening on http://localhost:${port}`);
      console.log(`CORS origins: ${allowedOrigins.join(', ')}`);
      console.log('Health check: http://localhost:' + port + '/health');
    });
  })
  .catch((err) => {
    console.error('Failed to start SoloLedger API:', err);
    process.exit(1);
  });
