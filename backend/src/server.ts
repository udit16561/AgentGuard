import { createApp } from './app';
import { dbPathFromUrl } from './server-config';
import { selfCheck } from './selfcheck';

const port = Number(process.env.PORT ?? 4000);

createApp({ dbPath: dbPathFromUrl(process.env.DATABASE_URL) }).then(({ app, config }) => {
  app.listen(port, () => {
    console.log(selfCheck(config).lines.join('\n'));
    console.log(`AgentGuard on http://localhost:${port} (integrations: ${config.integrationMode.toUpperCase()})`);
  });
});
