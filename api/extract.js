// Vercel serverless function — /api/extract
// フロントエンドからはAnthropic形式のまま受け取り、サーバー側でGemini APIに変換して中継します。
// 環境変数 GEMINI_API_KEY をVercelのプロジェクト設定で登録してください。
//
// モデル戦略: 手書き認識に強い上位モデルを優先し、使えない/混雑時は自動で下位へフォールバック。
//   gemini-3.1-pro-preview → gemini-2.5-pro → gemini-2.5-flash → gemini-2.5-flash-lite
// 混雑(429/503)は同一モデルで1回待って再試行してから次へ。

export const config = { api: { bodyParser: { sizeLimit: '15mb' } }, maxDuration: 60 };

const CHAIN = [
  process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
].filter((m, i, a) => a.indexOf(m) === i);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function genConfigFor(model) {
  const base = { maxOutputTokens: 16384, temperature: 0, responseMimeType: 'application/json' };
  if (model.startsWith('gemini-3')) {
    return { ...base, thinkingConfig: { thinkingLevel: 'low' } };
  }
  if (model.includes('2.5-flash')) {
    return { ...base, thinkingConfig: { thinkingBudget: 0 } };
  }
  return base;
}

async function callGemini(model, parts, apiKey) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(model) + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: genConfigFor(model),
    }),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty */ }
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
    for (const model of CHAIN) {
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
        last = { status: out.status, msg };
        if (out.status === 401 || out.status === 403) {
          res.status(out.status).json({ error: { message: msg } });
          return;
        }
        const congestion = out.status === 429 || out.status === 503
          || /high demand|overloaded|try again|quota|resource.*exhaust/i.test(msg);
        if (congestion && attempt === 0) { await sleep(1500); continue; }
        break;
      }
    }
    res.status(last.status && last.status >= 400 ? last.status : 503).json({
      error: { message: '読み取れませんでした。数分おいて再試行してください（' + last.msg + '）' },
    });
  } catch (e) {
    res.status(500).json({ error: { message: String(e) } });
  }
}
