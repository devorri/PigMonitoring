/*
 * ========================================================
 *  PIG MONITORING SYSTEM - ESP32-CAM (AI-Thinker)
 * ========================================================
 *  1. LIVE FEED  : uploads a JPEG to  snap/live.jpg  every N seconds (overwrites)
 *                  -> website shows it and refreshes it = live feed
 *  2. ALERT SNAPS: when the main ESP32 sends "SNAP:<reason>" over UART,
 *                  saves  snap/alerts/YYYYMMDD_HHMMSS.jpg  and logs it in the
 *                  `snapshots` table (run supabase_esp32cam_setup.sql first)
 *
 *  Settings read from system_settings (change them on the website):
 *    cam_live_enabled          true / false
 *    cam_live_interval_seconds 1..60 (default 2)
 *
 *  WIRING:
 *    Main ESP32 GPIO27 (TX) ---> ESP32-CAM GPIO13 (RX)
 *    Main ESP32 GND        ---> ESP32-CAM GND
 *    Power the CAM with a solid 5V / 1A+ supply (brownouts = random resets)
 *
 *  ARDUINO IDE:
 *    Board: "AI Thinker ESP32-CAM"   PSRAM: Enabled
 *    Partition: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *    Libraries: WiFiManager (tzapu), ArduinoJson v7
 *    First boot: connect to Wi-Fi AP "PigCam-Setup" to set the farm Wi-Fi
 * ========================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <time.h>
#include "esp_camera.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ========================================================
// --- AI-THINKER ESP32-CAM PIN MAP ---
// ========================================================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

#define FLASH_LED_PIN      4
#define LINK_RX_PIN       13   // from main ESP32 TX (GPIO27)

// Turn the white flash LED on for alert snapshots (useful at night)
#define USE_FLASH_ON_ALERT false

// ========================================================
// --- SUPABASE CONFIGURATION ---
// ========================================================
#define SUPABASE_URL  "https://rembfnigpvtuxoyjjexf.supabase.co"
#define SUPABASE_KEY  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlbWJmbmlncHZ0dXhveWpqZXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NDUzMTksImV4cCI6MjEwNDIyMTMxOX0.HIZvxN9LRPQl_9vh-bY1rqaMbh2mHhvGWIqZrR9ZftA"
#define SNAP_BUCKET   "snap"
#define LIVE_PATH     "live.jpg"

const char* settingsUrl  = SUPABASE_URL "/rest/v1/system_settings?select=setting_key,setting_value&setting_key=like.cam_*";
const char* snapshotsUrl = SUPABASE_URL "/rest/v1/snapshots";

// ========================================================
// --- STATE ---
// ========================================================
HardwareSerial linkSerial(1);
WiFiClientSecure secureClient;   // reused -> keeps TLS connection alive between uploads

bool liveEnabled = true;
unsigned long liveIntervalMs = 2000;
unsigned long lastLiveUpload = 0;
unsigned long lastSettingsFetch = 0;
const unsigned long SETTINGS_INTERVAL_MS = 15000;

unsigned long lastAlertSnap = 0;
const unsigned long ALERT_COOLDOWN_MS = 30000;

unsigned long lastWifiCheck = 0;
int consecutiveFailures = 0;
String linkBuffer = "";

// ========================================================
// --- CAMERA SETUP ---
// ========================================================
bool setupCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size   = FRAMESIZE_VGA;   // 640x480 (matches the 640 YOLO input on the website)
    config.jpeg_quality = 12;              // 10 = better quality / bigger file, 20 = smaller
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
    config.grab_mode    = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size   = FRAMESIZE_QVGA;
    config.jpeg_quality = 15;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] Init failed: 0x%x\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  s->set_brightness(s, 1);
  s->set_saturation(s, 0);
  s->set_whitebal(s, 1);
  s->set_exposure_ctrl(s, 1);
  s->set_gain_ctrl(s, 1);
  // Flip if the camera is mounted upside-down:
  // s->set_vflip(s, 1);
  // s->set_hmirror(s, 1);

  Serial.println("[CAM] Camera ready");
  return true;
}

// ========================================================
// --- HELPERS ---
// ========================================================
void addAuthHeaders(HTTPClient& https) {
  https.addHeader("apikey", SUPABASE_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
}

String timestampName() {
  struct tm t;
  if (getLocalTime(&t, 50)) {
    char buf[32];
    strftime(buf, sizeof(buf), "%Y%m%d_%H%M%S", &t);
    return String(buf);
  }
  return "boot_" + String(millis());
}

// Upload a JPEG to Supabase Storage. upsert=true overwrites the existing file.
bool uploadJpeg(const String& path, const uint8_t* data, size_t len, bool upsert) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient https;
  https.setReuse(true);
  https.setTimeout(10000);
  String url = String(SUPABASE_URL) + "/storage/v1/object/" + SNAP_BUCKET + "/" + path;

  if (!https.begin(secureClient, url)) return false;
  addAuthHeaders(https);
  https.addHeader("Content-Type", "image/jpeg");
  https.addHeader("cache-control", "max-age=0");   // website always gets the newest frame
  if (upsert) https.addHeader("x-upsert", "true");

  int code = https.sendRequest("POST", (uint8_t*)data, len);
  bool ok = (code == 200);
  if (!ok) {
    Serial.printf("[UPLOAD] %s failed: HTTP %d -> %s\n", path.c_str(), code, https.getString().c_str());
    secureClient.stop();  // reset the connection on error
  }
  https.end();
  return ok;
}

void logSnapshot(const String& publicUrl, const String& reason) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient https;
  https.setReuse(true);
  if (!https.begin(secureClient, snapshotsUrl)) return;
  addAuthHeaders(https);
  https.addHeader("Content-Type", "application/json");
  https.addHeader("Prefer", "return=minimal");

  JsonDocument doc;
  doc["image_url"] = publicUrl;
  doc["reason"] = reason;
  String body;
  serializeJson(doc, body);

  int code = https.POST(body);
  if (code != 201 && code != 200) {
    Serial.printf("[SNAPSHOT] DB insert failed: HTTP %d -> %s\n", code, https.getString().c_str());
  }
  https.end();
}

void fetchSettings() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient https;
  https.setReuse(true);
  if (!https.begin(secureClient, settingsUrl)) return;
  addAuthHeaders(https);

  if (https.GET() == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, https.getString())) {
      for (JsonObject elem : doc.as<JsonArray>()) {
        String key = elem["setting_key"].as<String>();
        String val = elem["setting_value"].as<String>();
        val.toLowerCase();

        if (key == "cam_live_enabled") {
          liveEnabled = (val == "true" || val == "1" || val == "on");
        } else if (key == "cam_live_interval_seconds") {
          int sec = val.toInt();
          if (sec >= 1 && sec <= 60) liveIntervalMs = sec * 1000UL;
        }
      }
    }
  }
  https.end();
}

// ========================================================
// --- LIVE FRAME ---
// ========================================================
void uploadLiveFrame() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] Frame capture failed");
    return;
  }

  bool ok = uploadJpeg(LIVE_PATH, fb->buf, fb->len, true);
  size_t len = fb->len;
  esp_camera_fb_return(fb);

  if (ok) {
    consecutiveFailures = 0;
    Serial.printf("[LIVE] Frame uploaded (%u KB)\n", (unsigned)(len / 1024));
  } else if (++consecutiveFailures >= 10) {
    Serial.println("[LIVE] Too many failures, restarting...");
    ESP.restart();
  }
}

// ========================================================
// --- ALERT SNAPSHOT ---
// ========================================================
void takeAlertSnapshot(const String& reason) {
  if (millis() - lastAlertSnap < ALERT_COOLDOWN_MS && lastAlertSnap != 0) {
    Serial.println("[ALERT] Snapshot skipped (cooldown)");
    return;
  }
  lastAlertSnap = millis();

  if (USE_FLASH_ON_ALERT) {
    digitalWrite(FLASH_LED_PIN, HIGH);
    delay(150);
  }

  // Drop one buffered frame so the alert image is fresh
  camera_fb_t* fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();

  if (USE_FLASH_ON_ALERT) digitalWrite(FLASH_LED_PIN, LOW);

  if (!fb) {
    Serial.println("[ALERT] Capture failed");
    return;
  }

  String path = "alerts/" + timestampName() + "_" + reason + ".jpg";
  bool ok = uploadJpeg(path, fb->buf, fb->len, false);
  esp_camera_fb_return(fb);

  if (ok) {
    String publicUrl = String(SUPABASE_URL) + "/storage/v1/object/public/" + SNAP_BUCKET + "/" + path;
    logSnapshot(publicUrl, reason);
    Serial.println("[ALERT] Saved " + path);
  }
}

// ========================================================
// --- UART COMMANDS FROM MAIN ESP32 ---
// ========================================================
void handleLinkSerial() {
  while (linkSerial.available()) {
    char c = linkSerial.read();
    if (c == '\n' || c == '\r') {
      linkBuffer.trim();
      if (linkBuffer.startsWith("SNAP")) {
        String reason = "ALERT";
        int colon = linkBuffer.indexOf(':');
        if (colon != -1 && colon + 1 < (int)linkBuffer.length()) {
          reason = linkBuffer.substring(colon + 1);
          reason.trim();
        }
        Serial.println("[LINK] Snapshot requested: " + reason);
        takeAlertSnapshot(reason);
      }
      linkBuffer = "";
    } else if (linkBuffer.length() < 64) {
      linkBuffer += c;
    }
  }
}

// ========================================================
// --- SETUP ---
// ========================================================
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);  // avoid brownout resets during Wi-Fi bursts
  Serial.begin(115200);
  delay(500);

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);

  linkSerial.begin(115200, SERIAL_8N1, LINK_RX_PIN, -1);

  if (!setupCamera()) {
    delay(3000);
    ESP.restart();
  }

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("PigCam-Setup")) {
    Serial.println("[WIFI] Setup timed out, restarting...");
    ESP.restart();
  }
  WiFi.setSleep(false);         // lower latency uploads
  WiFi.setAutoReconnect(true);
  Serial.print("[WIFI] Connected, IP: ");
  Serial.println(WiFi.localIP());

  configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  secureClient.setInsecure();

  fetchSettings();
  Serial.println("[BOOT] ESP32-CAM ready");
}

// ========================================================
// --- LOOP ---
// ========================================================
void loop() {
  handleLinkSerial();

  if (millis() - lastWifiCheck > 10000) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WIFI] Reconnecting...");
      WiFi.reconnect();
    }
  }

  if (millis() - lastSettingsFetch > SETTINGS_INTERVAL_MS) {
    lastSettingsFetch = millis();
    fetchSettings();
  }

  if (liveEnabled && millis() - lastLiveUpload > liveIntervalMs) {
    lastLiveUpload = millis();
    uploadLiveFrame();
  }

  delay(10);
}
