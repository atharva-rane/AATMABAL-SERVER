import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { ensureSecuritySchema, pool } from '../db';
import { adminOnly, currentAdmin } from '../middleware/adminOnly';
import { asyncHandler } from '../middleware/asyncHandler';
import { sharedRateLimit } from '../middleware/rateLimit';
import { signAdminToken } from '../services/tokens';

const router = Router();

// Compared against when the username does not exist (or the account is paused), so response time
// does not reveal which usernames are valid.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const BAD_LOGIN = { message: 'Invalid username or password. After 5 wrong tries the login pauses for 15 minutes.' };

// 10 attempts per 15 minutes per IP, counted in Redis so it holds across all server instances.
const loginLimiter = sharedRateLimit({ name: 'admin-login', max: 10, windowSeconds: 15 * 60 });

const LoginBody = z.object({
  username: z.string().max(60),
  password: z.string().max(200),
});

/** Remembers a token as logged-out until it would have expired anyway. */
async function revokeToken(jti: string, expiresAt: number): Promise<void> {
  await pool.query(
    `INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt],
  );
  // Tidy up entries that are already expired (an expired token is rejected anyway).
  await pool.query('DELETE FROM revoked_tokens WHERE expires_at < now()');
}

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid input.' });
    }

    await ensureSecuritySchema();

    const { rows } = await pool.query(
      `SELECT id, password_hash, token_version, failed_attempts,
              (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
         FROM admins WHERE username = $1`,
      [body.data.username],
    );
    const admin = rows[0];

    // The password is always checked (even for a paused/unknown account) so timing reveals nothing.
    const passwordOk = await bcrypt.compare(body.data.password, admin?.password_hash ?? DUMMY_HASH);

    if (!admin || admin.is_locked || !passwordOk) {
      if (admin && !admin.is_locked && !passwordOk) {
        // CASE keeps this one atomic: the 5th wrong password pauses the account.
        await pool.query(
          `UPDATE admins
              SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
                  locked_until = CASE WHEN failed_attempts + 1 >= $2
                                      THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [admin.id, config.lockout.maxFailures, config.lockout.minutes],
        );
      }
      return res.status(401).json(BAD_LOGIN);
    }

    await pool.query('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [admin.id]);

    res.json({ token: signAdminToken(admin.id, admin.token_version) });
  }),
);

// Swaps the current token for a fresh one (the old one stops working). The hard session limit
// still applies, because the original login time is carried over.
router.post(
  '/refresh',
  adminOnly,
  asyncHandler(async (_req, res) => {
    const current = currentAdmin(res);
    await revokeToken(current.jti, current.expiresAt);
    res.json({ token: signAdminToken(current.adminId, current.version, current.sessionStart) });
  }),
);

// Logging out really kills the token on the server, not just in the browser.
router.post(
  '/logout',
  adminOnly,
  asyncHandler(async (_req, res) => {
    const current = currentAdmin(res);
    await revokeToken(current.jti, current.expiresAt);
    res.json({ ok: true });
  }),
);

export default router;
