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

// In-memory tracking: username (lowercase) → array of minute timestamps
const userMinuteActivity = new Map();

// Track last awarded minute to prevent double awards
const userLastAwardMinute = new Map();

// Track previous streak length for detecting losses (for logging)
const userPreviousStreak = new Map();

// Bots to ignore
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

    console.log(`Message from: ${username} (Streak: 10 → +10 points awarded!)`);
    await conn.end();
  } catch (err) {
    console.error('Database error during award:', err);
  }
}

function processChatMessage(username) {
  const originalUsername = username;
  username = username.toLowerCase();

  // Ignore bots
  if (IGNORED_BOTS.has(username)) {
    return;
  }

  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);

  let minutes = userMinuteActivity.get(username) || [];

  // Determine if this is a new minute for this user
  const wasNewMinute = minutes.length === 0 || minutes[minutes.length - 1] !== currentMinute;

  // Only add if it's a new minute
  if (wasNewMinute) {
    minutes.push(currentMinute);
  }

  // Clean old minutes (keep last 20 as buffer)
  const cutoff = currentMinute - 20;
  minutes = minutes.filter(m => m > cutoff);
  userMinuteActivity.set(username, minutes);

  // Sort descending for streak checking
  const sortedMinutes = [...minutes].sort((a, b) => b - a);

  // Calculate current streak (consecutive minutes ending now)
  let currentStreak = 0;
  for (let i = 0; i < sortedMinutes.length; i++) {
    if (sortedMinutes[i] === currentMinute - i) {
      currentStreak++;
    } else {
      break;
    }
  }

  // Get previous streak for this user (before this message)
  const previousStreak = userPreviousStreak.get(username) || 0;

  // Log based on what happened
  if (!wasNewMinute) {
    // Same minute as last message → no streak change
    console.log(`Message from: ${originalUsername} (Streak: ${currentStreak})`);
  } else if (currentMinute - (sortedMinutes[1] || currentMinute) > 1) {
    // There was a gap: previous minute not present → streak reset
    if (previousStreak > 0) {
      console.log(`Message from: ${originalUsername} (Lost streak of ${previousStreak} → now 1)`);
    } else {
      console.log(`Message from: ${originalUsername} (Streak: 1)`);
    }
  } else if (currentStreak > previousStreak) {
    // Streak increased
    console.log(`Message from: ${originalUsername} (Streak: ${currentStreak})`);
  } else {
    // Shouldn't happen often, but safe
    console.log(`Message from: ${originalUsername} (Streak: ${currentStreak})`);
  }

  // Update previous streak for next comparison
  userPreviousStreak.set(username, currentStreak);

  // Award points if streak hits 10+
  if (currentStreak >= 10) {
    const lastAward = userLastAwardMinute.get(username) || 0;
    if (currentMinute > lastAward) {
      award10Points(originalUsername);
      userLastAwardMinute.set(username, currentMinute);
      // Note: we override the normal streak log above with the award log in award10Points
    }
  }
}

// WebSocket connection
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
          const trimmed = username.trim();
          if (trimmed) {
            processChatMessage(trimmed);
          }
        }
      }
    } catch (e) {
      // Ignore malformed
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

// Cleanup inactive users every 30 minutes
setInterval(() => {
  const nowMinute = Math.floor(Date.now() / 60000);
  let cleaned = 0;

  for (const [username, minutes] of userMinuteActivity.entries()) {
    if (minutes.length > 0 && nowMinute - minutes[minutes.length - 1] > 30) {
      userMinuteActivity.delete(username);
      userLastAwardMinute.delete(username);
      userPreviousStreak.delete(username);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`Cleanup: Removed ${cleaned} inactive users from tracking. Current active: ${userMinuteActivity.size}`);
  }
}, 1800000); // 30 minutes
