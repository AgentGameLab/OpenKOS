
import pg from 'pg'
const { Pool } = pg

let _pool = null

export function getPool() {
  if (!_pool) {
    const url = process.env.TM_DATABASE_URL
    if (!url) throw new Error('TM_DATABASE_URL not set')
    _pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
    _pool.on('error', (err) => {
      console.error('[db pool] idle client error:', err.message)
    })
  }
  return _pool
}

export async function closePool() {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

export async function query(sql, params = []) {
  const p = getPool()
  return p.query(sql, params)
}
