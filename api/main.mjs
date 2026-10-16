// Vercel entry point. vercel.json rewrites every /api/* request here, and
// sends the daily cron job to /api/cron.
import { createHandler } from '../lib/app.mjs';

const handler = createHandler();

export default function main(req, res) {
  return handler(req, res);
}
