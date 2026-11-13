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
