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
wget https://raw.githubusercontent.com/your-username/aviant-push-bridge/main/docker-compose.yml
# Or create manually with the configuration below
```

2. **Edit `docker-compose.yml`:**

Update the image URL (replace `your-username` with the actual GitHub username):
```yaml
image: ghcr.io/your-username/aviant-push-bridge:latest
```

Configure MQTT and Frigate connection:
```yaml
environment:
  - MQTT_HOST=mqtt://192.168.1.100:1883
  - MQTT_USERNAME=your_mqtt_user  # If MQTT requires auth
  - MQTT_PASSWORD=your_mqtt_pass  # If MQTT requires auth
  - FRIGATE_URL=http://192.168.1.100:5000  # Your Frigate server URL
```

Common MQTT broker locations:
- Home Assistant: `mqtt://homeassistant.local:1883`
- Standalone Mosquitto: `mqtt://192.168.1.X:1883`
- Same host as bridge: `mqtt://localhost:1883`

3. **Start the bridge:**

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
| `FRIGATE_URL` | `http://localhost:5000` | Frigate server URL (for thumbnail images) |
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
