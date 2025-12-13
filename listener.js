const WebSocket = require('ws');
const express = require('express');
const mysql = require('mysql2/promise');

// === CHANGE THESE ===
const CHANNEL_ID = '4847686'; // Booth's Kick channel ID - change if different

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

let isStreamActive = true; // Always on for testing
const userLastMessage = new Map();

async function awardCredit(username) {
  username = username.toLowerCase(); // Always store lowercase

  const now = Date.now();
  const last = userLastMessage.get(username) || 0;
  if (now - last < 60000) return; // 60-second cooldown

  userLastMessage.set(username, now);

  try {
    const conn = await mysql.createConnection(DB_CONFIG);

    // This single query: 
    // - Creates user if not exists (with live_credits = 1)
    // - Or adds +1 if they exist
    await conn.execute(`
      INSERT INTO users (username, live_credits, created_at, date_joined)
      VALUES (?, 1, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        live_credits = live_credits + 1,
        last_message_time = NOW()
    `, [username]);

    console.log(`+1 live credit → ${username}`); // Optional: see it working in logs

    await conn.end();
  } catch (err) {
    console.error('DB Award Error:', err.message);
  }
}

function connectWS() {
  const ws = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false');

  ws.on('open', () => {
    console.log('Connected to Kick chat!');
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: `chatrooms.${CHANNEL_ID}.v2` }
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event && msg.event.includes('ChatMessage')) {
        const payload = JSON.parse(msg.data);
        const username = payload.sender?.username || payload.chatData?.sender?.username;
        if (username) {
          awardCredit(username.toLowerCase());
        }
      }
    } catch (e) {
      // Ignore bad messages
    }
  });

  ws.on('close', () => {
    console.log('Disconnected – reconnecting...');
    setTimeout(connectWS, 5000);
  });
}

connectWS();

// Web server for health check and buttons
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.send('OK'));

const API_KEY = process.env.ADMIN_API_KEY || 'change-me-now';

app.post('/start-stream', (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).send('Wrong key');
  
  isStreamActive = true;
  
  mysql.createConnection(DB_CONFIG).then(conn => {
    conn.execute('UPDATE users SET live_credits = 0');
    conn.end();
    res.send('Stream started – all live credits cleared!');
  }).catch(err => res.status(500).send('DB error'));
});

app.post('/stop-stream', (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).send('Wrong key');
  
  isStreamActive = false;
  res.send('Stream stopped');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
