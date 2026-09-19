require('dotenv').config();
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

const headers = {
  'X-Api-App-Key': process.env.VOLC_TTS_APP_ID,
  'X-Api-Access-Key': `Bearer; ${process.env.VOLC_TTS_ACCESS_TOKEN}`,
  'X-Api-Resource-Id': 'volc.service_type.10029',
  'X-Api-Connect-Id': uuidv4(),
};

console.log('========== 测试官方 SDK 同款配置 ==========');
console.log('Endpoint:', ENDPOINT);
console.log('Headers:', JSON.stringify(headers, null, 2).replace(process.env.VOLC_TTS_ACCESS_TOKEN, '***'));

const ws = new WebSocket(ENDPOINT, { headers });

ws.on('open', () => {
  console.log('✅✅✅ 握手成功!');
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.log(`❌ 失败: ${err.message}`);
  process.exit(1);
});

ws.on('unexpected-response', (req, res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`❌ HTTP ${res.statusCode}, body:`, body);
    console.log('Response headers:', JSON.stringify(res.headers, null, 2));
    process.exit(1);
  });
});
