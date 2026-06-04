#!/bin/bash

# Ensure the script is run with sudo
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script with sudo."
  exit 1
fi

# Configuration
SERVICE_NAME="bot-backend"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Use the current directory as the working directory
# We assume this script is run from inside the backend directory.
APP_DIR="$( pwd )"
USER_NAME=$SUDO_USER
if [ -z "$USER_NAME" ]; then
    USER_NAME=$(whoami)
fi

echo "Creating systemd service file at ${SERVICE_FILE}..."

# Create the systemd service configuration
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=Bot Mini App Backend (HTTPS)
After=network.target

[Service]
Type=simple
# Run as the current user, or change to root if needed to bind to port 443
User=root
WorkingDirectory=${APP_DIR}
Environment=PORT=443
Environment=NODE_ENV=production
# If node is not in standard PATH, you might need to provide the full path like /usr/bin/node
ExecStart=$(command -v node || echo "/usr/bin/node") server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling and starting the service..."
systemctl enable ${SERVICE_NAME}
systemctl start ${SERVICE_NAME}

echo "=========================================================="
echo "Service setup complete!"
echo ""
echo "You can now manage the server using:"
echo "  sudo systemctl start ${SERVICE_NAME}"
echo "  sudo systemctl stop ${SERVICE_NAME}"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo ""
echo "To view the logs in real-time, run:"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "=========================================================="
