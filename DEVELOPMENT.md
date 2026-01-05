# Development Setup for Camera Access

## Camera Access Requirements

Browsers require a **secure context** (HTTPS) to access the camera. In development, you have a few options:

### Option 1: Use Localhost (Recommended - Easiest)

The camera works on `localhost` or `127.0.0.1` without HTTPS:

```bash
npm run dev
```

Then access: `http://localhost:3000`

### Option 2: Enable HTTPS in Development

If you need to test on a different hostname or want HTTPS:

#### Using mkcert (Recommended)

1. Install mkcert:
   ```bash
   # Windows (using Chocolatey)
   choco install mkcert
   
   # macOS
   brew install mkcert
   
   # Linux
   sudo apt install libnss3-tools
   wget -O mkcert https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-linux-amd64
   chmod +x mkcert
   sudo mv mkcert /usr/local/bin/
   ```

2. Create local CA and certificate:
   ```bash
   mkcert -install
   mkcert localhost 127.0.0.1 ::1
   ```

3. Update `next.config.js` to use HTTPS (requires custom server)

#### Using Next.js with HTTPS

Create a custom server file `server.js`:

```javascript
const { createServer } = require('https');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'localhost.pem')),
};

app.prepare().then(() => {
  createServer(httpsOptions, (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(3000, (err) => {
    if (err) throw err;
    console.log('> Ready on https://localhost:3000');
  });
});
```

Then run: `node server.js`

### Option 3: Use ngrok or similar tunnel

For testing on mobile devices:

```bash
# Install ngrok
npm install -g ngrok

# Start Next.js dev server
npm run dev

# In another terminal, create tunnel
ngrok http 3000
```

Use the HTTPS URL provided by ngrok.

## Browser Permissions

If the camera is blocked:

1. **Chrome/Edge**: Click the lock icon in the address bar → Site settings → Camera → Allow
2. **Firefox**: Click the lock icon → Permissions → Camera → Allow
3. **Safari**: Safari → Settings → Websites → Camera → Allow for localhost

## Troubleshooting

- **"Camera requires secure connection"**: Use localhost or enable HTTPS
- **"Permission denied"**: Check browser settings and allow camera access
- **"Camera not found"**: Ensure your device has a camera and it's not being used by another app
- **Camera works but capture doesn't**: Check browser console for errors

## Testing on Mobile

For testing on a physical mobile device:

1. Find your computer's local IP address:
   ```bash
   # Windows
   ipconfig
   
   # macOS/Linux
   ifconfig
   ```

2. Access from mobile: `http://YOUR_IP:3000`
   - Note: This may still show "not secure" - use ngrok or HTTPS for best results

3. Or use ngrok for a secure tunnel:
   ```bash
   ngrok http 3000
   ```

