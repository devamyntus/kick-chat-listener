const WebSocket = require('ws');
const express = require('express');
const mysql = require('mysql2/promise');

const CHANNEL_ID = '23714'; // Jonji's Kick channel ID

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 3306
};

// In-memory tracking: username (lowercase) → array of minute timestamps (as numbers)
const userMinuteActivity = new Map();

// Track when a user was last awarded (to prevent double-award in same completion minute)
const userLastAwardMinute = new Map();

// List of bots to ignore (case-insensitive)
const IGNORED_BOTS = new Set(['botrix']);

async function award10Points(username) {
  const lowerUsername = username.toLowerCase();

  try {
    const conn = await mysql.createConnection(DB_CONFIG);
    await conn.execute(`
      INSERT INTO users (username, points)
      VALUES (?, 0)
      ON DUPLICATE KEY UPDATE
        points = points + 10
    `, [lowerUsername]);

    console.log(`+10 points awarded (10-minute streak completed) → ${username}`);
    await conn.end();
  } catch (err) {
    console.error('Database error during award:', err);
  }
}

function processChatMessage(username) {
  const originalUsername = username;
  username = username.toLowerCase();

  // Ignore known bots
  if (IGNORED_BOTS.has(username)) {
    return;
  }

  const now = Date.now();
  const currentMinute = Math.floor(now / 60000); // Minute bucket

  // Get or initialize user's minute history
  let minutes = userMinuteActivity.get(username) || [];

  // Only add the minute if it's new (prevents spam in same minute from helping)
  if (minutes.length === 0 || minutes[minutes.length - 1] !== currentMinute) {
    minutes.push(currentMinute);
  }

  // Clean up old minutes: keep only last 20 minutes worth (safety buffer)
  const cutoff = currentMinute - 20;
  minutes = minutes.filter(m => m > cutoff);

  // Update map
  userMinuteActivity.set(username, minutes);

  // Sort descending: latest minute first
  const sortedMinutes = [...minutes].sort((a, b) => b - a);

  // Check for 10 consecutive minutes ending with currentMinute
  let streakLength = 0;
  for (let i = 0; i < sortedMinutes.length; i++) {
    if (sortedMinutes[i] === currentMinute - i) {
      streakLength++;
    } else {
      break; // Gap found → streak ends
    }
  }

  // If streak reaches exactly 10 (or more, but we only care about hitting 10)
  if (streakLength >= 10) {
    const lastAward = userLastAwardMinute.get(username) || 0;

    // Only award once per completed streak (when the 10th minute is filled)
    if (currentMinute > lastAward) {
      award10Points(originalUsername);
      userLastAwardMinute.set(username, currentMinute);
    }
  }
}

// WebSocket connection to Kick chat
function connectWS() {
  const ws = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false');

  ws.on('open', () => {
    console.log('Connected to Kick chat (Jonji)');
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: `chatrooms.${CHANNEL_ID}.v2` }
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Main chat message events
      if (msg.event === 'App\\Events\\ChatMessageSentEvent' || msg.event.includes('ChatMessage')) {
        let payload;
        try {
          payload = JSON.parse(msg.data);
        } catch {
          return;
        }

        const username =
          payload.sender?.username ||
          payload.message?.sender?.username ||
          payload.chatData?.sender?.username ||
          payload.sender_username;

        if (username && typeof username === 'string') {
          console.log(`Message from: ${username}`);
          processChatMessage(username.trim());
        }
      }
    } catch (e) {
      // Silently ignore malformed messages
    }
  });

  ws.on('close', () => {
    console.log('WebSocket disconnected – reconnecting in 5 seconds...');
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
}

connectWS();

// Health check for Render
const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

// Optional: Cleanup inactive users every 30 minutes to prevent memory growth
setInterval(() => {
  const nowMinute = Math.floor(Date.now() / 60000);
  let cleaned = 0;

  for (const [username, minutes] of userMinuteActivity.entries()) {
    if (minutes.length > 0 && nowMinute - minutes[minutes.length - 1] > 30) {
      userMinuteActivity.delete(username);
      userLastAwardMinute.delete(username);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`Cleanup: Removed ${cleaned} inactive users from tracking. Current active: ${userMinuteActivity.size}`);
  }
}, 1800000); // Every 30 minutes
