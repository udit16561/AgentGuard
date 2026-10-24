import { createApp } from './app';
import { dbPathFromUrl } from './server-config';

const port = Number(process.env.PORT ?? 4000);

createApp({ dbPath: dbPathFromUrl(process.env.DATABASE_URL) }).then(({ app, config }) => {
  app.listen(port, () => console.log(`AgentGuard API on http://localhost:${port} (integrations: ${config.integrationMode.toUpperCase()})`));
});
