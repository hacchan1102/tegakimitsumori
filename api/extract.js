// Vercel serverless function — /api/extract
// フロントエンドからはAnthropic形式のまま受け取り、サーバー側でGemini APIに変換して中継します。
// GoogleのGemini API無料枠（クレジットカード不要）で動きます。
// 環境変数 GEMINI_API_KEY をVercelのプロジェクト設定で登録してください。
// （取得先: https://aistudio.google.com/apikey ）
//
// 混雑対策: 高負荷エラー(429/503/high demand)時は自動で待って再試行し、
// それでも失敗する場合は軽量モデル(gemini-2.5-flash-lite)に自動フォールバックします。

export const config = { api: { bodyParser: { sizeLimit: '15mb' } }, maxDuration: 60 };

const MODELS = [
  process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(model, parts, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(model) + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* 空ボディ等 */ }
  return { ok: r.ok, status: r.status, data };
}

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
    // Anthropic形式のリクエストをGemini形式に変換
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

    let last = { status: 500, msg: '不明なエラー' };
    for (const model of MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await callGemini(model, parts, process.env.GEMINI_API_KEY);
        if (out.ok) {
          const text = (((out.data.candidates || [])[0] || {}).content || {}).parts
            ? out.data.candidates[0].content.parts.map((p) => p.text || '').join('')
            : '';
          res.status(200).json({ content: [{ type: 'text', text }] });
          return;
        }
        const msg = (out.data && out.data.error && out.data.error.message)
          ? out.data.error.message : ('Gemini HTTP ' + out.status);
        const retriable = out.status === 429 || out.status === 503
          || /high demand|overloaded|try again|quota|resource.*exhaust/i.test(msg);
        last = { status: out.status, msg };
        if (!retriable) {
          res.status(out.status).json({ error: { message: msg } });
          return;
        }
        // 混雑: 少し待って再試行（2回目で同モデルを諦め、次のモデルへ）
        await sleep(1500);
      }
    }
    res.status(last.status || 503).json({
      error: { message: '混雑のため読み取れませんでした。数分おいて再試行してください（' + last.msg + '）' },
    });
  } catch (e) {
    res.status(500).json({ error: { message: String(e) } });
  }
}
