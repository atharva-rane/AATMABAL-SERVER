import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export type AdminToken = {
  adminId: number;
  /** Matches admins.token_version; bumping that column logs the admin out everywhere. */
  version: number;
  /** Unique id of this token, so a single token can be revoked on logout. */
  jti: string;
  /** Unix seconds when the password was typed (kept across refreshes to enforce the session limit). */
  sessionStart: number;
  /** Unix seconds when this token expires. */
  expiresAt: number;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function signAdminToken(adminId: number, version: number, sessionStart = nowSeconds()): string {
  return jwt.sign({ ver: version, sat: sessionStart }, config.jwtSecret, {
    algorithm: 'HS256', // pinned: a token claiming "alg: none" or any other algorithm is rejected
    expiresIn: config.jwt.accessSeconds,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    subject: String(adminId),
    jwtid: randomUUID(),
  });
}

/** Returns the verified token contents, or null for anything that is not a perfectly valid admin token. */
export function readAdminToken(token: string): AdminToken | null {
  try {
    const p = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });

    if (typeof p === 'string') return null;

    const adminId = Number(p.sub);
    if (
      !Number.isInteger(adminId) ||
      adminId <= 0 ||
      !Number.isInteger(p.ver) ||
      !Number.isInteger(p.sat) ||
      typeof p.jti !== 'string' ||
      typeof p.exp !== 'number'
    ) {
      return null;
    }

    if (nowSeconds() - (p.sat as number) > config.jwt.sessionMaxSeconds) return null;

    return {
      adminId,
      version: p.ver as number,
      jti: p.jti,
      sessionStart: p.sat as number,
      expiresAt: p.exp,
    };
  } catch {
    return null;
  }
}
