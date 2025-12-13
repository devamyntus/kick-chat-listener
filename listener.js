const WebSocket = require('ws');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

// === CONFIGURATION ===
const CHANNEL_ID = '4847686'; // Booth's Kick channel ID

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

let isStreamActive = true; // Set to false if you want to add stop functionality later

const userLastMessage = new Map(); // In-memory cooldown tracker (username → timestamp)

// Award +1 live credit with 60-second rolling cooldown per user
async function awardCredit(username) {
  username = username.toLowerCase();

  const now = Date.now();
  const last = userLastMessage.get(username) || 0;
  if (now - last < 60000) return; // 60-second cooldown

  userLastMessage.set(username, now);

  try {
    const conn = await mysql.createConnection(DB_CONFIG);

    await conn.execute(`
      INSERT INTO users (username, live_credits, created_at, date_joined, last_message_time)
      VALUES (?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        live_credits = live_credits + 1,
        last_message_time = CURRENT_TIMESTAMP
    `, [username]);

    console.log(`+1 live credit → ${username}`);
    await conn.end();
  } catch (err) {
    console.error('DB Award Error:', err.message);
  }
}

// WebSocket connection to Kick chat
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
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log('Disconnected – reconnecting in 5 seconds...');
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket Error:', err);
  });
}

connectWS();

// === Express Server ===
const app = express();
app.use(express.json());

// Enable CORS for your admin site (and localhost for testing)
app.use(cors({
  origin: [
    'https://darkgrey-echidna-627099.hostingersite.com', // Your Hostinger site
    'http://localhost',
    'http://127.0.0.1'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));

// Optional: Log incoming requests (helpful for debugging)
app.use((req, res, next) => {
  console.log(`Incoming ${req.method} ${req.path} from ${req.get('origin') || 'direct'}`);
  next();
});

// Health check endpoint (for UptimeRobot / Hostinger cron)
app.get('/health', (req, res) => {
  res.send('OK');
});

const API_KEY = process.env.ADMIN_API_KEY || 'change-me-now';

// Endpoint to clear all live credits (used by admin button)
app.post('/start-stream', async (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).send('Wrong key');
  }

  try {
    const conn = await mysql.createConnection(DB_CONFIG);
    await conn.execute('UPDATE users SET live_credits = 0');
    await conn.end();
    console.log('All live credits cleared by admin request');
    res.send('All live credits cleared!');
  } catch (err) {
    console.error('DB Clear Error:', err);
    res.status(500).send('Database error');
  }
});

// Optional stop-stream (currently not used, but kept for future)
app.post('/stop-stream', (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).send('Wrong key');
  }
  isStreamActive = false;
  res.send('Stream stopped');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
