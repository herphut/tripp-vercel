import { Pool } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __pgpool__: Pool | undefined;
}

export const pool =
  global.__pgpool__ ??
  new Pool({
    connectionString: process.env.POSTGRES_URL!,
    // ssl: { rejectUnauthorized: false }, // uncomment if Neon requires it in your setup
    max: 5,
  });

if (process.env.NODE_ENV !== 'production') {
  global.__pgpool__ = pool;
}
