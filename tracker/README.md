# Zemenay email tracker

This is a Vercel project for the open-tracking pixel and live dashboard.

## Deploy

From this directory:

```bash
npm install
npx vercel login
npx vercel
```

Create a Neon Postgres database and add these Vercel environment variables:

```text
DATABASE_URL=your-neon-connection-string
WRITE_KEY=replace-with-a-long-random-value
DASHBOARD_KEY=replace-with-another-long-random-value
```

The dashboard is at `/dashboard/`. The extension registers each email at
`/api/register` and places an image at `/api/open.gif?id=...`.
