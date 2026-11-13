import bcrypt from 'bcryptjs';
import { ensureSecuritySchema, pool } from './db';

const MIN_PASSWORD_LENGTH = 12;

async function main(): Promise<void> {
  const [username, password] = process.argv.slice(2);

  if (!username || !password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`usage: npm run seed-admin <user> <password (${MIN_PASSWORD_LENGTH}+ chars)>`);
    process.exitCode = 1;
    return;
  }

  await ensureSecuritySchema();

  const hash = await bcrypt.hash(password, 12);

  // Saving a password also logs this admin out everywhere (token_version) and lifts any login pause,
  // so re-running this command is the "I forgot my password / my phone was stolen" fix.
  await pool.query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE
        SET password_hash = $2,
            token_version = admins.token_version + 1,
            failed_attempts = 0,
            locked_until = NULL`,
    [username, hash],
  );

  console.log(`Admin "${username}" saved. Any older logins for this admin have been signed out.`);
}

main()
  .catch((err) => {
    console.error('Failed to seed admin:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
