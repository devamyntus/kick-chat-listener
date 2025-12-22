const WebSocket = require('ws');
const express = require('express');
const mysql = require('mysql2/promise');

const CHANNEL_ID = '121684';

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 3306 
};

const userLastMessage = new Map();

async function awardCredit(username) {
  username = username.toLowerCase();

  const now = Date.now();
  const last = userLastMessage.get(username) || 0;

  if (now - last < 60000) return;

  userLastMessage.set(username, now);

  try {
    const conn = await mysql.createConnection(DB_CONFIG);

    await conn.execute(`
      INSERT INTO users (username, live_credits, last_message_time)
      VALUES (?, 1, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        live_credits = live_credits + 1,
        last_message_time = CURRENT_TIMESTAMP
    `, [username]);

    console.log(`+1 live credit → ${username}`);
    await conn.end();
} catch (err) {
  console.error('DB Award Error:', err);
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

      if (msg.event === 'App\\Events\\ChatMessageSentEvent' || msg.event.includes('ChatMessage')) {
        try {
          const payload = JSON.parse(msg.data);
const username = payload.sender?.username ||
                 payload.message?.sender?.username ||
                 payload.chatData?.sender?.username;

if (username) {
  const lowerUsername = username.toLowerCase();

  if (lowerUsername === 'botrix' || lowerUsername === 'booth') {
    console.log(`Ignored message from excluded user: ${username}`);
  } else {
    console.log(`Message from: ${username}`);
    awardCredit(username);
  }
}
        } catch (e) {
        }
      }
    } catch (e) {
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

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});
