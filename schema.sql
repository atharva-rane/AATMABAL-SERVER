-- Aatmabal schema (PostgreSQL / Neon). Safe to re-run.
-- Existing database? Run migrations 001 to 007 once (005 = login safety, 006 = Bill Book, 007 = bill delete requests). The server also creates the 005-007 tables by itself if you forget.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_name_uq
    ON users (lower(first_name), lower(last_name));

CREATE INDEX IF NOT EXISTS users_first_idx
    ON users (lower(first_name) text_pattern_ops);


CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_uq
    ON roles (lower(name));


CREATE TABLE IF NOT EXISTS user_roles (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users ON DELETE RESTRICT,
    role_id INT NOT NULL REFERENCES roles ON DELETE RESTRICT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS user_roles_role_idx
    ON user_roles (role_id);


CREATE TABLE IF NOT EXISTS attendance_control (
    id SERIAL PRIMARY KEY,
    attendance_date DATE NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);


-- Only one date can be active at a time.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_control_one_active
    ON attendance_control (is_active)
    WHERE is_active;


CREATE TABLE IF NOT EXISTS attendance_allocation (
    id SERIAL PRIMARY KEY,
    attendance_control_id INT NOT NULL REFERENCES attendance_control,
    user_id INT NOT NULL REFERENCES users,
    role_id INT NOT NULL REFERENCES roles,
    allocation_status TEXT NOT NULL DEFAULT 'ENABLED'
        CHECK (allocation_status IN ('ENABLED', 'SNA')),
    UNIQUE (attendance_control_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS attendance_allocation_user_idx
    ON attendance_allocation (user_id);


CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    attendance_control_id INT NOT NULL REFERENCES attendance_control,
    user_id INT NOT NULL REFERENCES users,
    role_id INT NOT NULL REFERENCES roles,
    arrival_time TIME,
    status TEXT NOT NULL DEFAULT 'PRESENT',
    marked_by_admin BOOLEAN NOT NULL DEFAULT false,
    submitted_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (attendance_control_id, user_id, role_id)
);


CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);


-- Places where sevaks may mark attendance (each is a centre point + radius in metres).
CREATE TABLE IF NOT EXISTS attendance_locations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    radius_m DOUBLE PRECISION NOT NULL CHECK (radius_m > 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_locations_name_uq
    ON attendance_locations (lower(name));

-- Starting locations (only when the table is empty).
INSERT INTO attendance_locations (name, latitude, longitude, radius_m)
SELECT v.name, v.latitude, v.longitude, v.radius_m
  FROM (VALUES
         ('SHGG',      19.067874::double precision, 72.849776::double precision, 500::double precision),
         ('Sai Niwas', 19.058658::double precision, 72.835358::double precision, 300::double precision)
       ) AS v(name, latitude, longitude, radius_m)
 WHERE NOT EXISTS (SELECT 1 FROM attendance_locations)
ON CONFLICT DO NOTHING;


-- ===== Login safety (migration 005) =====
ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Tokens that were logged out before they expired.
CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_exp_idx ON revoked_tokens (expires_at);


-- ===== Bill Book (migration 006) =====
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
);
CREATE INDEX IF NOT EXISTS bills_status_idx ON bills (status, bill_date DESC);

CREATE TABLE IF NOT EXISTS bill_images (
    id SERIAL PRIMARY KEY,
    bill_id INT NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
    mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    storage_path TEXT, -- file lives in the private Supabase bucket
    size_bytes INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bill_images_bill_idx ON bill_images (bill_id);


-- ===== Bill delete requests (migration 007) =====
-- Anyone can ask for a bill to be deleted; an admin approves or rejects. The bill's details are
-- copied into the request (snap_*) so the history survives after the bill is deleted.
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
);
CREATE UNIQUE INDEX IF NOT EXISTS bill_delete_one_pending ON bill_delete_requests (bill_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS bill_delete_requests_status_idx ON bill_delete_requests (status, requested_at DESC);
