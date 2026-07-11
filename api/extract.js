// Vercel serverless function — /api/extract
// フロントエンドからはAnthropic形式のまま受け取り、サーバー側でGemini APIに変換して中継します。
// GoogleのGemini API無料枠（クレジットカード不要）で動きます。
// 環境変数 GEMINI_API_KEY をVercelのプロジェクト設定で登録してください。
// （取得先: https://aistudio.google.com/apikey ）

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POSTのみ対応しています' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: { message: 'サーバーにAPIキーが設定されていません（GEMINI_API_KEY）' } });
    return;
  }
  try {
    const msgs = (req.body && req.body.messages) || [];
    const parts = [];
    for (const m of msgs) {
      const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      for (const block of content) {
        if (block.type === 'image' || block.type === 'document') {
          parts.push({ inline_data: { mime_type: block.source.media_type, data: block.source.data } });
        } else if (block.type === 'text') {
          parts.push({ text: block.text });
        }
      }
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(GEMINI_MODEL) + ':generateContent';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          maxOutputTokens: (req.body && req.body.max_tokens) ? Math.max(req.body.max_tokens, 2000) : 2000,
          temperature: 0,
        },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('Gemini HTTP ' + r.status);
      res.status(r.status).json({ error: { message: msg } });
      return;
    }

    const text = (((data.candidates || [])[0] || {}).content || {}).parts
      ? data.candidates[0].content.parts.map(p => p.text || '').join('')
      : '';
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (e) {
    res.status(500).json({ error: { message: String(e) } });
  }
}
