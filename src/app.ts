import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { isCacheEnabled } from './cache';
import { isStorageConfigured } from './services/storage';
import { config } from './config';
import rateLimit from 'express-rate-limit';
import { errorHandler, notFound } from './middleware/errorHandler';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import billAdminRoutes from './routes/billAdmin';
import billRoutes from './routes/bills';
import publicRoutes from './routes/public';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: config.clientOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Lets browsers remember the preflight answer (Chrome caps this at 2h) so admin calls aren't doubled.
    maxAge: 7200,
  }),
);

// A broad safety net for the whole API (the login has its own, much stricter limit).
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again in a little while.' },
  }),
);

// Admin answers contain private data: never let a browser or proxy keep a copy.
app.use('/api/admin', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// The Bill Book is open to everyone (no login). It reads its own, larger JSON bodies (photos), so it
// must come before the small global limit below. Every write in it is rate-limited.
app.use('/api/bills', billRoutes);

app.use(express.json({ limit: '20kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, cache: isCacheEnabled ? 'redis' : 'disabled', photos: isStorageConfigured ? 'supabase' : 'not configured' });
});

app.use('/api/admin', authRoutes); // POST /api/admin/login (public)
app.use('/api/admin/bill-requests', billAdminRoutes); // admin reviews bill delete requests
app.use('/api/admin', adminRoutes); // everything else under /api/admin requires a token
app.use('/api/public', publicRoutes);

app.use('/api', notFound);
app.use(errorHandler);

// Vercel runs this file as a serverless function and uses the default export below.
// Locally (`npm run dev`) we start a normal HTTP server.
if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
  });
}

export default app;
