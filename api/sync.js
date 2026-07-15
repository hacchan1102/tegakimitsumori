// Vercel serverless function — /api/sync
// 学習データ（業者別の品名・単位・単価）を端末間で共有するための同期API。
//
// 必要な環境変数:
//   KV_REST_API_URL / KV_REST_API_TOKEN … Vercel の Storage で Upstash Redis を作成すると自動で入る
//   SYNC_PASSCODE                        … 自分で決める合言葉（これが無いと同期は無効＝安全側に倒す）
//
// 認証: クライアントは x-sync-pass ヘッダーで合言葉を送る。SYNC_PASSCODE と一致しなければ拒否。

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const KEY = 'tegaki:vendor_profiles:v1';

function env() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function redisGet() {
  const { url, token } = env();
  const r = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('redis get ' + r.status);
  const j = await r.json();
  if (!j.result) return {};
  try { return JSON.parse(j.result); } catch (e) { return {}; }
}

async function redisSet(obj) {
  const { url, token } = env();
  const r = await fetch(`${url}/set/${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error('redis set ' + r.status);
  return true;
}

// 2つの学習ストアを統合する。品名ごとに ts（最終更新）が新しい方を採用。
export function mergeStores(a, b) {
  const out = {};
  const vendors = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const v of vendors) {
    const pa = (a && a[v]) || { items: {}, updated: 0 };
    const pb = (b && b[v]) || { items: {}, updated: 0 };
    const items = {};
    const names = new Set([...Object.keys(pa.items || {}), ...Object.keys(pb.items || {})]);
    for (const nm of names) {
      const ia = (pa.items || {})[nm];
      const ib = (pb.items || {})[nm];
      if (!ia) { items[nm] = ib; continue; }
      if (!ib) { items[nm] = ia; continue; }
      const ta = ia.ts || 0, tb = ib.ts || 0;
      const winner = tb > ta ? ib : ia;
      items[nm] = {
        unit: winner.unit || ia.unit || ib.unit || '',
        price: winner.price != null ? winner.price : (ia.price != null ? ia.price : ib.price),
        count: (ia.count || 0) + (ib.count || 0),
        ts: Math.max(ta, tb),
      };
    }
    out[v] = { items, updated: Math.max(pa.updated || 0, pb.updated || 0) };
  }
  return out;
}

export default async function handler(req, res) {
  const pass = process.env.SYNC_PASSCODE;
  const { url, token } = env();

  if (req.method === 'GET' && req.query && req.query.status === '1') {
    res.status(200).json({ configured: !!(pass && url && token) });
    return;
  }
  if (!pass || !url || !token) {
    res.status(501).json({ error: { message: '同期は未設定です（サーバーにKV_REST_API_URL / KV_REST_API_TOKEN / SYNC_PASSCODE が必要）' } });
    return;
  }
  const given = req.headers['x-sync-pass'];
  if (!given || String(given) !== String(pass)) {
    res.status(401).json({ error: { message: '合言葉が違います' } });
    return;
  }

  try {
    if (req.method === 'GET') {
      const store = await redisGet();
      res.status(200).json({ store });
      return;
    }
    if (req.method === 'POST') {
      const incoming = (req.body && req.body.store) || {};
      const current = await redisGet();
      const merged = mergeStores(current, incoming);
      await redisSet(merged);
      res.status(200).json({ store: merged });
      return;
    }
    res.status(405).json({ error: { message: 'GET か POST のみ対応しています' } });
  } catch (e) {
    res.status(500).json({ error: { message: String(e) } });
  }
}
