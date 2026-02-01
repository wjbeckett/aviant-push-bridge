require('dotenv').config();
const mqtt = require('mqtt');
const axios = require('axios');
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
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
    topic: process.env.MQTT_TOPIC || 'frigate/reviews', // Use reviews by default (recommended by Frigate docs)
  },
  frigate: {
    url: process.env.FRIGATE_URL || 'http://localhost:5000',
  },
  bridge: {
    port: parseInt(process.env.BRIDGE_PORT || '3002'),
  },
  notifications: {
    cooldown: parseInt(process.env.NOTIFICATION_COOLDOWN || '30'), // seconds between notifications per camera
    filterLabels: process.env.FILTER_LABELS?.split(',').filter(Boolean) || [], // Only these labels (empty = all)
    filterCameras: process.env.FILTER_CAMERAS?.split(',').filter(Boolean) || [], // Only these cameras (empty = all)
    severityFilter: process.env.SEVERITY_FILTER || 'alert', // 'alert', 'detection', or 'all'
  },
};

// Notification Proxy Configuration
// Uses Cloudflare Worker to send notifications (FCM credentials secured there)
const NOTIFICATION_PROXY_BASE_URL = process.env.NOTIFICATION_PROXY_URL || 'https://notify.aviant.app';
const NOTIFICATION_PROXY_URL = `${NOTIFICATION_PROXY_BASE_URL}/send`; // Full endpoint for sending notifications
let NOTIFICATION_PROXY_TOKEN = process.env.NOTIFICATION_PROXY_TOKEN || null; // Will be auto-generated on first run

console.log('[Proxy] Notification proxy:', NOTIFICATION_PROXY_BASE_URL);
console.log('[Proxy] FCM credentials secured in Cloudflare Worker (not in bridge)');

// Firebase Admin SDK is NOT initialized on the bridge
// All notifications are sent via the secure Cloudflare Worker proxy
// This keeps FCM credentials secure and separate from the bridge
const fcmAvailable = false; // FCM not initialized on bridge, using proxy instead
console.log('[Bridge] Notification proxy mode: FCM credentials secured in Cloudflare Worker');
console.log('[Bridge] Bridge does NOT have direct access to FCM credentials (secure by design)');

// Store push tokens and configuration with persistent storage

const DATA_DIR = path.join(__dirname, '../data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const API_KEY_FILE = path.join(DATA_DIR, 'api_key.json');

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
    severityFilter: process.env.SEVERITY_FILTER || 'alert',
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

// Track review notifications for progressive enhancement
// reviewId → { severity, thumbPath, timestamp, notificationSent }
const sentNotifications = new Map();

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
  const { pushToken, deviceName, deviceModel, platform, notificationType } = req.body;
  
  // Validate token format
  if (!pushToken || typeof pushToken !== 'string' || pushToken.length < 10) {
    return res.status(400).json({ error: 'Invalid push token format' });
  }
  
  // Detect token type
  const isExpoToken = pushToken.startsWith('ExponentPushToken[');
  const isFCMToken = !isExpoToken && pushToken.length > 50; // FCM tokens are typically 150+ chars
  
  if (!isExpoToken && !isFCMToken) {
    return res.status(400).json({ error: 'Unknown push token format' });
  }
  
  const tokenType = isExpoToken ? 'expo' : 'fcm';
  
  // Store device metadata (preserve existing templates if re-registering)
  const existingDevice = devices.get(pushToken);
  const deviceInfo = {
    token: pushToken,
    tokenType, // Store token type for logging
    name: deviceName || 'Unknown Device',
    model: deviceModel || 'Unknown Model',
    platform: platform || 'Unknown',
    registeredAt: existingDevice?.registeredAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    templates: existingDevice?.templates || {
      title: '{label} detected on {camera}',
      body: 'Motion in {zones} at {time}',
    },
  };
  
  pushTokens.add(pushToken);
  devices.set(pushToken, deviceInfo);
  
  saveTokens();
  saveDevices();
  
  console.log(`[Bridge] Registered device: ${deviceInfo.name} (${deviceInfo.model}) - Token type: ${tokenType}`);
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

// Send test notification
app.post('/test-notification', async (req, res) => {
  const { pushToken } = req.body;
  
  if (!pushToken) {
    return res.status(400).json({ error: 'Push token required' });
  }
  
  const device = devices.get(pushToken);
  if (!device) {
    return res.status(404).json({ error: 'Device not registered' });
  }
  
  try {
    console.log(`[Bridge] Sending test notification to: ${device.name}`);
    
    // Check if it's an FCM token
    const isFCMToken = device.tokenType === 'fcm' || (!pushToken.startsWith('ExponentPushToken['));
    
    if (isFCMToken) {
      // Send via Notification Proxy (Cloudflare Worker with FCM credentials)
      console.log('[Bridge] Using notification proxy for FCM token');
      
      const proxyPayload = {
        token: pushToken,
        title: 'Test Notification',
        body: 'This is a test notification from Aviant Bridge',
        data: {
          notificationType: 'test',
          timestamp: Date.now().toString(),
        },
        priority: 'high',
      };
      
      const response = await axios.post(NOTIFICATION_PROXY_URL, proxyPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${NOTIFICATION_PROXY_TOKEN}`,
        },
        timeout: 10000,
      });
      
      console.log('[Bridge] Test notification sent via proxy:', response.data);
      
      return res.json({ 
        success: true, 
        message: 'Test notification sent via proxy',
        result: response.data,
      });
    } else {
      // Send via Expo Push (for legacy tokens)
      console.log('[Bridge] Using Expo Push Service for legacy token');
      
      const expoPushMessage = {
        to: pushToken,
        sound: 'default',
        title: 'Test Notification',
        body: 'This is a test notification from Aviant Bridge',
        data: { notificationType: 'test' },
      };
      
      const expoPushResponse = await axios.post('https://exp.host/--/api/v2/push/send', expoPushMessage, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });
      
      console.log('[Bridge] Test Expo notification sent:', expoPushResponse.data);
      
      return res.json({ 
        success: true, 
        message: 'Test notification sent via Expo',
        result: expoPushResponse.data,
      });
    }
  } catch (error) {
    console.error('[Bridge] Failed to send test notification:', error.message);
    if (error.response) {
      console.error('[Bridge] Proxy response:', error.response.status, error.response.data);
    }
    return res.status(500).json({ 
      error: 'Failed to send test notification',
      details: error.message,
    });
  }
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

// Update device preferences (notification templates, etc.)
app.put('/devices/:token/preferences', (req, res) => {
  const { token } = req.params;
  const { templates } = req.body;
  
  // Find device by full token match
  const device = devices.get(token);
  
  if (!device) {
    return res.status(404).json({ error: 'Device not found. Ensure you are registered first.' });
  }
  
  // Validate templates if provided
  if (templates) {
    if (!templates.title || !templates.body) {
      return res.status(400).json({ error: 'Templates must include both title and body' });
    }
    
    if (typeof templates.title !== 'string' || typeof templates.body !== 'string') {
      return res.status(400).json({ error: 'Template title and body must be strings' });
    }
    
    // Update templates
    device.templates = {
      title: templates.title.trim(),
      body: templates.body.trim(),
    };
    
    devices.set(token, device);
    saveDevices();
    
    console.log(`[Bridge] Updated templates for device: ${device.name}`);
    console.log(`[Bridge]   Title: ${device.templates.title}`);
    console.log(`[Bridge]   Body: ${device.templates.body}`);
  }
  
  res.json({ 
    success: true, 
    message: 'Preferences updated successfully',
    templates: device.templates,
  });
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

// === AUTO-REGISTRATION WITH NOTIFICATION PROXY ===

/**
 * Generate unique bridge identifier based on machine fingerprint
 * Uses MAC address + hostname for consistent ID across restarts
 */
function generateBridgeId() {
  const os = require('os');
  const crypto = require('crypto');
  const networkInterfaces = os.networkInterfaces();
  let macAddress = '';
  
  // Get first non-internal MAC address
  for (const iface of Object.values(networkInterfaces)) {
    for (const addr of iface) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
        macAddress = addr.mac;
        break;
      }
    }
    if (macAddress) break;
  }
  
  // Fallback to random UUID if no MAC found
  if (!macAddress) {
    console.log('[Bridge] No MAC address found, using random UUID');
    return crypto.randomUUID();
  }
  
  // Hash MAC + hostname for privacy (don't expose raw MAC address)
  const fingerprint = `${macAddress}-${os.hostname()}`;
  const bridgeId = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 32);
  
  return bridgeId;
}

/**
 * Auto-register bridge with notification proxy on first run
 * Returns API key for authenticated notification sending
 */
async function ensureApiKey() {
  const os = require('os');
  
  // If API key provided via environment variable, use it
  if (process.env.NOTIFICATION_PROXY_TOKEN) {
    console.log('[Proxy] Using API key from environment variable');
    return process.env.NOTIFICATION_PROXY_TOKEN;
  }
  
  // Check if we already have an API key
  if (fs.existsSync(API_KEY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(API_KEY_FILE, 'utf8'));
      console.log('[Proxy] Using existing API key');
      console.log('[Proxy] Bridge ID:', data.bridgeId);
      console.log('[Proxy] Registered:', new Date(data.registeredAt).toLocaleString());
      if (data.userEmail) {
        console.log('[Proxy] Linked to account:', data.userEmail);
      } else {
        console.log('[Proxy] Anonymous mode (100 notifications/day limit)');
        console.log('[Proxy] To upgrade: Visit https://notify.aviant.app/link?key=' + data.apiKey.substring(0, 16) + '...');
      }
      return data.apiKey;
    } catch (error) {
      console.error('[Proxy] Error reading API key file:', error.message);
      console.log('[Proxy] Will re-register...');
    }
  }
  
  // First run - register with proxy
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  FIRST RUN DETECTED - Registering with notification proxy');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  
  const bridgeId = generateBridgeId();
  
  try {
    console.log('[Proxy] Contacting notification proxy:', NOTIFICATION_PROXY_BASE_URL);
    console.log('[Proxy] Bridge ID:', bridgeId);
    
    const response = await axios.post(
      `${NOTIFICATION_PROXY_BASE_URL}/register-bridge`,
      {
        bridgeId: bridgeId,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        version: version,
      },
      { 
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    const apiKey = response.data.apiKey;
    const isExisting = response.data.message?.includes('existing');
    
    // Save API key locally
    const keyData = {
      apiKey: apiKey,
      bridgeId: bridgeId,
      registeredAt: new Date().toISOString(),
      hostname: os.hostname(),
      platform: os.platform(),
    };
    
    fs.writeFileSync(API_KEY_FILE, JSON.stringify(keyData, null, 2));
    
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         REGISTRATION SUCCESSFUL                        ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    if (isExisting) {
      console.log('  This bridge was already registered. Using existing API key.');
    } else {
      console.log('  Your bridge is now registered with the notification proxy!');
    }
    console.log('');
    console.log('  Your API Key:');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log(`  │ ${apiKey} │`);
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('  This key is saved in:', API_KEY_FILE);
    console.log('  Anonymous mode: 100 notifications/day');
    console.log('  To link to an account (optional):');
    console.log(`  Visit: https://notify.aviant.app/link?key=${apiKey.substring(0, 16)}...`);
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    
    return apiKey;
    
  } catch (error) {
    console.error('');
    console.error('╔═══════════════════════════════════════════════════════════╗');
    console.error('║         REGISTRATION FAILED                            ║');
    console.error('╚═══════════════════════════════════════════════════════════╝');
    console.error('');
    console.error('  Error:', error.message);
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Details:', error.response.data);
    }
    console.error('');
    console.error('  Notifications will NOT work until registration succeeds.');
    console.error('  Please check:');
    console.error('  1. Internet connection is working');
    console.error('  2. Notification proxy is online:', NOTIFICATION_PROXY_BASE_URL);
    console.error('  3. No firewall blocking outbound HTTPS');
    console.error('');
    console.error('  You can manually set an API key with:');
    console.error('  NOTIFICATION_PROXY_TOKEN=your-key-here');
    console.error('');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('');
    return null;
  }
}

// === STARTUP SEQUENCE ===

(async function startBridge() {
  // Step 1: Register with notification proxy and get API key
  console.log('[Bridge] Step 1: Registering with notification proxy...');
  NOTIFICATION_PROXY_TOKEN = await ensureApiKey();
  
  if (!NOTIFICATION_PROXY_TOKEN) {
    console.error('[Bridge] Starting without notification proxy access');
    console.error('[Bridge] Push notifications will NOT work');
  } else {
    console.log('[Bridge] Notification proxy ready');
  }
  
  // Step 2: Start Express server
  console.log('[Bridge] Step 2: Starting HTTP server...');
  app.listen(config.bridge.port, () => {
    console.log(`[Bridge] HTTP server listening on port ${config.bridge.port}`);
    console.log(`[Bridge] Health check: http://localhost:${config.bridge.port}/health`);
  });

  // Step 3: Connect to MQTT
  console.log('[Bridge] Step 3: Connecting to MQTT...');
  console.log(`[MQTT] Connecting to ${config.mqtt.host}...`);
})();

// MQTT Client (initialized after registration)
const client = mqtt.connect(config.mqtt.host, {
  username: config.mqtt.username,
  password: config.mqtt.password,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
});

client.on('connect', () => {
  console.log('[MQTT] Connected to broker');
  stats.mqttConnected = true;
  
  // Subscribe to configured MQTT topic (frigate/reviews by default)
  client.subscribe(config.mqtt.topic, (err) => {
    if (err) {
      console.error('[MQTT] Subscription error:', err);
    } else {
      console.log(`[MQTT] Subscribed to topic: ${config.mqtt.topic}`);
      
      // Log recommendation if using old events topic
      if (config.mqtt.topic === 'frigate/events') {
        console.log('[MQTT] Using frigate/events topic. Consider switching to frigate/reviews for better notification management.');
      }
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
    const payload = JSON.parse(message.toString());
    stats.eventsReceived++;
    stats.lastEventTime = new Date().toISOString();
    
    // Detect if this is a review or event message
    const isReview = topic.includes('reviews') || payload.severity !== undefined;
    
    if (isReview) {
      // Process frigate/reviews message (recommended)
      await processReviewMessage(payload);
    } else {
      // Process legacy frigate/events message (backwards compatibility)
      await processEventMessage(payload);
    }
    
  } catch (err) {
    console.error('[MQTT] Error processing message:', err.message);
  }
});

// Process frigate/reviews message (new format)
async function processReviewMessage(review) {
  // NOTIFICATION STRATEGY (ALERT-ONLY WITH PROGRESSIVE ENHANCEMENT):
  // 
  // Review lifecycle:
  //   'new' = Review created (thumb_path EXISTS - confirmed via MQTT testing)
  //   'update' = Severity changes, objects added, or better thumbnail
  //   'end' = Review complete (cleanup only)
  //
  // Behavior:
  //   - 'new' with severity=detection → Track silently (no notification)
  //   - 'new' with severity=alert → Send notification immediately ⚡
  //   - 'update' detection→alert → Send notification (escalation!)
  //   - 'update' alert (same severity, better image) → Update notification image
  //   - 'update' detection (same severity) → Update tracking silently
  //   - 'end' → Cleanup tracking data (notification persists on device)
  
  const reviewId = review.after?.id || review.id;
  const severity = review.after?.severity || review.severity;
  const thumbPath = review.after?.thumb_path || review.thumb_path;
  const messageType = review.type;
  const camera = review.after?.camera || review.camera;
  const startTime = review.after?.start_time || review.start_time;
  const objects = review.after?.data?.objects || review.data?.objects || [];
  const zones = review.after?.data?.zones || review.data?.zones || [];
  const detections = review.after?.data?.detections || review.data?.detections || [];
  
  // Get tracking data
  const tracking = sentNotifications.get(reviewId);
  
  // === HANDLE 'NEW' MESSAGES ===
  if (messageType === 'new') {
    
    // Apply filters before processing
    if (!applyReviewFilters(severity, camera, objects)) {
      // Still track even if filtered (might escalate later)
      if (severity === 'detection') {
        sentNotifications.set(reviewId, {
          severity,
          thumbPath,
          timestamp: Date.now(),
          notificationSent: false,
        });
      }
      return;
    }
    
    if (severity === 'alert') {
      // ALERT - Send notification immediately
      console.log(`[New Alert] Sending instant notification for ${reviewId}`);
      console.log(`[Review] ${severity.toUpperCase()} on ${camera}: ${objects.join(', ')}`);
      console.log(`[Review] thumb_path: ${thumbPath ? 'EXISTS' : 'MISSING'}`);
      
      await sendReviewNotification({
        reviewId,
        camera,
        severity,
        objects,
        zones,
        detections,
        thumbPath,
        startTime,
        isImageUpdate: false,
      });
      
      // Track as notified
      sentNotifications.set(reviewId, {
        severity,
        thumbPath,
        timestamp: Date.now(),
        notificationSent: true,
      });
      
    } else {
      // DETECTION - Track silently (might escalate to alert later)
      console.log(`[New Detection] Tracking ${reviewId} silently on ${camera}: ${objects.join(', ')} (no notification)`);
      
      sentNotifications.set(reviewId, {
        severity,
        thumbPath,
        timestamp: Date.now(),
        notificationSent: false,
      });
    }
    
    return;
  }
  
  // === HANDLE 'UPDATE' MESSAGES ===
  if (messageType === 'update') {
    
    // If no tracking, this is an orphaned update (shouldn't happen, but handle it)
    if (!tracking) {
      if (severity === 'alert' && applyReviewFilters(severity, camera, objects)) {
        console.log(`[Update] No tracking found for ${reviewId}, treating as new alert`);
        await sendReviewNotification({
          reviewId,
          camera,
          severity,
          objects,
          zones,
          detections,
          thumbPath,
          startTime,
          isImageUpdate: false,
        });
        sentNotifications.set(reviewId, {
          severity,
          thumbPath,
          timestamp: Date.now(),
          notificationSent: true,
        });
      }
      return;
    }
    
    const severityChanged = tracking.severity !== severity;
    const imageChanged = tracking.thumbPath !== thumbPath;
    
    // --- SCENARIO 1: SEVERITY ESCALATION (detection → alert) ---
    if (severityChanged && severity === 'alert') {
      // Apply filters for escalated alerts
      if (!applyReviewFilters(severity, camera, objects)) {
        console.log(`[Escalation] ${reviewId} escalated to alert but filtered out`);
        tracking.severity = severity;
        return;
      }
      
      console.log(`[Escalation] ${reviewId} escalated detection→alert, sending notification`);
      console.log(`[Review] ${severity.toUpperCase()} on ${camera}: ${objects.join(', ')}`);
      
      await sendReviewNotification({
        reviewId,
        camera,
        severity,
        objects,
        zones,
        detections,
        thumbPath,
        startTime,
        isImageUpdate: false,
      });
      
      tracking.severity = severity;
      tracking.thumbPath = thumbPath;
      tracking.timestamp = Date.now();
      tracking.notificationSent = true;
      return;
    }
    
    // --- SCENARIO 2: IMAGE IMPROVEMENT (alert level only) ---
    if (tracking.notificationSent && imageChanged && severity === 'alert') {
      console.log(`[Image Update] Enhancing notification image for ${reviewId}`);
      console.log(`[Review] Better thumbnail available for ${camera}`);
      
      await sendReviewNotification({
        reviewId,
        camera,
        severity,
        objects,
        zones,
        detections,
        thumbPath,
        startTime,
        isImageUpdate: true, // Flag for image-only update
      });
      
      tracking.thumbPath = thumbPath;
      return;
    }
    
    // --- SCENARIO 3: DETECTION LEVEL UPDATES (no notification) ---
    if (severity === 'detection') {
      if (imageChanged) {
        console.log(`[Silent Update] Detection ${reviewId} image updated (no notification)`);
        tracking.thumbPath = thumbPath;
      }
      return;
    }
    
    // --- SCENARIO 4: DOWNGRADE (alert → detection) - rare but possible ---
    if (severityChanged && severity === 'detection') {
      console.log(`[Downgrade] Alert downgraded to detection for ${reviewId}`);
      tracking.severity = severity;
      return;
    }
    
    return;
  }
  
  // === HANDLE 'END' MESSAGES - CLEANUP ONLY ===
  if (messageType === 'end') {
    if (tracking) {
      console.log(`[End] Review ${reviewId} completed (notified: ${tracking.notificationSent}), cleaning up tracking`);
      sentNotifications.delete(reviewId);
    }
    return;
  }
}

// Helper function to apply review filters
function applyReviewFilters(severity, camera, objects) {
  // Filter by severity (default: only alerts)
  if (bridgeConfig.notifications.severityFilter !== 'all') {
    if (severity !== bridgeConfig.notifications.severityFilter) {
      return false;
    }
  }
  
  // Filter by cameras if configured
  if (bridgeConfig.notifications.filterCameras.length > 0) {
    if (!bridgeConfig.notifications.filterCameras.includes(camera)) {
      return false;
    }
  }
  
  // Filter by labels if configured (check if any object matches)
  if (bridgeConfig.notifications.filterLabels.length > 0) {
    const hasMatchingLabel = objects.some(obj => bridgeConfig.notifications.filterLabels.includes(obj));
    if (!hasMatchingLabel) {
      return false;
    }
  }
  
  return true;
}

// Process legacy frigate/events message (old format - backwards compatibility)
async function processEventMessage(event) {
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
  
  // Send push notification (legacy format)
  await sendPushNotifications(event);
}

/**
 * Detect if token is FCM or Expo Push token
 */
function isFCMToken(token) {
  // Expo Push tokens start with "ExponentPushToken["
  // FCM tokens are long alphanumeric strings
  return !token.startsWith('ExponentPushToken[');
}

/**
 * Send FCM notification with authenticated image support
 */
async function sendFCMNotification(fcmToken, notificationData) {
  try {
    const { title, body, thumbnailUrl, jwtToken, camera, reviewId, eventId, timestamp, severity, isImageUpdate } = notificationData;

    // Create notification tag for update/replace behavior
    // Only alerts get notifications, so tag is always reviewId_alert
    const notificationTag = `review_${reviewId}_alert`;

    // Use Cloudflare Worker proxy (secure, recommended)
    if (!fcmAvailable || process.env.USE_LEGACY_FCM !== 'true') {
      if (isImageUpdate) {
        console.log(`[Proxy] Updating notification image via Cloudflare Worker proxy (tag: ${notificationTag})`);
      } else {
        console.log(`[Proxy] Sending notification via Cloudflare Worker proxy (tag: ${notificationTag})`);
      }
      
      const proxyPayload = {
        token: fcmToken,
        // DATA-ONLY message (no 'notification' field)
        // This ensures FrigateMessagingService.onMessageReceived() is ALWAYS called,
        // even when app is in background, so it can fetch authenticated images
        data: {
          title: title || 'Frigate Alert',
          body: body || 'Motion detected',
          thumbnailUrl: thumbnailUrl || '',
          jwtToken: jwtToken || '',
          camera: camera || '',
          reviewId: reviewId || '',
          eventId: eventId || '',
          timestamp: timestamp?.toString() || '',
          severity: severity || 'alert',
          notificationType: 'frigate_alert',
          notificationTag: notificationTag, // For Android grouping/replacing
        },
        android: {
          priority: 'high', // Always high for alerts
          notification: {
            channelId: 'frigate_alerts', // Android notification channel
            tag: notificationTag, // Same tag = replace existing notification
            sound: 'default',
          },
        },
        apns: {
          headers: {
            'apns-priority': '10', // Always high for alerts
            'apns-collapse-id': notificationTag, // iOS equivalent of Android tag
          },
          payload: {
            aps: {
              'mutable-content': 1,
              sound: 'default',
              category: 'FRIGATE_ALERT',
            },
          },
          fcm_options: {
            image: thumbnailUrl,
          },
        },
      };

      const response = await axios.post(NOTIFICATION_PROXY_URL, proxyPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${NOTIFICATION_PROXY_TOKEN}`,
        },
        timeout: 10000,
      });

      if (response.data.success) {
        console.log('[Proxy] Notification sent successfully:', response.data.messageId);
        return true;
      } else {
        console.error('[Proxy] Failed to send notification:', response.data.error);
        return false;
      }
    }

    // No direct FCM fallback - proxy is required
    console.error('[Notification] Proxy failed and no fallback configured');
    console.error('[Notification] Please ensure your Cloudflare Worker proxy is running');
    return false;

  } catch (error) {
    console.error('[Notification] Failed to send:', error.message);
    if (error.response) {
      console.error('[Notification] Response status:', error.response.status);
      console.error('[Notification] Response data:', error.response.data);
    }
    if (error.code === 'messaging/invalid-registration-token' || 
        error.code === 'messaging/registration-token-not-registered') {
      console.error('[Notification] Token is invalid or expired - device should re-register');
    }
    return false;
  }
}

/**
 * Send Expo Push notification (legacy, fallback)
 */
async function sendExpoPushNotification(expoToken, notificationData) {
  try {
    const { title, body, thumbnailUrl, camera, reviewId, eventId, timestamp, severity, isImageUpdate } = notificationData;

    const message = {
      to: expoToken,
      sound: 'default',
      title: title || 'Frigate Alert',
      body: body || 'Motion detected',
      priority: 'high', // Always high for alerts
      categoryId: 'frigate_alert',
      channelId: 'frigate_alerts', // Android notification channel
      data: {
        reviewId,
        camera,
        severity,
        timestamp,
        eventId,
        thumbnailUrl,
        type: 'frigate_alert',
        action: 'live',
      },
    };

    // Note: Expo Push cannot fetch authenticated images
    // This is why we're migrating to FCM
    if (thumbnailUrl) {
      message.image = thumbnailUrl; // Will fail with 401 for authenticated endpoints
    }

    const response = await axios.post(
      'https://exp.host/--/api/v2/push/send',
      [message],
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data && response.data.data && response.data.data[0]) {
      const result = response.data.data[0];
      if (result.status === 'ok') {
        console.log('[Expo] Message sent:', result.id);
        return true;
      } else {
        console.error('[Expo] Error:', result.message);
        return false;
      }
    }
  } catch (error) {
    console.error('[Expo] Failed to send:', error.message);
    return false;
  }
}

// Send push notifications for frigate/reviews (new format)
async function sendReviewNotification(review) {
  if (pushTokens.size === 0) {
    console.log('[Push] No registered tokens, skipping notification');
    return;
  }
  
  const { reviewId, camera, severity, objects, zones, detections, thumbPath, startTime, isImageUpdate = false } = review;
  
  // Format objects list for notification title
  const objectsList = objects.length > 0 ? objects.join(', ') : 'Activity';
  const capitalizedObjects = objectsList.split(', ').map(obj => 
    obj.charAt(0).toUpperCase() + obj.slice(1)
  ).join(', ');
  
  // Extract first event ID for deep linking and thumbnail fallback
  const firstEventId = detections.length > 0 ? detections[0] : null;
  
  // Build thumbnail URL - smart fallback strategy like Frigate PWA
  let thumbnailUrl = null;
  
  if (thumbPath && bridgeConfig.externalFrigateUrl) {
    // Option 1: Use review thumbnail path (webp) - best quality, shows all detected objects
    // Format: /media/frigate/clips/review/thumbnails/{reviewId}.webp
    const cleanPath = thumbPath.replace('/media/frigate', '');
    thumbnailUrl = `${bridgeConfig.externalFrigateUrl}${cleanPath}`;
    
    if (bridgeConfig.frigateJwtToken) {
      thumbnailUrl += `?token=${bridgeConfig.frigateJwtToken}`;
    }
    console.log(`[Push] Review thumbnail (webp): ${cleanPath}`);
  } else if (firstEventId && bridgeConfig.externalFrigateUrl) {
    // Option 2: Fallback to Events API (JPG) - reliable but lower quality than webp
    // Note: /api/notifications/ doesn't work, but /api/events/ does!
    thumbnailUrl = `${bridgeConfig.externalFrigateUrl}/api/events/${firstEventId}/thumbnail.jpg`;
    
    if (bridgeConfig.frigateJwtToken) {
      thumbnailUrl += `?token=${bridgeConfig.frigateJwtToken}`;
    }
    console.log(`[Push] Events API fallback (JPG) - event: ${firstEventId}`);
  } else {
    // No thumbnail available at all
    console.log(`[Push] No thumbnail available - thumb_path missing and no event IDs`);
    console.log(`[Push] Review ID: ${reviewId}, Detections: ${detections.length}`);
    console.log(`[Push] This notification will arrive WITHOUT an image`);
  }
  
  // Format camera name
  const formattedCamera = camera.replace(/_/g, ' ');
  
  // Helper function to format template with event data
  const formatTemplate = (template, eventData) => {
    return template
      .replace(/{label}/g, eventData.capitalizedLabel)
      .replace(/{camera}/g, eventData.cameraFormatted)
      .replace(/{zones}/g, eventData.zones || 'Unknown')
      .replace(/{time}/g, eventData.time)
      .replace(/{score}/g, eventData.scoreFormatted);
  };
  
  // Prepare data for template formatting
  const templateData = {
    capitalizedLabel: capitalizedObjects,
    cameraFormatted: formattedCamera,
    zones: zones.length > 0 ? zones.join(', ') : '',
    time: new Date(startTime * 1000).toLocaleTimeString(),
    scoreFormatted: '', // Review segments don't have scores
  };
  
  // IMPORTANT: Keep full URL with ?token= parameter for notification images
  // OS notification systems fetch images BEFORE app opens, so token must be in URL
  console.log(`[Push] Sending notification(s) for review ${reviewId} (${severity})`);
  console.log(`[Push] Registered devices: ${pushTokens.size}`);
  if (thumbnailUrl) {
    console.log(`[Push] Thumbnail URL (with auth): ${thumbnailUrl}`);
  }
  
  // Send to each registered device
  let fcmCount = 0;
  let expoCount = 0;
  let successCount = 0;
  
  for (const token of pushTokens) {
    try {
      // Get device-specific templates (or use defaults)
      const device = devices.get(token);
      const templates = device?.templates || {
        title: '{label} detected on {camera}',
        body: 'Motion in {zones} at {time}',
      };
      
      // Format title and body with templates
      const title = formatTemplate(templates.title, templateData);
      const body = formatTemplate(templates.body, templateData);
      
      console.log(`[Push] Device: ${device?.name || 'Unknown'} (${device?.platform || 'unknown'})`);
      console.log(`[Push]   Title: "${title}"`);
      console.log(`[Push]   Body: "${body}"`);
      
      // Prepare notification data
      const notificationData = {
        title,
        body,
        thumbnailUrl: thumbnailUrl, // Full URL with ?token= for OS to fetch image
        jwtToken: bridgeConfig.frigateJwtToken, // Also include JWT for app deep linking
        camera,
        reviewId,
        eventId: firstEventId,
        timestamp: startTime,
        severity,
        isImageUpdate, // Flag for progressive image enhancement
      };
      
      // Detect token type and send via appropriate service
      if (isFCMToken(token)) {
        console.log(`[Push]   Type: FCM`);
        fcmCount++;
        const success = await sendFCMNotification(token, notificationData);
        if (success) successCount++;
      } else {
        console.log(`[Push]   Type: Expo Push (legacy)`);
        expoCount++;
        const success = await sendExpoPushNotification(token, notificationData);
        if (success) successCount++;
      }
    } catch (error) {
      console.error(`[Push] Error sending to token:`, error.message);
    }
  }
  
  stats.notificationsSent += successCount;
  console.log(`[Push] Sent ${successCount}/${pushTokens.size} notifications (${fcmCount} FCM, ${expoCount} Expo)`);
}

// Send push notifications to all registered tokens (legacy frigate/events format)
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
  
  // Helper function to format template with event data
  const formatTemplate = (template, eventData) => {
    return template
      .replace(/{label}/g, eventData.capitalizedLabel)
      .replace(/{camera}/g, eventData.cameraFormatted)
      .replace(/{zones}/g, eventData.zones || 'Unknown')
      .replace(/{time}/g, eventData.time)
      .replace(/{score}/g, eventData.scoreFormatted);
  };
  
  // Prepare data for template formatting
  const templateData = {
    capitalizedLabel: capitalizedLabel,
    cameraFormatted: camera.replace(/_/g, ' '),
    zones: event.after?.current_zones?.join(', ') || '',
    time: new Date(startTime * 1000).toLocaleTimeString(),
    scoreFormatted: event.after?.score ? `${Math.round(event.after.score * 100)}%` : '',
  };
  
  // Prepare notification messages for all tokens (with per-device templates)
  const messages = Array.from(pushTokens).map(token => {
    // Get device-specific templates (or use defaults)
    const device = devices.get(token);
    const templates = device?.templates || {
      title: '{label} detected on {camera}',
      body: 'Motion in {zones} at {time}',
    };
    
    const message = {
      to: token,
      sound: 'default',
      title: formatTemplate(templates.title, templateData),
      body: formatTemplate(templates.body, templateData),
      priority: 'high',
      categoryId: 'frigate_detection', // For iOS notification categories
      data: {
        eventId: eventId,
        camera: camera,
        label: label,
        score: event.after?.score,
        thumbnailUrl: thumbnailUrl,
        timestamp: startTime, // Send Unix timestamp for local formatting
        type: 'frigate_detection',
        action: 'live', // Default action when tapped
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
    
    // Add action buttons (Android & iOS)
    // Android automatically shows actions from data
    // iOS requires notification categories to be registered in the app
    message.android = {
      sound: 'default',
      priority: 'high',
      channelId: 'frigate-detections',
    };
    
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
