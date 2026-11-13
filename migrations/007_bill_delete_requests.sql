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
