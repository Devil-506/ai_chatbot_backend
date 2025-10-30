const fetch = require('node-fetch');

const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const MODEL = 'deepseek-v3.1:671b-cloud';

async function fastQuery(prompt) {
  const response = await fetch('https://api.ollama.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OLLAMA_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,       // no streaming = faster
      temperature: 0.7,
      max_tokens: 500
    })
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);

  const data = await response.json();
  return data.choices[0].message.content;
}

// Example:
fastQuery("Hello from Tunisian medical bot")
  .then(console.log)
  .catch(console.error);
