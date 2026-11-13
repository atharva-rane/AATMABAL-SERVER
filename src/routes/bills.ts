import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { ensureBillSchema, pool, todayIST } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { sharedRateLimit } from '../middleware/rateLimit';
import { deletePhotos, downloadPhoto, MAX_PHOTO_BYTES, StorageNotConfigured, uploadPhoto, isStorageConfigured } from '../services/storage';
import { dateParam, idParam } from '../utils/validation';

/**
 * Bill Book, OPEN TO EVERYONE (no login): add bills, photos, edit, mark as cleared.
 * The one thing nobody can do directly is delete: they send a delete REQUEST, and an admin
 * decides (see routes/billAdmin.ts). Because it is open, every write is rate-limited.
 *
 *   GET    /api/bills                      everything the page needs in one call
 *   POST   /api/bills                      add a bill
 *   PATCH  /api/bills/:id                  edit a bill
 *   POST   /api/bills/:id/clear            money paid back  -> Cleared
 *   POST   /api/bills/:id/reopen           undo             -> Pending
 *   POST   /api/bills/:id/images           add one photo
 *   GET    /api/bills/images/:imageId      one photo
 *   POST   /api/bills/:id/delete-request   ask the admin to delete this bill
 */
const router = Router();

// The browser shrinks every photo to about 250 KB before upload; this is the hard ceiling the server enforces.
const MAX_IMAGE_BYTES = MAX_PHOTO_BYTES;
const MAX_IMAGES_PER_BILL = 6;
const MAX_BILLS_LISTED = 2000;

router.use(express.json({ limit: '1mb' }));
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); // the photo route below sets its own caching
  next();
});
router.use((_req, _res, next) => {
  ensureBillSchema().then(() => next(), next);
});

// Anyone can reach these, so each kind of write has its own per-visitor limit (counted per IP).
const addLimit = sharedRateLimit({ name: 'bill-add', max: 30, windowSeconds: 10 * 60 });
const photoLimit = sharedRateLimit({ name: 'bill-photo', max: 80, windowSeconds: 10 * 60 });
const editLimit = sharedRateLimit({ name: 'bill-edit', max: 80, windowSeconds: 10 * 60 });
const requestLimit = sharedRateLimit({ name: 'bill-delete-request', max: 10, windowSeconds: 10 * 60 });

const squash = (v: string) => v.replace(/\s+/g, ' ');

const BillBody = z.object({
  payerName: z.string().transform(squash).pipe(z.string().trim().min(1).max(80)),
  amount: z
    .number()
    .positive()
    .max(99_999_999.99)
    .transform((n) => Math.round(n * 100) / 100),
  billDate: dateParam,
  title: z.string().trim().max(120).default(''),
  note: z.string().trim().max(500).default(''),
});

/** Works out the real file type from the first bytes, never from what the browser claims. */
function sniffImage(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length > 12) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
      return 'image/webp';
    }
  }
  return null;
}

/** Reads a photo that an old version stored inside the database. Returns null when there is no such column. */
async function legacyPhoto(imageId: number): Promise<Buffer | null> {
  try {
    const { rows } = await pool.query('SELECT data FROM bill_images WHERE id = $1', [imageId]);
    return rows[0]?.data ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '42703') return null; // undefined_column: this database never had it
    throw err;
  }
}

// ---------------------------------------------------------------- list
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [bills, totals, owed, payers] = await Promise.all([
      pool.query(
        `SELECT b.id,
                b.payer_name AS "payerName",
                b.amount::float8 AS amount,
                to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                b.title,
                b.note,
                b.status,
                to_char(b.cleared_on, 'YYYY-MM-DD') AS "clearedOn",
                COALESCE((SELECT json_agg(i.id ORDER BY i.id) FROM bill_images i WHERE i.bill_id = b.id), '[]') AS "imageIds",
                EXISTS (SELECT 1 FROM bill_delete_requests r WHERE r.bill_id = b.id AND r.status = 'PENDING') AS "deleteRequested"
           FROM bills b
          ORDER BY b.bill_date DESC, b.id DESC
          LIMIT $1`,
        [MAX_BILLS_LISTED],
      ),
      pool.query(
        `SELECT status, count(*)::int AS count, COALESCE(sum(amount), 0)::float8 AS total
           FROM bills GROUP BY status`,
      ),
      pool.query(
        `SELECT min(payer_name) AS payer, count(*)::int AS count, sum(amount)::float8 AS total
           FROM bills WHERE status = 'PENDING'
          GROUP BY lower(payer_name)
          ORDER BY sum(amount) DESC`,
      ),
      pool.query(`SELECT min(payer_name) AS name FROM bills GROUP BY lower(payer_name) ORDER BY lower(min(payer_name))`),
    ]);

    const summary = (status: string) => {
      const row = totals.rows.find((r) => r.status === status);
      return { count: row?.count ?? 0, total: row?.total ?? 0 };
    };

    res.json({
      bills: bills.rows,
      pending: summary('PENDING'),
      cleared: summary('CLEARED'),
      owedByPayer: owed.rows,
      payers: payers.rows.map((r) => r.name),
      photoStorageReady: isStorageConfigured,
    });
  }),
);

// ---------------------------------------------------------------- photos (static paths first)
router.get(
  '/images/:imageId',
  asyncHandler(async (req, res) => {
    const imageId = idParam.parse(req.params.imageId);
    const { rows } = await pool.query('SELECT mime, storage_path FROM bill_images WHERE id = $1', [imageId]);
    const row = rows[0];

    // Photos come from Supabase Storage. Only databases made by the very first Bill Book version
    // (photos kept inside Postgres) have a legacy "data" column to fall back on.
    const bytes: Buffer | null = row ? (row.storage_path ? await downloadPhoto(row.storage_path) : await legacyPhoto(imageId)) : null;

    if (!row || !bytes) {
      return res.status(404).json({ message: 'Photo not found.' });
    }

    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable'); // a photo never changes once saved
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // lets the website (on another address) show it in <img>
    res.send(bytes);
  }),
);

// ---------------------------------------------------------------- create / edit
router.post(
  '/',
  addLimit,
  asyncHandler(async (req, res) => {
    const body = BillBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Please check the bill details.' });
    }

    const { payerName, amount, billDate, title, note } = body.data;
    const { rows } = await pool.query(
      `INSERT INTO bills (payer_name, amount, bill_date, title, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [payerName, amount, billDate, title, note],
    );

    res.status(201).json({ id: rows[0].id });
  }),
);

router.patch(
  '/:id',
  editLimit,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = BillBody.extend({ clearedOn: dateParam.optional() }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Please check the bill details.' });
    }

    const { payerName, amount, billDate, title, note, clearedOn } = body.data;
    const result = await pool.query(
      `UPDATE bills
          SET payer_name = $2, amount = $3, bill_date = $4, title = $5, note = $6,
              cleared_on = CASE WHEN status = 'CLEARED' THEN COALESCE($7::date, cleared_on) ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [id, payerName, amount, billDate, title, note, clearedOn ?? null],
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Bill not found.' });
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/clear',
  editLimit,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = z.object({ clearedOn: dateParam.default(todayIST) }).safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ message: 'Please pick a valid date.' });
    }

    const result = await pool.query(
      `UPDATE bills SET status = 'CLEARED', cleared_on = $2, updated_at = now() WHERE id = $1`,
      [id, body.data.clearedOn],
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Bill not found.' });
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/reopen',
  editLimit,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const result = await pool.query(
      `UPDATE bills SET status = 'PENDING', cleared_on = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: 'Bill not found.' });
    }
    res.json({ ok: true });
  }),
);

// Nobody deletes a bill directly. This only files a request; an admin reviews it and decides.
router.post(
  '/:id/delete-request',
  requestLimit,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = z
      .object({
        requesterName: z.string().transform(squash).pipe(z.string().trim().min(1).max(60)),
        reason: z.string().trim().min(3).max(300),
      })
      .safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Please enter your name and a short reason.' });
    }

    try {
      // Copies the bill's details into the request so the record survives even after the bill is deleted.
      const { rowCount } = await pool.query(
        `INSERT INTO bill_delete_requests
           (bill_id, requester_name, reason, snap_payer, snap_amount, snap_bill_date, snap_title, snap_note,
            snap_status, snap_cleared_on, snap_photo_count)
         SELECT b.id, $2, $3, b.payer_name, b.amount, b.bill_date, b.title, b.note, b.status, b.cleared_on,
                (SELECT count(*)::int FROM bill_images i WHERE i.bill_id = b.id)
           FROM bills b WHERE b.id = $1`,
        [id, body.data.requesterName, body.data.reason],
      );
      if (!rowCount) {
        return res.status(404).json({ message: 'Bill not found.' });
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // unique index: only one waiting request per bill
        return res.status(409).json({ message: 'A delete request for this bill is already waiting for the admin.' });
      }
      throw err;
    }

    res.status(201).json({ ok: true });
  }),
);

router.post(
  '/:id/images',
  photoLimit,
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const body = z.object({ data: z.string().min(100) }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ message: 'Invalid photo.' });
    }

    // Accept a plain base64 string or a "data:image/...;base64,..." URL.
    const base64 = body.data.data.replace(/^data:[^,]*,/, '');
    const bytes = Buffer.from(base64, 'base64');
    const mime = sniffImage(bytes);

    if (!mime) {
      return res.status(400).json({ message: 'Only JPG, PNG or WebP photos are allowed.' });
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ message: 'That photo is too large. Please use a smaller one.' });
    }

    if (!isStorageConfigured) throw new StorageNotConfigured();

    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const path = `bills/${id}/${randomUUID()}.${ext}`;

    const client = await pool.connect();
    let uploaded = false;
    try {
      await client.query('BEGIN');
      // Locking the bill row keeps two uploads from both squeezing past the per-bill limit.
      const bill = await client.query('SELECT id FROM bills WHERE id = $1 FOR UPDATE', [id]);
      if (!bill.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Bill not found.' });
      }

      const count = await client.query('SELECT count(*)::int AS n FROM bill_images WHERE bill_id = $1', [id]);
      if (count.rows[0].n >= MAX_IMAGES_PER_BILL) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `A bill can have at most ${MAX_IMAGES_PER_BILL} photos.` });
      }

      await uploadPhoto(path, bytes, mime);
      uploaded = true;

      const { rows } = await client.query(
        'INSERT INTO bill_images (bill_id, mime, storage_path, size_bytes) VALUES ($1, $2, $3, $4) RETURNING id',
        [id, mime, path, bytes.length],
      );
      await client.query('COMMIT');
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (uploaded) await deletePhotos([path]); // don't leave an orphan file behind
      throw err;
    } finally {
      client.release();
    }
  }),
);

export default router;
