import './../env'; // makes sure .env is loaded before we read process.env below

/**
 * Bill photos live in a PRIVATE Supabase Storage bucket, so the database only keeps small notes
 * about each photo. Nothing here is public: the browser never talks to Supabase. It asks our API,
 * which checks the admin login and then fetches the file using the secret service key.
 *
 * Uses Supabase's plain REST API through fetch, so there is no extra package to install.
 */

// People often paste more than the value: quotes, the variable name ("NEXT_PUBLIC_SUPABASE_URL=https://...",
// copied from Supabase's own snippet), or a trailing path like ".../rest/v1". All of that is cleaned up here.
const unquote = (v: string) => v.trim().replace(/^['"]+|['"]+$/g, '').trim();

const rawUrl = unquote(process.env.SUPABASE_URL ?? '');
const url = (rawUrl.match(/https?:\/\/[^\s'"]+/i)?.[0] ?? rawUrl)
  .replace(/\/+$/, '')
  .replace(/\/(rest|storage|auth)\/v1$/i, '')
  .replace(/\/+$/, '');

// Keys never contain "=", so anything before the last "=" is a pasted variable name ("SUPABASE_SERVICE_ROLE_KEY=eyJ...").
const rawKey = unquote(process.env.SUPABASE_SERVICE_KEY ?? '');
const serviceKey = unquote(rawKey.includes('=') ? rawKey.slice(rawKey.lastIndexOf('=') + 1) : rawKey);
const bucket = (process.env.SUPABASE_BUCKET ?? 'bill-images').trim();

export const isStorageConfigured = Boolean(url && serviceKey);

const isValidUrl = (() => {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
})();

/** Shown when the admin has not filled in the Supabase settings yet. */
export class StorageNotConfigured extends Error {
  constructor() {
    super('Photo storage is not set up yet. Add SUPABASE_URL and SUPABASE_SERVICE_KEY to the server settings.');
  }
}

/** Biggest photo the bucket accepts. The browser shrinks photos to ~250 KB, so this is a safety net. */
export const MAX_PHOTO_BYTES = 600 * 1024;

/** A problem talking to Supabase, with a message that tells the admin what to fix. */
export class StorageError extends Error {}

// Older Supabase keys are JWTs ("eyJ...") and are sent as a Bearer token too. Newer "secret" keys
// ("sb_secret_...") are NOT JWTs: they go in the apikey header only, and a Bearer header would be rejected.
const looksLikeJwt = serviceKey.startsWith('eyJ');

const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  apikey: serviceKey,
  ...(looksLikeJwt ? { Authorization: `Bearer ${serviceKey}` } : {}),
  ...extra,
});

/** Supabase answers with JSON like {"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}. */
function parseBody(body: string): { code: number | null; message: string } {
  try {
    const json = JSON.parse(body) as { statusCode?: string | number; status?: number; message?: string; msg?: string; error?: string };
    const code = Number(json.statusCode ?? json.status);
    return { code: Number.isFinite(code) ? code : null, message: String(json.message ?? json.msg ?? json.error ?? body) };
  } catch {
    return { code: null, message: body };
  }
}

function explain(status: number, body: string): StorageError {
  const parsed = parseBody(body);
  const code = parsed.code ?? status;
  const text = parsed.message.replace(/\s+/g, ' ').slice(0, 200);

  // Supabase often reports a permission problem with HTTP 400 and the real code only inside the JSON.
  if (code === 401 || code === 403 || status === 401 || status === 403 || /row-level security|invalid (api )?key|jwt|unauthorized/i.test(text)) {
    return new StorageError(
      'Supabase refused the key. In SUPABASE_SERVICE_KEY use the "service_role" key (or the "secret" key) from Supabase > Project Settings > API, not the "anon" / "publishable" key.',
    );
  }
  if (code === 404) {
    return new StorageError('Supabase could not find that. Check that SUPABASE_URL is your Project URL, like https://abcdxyz.supabase.co');
  }
  return new StorageError(`Supabase storage error (${status}): ${text}`);
}

// Each object key is encoded piece by piece so "/" stays a folder separator.
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

const TIMEOUT_MS = 15_000;

async function call(input: string, init: RequestInit): Promise<Response> {
  if (!isStorageConfigured) throw new StorageNotConfigured();
  if (!isValidUrl) {
    throw new StorageError(
      'SUPABASE_URL is not a valid web address. In server/.env it should be only the address, for example SUPABASE_URL=https://abcdxyz.supabase.co (no variable name before it, no spaces).',
    );
  }
  try {
    return await fetch(`${url}/storage/v1${input}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.error('[storage] request failed', err);
    throw new StorageError(
      `Could not reach Supabase at ${new URL(url).host}. Check SUPABASE_URL (it should look like https://abcdxyz.supabase.co) and your internet connection.`,
    );
  }
}

let bucketReady: Promise<void> | null = null;

/** Creates the private bucket the first time (and does nothing if it already exists). */
export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const res = await call('/bucket', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: bucket,
        name: bucket,
        public: false,
        file_size_limit: 1024 * 1024,
        allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
      }),
    });

    if (res.ok) return;
    const text = await res.text().catch(() => '');
    if (/already exists|duplicate/i.test(text)) return;
    console.error(`[storage] could not create bucket "${bucket}" (${res.status}): ${text.slice(0, 300)}`);
    throw explain(res.status, text);
  })().catch((err) => {
    bucketReady = null; // retry on the next request
    throw err;
  });
  return bucketReady;
}

export async function uploadPhoto(path: string, bytes: Buffer, mime: string): Promise<void> {
  await ensureBucket();

  const send = () =>
    call(`/object/${bucket}/${encodePath(path)}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': mime, 'x-upsert': 'false' }),
      body: new Uint8Array(bytes),
    });

  let res = await send();

  // The bucket may have been deleted in the Supabase dashboard since the server started: recreate it and try once more.
  if (!res.ok && /bucket not found/i.test(await res.clone().text().catch(() => ''))) {
    bucketReady = null;
    await ensureBucket();
    res = await send();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[storage] photo upload failed (${res.status}): ${text.slice(0, 300)}`);
    throw explain(res.status, text);
  }
}

/** Returns the photo, or null if it no longer exists in storage. */
export async function downloadPhoto(path: string): Promise<Buffer | null> {
  const res = await call(`/object/authenticated/${bucket}/${encodePath(path)}`, { headers: headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Only a real "no such file" means missing. Any other refusal (bad key, bad URL...) must be reported, not hidden.
    if (res.status === 404 || parseBody(text).code === 404) return null;
    console.error(`[storage] photo download failed (${res.status}): ${text.slice(0, 300)}`);
    throw explain(res.status, text);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Best effort: a leftover file is harmless and invisible, so a failure here never blocks the admin. */
export async function deletePhotos(paths: string[]): Promise<void> {
  if (!paths.length || !isStorageConfigured) return;
  try {
    const res = await call(`/object/${bucket}`, {
      method: 'DELETE',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) console.error(`[storage] could not delete ${paths.length} photo(s): ${res.status}`);
  } catch (err) {
    console.error('[storage] could not delete photos', err);
  }
}
