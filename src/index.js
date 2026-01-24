require('dotenv').config();
const mqtt = require('mqtt');
const axios = require('axios');
const express = require('express');
const { version } = require('../package.json');

// Log version on startup
console.log(`[Bridge] Aviant Push Bridge v${version}`);
console.log(`[Bridge] Starting up...`);

// Configuration
const config = {
  mqtt: {
    host: process.env.MQTT_HOST || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    topic: process.env.MQTT_TOPIC || 'frigate/events',
  },
  frigate: {
    url: process.env.FRIGATE_URL || 'http://localhost:5000',
  },
  bridge: {
    port: parseInt(process.env.BRIDGE_PORT || '3002'),
  },
  notifications: {
    cooldown: parseInt(process.env.NOTIFICATION_COOLDOWN || '30'), // seconds between notifications per camera
    filterLabels: process.env.FILTER_LABELS?.split(',') || [], // Only these labels (empty = all)
    filterCameras: process.env.FILTER_CAMERAS?.split(',') || [], // Only these cameras (empty = all)
  },
};

// Store push tokens (in production, use database)
const pushTokens = new Set();

// Cooldown tracking to prevent notification spam
const notificationCooldowns = new Map();

// Statistics
const stats = {
  mqttConnected: false,
  eventsReceived: 0,
  notificationsSent: 0,
  notificationsFailed: 0,
  lastEventTime: null,
  uptime: Date.now(),
};

// Express server for token registration and health checks
const app = express();
app.use(express.json());

// Simple API key authentication middleware (if AUTH_TOKEN is set)
const authMiddleware = (req, res, next) => {
  const authToken = process.env.AUTH_TOKEN;
  
  // Skip auth if no token configured
  if (!authToken) {
    return next();
  }
  
  const providedToken = req.headers['authorization']?.replace('Bearer ', '');
  
  if (!providedToken || providedToken !== authToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// Apply auth to registration endpoints only (health check stays public)
app.use('/register', authMiddleware);
app.use('/unregister', authMiddleware);
app.use('/tokens', authMiddleware);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: stats.mqttConnected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - stats.uptime) / 1000),
    stats: {
      eventsReceived: stats.eventsReceived,
      notificationsSent: stats.notificationsSent,
      notificationsFailed: stats.notificationsFailed,
      lastEventTime: stats.lastEventTime,
    },
    registeredTokens: pushTokens.size,
  });
});

// Register push token endpoint
app.post('/register', (req, res) => {
  const { pushToken } = req.body;
  
  if (!pushToken || !pushToken.startsWith('ExponentPushToken[')) {
    return res.status(400).json({ error: 'Invalid push token format' });
  }
  
  pushTokens.add(pushToken);
  console.log(`[Bridge] Registered push token: ${pushToken.substring(0, 30)}...`);
  console.log(`[Bridge] Total registered tokens: ${pushTokens.size}`);
  
  res.json({ 
    success: true, 
    message: 'Push token registered successfully',
    totalTokens: pushTokens.size,
  });
});

// Unregister push token endpoint
app.post('/unregister', (req, res) => {
  const { pushToken } = req.body;
  
  if (pushTokens.has(pushToken)) {
    pushTokens.delete(pushToken);
    console.log(`[Bridge] Unregistered push token: ${pushToken.substring(0, 30)}...`);
    res.json({ success: true, message: 'Push token unregistered' });
  } else {
    res.status(404).json({ error: 'Push token not found' });
  }
});

// List registered tokens (for debugging)
app.get('/tokens', (req, res) => {
  res.json({
    count: pushTokens.size,
    tokens: Array.from(pushTokens).map(t => `${t.substring(0, 30)}...`),
  });
});

// Start Express server
app.listen(config.bridge.port, () => {
  console.log(`[Bridge] HTTP server listening on port ${config.bridge.port}`);
  console.log(`[Bridge] Health check: http://localhost:${config.bridge.port}/health`);
});

// MQTT Client
console.log(`[MQTT] Connecting to ${config.mqtt.host}...`);
const client = mqtt.connect(config.mqtt.host, {
  username: config.mqtt.username,
  password: config.mqtt.password,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
});

client.on('connect', () => {
  console.log('[MQTT] Connected to broker');
  stats.mqttConnected = true;
  
  // Subscribe to Frigate events
  client.subscribe(config.mqtt.topic, (err) => {
    if (err) {
      console.error('[MQTT] Subscription error:', err);
    } else {
      console.log(`[MQTT] Subscribed to topic: ${config.mqtt.topic}`);
    }
  });
  
  // Also subscribe to reviews (alerts)
  client.subscribe('frigate/reviews', (err) => {
    if (!err) {
      console.log('[MQTT] Subscribed to topic: frigate/reviews');
    }
  });
});

client.on('error', (err) => {
  console.error('[MQTT] Connection error:', err.message);
  stats.mqttConnected = false;
});

client.on('close', () => {
  console.log('[MQTT] Connection closed');
  stats.mqttConnected = false;
});

client.on('reconnect', () => {
  console.log('[MQTT] Reconnecting...');
});

client.on('message', async (topic, message) => {
  try {
    const event = JSON.parse(message.toString());
    stats.eventsReceived++;
    stats.lastEventTime = new Date().toISOString();
    
    // Only process 'new' events (not 'update' or 'end')
    if (event.type !== 'new') {
      return;
    }
    
    // Filter by labels if configured
    if (config.notifications.filterLabels.length > 0) {
      if (!config.notifications.filterLabels.includes(event.after?.label)) {
        console.log(`[Filter] Skipping event - label '${event.after?.label}' not in filter`);
        return;
      }
    }
    
    // Filter by cameras if configured
    if (config.notifications.filterCameras.length > 0) {
      if (!config.notifications.filterCameras.includes(event.after?.camera)) {
        console.log(`[Filter] Skipping event - camera '${event.after?.camera}' not in filter`);
        return;
      }
    }
    
    // Check cooldown to prevent spam
    const cooldownKey = `${event.after?.camera}_${event.after?.label}`;
    const lastNotification = notificationCooldowns.get(cooldownKey);
    const now = Date.now();
    
    if (lastNotification && (now - lastNotification) < config.notifications.cooldown * 1000) {
      console.log(`[Cooldown] Skipping notification for ${cooldownKey} (cooldown active)`);
      return;
    }
    
    // Update cooldown
    notificationCooldowns.set(cooldownKey, now);
    
    console.log(`[Event] ${event.after?.label} detected on ${event.after?.camera}`);
    
    // Send push notification
    await sendPushNotifications(event);
    
  } catch (err) {
    console.error('[MQTT] Error processing message:', err.message);
  }
});

// Send push notifications to all registered tokens
async function sendPushNotifications(event) {
  if (pushTokens.size === 0) {
    console.log('[Push] No registered tokens, skipping notification');
    return;
  }
  
  const label = event.after?.label || 'Object';
  const camera = event.after?.camera || 'Unknown';
  const score = event.after?.score ? `(${Math.round(event.after.score * 100)}%)` : '';
  const timestamp = event.after?.start_time 
    ? new Date(event.after.start_time * 1000).toLocaleTimeString()
    : new Date().toLocaleTimeString();
  
  // Build thumbnail URL from Frigate event ID
  // Frigate thumbnail format: /api/events/{event_id}/thumbnail.jpg
  const eventId = event.after?.id;
  const thumbnailUrl = eventId 
    ? `${config.frigate.url}/api/events/${eventId}/thumbnail.jpg`
    : null;
  
  // Capitalize label for cleaner display
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);
  
  // Prepare notification messages for all tokens
  const messages = Array.from(pushTokens).map(token => {
    const message = {
      to: token,
      sound: 'default',
      title: `${capitalizedLabel} detected ${score}`,
      body: `${camera.replace(/_/g, ' ')} • ${timestamp}`,
      priority: 'high',
      data: {
        eventId: eventId,
        camera: camera,
        label: label,
        score: event.after?.score,
        thumbnailUrl: thumbnailUrl,
        type: 'frigate_detection',
      },
    };
    
    // Add thumbnail image if available
    if (thumbnailUrl) {
      // Android: uses 'image' field
      message.image = thumbnailUrl;
      
      // iOS: uses 'attachments' array in 'ios' field
      message.ios = {
        attachments: [{
          url: thumbnailUrl,
        }],
      };
    }
    
    return message;
  });
  
  try {
    console.log(`[Push] Sending ${messages.length} notification(s)${thumbnailUrl ? ' with image attachment' : ''}...`);
    
    const response = await axios.post(
      'https://exp.host/--/api/v2/push/send',
      messages,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    
    stats.notificationsSent += messages.length;
    console.log('[Push] Notifications sent successfully');
    
    // Check for errors in response
    if (response.data?.data) {
      response.data.data.forEach((result, index) => {
        if (result.status === 'error') {
          console.error(`[Push] Error for token ${index}:`, result.message);
          stats.notificationsFailed++;
        }
      });
    }
    
  } catch (err) {
    stats.notificationsFailed += messages.length;
    console.error('[Push] Failed to send notifications:', err.response?.data || err.message);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down gracefully...');
  client.end();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Bridge] Received SIGTERM, shutting down...');
  client.end();
  process.exit(0);
});

console.log('[Bridge] Aviant Push Bridge started');
console.log('[Bridge] Waiting for Frigate events...');
