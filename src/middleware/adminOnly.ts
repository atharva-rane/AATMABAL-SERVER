import type { NextFunction, Request, Response } from 'express';
import { ensureSecuritySchema, pool } from '../db';
import { readAdminToken, type AdminToken } from '../services/tokens';

const MAX_HEADER_LENGTH = 2000;

const reject = (res: Response) => res.status(401).json({ message: 'Please log in again.' });

/** The verified token of the current request (only set after adminOnly has let it through). */
export const currentAdmin = (res: Response): AdminToken => res.locals.admin as AdminToken;

/**
 * The gate for every admin route. A request passes only if ALL of these are true:
 *  1. It carries "Authorization: Bearer <token>".
 *  2. The token's signature, algorithm, issuer, audience and expiry are valid.
 *  3. The session is younger than the hard session limit.
 *  4. The token was not revoked by a logout.
 *  5. The admin still exists and has not been "logged out everywhere" since the token was issued.
 */
export async function adminOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = header.length <= MAX_HEADER_LENGTH ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header) : null;
  const token = match ? readAdminToken(match[1]) : null;

  if (!token) {
    reject(res);
    return;
  }

  try {
    await ensureSecuritySchema();

    const { rows } = await pool.query(
      `SELECT a.token_version,
              EXISTS (SELECT 1 FROM revoked_tokens r WHERE r.jti = $2) AS revoked
         FROM admins a
        WHERE a.id = $1`,
      [token.adminId, token.jti],
    );

    if (!rows[0] || rows[0].revoked || rows[0].token_version !== token.version) {
      reject(res);
      return;
    }

    res.locals.admin = token;
    next();
  } catch (err) {
    // A database hiccup is a server problem, not a reason to log the admin out.
    next(err);
  }
}
