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

// Store push tokens and configuration with persistent storage
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load tokens from file
let pushTokens = new Set();
try {
  if (fs.existsSync(TOKENS_FILE)) {
    const data = fs.readFileSync(TOKENS_FILE, 'utf8');
    const tokens = JSON.parse(data);
    pushTokens = new Set(tokens);
    console.log(`[Bridge] Loaded ${pushTokens.size} token(s) from persistent storage`);
  }
} catch (err) {
  console.error('[Bridge] Error loading tokens:', err.message);
}

// Load devices from file (map of token -> device metadata)
let devices = new Map();
try {
  if (fs.existsSync(DEVICES_FILE)) {
    const data = fs.readFileSync(DEVICES_FILE, 'utf8');
    const devicesArray = JSON.parse(data);
    devices = new Map(devicesArray);
    console.log(`[Bridge] Loaded ${devices.size} device(s) from persistent storage`);
  }
} catch (err) {
  console.error('[Bridge] Error loading devices:', err.message);
}

// Load configuration from file
let bridgeConfig = {
  frigateJwtToken: null,
  externalFrigateUrl: process.env.EXTERNAL_FRIGATE_URL || config.frigate.url,
  notifications: {
    cooldown: parseInt(process.env.NOTIFICATION_COOLDOWN || '30'),
    filterLabels: process.env.FILTER_LABELS?.split(',').filter(Boolean) || [],
    filterCameras: process.env.FILTER_CAMERAS?.split(',').filter(Boolean) || [],
  },
};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    const savedConfig = JSON.parse(data);
    bridgeConfig = { ...bridgeConfig, ...savedConfig };
    console.log(`[Bridge] Loaded configuration from persistent storage`);
    if (bridgeConfig.frigateJwtToken) {
      console.log(`[Bridge] Frigate JWT token configured: ${bridgeConfig.frigateJwtToken.substring(0, 20)}...`);
    }
  }
} catch (err) {
  console.error('[Bridge] Error loading config:', err.message);
}

// Save functions
function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(Array.from(pushTokens), null, 2));
  } catch (err) {
    console.error('[Bridge] Error saving tokens:', err.message);
  }
}

function saveDevices() {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(Array.from(devices.entries()), null, 2));
  } catch (err) {
    console.error('[Bridge] Error saving devices:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(bridgeConfig, null, 2));
  } catch (err) {
    console.error('[Bridge] Error saving config:', err.message);
  }
}

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

// Register push token endpoint (with optional device metadata)
app.post('/register', (req, res) => {
  const { pushToken, deviceName, deviceModel, platform } = req.body;
  
  if (!pushToken || !pushToken.startsWith('ExponentPushToken[')) {
    return res.status(400).json({ error: 'Invalid push token format' });
  }
  
  // Store device metadata
  const deviceInfo = {
    token: pushToken,
    name: deviceName || 'Unknown Device',
    model: deviceModel || 'Unknown Model',
    platform: platform || 'Unknown',
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  
  pushTokens.add(pushToken);
  devices.set(pushToken, deviceInfo);
  
  saveTokens();
  saveDevices();
  
  console.log(`[Bridge] Registered device: ${deviceInfo.name} (${deviceInfo.model})`);
  console.log(`[Bridge] Total registered devices: ${pushTokens.size}`);
  
  res.json({ 
    success: true, 
    message: 'Device registered successfully',
    totalDevices: pushTokens.size,
    device: deviceInfo,
  });
});

// Unregister push token endpoint
app.post('/unregister', (req, res) => {
  const { pushToken } = req.body;
  
  if (pushTokens.has(pushToken)) {
    pushTokens.delete(pushToken);
    devices.delete(pushToken);
    saveTokens();
    saveDevices();
    console.log(`[Bridge] Unregistered device: ${pushToken.substring(0, 30)}...`);
    res.json({ success: true, message: 'Device unregistered successfully' });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

// List registered tokens (for debugging)
app.get('/tokens', (req, res) => {
  res.json({
    count: pushTokens.size,
    tokens: Array.from(pushTokens).map(t => `${t.substring(0, 30)}...`),
  });
});

// === DEVICE MANAGEMENT ENDPOINTS ===

// List all registered devices with metadata
app.get('/devices', (req, res) => {
  const devicesList = Array.from(devices.values()).map(device => ({
    ...device,
    token: `${device.token.substring(0, 30)}...`, // Redact full token
  }));
  
  res.json({
    count: devices.size,
    devices: devicesList,
  });
});

// Remove a specific device by token
app.delete('/devices/:token', (req, res) => {
  const { token } = req.params;
  
  // Find device by partial token match (since we redact in UI)
  let fullToken = null;
  for (const [key] of devices) {
    if (key === token || key.startsWith(token.substring(0, 30))) {
      fullToken = key;
      break;
    }
  }
  
  if (fullToken && pushTokens.has(fullToken)) {
    pushTokens.delete(fullToken);
    devices.delete(fullToken);
    saveTokens();
    saveDevices();
    console.log(`[Bridge] Removed device: ${fullToken.substring(0, 30)}...`);
    res.json({ success: true, message: 'Device removed successfully' });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

// === CONFIGURATION MANAGEMENT ENDPOINTS ===

// Get current bridge configuration
app.get('/config', (req, res) => {
  res.json({
    frigateJwtToken: bridgeConfig.frigateJwtToken ? '***configured***' : null,
    externalFrigateUrl: bridgeConfig.externalFrigateUrl,
    notifications: bridgeConfig.notifications,
  });
});

// Update Frigate JWT token (sent from mobile app)
app.post('/config/frigate-token', (req, res) => {
  const { token, externalUrl } = req.body;
  
  if (!token || typeof token !== 'string' || token.length < 20) {
    return res.status(400).json({ error: 'Invalid JWT token format' });
  }
  
  bridgeConfig.frigateJwtToken = token;
  
  if (externalUrl) {
    bridgeConfig.externalFrigateUrl = externalUrl;
  }
  
  saveConfig();
  
  console.log(`[Bridge] Frigate JWT token updated: ${token.substring(0, 20)}...`);
  if (externalUrl) {
    console.log(`[Bridge] External Frigate URL updated: ${externalUrl}`);
  }
  
  res.json({ 
    success: true, 
    message: 'Frigate configuration updated successfully',
    configured: true,
  });
});

// Get Frigate token status
app.get('/config/frigate-token', (req, res) => {
  res.json({
    configured: !!bridgeConfig.frigateJwtToken,
    externalFrigateUrl: bridgeConfig.externalFrigateUrl,
  });
});

// Update notification filters
app.put('/config/notifications', (req, res) => {
  const { cooldown, filterLabels, filterCameras } = req.body;
  
  if (cooldown !== undefined) {
    bridgeConfig.notifications.cooldown = parseInt(cooldown);
  }
  
  if (filterLabels !== undefined) {
    bridgeConfig.notifications.filterLabels = Array.isArray(filterLabels) 
      ? filterLabels.filter(Boolean) 
      : [];
  }
  
  if (filterCameras !== undefined) {
    bridgeConfig.notifications.filterCameras = Array.isArray(filterCameras) 
      ? filterCameras.filter(Boolean) 
      : [];
  }
  
  saveConfig();
  
  console.log(`[Bridge] Notification filters updated:`, bridgeConfig.notifications);
  
  res.json({ 
    success: true, 
    message: 'Notification filters updated successfully',
    notifications: bridgeConfig.notifications,
  });
});

// Get notification filters
app.get('/config/notifications', (req, res) => {
  res.json(bridgeConfig.notifications);
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
    if (bridgeConfig.notifications.filterLabels.length > 0) {
      if (!bridgeConfig.notifications.filterLabels.includes(event.after?.label)) {
        console.log(`[Filter] Skipping event - label '${event.after?.label}' not in filter`);
        return;
      }
    }
    
    // Filter by cameras if configured
    if (bridgeConfig.notifications.filterCameras.length > 0) {
      if (!bridgeConfig.notifications.filterCameras.includes(event.after?.camera)) {
        console.log(`[Filter] Skipping event - camera '${event.after?.camera}' not in filter`);
        return;
      }
    }
    
    // Check cooldown to prevent spam
    const cooldownKey = `${event.after?.camera}_${event.after?.label}`;
    const lastNotification = notificationCooldowns.get(cooldownKey);
    const now = Date.now();
    
    if (lastNotification && (now - lastNotification) < bridgeConfig.notifications.cooldown * 1000) {
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
  
  // Send Unix timestamp to mobile app so it can format in user's local timezone
  const startTime = event.after?.start_time || Math.floor(Date.now() / 1000);
  
  // Build thumbnail URL with JWT token authentication
  // Frigate supports ?token=xxx query parameter for authentication
  const eventId = event.after?.id;
  
  let thumbnailUrl = null;
  if (eventId) {
    thumbnailUrl = `${bridgeConfig.externalFrigateUrl}/api/events/${eventId}/thumbnail.jpg`;
    // Add JWT token if configured (allows auth without custom headers)
    if (bridgeConfig.frigateJwtToken) {
      thumbnailUrl += `?token=${bridgeConfig.frigateJwtToken}`;
    }
  }
  
  // Capitalize label for cleaner display
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);
  
  // Prepare notification messages for all tokens
  const messages = Array.from(pushTokens).map(token => {
    const message = {
      to: token,
      sound: 'default',
      title: `${capitalizedLabel} detected ${score}`,
      body: `${camera.replace(/_/g, ' ')}`, // Don't include timestamp in body - mobile app will format it
      priority: 'high',
      data: {
        eventId: eventId,
        camera: camera,
        label: label,
        score: event.after?.score,
        thumbnailUrl: thumbnailUrl,
        timestamp: startTime, // Send Unix timestamp for local formatting
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
