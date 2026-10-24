import fs from 'node:fs';
import { dbPathFromUrl } from '../server-config';

// npm run db:reset: deletes the local development database file (never runs in production)
if (process.env.NODE_ENV === 'production') { console.error('Refusing to reset in production'); process.exit(1); }
const dbPath = dbPathFromUrl(process.env.DATABASE_URL);
if (dbPath === ':memory:') { console.log('In-memory database: nothing to delete'); process.exit(0); }
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
console.log(`Deleted ${dbPath}. Run npm run db:seed to create the demo again.`);
