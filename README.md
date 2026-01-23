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

### Installation

#### Option 1: Using Pre-Built Image (Recommended)

1. **Download docker-compose.yml:**

```bash
wget https://raw.githubusercontent.com/wjbeckett/aviant-push-bridge/main/docker-compose.yml
# Or create manually with the configuration below
```

2. **Edit `docker-compose.yml`:**

Configure MQTT connection:
```yaml
environment:
  - MQTT_HOST=mqtt://192.168.1.100:1883
  - MQTT_USERNAME=your_mqtt_user  # If MQTT requires auth
  - MQTT_PASSWORD=your_mqtt_pass  # If MQTT requires auth
```

Common MQTT broker locations:
- Home Assistant: `mqtt://homeassistant.local:1883`
- Standalone Mosquitto: `mqtt://192.168.1.X:1883`
- Same host as bridge: `mqtt://localhost:1883`

1. **Start the bridge:**

```bash
docker compose up -d
```

The image will be automatically pulled from GitHub Container Registry.

4. **Check status:**

```bash
# View logs
docker compose logs -f

# Check health
curl http://localhost:3002/health
```

5. **Register your phone in Aviant app:**

- Open Aviant app
- Go to Settings → Notifications
- Select "Local Bridge"
- Enter Bridge URL: `http://YOUR_SERVER_IP:3002`
- Tap "Register Device"
- Your push token will be sent to the bridge

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

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_HOST` | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_USERNAME` | - | MQTT username (if required) |
| `MQTT_PASSWORD` | - | MQTT password (if required) |
| `MQTT_TOPIC` | `frigate/events` | MQTT topic to subscribe to |
| `BRIDGE_PORT` | `3002` | HTTP server port |
| `NOTIFICATION_COOLDOWN` | `30` | Seconds between notifications per camera |
| `FILTER_LABELS` | - | Comma-separated labels (e.g., `person,car,dog`) |
| `FILTER_CAMERAS` | - | Comma-separated cameras (e.g., `driveway,backyard`) |
| `AUTH_TOKEN` | - | Optional API authentication token (recommended for public exposure) |

### Filtering Examples

**Only person and car detections:**
```yaml
- FILTER_LABELS=person,car
```

**Only specific cameras:**
```yaml
- FILTER_CAMERAS=front_door,driveway
```

**Combine both:**
```yaml
- FILTER_LABELS=person
- FILTER_CAMERAS=front_door,back_door
```

## API Endpoints

### Health Check
```bash
GET http://localhost:3002/health
```

Returns bridge status, uptime, and statistics.

### Register Push Token
```bash
POST http://localhost:3002/register
Content-Type: application/json

{
  "pushToken": "ExponentPushToken[xxxxxxxxxxxxxx]"
}
```

Automatically called by Aviant app.

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

## License

MIT
