import { Pool } from 'pg';
import { requireEnv } from './env';

// Every serverless instance owns its own pool, so keep it small there and use Neon's
// *pooled* connection string (host contains "-pooler") to avoid running out of connections.
const poolSize = Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 3 : 10);

const connectionString = requireEnv('NEON_DATABASE_URL');

// A Postgres running on your own computer usually has no TLS; every hosted database (Neon, etc.) does.
const isLocalDatabase = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(connectionString);

export const pool = new Pool({
  connectionString,
  max: poolSize,
  idleTimeoutMillis: 30_000,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: true },
});

// An idle client erroring must not crash the process.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
});

/** Today's date in India Standard Time, formatted as YYYY-MM-DD. */
export const todayIST = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

let adminEditSchema: Promise<void> | null = null;

/**
 * Admin-marked Present rows have no arrival time or location, so those columns
 * must be nullable. Same as migrations/002; safe to repeat, and runs at most once
 * per server process so the admin never has to apply it by hand.
 */
export function ensureAdminEditSchema(): Promise<void> {
  adminEditSchema ??= (async () => {
    await pool.query('ALTER TABLE attendance ALTER COLUMN arrival_time DROP NOT NULL');
    // Older databases may still have the (now unused) coordinate columns; they must not block inserts.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'attendance' AND column_name = 'latitude') THEN
          ALTER TABLE attendance ALTER COLUMN latitude DROP NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'attendance' AND column_name = 'longitude') THEN
          ALTER TABLE attendance ALTER COLUMN longitude DROP NOT NULL;
        END IF;
      END $$;
    `);
    await pool.query('ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by_admin BOOLEAN NOT NULL DEFAULT false');
  })().catch((err) => {
    adminEditSchema = null; // retry on the next request
    throw err;
  });
  return adminEditSchema;
}

let locationSchema: Promise<void> | null = null;

/**
 * Creates the attendance_locations table (same as migrations/003) and seeds the two starting
 * locations, but only when the table is created here - so a location the admin deleted never
 * comes back. Runs at most once per server process.
 */
export function ensureLocationSchema(): Promise<void> {
  locationSchema ??= (async () => {
    await ensureAdminEditSchema();

    const { rows } = await pool.query(`SELECT to_regclass('attendance_locations') AS t`);
    const existed = rows[0].t !== null;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_locations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        radius_m DOUBLE PRECISION NOT NULL CHECK (radius_m > 0),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )`);
    await pool.query('ALTER TABLE attendance_locations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true');
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS attendance_locations_name_uq ON attendance_locations (lower(name))',
    );

    if (!existed) {
      await pool.query(`
        INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
        VALUES ('SHGG', 19.067874, 72.849776, 500),
               ('Sai Niwas', 19.058658, 72.835358, 300)
        ON CONFLICT DO NOTHING`);
    }
  })().catch((err) => {
    locationSchema = null; // retry on the next request
    throw err;
  });
  return locationSchema;
}


let securitySchema: Promise<void> | null = null;

/**
 * Login-safety columns and the list of logged-out tokens (same as migrations/005).
 * Safe to repeat; runs at most once per server process.
 */
export function ensureSecuritySchema(): Promise<void> {
  securitySchema ??= (async () => {
    await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS revoked_tokens_exp_idx ON revoked_tokens (expires_at)');
  })().catch((err) => {
    securitySchema = null; // retry on the next request
    throw err;
  });
  return securitySchema;
}

// Anyone can ask for a bill to be deleted; an admin decides. The bill's details are copied into the
// request (snap_*) so the record survives after the bill itself is gone.
const DELETE_REQUESTS_SQL = `
  CREATE TABLE IF NOT EXISTS bill_delete_requests (
    id SERIAL PRIMARY KEY,
    bill_id INT REFERENCES bills (id) ON DELETE SET NULL,
    requester_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by TEXT,
    decision_note TEXT NOT NULL DEFAULT '',
    snap_payer TEXT NOT NULL,
    snap_amount NUMERIC(12,2) NOT NULL,
    snap_bill_date DATE NOT NULL,
    snap_title TEXT NOT NULL DEFAULT '',
    snap_note TEXT NOT NULL DEFAULT '',
    snap_status TEXT NOT NULL,
    snap_cleared_on DATE,
    snap_photo_count INT NOT NULL DEFAULT 0
  )`;

let billSchema: Promise<void> | null = null;

/**
 * Creates the Bill Book tables (same as migrations/006). Safe to repeat; runs at most once
 * per server process, so the admin never has to apply it by hand.
 */
export function ensureBillSchema(): Promise<void> {
  billSchema ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bills (
        id SERIAL PRIMARY KEY,
        payer_name TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        bill_date DATE NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLEARED')),
        cleared_on DATE,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS bills_status_idx ON bills (status, bill_date DESC)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bill_images (
        id SERIAL PRIMARY KEY,
        bill_id INT NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
        mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
        storage_path TEXT,
        size_bytes INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
    // Databases created by the first Bill Book version kept photos inside Postgres (column "data").
    // Those photos keep working; new photos go to Supabase Storage.
    await pool.query('ALTER TABLE bill_images ADD COLUMN IF NOT EXISTS storage_path TEXT');
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'bill_images' AND column_name = 'data') THEN
          ALTER TABLE bill_images ALTER COLUMN data DROP NOT NULL;
        END IF;
      END $$;`)
    await pool.query('CREATE INDEX IF NOT EXISTS bill_images_bill_idx ON bill_images (bill_id)');
    await pool.query(DELETE_REQUESTS_SQL);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS bill_delete_one_pending ON bill_delete_requests (bill_id) WHERE status = \'PENDING\'');
    await pool.query('CREATE INDEX IF NOT EXISTS bill_delete_requests_status_idx ON bill_delete_requests (status, requested_at DESC)');
  })().catch((err) => {
    billSchema = null; // retry on the next request
    throw err;
  });
  return billSchema;
}
