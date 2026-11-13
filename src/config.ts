import { requireEnv } from './env';

const PLACEHOLDER_SECRET = 'change-me-long-random';
const MIN_SECRET_LENGTH = 32;

const isProduction = process.env.NODE_ENV === 'production';
const jwtSecret = requireEnv('JWT_SECRET');

// A weak signing secret would let an attacker forge admin tokens, so we refuse to start with one
// (in every environment, not only production).
if (jwtSecret === PLACEHOLDER_SECRET || jwtSecret.length < MIN_SECRET_LENGTH) {
  throw new Error(
    `JWT_SECRET is missing, still the placeholder, or shorter than ${MIN_SECRET_LENGTH} characters.\n` +
      `Create a strong one with this command (works on Windows, macOS and Linux):\n` +
      `  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
  );
}

// CLIENT_ORIGIN may hold several comma-separated origins, e.g. the production URL and a custom domain.
const clientOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const config = {
  isProduction,
  port: Number(process.env.PORT) || 4000,
  clientOrigins,
  jwtSecret,
  jwt: {
    issuer: 'aatmabal-api',
    audience: 'aatmabal-admin',
    /** A token is valid this long; the app quietly swaps it for a fresh one while the admin works. */
    accessSeconds: 30 * 60,
    /** Hard limit: after this long since the password was typed, the admin must log in again. */
    sessionMaxSeconds: 8 * 60 * 60,
  },
  lockout: {
    /** Wrong passwords in a row before the account is paused... */
    maxFailures: 5,
    /** ...for this many minutes. */
    minutes: 15,
  },
} as const;
