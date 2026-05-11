/**
 * AI Worker Process
 * 
 * Handles Ollama API calls in a separate process to prevent blocking the main backend event loop.
 */

const fetch = require('node-fetch');

process.on('message', async (data) => {
  const { ollamaHost, ollamaModel, prompt } = data;
  // Worker uses 85% of the route's AI_TIMEOUT_MS so the route always gets
  // a clean error message before the worker is force-killed.
  const routeTimeout = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10);
  const WORKER_TIMEOUT_MS = Math.floor(routeTimeout * 0.85);

  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => {
    abortCtrl.abort();
    process.send({ error: `AI worker hard timeout after ${WORKER_TIMEOUT_MS / 1000}s` });
  }, WORKER_TIMEOUT_MS);

  try {
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: prompt,
        stream: false,
        keep_alive: -1,
        options: {
          num_predict: 400,  // ~5-15s on phi3:mini; was 400, kept same
          temperature: 0.3
        }
      }),
      signal: abortCtrl.signal
    });

    clearTimeout(abortTimer);

    if (response.status !== 200) {
      const errorText = await response.text();
      process.send({ error: `Ollama API error: ${response.status} ${errorText}` });
      return;
    }

    const result = await response.json();
    process.send({ response: result.response });

  } catch (error) {
    clearTimeout(abortTimer);
    if (error.name === 'AbortError') {
      process.send({ error: `AI worker hard timeout after ${WORKER_TIMEOUT_MS / 1000}s` });
    } else {
      process.send({ error: error.message });
    }
  }
});
