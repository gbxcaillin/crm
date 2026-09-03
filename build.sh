#!/usr/bin/env sh
# Wraps wireframe.html (artifact source, no <html>/<head>) into a full
# installable document at index.html, and renders PNG icons from the SVGs.
set -e
cd "$(dirname "$0")"

cat > index.html <<'EOF'
<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0A0A0A" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#FFFDF8" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="light dark">
<meta name="application-name" content="GBX Pipeline">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="GBX">
<meta name="description" content="GBX Professional Services CRM">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
</head>
<body>
EOF
cat wireframe.html >> index.html
cat >> index.html <<'EOF'
</body>
</html>
EOF
echo "index.html built ($(wc -c < index.html) bytes)"

# PNG icons (needs playwright-core + a Chromium binary; skipped if unavailable)
if [ -n "$CHROME_BIN" ] && [ -d node_modules/playwright-core ]; then
  node icons/render.mjs && echo "icons rendered"
else
  echo "icons: set CHROME_BIN and install playwright-core to re-render PNGs (committed PNGs are used otherwise)"
fi
