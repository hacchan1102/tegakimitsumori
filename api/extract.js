// Vercel serverless function — /api/extract
// ブラウザから送られた本文をそのままAnthropicへ中継し、APIキーを隠します。
// 環境変数 ANTHROPIC_API_KEY をVercelのプロジェクト設定で登録してください。

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POSTのみ対応しています' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'サーバーにAPIキーが設定されていません（ANTHROPIC_API_KEY）' });
    return;
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
