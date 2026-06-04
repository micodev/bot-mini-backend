#!/bin/bash

# Navigate to the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$DIR"

echo "Starting backend..."
echo "The server will automatically use HTTPS if the Let's Encrypt certificates are present at:"
echo "  - /etc/letsencrypt/live/ibrahim-api.duckdns.org/privkey.pem"
echo "  - /etc/letsencrypt/live/ibrahim-api.duckdns.org/fullchain.pem"
echo ""

# Run the node server
# Assuming you want to run it via Node directly.
# If you use PM2 or another process manager, you can update this line accordingly.
node server.js
