import { openDb } from './index';
import { seedPlans } from '../services/plans';
import { dbPathFromUrl } from '../server-config';

// npm run db:migrate: creates or updates the tables in the DATABASE_URL file
const dbPath = dbPathFromUrl(process.env.DATABASE_URL);
const db = openDb(dbPath);
seedPlans(db);
db.close();
console.log(`Migrated ${dbPath}`);
