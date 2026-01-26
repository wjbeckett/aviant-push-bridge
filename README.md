# Aviant Push Bridge

MQTT to Expo Push notification bridge for the Aviant Frigate mobile app.

## What It Does

- Subscribes to your Frigate MQTT broker
- Listens for detection events (person, car, etc.)
- Sends push notifications to your Aviant mobile app
- Prevents notification spam with configurable cooldown
- Filters by camera and object labels

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Frigate with MQTT configured
- Aviant mobile app installed

### Installation (Super Simple - 3 Steps!)

#### 1. Download docker-compose.yml

```bash
wget https://raw.githubusercontent.com/your-username/aviant-push-bridge/main/docker-compose.yml
# Or create manually from the template
```

#### 2. Configure MQTT Connection

**Edit docker-compose.yml** - Only MQTT settings are required:

```yaml
environment:
  # REQUIRED: Your MQTT broker details
  - MQTT_HOST=mqtt://192.168.1.100:1883
  - MQTT_USERNAME=your_mqtt_user  # Leave empty if no auth
  - MQTT_PASSWORD=your_mqtt_pass  # Leave empty if no auth
  - MQTT_TOPIC=frigate/reviews     # Recommended (use frigate/events for legacy)
  
  # OPTIONAL: Fine-tuning (defaults shown)
  - BRIDGE_PORT=3002
  - NOTIFICATION_COOLDOWN=30
  - SEVERITY_FILTER=alert          # 'alert', 'detection', or 'all'
  - FILTER_LABELS=                 # Leave empty for all labels
  - FILTER_CAMERAS=                # Leave empty for all cameras
```

**Common MQTT broker locations:**
- Home Assistant: `mqtt://homeassistant.local:1883`
- Standalone Mosquitto: `mqtt://192.168.1.X:1883`
- Same host as bridge: `mqtt://localhost:1883`

**Note:** You do NOT need to configure:
- ~~`FRIGATE_URL`~~ - Auto-configured by app
- ~~`EXTERNAL_FRIGATE_URL`~~ - Auto-configured by app
- ~~`FRIGATE_JWT_TOKEN`~~ - Auto-configured by app

The mobile app automatically sends these when you register!

#### 3. Start the Bridge

```bash
docker compose up -d
```

**Check it's running:**

```bash
# View logs
docker compose logs -f

# Check health endpoint
curl http://localhost:3002/health
```

You should see:
```
✓ Bridge listening on port 3002
✓ MQTT connected to mqtt://192.168.1.100:1883
✓ Subscribed to frigate/events
```

### Register Your Phone (Auto-Configuration Magic!)

**In the Aviant mobile app:**

1. Open **Settings → Notifications**
2. Select **"Local Bridge"** method
3. Enter Bridge URL: `http://YOUR_SERVER_IP:3002`
4. Tap **"Register Device"**

**What happens automatically:**
- ✓ App sends your push token to bridge
- ✓ App sends your Frigate JWT token (from login)
- ✓ App sends your external Frigate URL (for thumbnails)
- ✓ Bridge stores everything in `./data/config.json`
- ✓ Configuration Status shows "Ready" and "Configured"

**Done!** You'll now receive push notifications when Frigate detects activity

#### Option 2: Build Locally (Development)

1. **Clone the repository:**

```bash
git clone https://github.com/your-username/aviant-push-bridge.git
cd aviant-push-bridge
```

2. **Configure environment:**

```bash
cp .env.example .env
nano .env  # Edit with your MQTT settings
```

3. **Build and run:**

```bash
# Using development docker-compose
docker compose -f docker-compose.dev.yml up -d

# Or build directly
docker build -t aviant-push-bridge .
docker run -d --env-file .env -p 3002:3002 aviant-push-bridge
```

## Configuration Options

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **MQTT Configuration** ||||
| `MQTT_HOST` | ✅ Yes | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_USERNAME` | No | - | MQTT username (if broker requires auth) |
| `MQTT_PASSWORD` | No | - | MQTT password (if broker requires auth) |
| `MQTT_TOPIC` | No | `frigate/reviews` | MQTT topic to subscribe to. Use `frigate/reviews` (recommended) for consolidated alerts, or `frigate/events` for individual object tracking (verbose). |
| **Bridge Settings** ||||
| `BRIDGE_PORT` | No | `3002` | HTTP server port |
| `NOTIFICATION_COOLDOWN` | No | `30` | Seconds between notifications per camera |
| **Notification Filters** ||||
| `SEVERITY_FILTER` | No | `alert` | Filter by review severity: `alert` (only alerts), `detection` (only detections), or `all` (everything). Only applies to `frigate/reviews` topic. |
| `FILTER_LABELS` | No | - | Comma-separated labels (e.g., `person,car,dog`). Leave empty for all. |
| `FILTER_CAMERAS` | No | - | Comma-separated cameras (e.g., `driveway,backyard`). Leave empty for all. |
| **Auto-Configured by App** ||||
| `FRIGATE_JWT_TOKEN` | 🤖 Auto | - | **Sent automatically by app** when you register. Can manually override if needed. |
| `EXTERNAL_FRIGATE_URL` | 🤖 Auto | - | **Sent automatically by app** from your Frigate server URL. Used for notification thumbnails. |
| `FRIGATE_URL` | 🤖 Auto | `http://localhost:5000` | **Sent automatically by app**. Internal Frigate URL (usually same as external). |

**Note:** Variables marked with 🤖 are automatically configured by the Aviant mobile app when you register your device. The app sends your Frigate credentials from your login session, so you don't need to copy/paste JWT tokens manually!

### MQTT Topic: Events vs Reviews

**Recommended: `frigate/reviews`** (Default)
- ✅ Consolidated notifications (groups related objects)
- ✅ Severity filtering (`alert` vs `detection`)
- ✅ Less spam (one notification for complex activities)
- ✅ Aligns with Frigate UI behavior
- Example: Person exits car = **1 notification** with both objects

**Legacy: `frigate/events`**
- ❌ Very verbose (separate notification per object)
- ❌ No severity levels
- ❌ Multiple messages for same activity (`new`, `update`, `end`)
- Example: Person exits car = **2 notifications** (car, then person)

**When to use `frigate/events`:**
- You need granular per-object tracking
- You want notifications for every object state change
- You have custom filtering logic

### Severity Filter Examples

**Default (Alerts only - Recommended):**
```yaml
- SEVERITY_FILTER=alert
```
Only sends notifications for:
- Objects configured as alerts in Frigate (person, car by default)
- Objects detected in alert zones
- High-priority events

**All detections (Spammy):**
```yaml
- SEVERITY_FILTER=all
```
Sends notifications for everything (not recommended - very noisy).

**Detections only:**
```yaml
- SEVERITY_FILTER=detection
```
Only sends notifications for low-priority detections (animals, general activity).

### Object/Camera Filter Examples

**Only person and car detections:**
```yaml
- FILTER_LABELS=person,car
```

**Only specific cameras:**
```yaml
- FILTER_CAMERAS=front_door,driveway
```

**Combine filters:**
```yaml
- SEVERITY_FILTER=alert
- FILTER_LABELS=person
- FILTER_CAMERAS=front_door,back_door
```
Result: Only person alerts on front/back doors.

## Notification Features

### Custom Notification Templates

Customize notification content per-device using template variables.

**Configure in Aviant app:**
1. Settings → Notification Templates
2. Edit title and body templates
3. Use variables: `{label}`, `{camera}`, `{zones}`, `{time}`, `{score}`
4. Save to sync with bridge

**Default templates:**
- Title: `{label} detected on {camera}`
- Body: `Motion in {zones} at {time}`

**Example customizations:**
- `🚨 {label} on {camera}` → "🚨 Person on Front Door"
- `{camera}: {label} detected ({score})` → "Front Door: Person detected (95%)"
- `Motion in {zones} at {time}` → "Motion in Driveway, Sidewalk at 2:45 PM"

Templates can be updated anytime after device registration - no need to re-register!

### Deep Linking & Notification Actions

**Default tap behavior:** Opens live view of the camera that triggered the alert.

**Action buttons:**
- **"View Live"** → Opens live stream of the camera
- **"View Recording"** → Opens timeline at exact detection time

**Platform support:**
- Android: Up to 3 action buttons
- iOS: Up to 4 actions

**How it works:**
- Tap notification → App opens to live camera view
- Tap "View Recording" button → App opens timeline at detection moment
- All navigation is automatic - no manual searching required!

**Deep link format:**
```
aviant://camera/{cameraName}?action=live|timeline&time={timestamp}
```

You can also use deep links from other automation tools (Home Assistant, Tasker, etc.).

### Notification Image Attachments ✅

**Images ARE included in OS notifications!**

The bridge automatically includes thumbnail images in notifications using Frigate's event API:

**How it works:**
1. Reviews contain a list of event IDs (tracked objects)
2. Bridge uses first event ID to fetch thumbnail: `/api/events/:event_id/thumbnail.jpg`
3. JWT token authentication via `?token=` query parameter
4. Expo's servers fetch the image from your public Frigate URL
5. Notification displays with image preview

**Requirements:**
- ✅ Frigate accessible via HTTPS (you already have this)
- ✅ JWT token authentication (configured automatically by app)
- ✅ Snapshots enabled in Frigate (default)

**What you get:**
- ✅ Thumbnail images in OS notifications
- ✅ Custom notification templates
- ✅ Action buttons (View Live / View Recording)
- ✅ Deep linking to camera/timeline
- ✅ Secure (JWT token authentication)

**See detailed explanation:** [NOTIFICATION_IMAGES_SOLUTION.md](NOTIFICATION_IMAGES_SOLUTION.md)
## API Endpoints

All endpoints are automatically called by the Aviant mobile app. Manual usage is optional.

### Health Check
```bash
GET http://localhost:3002/health
```

Returns bridge status, uptime, registered tokens, and configuration status.

**Response:**
```json
{
  "status": "healthy",
  "uptime": 86400,
  "registeredTokens": 2,
  "mqttConnected": true,
  "configured": {
    "frigateToken": true,
    "externalUrl": true
  }
}
```

### Register Device & Auto-Configure
```bash
POST http://localhost:3002/register
Content-Type: application/json

{
  "pushToken": "ExponentPushToken[xxxxxxxxxxxxxx]",
  "deviceId": "unique-device-id",
  "deviceName": "John's iPhone",
  "frigateUrl": "https://cctv.example.com",
  "frigateToken": "eyJhbGc...",
  "platform": "ios"
}
```

**Automatically called by Aviant app** when you tap "Register Device".

This single endpoint:
1. Registers your push token
2. Auto-configures Frigate credentials (JWT token)
3. Auto-configures external URL for thumbnails
4. Stores everything in `./data/config.json`
5. Syncs custom notification templates (if configured)

### Update Device Preferences (Templates)
```bash
PUT http://localhost:3002/devices/:token/preferences
Content-Type: application/json

{
  "templates": {
    "title": "{label} detected on {camera}",
    "body": "Motion in {zones} at {time}"
  }
}
```

**Automatically called by Aviant app** when you customize notification templates in Settings → Notification Templates.

**Available template variables:**
- `{label}` - Detected object (person, car, dog, etc.)
- `{camera}` - Camera name
- `{zones}` - Zone names (comma-separated)
- `{time}` - Time of detection
- `{score}` - Detection confidence score

**Example custom templates:**
```json
{
  "title": "🚨 {label} on {camera}",
  "body": "Detected in {zones} with {score} confidence"
}
```

Templates are stored per-device and can be updated anytime after registration without re-registering.

### Sync Configuration (Auto)
```bash
POST http://localhost:3002/configure
Content-Type: application/json

{
  "frigateUrl": "https://cctv.example.com",
  "frigateToken": "eyJhbGc...",
  "externalFrigateUrl": "https://cctv.example.com"
}
```

**Automatically called by Aviant app** during registration. You can also call manually to update credentials without re-registering.

### Check Configuration Status
```bash
GET http://localhost:3002/config/status
```

Returns which credentials are configured:
```json
{
  "frigateTokenConfigured": true,
  "externalFrigateUrlConfigured": true
}
```

### Unregister Push Token
```bash
POST http://localhost:3002/unregister
Content-Type: application/json

{
  "pushToken": "ExponentPushToken[xxxxxxxxxxxxxx]"
}
```

### List Registered Tokens (Debug)
```bash
GET http://localhost:3002/tokens
```

Shows all registered devices (useful for debugging).

## Troubleshooting

### No notifications received

1. **Check bridge is running:**
   ```bash
   docker compose ps
   ```

2. **Check MQTT connection:**
   ```bash
   docker compose logs | grep MQTT
   ```
   Should see: `[MQTT] Connected to broker`

3. **Check push token is registered:**
   ```bash
   curl http://localhost:3002/health
   ```
   Look for `"registeredTokens": 1` (or more)

4. **Test with manual event:**
   Trigger a detection in Frigate and check bridge logs:
   ```bash
   docker compose logs -f
   ```

### MQTT connection failed

- Verify MQTT broker IP/hostname
- Check MQTT credentials (username/password)
- Ensure port 1883 is accessible
- If using Home Assistant, create dedicated MQTT user

### Bridge restarts constantly

```bash
docker compose logs
```

Look for error messages. Common issues:
- Invalid MQTT_HOST format (must be `mqtt://host:port`)
- MQTT broker not reachable
- Authentication failure

## Running Without Docker

```bash
# Install dependencies
npm install

# Copy and configure .env
cp .env.example .env
nano .env

# Start bridge
npm start
```

## Integration with Home Assistant

If you're using Home Assistant with Frigate:

1. **Use HA's MQTT broker:**
   ```yaml
   - MQTT_HOST=mqtt://homeassistant.local:1883
   ```

2. **Create MQTT user in HA:**
   - Settings → Devices & Services → MQTT → Configure
   - Add user for bridge

3. **Optional: Add as HA add-on:**
   The bridge can be packaged as a Home Assistant add-on for easier installation.

## Updates

### Using Pre-Built Image

```bash
# Pull latest image
docker compose pull

# Restart with new image
docker compose down
docker compose up -d
```

### Version Pinning (Recommended for Production)

Instead of `latest`, pin to a specific version:

```yaml
# docker-compose.yml
image: ghcr.io/your-username/aviant-push-bridge:v1.0.0
```

Available versions: https://github.com/your-username/aviant-push-bridge/pkgs/container/aviant-push-bridge

### Building from Source

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml up -d --build
```

### Checking Current Version

```bash
# View image info
docker inspect aviant-push-bridge | grep -A 5 Labels

# Check logs for startup message
docker compose logs | grep version
```

## Uninstall

```bash
# Stop and remove container
docker compose down

# Remove image
docker rmi aviant-push-bridge
```

## External Access & Security

### Deployment Scenarios

#### Option 1: Local Network Only (No Setup Needed)
- Bridge URL: `http://192.168.1.X:3002`
- **Works:** Only on home WiFi
- **Security:** Fully private, no exposure
- **Limitation:** Can't register devices when away from home

#### Option 2: Tailscale (Recommended ⭐)
- Install Tailscale on bridge server and phone
- Bridge URL: `http://100.64.X.X:3002` (Tailscale IP)
- **Works:** Anywhere with Tailscale connected
- **Security:** Encrypted mesh VPN
- **Free:** Up to 100 devices

```bash
# Install on bridge server
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Get Tailscale IP
tailscale ip -4
```

#### Option 3: Reverse Proxy (Public Exposure)

**⚠️ Enable authentication when exposing publicly!**

Add to `docker-compose.yml`:
```yaml
environment:
  - AUTH_TOKEN=your_secure_random_token_here
```

Generate secure token:
```bash
openssl rand -hex 32
```

Then configure reverse proxy (nginx example):
```nginx
server {
    listen 443 ssl;
    server_name push.yourdomain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

In Aviant app:
- Bridge URL: `https://push.yourdomain.com`
- Auth Token: Enter the `AUTH_TOKEN` value

#### Option 4: Cloudflare Tunnel
- No port forwarding required
- Free SSL certificate
- DDoS protection included
- **Still recommended:** Enable `AUTH_TOKEN`

```bash
# Install cloudflared
cloudflared tunnel create aviant-push
cloudflared tunnel route dns aviant-push push.yourdomain.com

# Add to cloudflared config
cloudflared tunnel --url http://localhost:3002
```

### Authentication Details

When `AUTH_TOKEN` is set in the bridge:
- `/health` endpoint remains public (no auth required)
- `/register`, `/unregister`, `/tokens` require auth
- App automatically sends token in `Authorization: Bearer <token>` header
- Invalid/missing token returns `401 Unauthorized`

## Privacy & Security

- **No data stored:** Push tokens are kept in memory only (use Redis for persistence)
- **Local processing:** Bridge runs on your network (no cloud dependency)
- **Direct to Expo:** Notifications go directly to Expo Push API
- **Minimal data:** Only event metadata is sent (no video/images)
- **Optional auth:** Enable `AUTH_TOKEN` for public deployments
- **HTTPS recommended:** Use reverse proxy with SSL for external access

## Support

For issues or questions:
- Check Aviant app documentation
- Review Frigate MQTT documentation: https://docs.frigate.video/integrations/mqtt/
- Verify MQTT broker is working with other clients (MQTT Explorer, etc.)

## License

MIT
