import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });

  const { rows } = await pool.query(
    `select role, content, created_at from tripp_message
     where session_id = $1 order by created_at asc`,
    [sessionId]
  );
  return NextResponse.json({ messages: rows });
}
