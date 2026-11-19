#!/usr/bin/env bash
# ========================================================
#  Pig Monitoring - Raspberry Pi installer
#  Run from this folder:   bash install.sh
#  Needs Raspberry Pi OS 64-bit (Bookworm or newer)
#  Safe to run again after updating app.py.
# ========================================================
set -e

PI_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
NEED_REBOOT=0

echo "==> Folder: $PI_DIR   User: $RUN_USER"

if [ "$(uname -m)" != "aarch64" ]; then
  echo "!! This Pi is not running the 64-bit OS ($(uname -m))."
  echo "!! onnxruntime needs Raspberry Pi OS 64-bit. Reflash with the 64-bit image."
  exit 1
fi

echo "==> Installing system packages"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip python3-gpiozero python3-lgpio alsa-utils i2c-tools

echo "==> Turning on I2C (temp sensor), I2S (mic) and boot-safe relay pins"
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
add_line() {
  if ! grep -qxF "$1" "$CONFIG"; then
    echo "$1" | sudo tee -a "$CONFIG" > /dev/null
    echo "    added: $1"
    NEED_REBOOT=1
  fi
}
if ! grep -qF "# --- Pig Monitoring ---" "$CONFIG"; then
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# --- Pig Monitoring ---" | sudo tee -a "$CONFIG" > /dev/null
fi
add_line "dtparam=i2c_arm=on"
add_line "dtparam=i2c_arm_baudrate=50000"
add_line "dtparam=i2s=on"
add_line "dtoverlay=googlevoicehat-soundcard"
add_line "gpio=17,27=op,dh"
sudo modprobe i2c-dev 2>/dev/null || true
if ! grep -qxF "i2c-dev" /etc/modules; then
  echo "i2c-dev" | sudo tee -a /etc/modules > /dev/null
fi

echo "==> Creating Python environment (can use the system's GPIO libraries)"
python3 -m venv --system-site-packages --clear "$PI_DIR/venv"
"$PI_DIR/venv/bin/pip" install --upgrade pip
"$PI_DIR/venv/bin/pip" install -r "$PI_DIR/requirements.txt"

echo "==> Checking models"
for m in best.onnx pig_audio.onnx; do
  if [ -f "$PI_DIR/models/$m" ] || [ -f "$PI_DIR/../public/models/$m" ]; then
    echo "    found $m"
  else
    echo "!! $m missing. Copy it into $PI_DIR/models/"
    exit 1
  fi
done

echo "==> Allowing $RUN_USER to use USB serial, I2C, GPIO and the mic"
sudo usermod -aG dialout,i2c,gpio,audio "$RUN_USER"

echo "==> Setting time zone to Asia/Manila"
sudo timedatectl set-timezone Asia/Manila || true

echo "==> Installing the service"
sed -e "s|^User=.*|User=$RUN_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PI_DIR|" \
    -e "s|^ExecStart=.*|ExecStart=$PI_DIR/venv/bin/python $PI_DIR/app.py|" \
    "$PI_DIR/pigmonitor.service" | sudo tee /etc/systemd/system/pigmonitor.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable pigmonitor

echo ""
if [ "$NEED_REBOOT" = "1" ]; then
  echo "==> Done. REBOOT NOW so the sensor, mic and relay settings take effect:"
  echo "       sudo reboot"
  echo "    The service starts by itself after the reboot. Logs: journalctl -u pigmonitor -f"
else
  sudo systemctl restart pigmonitor
  echo "==> Done. Live logs:   journalctl -u pigmonitor -f"
fi
