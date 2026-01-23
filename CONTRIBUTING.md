# Contributing to Aviant Push Bridge

## Development Setup

### Prerequisites
- Node.js 18+ and npm
- Docker and Docker Compose
- Git

### Local Development

1. **Clone the repository:**
```bash
git clone https://github.com/your-username/aviant-push-bridge.git
cd aviant-push-bridge
```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your MQTT broker details
```

4. **Run locally (without Docker):**
```bash
npm start
# Or with auto-reload:
npm run dev
```

5. **Run with Docker:**
```bash
docker compose -f docker-compose.dev.yml up
```

## Testing

### Manual Testing

1. **Check bridge is running:**
```bash
curl http://localhost:3002/health
```

2. **Register a test push token:**
```bash
curl -X POST http://localhost:3002/register \
  -H "Content-Type: application/json" \
  -d '{"pushToken": "ExponentPushToken[test-token-here]"}'
```

3. **Trigger a test MQTT event:**
```bash
# Using mosquitto_pub
mosquitto_pub -h localhost -t "frigate/events" \
  -m '{"type":"new","after":{"label":"person","camera":"test","score":0.9}}'
```

### Testing with Aviant App

1. Build and run the bridge locally
2. Open Aviant app on your phone (must be on same WiFi)
3. Go to Settings → Notifications
4. Enter bridge URL: `http://YOUR_LOCAL_IP:3002`
5. Tap "Register Device"
6. Trigger a detection in Frigate
7. Verify notification appears on phone

## Docker Image Build Process

### Multi-Architecture Builds

The GitHub Actions workflow builds images for:
- `linux/amd64` (x86_64 servers, most common)
- `linux/arm64` (Raspberry Pi 4, Apple Silicon)
- `linux/arm/v7` (Raspberry Pi 3, older ARM boards)

### Build Triggers

Images are automatically built on:
1. **Push to main branch** → `latest` tag
2. **Version tags** (e.g., `v1.0.0`) → Multiple tags:
   - `1.0.0`
   - `1.0`
   - `1`
   - `latest`
3. **Pull requests** → Test build only (not pushed)

### Manual Build

To build locally for testing:

```bash
# Single architecture (current platform)
docker build -t aviant-push-bridge:test .

# Multi-architecture (requires buildx)
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t aviant-push-bridge:test \
  --load \
  .
```

## Release Process

### Creating a New Release

1. **Update version in package.json:**
```bash
npm version patch  # 1.0.0 → 1.0.1
# or
npm version minor  # 1.0.0 → 1.1.0
# or
npm version major  # 1.0.0 → 2.0.0
```

2. **Update CHANGELOG.md** with changes:
```markdown
## [1.1.0] - 2026-01-23
### Added
- New feature X
- New feature Y

### Fixed
- Bug fix Z
```

3. **Commit and tag:**
```bash
git add package.json CHANGELOG.md
git commit -m "Release v1.1.0"
git tag v1.1.0
git push origin main --tags
```

4. **GitHub Actions will automatically:**
   - Build Docker images for all architectures
   - Tag with version number
   - Push to GitHub Container Registry
   - Create GitHub release draft

5. **Edit the release on GitHub:**
   - Go to https://github.com/your-username/aviant-push-bridge/releases
   - Edit the draft release
   - Add release notes from CHANGELOG
   - Publish release

### Version Numbering

Follow [Semantic Versioning](https://semver.org/):
- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.0.0 → 1.1.0): New features (backward compatible)
- **PATCH** (1.0.0 → 1.0.1): Bug fixes (backward compatible)

## GitHub Actions Setup

### Required Secrets

No secrets needed! The workflow uses `GITHUB_TOKEN` which is automatically provided.

### Workflow Configuration

The workflow is located at `.github/workflows/docker-publish.yml`

**Key features:**
- Multi-architecture builds (amd64, arm64, armv7)
- Build caching for faster builds
- Automatic tagging based on git tags
- Attestation for supply chain security
- Only pushes on main branch and tags (not PRs)

### Monitoring Builds

1. **Check workflow runs:**
   - https://github.com/your-username/aviant-push-bridge/actions

2. **View published images:**
   - https://github.com/your-username/aviant-push-bridge/pkgs/container/aviant-push-bridge

3. **Build time:** Typically 3-5 minutes for all architectures

## Making a Contribution

### Pull Request Process

1. **Fork the repository**

2. **Create a feature branch:**
```bash
git checkout -b feature/your-feature-name
```

3. **Make your changes and commit:**
```bash
git add .
git commit -m "feat: add your feature"
```

Commit message format:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance tasks

4. **Push to your fork:**
```bash
git push origin feature/your-feature-name
```

5. **Create a Pull Request:**
   - Go to the original repository
   - Click "New Pull Request"
   - Select your fork and branch
   - Fill in the PR template

6. **Wait for review:**
   - GitHub Actions will automatically test your build
   - Maintainers will review your code
   - Address any feedback

### Code Style

- Use 2 spaces for indentation
- Use semicolons
- Use single quotes for strings
- Add comments for complex logic
- Follow existing code patterns

### Commit Guidelines

- Keep commits focused on a single change
- Write clear commit messages
- Reference issue numbers if applicable (`fix #123`)

## Troubleshooting Development

### Docker build fails

```bash
# Clear Docker cache
docker system prune -a

# Rebuild without cache
docker build --no-cache -t aviant-push-bridge .
```

### MQTT connection fails in development

- Check MQTT_HOST in .env
- Verify MQTT broker is accessible: `nc -zv mqtt-host 1883`
- Check MQTT credentials
- Review broker logs

### Push notifications not sending

- Check Expo Push token format: `ExponentPushToken[...]`
- Verify token is registered: `curl http://localhost:3002/tokens`
- Check bridge logs for errors
- Test with Expo's push tool: https://expo.dev/notifications

## Resources

- [Expo Push Notifications](https://docs.expo.dev/push-notifications/overview/)
- [MQTT Protocol](https://mqtt.org/)
- [Frigate MQTT Events](https://docs.frigate.video/integrations/mqtt/)
- [Docker Multi-Platform Builds](https://docs.docker.com/build/building/multi-platform/)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.