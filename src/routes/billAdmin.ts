import { Router } from 'express';
import { z } from 'zod';
import { ensureBillSchema, pool } from '../db';
import { adminOnly, currentAdmin } from '../middleware/adminOnly';
import { asyncHandler } from '../middleware/asyncHandler';
import { deletePhotos } from '../services/storage';
import { idParam } from '../utils/validation';

/**
 * Admin side of the Bill Book: review delete requests and see what was deleted.
 *
 *   GET  /api/admin/bill-requests            waiting requests + history (deleted / kept)
 *   GET  /api/admin/bill-requests/summary    just the number waiting (for the dashboard badge)
 *   POST /api/admin/bill-requests/:id/approve  delete the bill (and its photos) for good
 *   POST /api/admin/bill-requests/:id/reject   keep the bill
 */
const router = Router();

router.use(adminOnly);
router.use((_req, _res, next) => {
  ensureBillSchema().then(() => next(), next);
});

const DecisionBody = z.object({ note: z.string().trim().max(300).default('') });

router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT count(*)::int AS pending FROM bill_delete_requests WHERE status = 'PENDING'`);
    res.json({ pending: rows[0].pending });
  }),
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [pending, history] = await Promise.all([
      // Waiting requests show the LIVE bill, so the admin sees its current details and photos.
      pool.query(
        `SELECT r.id,
                r.requester_name AS "requesterName",
                r.reason,
                r.requested_at AS "requestedAt",
                b.payer_name AS "payerName",
                b.amount::float8 AS amount,
                to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                b.title,
                b.note,
                b.status AS "billStatus",
                to_char(b.cleared_on, 'YYYY-MM-DD') AS "clearedOn",
                COALESCE((SELECT json_agg(i.id ORDER BY i.id) FROM bill_images i WHERE i.bill_id = b.id), '[]') AS "imageIds"
           FROM bill_delete_requests r
           JOIN bills b ON b.id = r.bill_id
          WHERE r.status = 'PENDING'
          ORDER BY r.requested_at ASC`,
      ),
      // History uses the copy saved with the request, because a deleted bill no longer exists.
      pool.query(
        `SELECT r.id,
                r.status,
                r.requester_name AS "requesterName",
                r.reason,
                r.requested_at AS "requestedAt",
                r.decided_at AS "decidedAt",
                r.decided_by AS "decidedBy",
                r.decision_note AS "decisionNote",
                r.snap_payer AS "payerName",
                r.snap_amount::float8 AS amount,
                to_char(r.snap_bill_date, 'YYYY-MM-DD') AS "billDate",
                r.snap_title AS title,
                r.snap_note AS note,
                r.snap_status AS "billStatus",
                to_char(r.snap_cleared_on, 'YYYY-MM-DD') AS "clearedOn",
                r.snap_photo_count AS "photoCount"
           FROM bill_delete_requests r
          WHERE r.status <> 'PENDING'
          ORDER BY r.decided_at DESC NULLS LAST, r.id DESC
          LIMIT 300`,
      ),
    ]);

    res.json({ pending: pending.rows, history: history.rows });
  }),
);

router.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = DecisionBody.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ message: 'That note is too long.' });
    }

    const client = await pool.connect();
    let paths: string[] = [];
    try {
      await client.query('BEGIN');

      const request = await client.query(
        `SELECT bill_id FROM bill_delete_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
        [id],
      );
      if (!request.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'This request was already decided.' });
      }

      const billId: number = request.rows[0].bill_id;
      const bill = await client.query('SELECT id FROM bills WHERE id = $1 FOR UPDATE', [billId]);
      if (!bill.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'That bill no longer exists.' });
      }

      const files = await client.query('SELECT storage_path FROM bill_images WHERE bill_id = $1', [billId]);
      paths = files.rows.map((r) => r.storage_path).filter(Boolean);

      // Refresh the saved copy to exactly what is being deleted, and record who decided.
      await client.query(
        `UPDATE bill_delete_requests r
            SET status = 'APPROVED',
                decided_at = now(),
                decided_by = (SELECT username FROM admins WHERE id = $2),
                decision_note = $3,
                snap_payer = b.payer_name,
                snap_amount = b.amount,
                snap_bill_date = b.bill_date,
                snap_title = b.title,
                snap_note = b.note,
                snap_status = b.status,
                snap_cleared_on = b.cleared_on,
                snap_photo_count = $4
           FROM bills b
          WHERE r.id = $1 AND b.id = r.bill_id`,
        [id, currentAdmin(res).adminId, body.data.note, files.rowCount ?? 0],
      );

      // Photo rows go with the bill (ON DELETE CASCADE); the request row stays with bill_id set to NULL.
      await client.query('DELETE FROM bills WHERE id = $1', [billId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    await deletePhotos(paths); // after the database is settled; a leftover file would be harmless
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = DecisionBody.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ message: 'That note is too long.' });
    }

    const result = await pool.query(
      `UPDATE bill_delete_requests
          SET status = 'REJECTED',
              decided_at = now(),
              decided_by = (SELECT username FROM admins WHERE id = $2),
              decision_note = $3
        WHERE id = $1 AND status = 'PENDING'`,
      [id, currentAdmin(res).adminId, body.data.note],
    );

    if (!result.rowCount) {
      return res.status(409).json({ message: 'This request was already decided.' });
    }
    res.json({ ok: true });
  }),
);

export default router;
