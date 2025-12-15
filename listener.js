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

// Track users who messaged in last 5 minutes (for coin drops)
const activeUsers = new Map(); // username (lowercase) → timestamp (ms)

// Clean up old entries every 30 seconds
setInterval(() => {
  const cutoff = Date.now() - 300000; // 5 minutes ago
  for (const [user, time] of activeUsers.entries()) {
    if (time < cutoff) {
      activeUsers.delete(user);
    }
  }
}, 30000);

let isStreamActive = true;
const userLastMessage = new Map(); // cooldown for live credits

// Award +1 live credit (60-second cooldown)
async function awardCredit(username) {
  username = username.toLowerCase();
  const now = Date.now();
  const last = userLastMessage.get(username) || 0;
  if (now - last < 60000) return; // 60 sec cooldown

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
          const lower = username.toLowerCase();

          // Track for coin drop (active in last 5 min)
          activeUsers.set(lower, Date.now());

          // Award live credit
          awardCredit(lower);
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

// CORS for your admin site
app.use(cors({
  origin: [
    'https://darkgrey-echidna-627099.hostingersite.com',
    'http://localhost',
    'http://127.0.0.1'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));

// Log requests
app.use((req, res, next) => {
  console.log(`Incoming ${req.method} ${req.path} from ${req.get('origin') || 'direct'}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

const API_KEY = process.env.ADMIN_API_KEY || 'change-me-now';

// Clear all live credits
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

// Optional stop stream
app.post('/stop-stream', (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).send('Wrong key');
  }
  isStreamActive = false;
  res.send('Stream stopped');
});

// Drop coins to everyone active in last 5 minutes
app.post('/drop-coins', async (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).send('Wrong key');
  }

  const amount = parseInt(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).send('Invalid amount');
  }

  const users = Array.from(activeUsers.keys());
  if (users.length === 0) {
    return res.send('No users active in the last 5 minutes.');
  }

  try {
    const conn = await mysql.createConnection(DB_CONFIG);

    for (const user of users) {
      await conn.execute(`
        INSERT INTO users (username, current_coins, total_coins)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          current_coins = current_coins + VALUES(current_coins),
          total_coins = total_coins + VALUES(total_coins)
      `, [user, amount, amount]);
    }

    await conn.end();
    console.log(`Coin drop: ${amount} coins to ${users.length} active users`);
    res.send(`Dropped ${amount} coins to ${users.length} active user(s)!`);
  } catch (err) {
    console.error('Drop coins error:', err);
    res.status(500).send('Database error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
