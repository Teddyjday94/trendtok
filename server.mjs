// TrendTok Local: run the app on your own computer.
//   npm start            live data, http://127.0.0.1:5173
//   npm run offline      sample data only
// The same handler runs on Vercel through api/main.mjs.
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';

export { createApp };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  const offline = process.argv.includes('--offline') || process.env.TRENDTOK_OFFLINE === '1';
  const server = createApp({ offline });
  server.listen(port, host, () => {
    console.log(`TrendTok Local running at http://${host}:${port}${offline ? ' (offline sample data)' : ''}`);
    server.startSchedule();
  });
}
