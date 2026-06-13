const http = require('http');

const body = JSON.stringify({ text: '剑魔对线技巧', sessionId: 'test-rerank-178117', source: 'smoke_test', priority: 'high' });

const req = http.request({
  hostname: 'localhost',
  port: 8788,
  path: '/api/agent/orchestrate/trigger',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const j = JSON.parse(data);
      console.log('Response:', JSON.stringify(j, null, 2));
    } catch {
      console.log('Body:', data.slice(0, 500));
    }
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});

req.write(body);
req.end();
