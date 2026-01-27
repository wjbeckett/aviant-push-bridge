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
| `MQTT_HOST` | Yes | `mqtt://localhost:1883` | MQTT broker URL |
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
## License

MIT
