import { getDb } from './db.js';

export async function getOpenPositions(userId: string) {
  const db = await getDb();
  const result = await db.query('SELECT * FROM positions WHERE user_id = $1 AND status = $2', [userId, 'open']);
  return result.rows;
}

export async function getFillsByPosition(positionId: string) {
  const db = await getDb();
  const result = await db.query('SELECT * FROM fills WHERE position_id = $1 ORDER BY created_at ASC', [positionId]);
  return result.rows;
}