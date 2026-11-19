/*
 * ========================================================
 *  PIG MONITORING SYSTEM - ESP32-CAM (AI-Thinker)
 * ========================================================
 *  Runs on its own (NOT connected to the main ESP32).
 *  1. LIVE FEED  : uploads a JPEG to  snap/live.jpg  every N seconds (overwrites)
 *                  -> website shows it and refreshes it = live feed
 *  2. HEALTH     : every 60s writes uptime / memory / reset reason to
 *                  system_settings -> cam_status  (so crashes can be diagnosed remotely)
 *
 *  Settings read from system_settings (change them on the website):
 *    cam_live_enabled          true / false
 *    cam_live_interval_seconds 1..60 (default 3)
 *
 *  POWER:
 *    Power the CAM with a solid 5V / 2A supply (weak power = random crashes)
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
#include <Preferences.h>
#include <esp_system.h>
#include <esp_heap_caps.h>
#include <time.h>
#include "esp_camera.h"

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

// ========================================================
// --- SUPABASE CONFIGURATION ---
// ========================================================
#define SUPABASE_URL  "https://rembfnigpvtuxoyjjexf.supabase.co"
#define SUPABASE_KEY  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlbWJmbmlncHZ0dXhveWpqZXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NDUzMTksImV4cCI6MjEwNDIyMTMxOX0.HIZvxN9LRPQl_9vh-bY1rqaMbh2mHhvGWIqZrR9ZftA"
#define SNAP_BUCKET   "snap"
#define LIVE_PATH     "live.jpg"

const char* settingsUrl  = SUPABASE_URL "/rest/v1/system_settings?select=setting_key,setting_value&setting_key=like.cam_*";
const char* statusUrl    = SUPABASE_URL "/rest/v1/system_settings?setting_key=eq.cam_status";

// ========================================================
// --- STATE ---
// ========================================================
WiFiClientSecure secureClient;   // reused -> keeps TLS connection alive between uploads
Preferences prefs;

bool liveEnabled = true;
unsigned long liveIntervalMs = 3000;
unsigned long lastLiveUpload = 0;
unsigned long lastSettingsFetch = 0;
const unsigned long SETTINGS_INTERVAL_MS = 15000;

unsigned long lastStatusReport = 0;
const unsigned long STATUS_INTERVAL_MS = 60000;
#define MIN_SAFE_HEAP_BLOCK 30000   // internal RAM block needed for a TLS connection

unsigned long lastWifiCheck = 0;
int consecutiveFailures = 0;
String bootReason = "";

// ========================================================
// --- RESET REASON / SAFE RESTART ---
// ========================================================
String resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "POWER_ON";
    case ESP_RST_SW:       return "SOFTWARE_RESTART";
    case ESP_RST_PANIC:    return "CRASH_PANIC";
    case ESP_RST_INT_WDT:  return "CRASH_INT_WATCHDOG";
    case ESP_RST_TASK_WDT: return "CRASH_TASK_WATCHDOG";
    case ESP_RST_WDT:      return "CRASH_WATCHDOG";
    case ESP_RST_BROWNOUT: return "BROWNOUT_POWER_DIP";
    case ESP_RST_EXT:      return "RESET_BUTTON";
    default:               return "OTHER";
  }
}

void safeRestart(const String& why) {
  Serial.println("[SYSTEM] Planned restart: " + why);
  prefs.putString("restart_why", why);
  delay(200);
  ESP.restart();
}

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
  config.xclk_freq_hz = 10000000;          // 10MHz: cooler + more stable than 20MHz
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
// --- HTTPS HELPERS ---
// ========================================================
bool beginRequest(HTTPClient& https, const String& url) {
  if (WiFi.status() != WL_CONNECTED) return false;
  https.setReuse(true);
  https.setTimeout(10000);
  if (!https.begin(secureClient, url)) return false;
  https.addHeader("apikey", SUPABASE_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  return true;
}

// Negative codes = connection problem -> drop the socket so the next call reconnects clean
void finishRequest(HTTPClient& https, int code) {
  https.end();
  if (code < 0) secureClient.stop();
}

// Upload a JPEG to Supabase Storage. upsert=true overwrites the existing file.
bool uploadJpeg(const String& path, const uint8_t* data, size_t len, bool upsert) {
  HTTPClient https;
  String url = String(SUPABASE_URL) + "/storage/v1/object/" + SNAP_BUCKET + "/" + path;
  if (!beginRequest(https, url)) return false;

  https.addHeader("Content-Type", "image/jpeg");
  https.addHeader("cache-control", "max-age=0");   // website always gets the newest frame
  if (upsert) https.addHeader("x-upsert", "true");

  int code = https.sendRequest("POST", (uint8_t*)data, len);
  bool ok = (code == 200);
  if (!ok) Serial.printf("[UPLOAD] %s failed: HTTP %d\n", path.c_str(), code);
  finishRequest(https, ok ? code : -1);   // reset socket on any failure
  return ok;
}

void fetchSettings() {
  HTTPClient https;
  if (!beginRequest(https, settingsUrl)) return;

  int code = https.GET();
  if (code == 200) {
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
  finishRequest(https, code);
}

void reportStatus() {
  HTTPClient https;
  if (!beginRequest(https, statusUrl)) return;
  https.addHeader("Content-Type", "application/json");
  https.addHeader("Prefer", "return=minimal");

  String status = "uptime=" + String(millis() / 60000) + "min"
                + " heap=" + String(ESP.getFreeHeap())
                + " minheap=" + String(ESP.getMinFreeHeap())
                + " block=" + String(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT))
                + " psram=" + String(ESP.getFreePsram())
                + " rssi=" + String(WiFi.RSSI())
                + " live=" + String(liveEnabled ? "on" : "off")
                + " boot=" + bootReason;

  JsonDocument doc;
  doc["setting_value"] = status;
  String body;
  serializeJson(doc, body);

  int code = https.sendRequest("PATCH", body);
  finishRequest(https, code);
  Serial.println("[STATUS] " + status);
}

void checkHeap() {
  size_t block = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (block < MIN_SAFE_HEAP_BLOCK) {
    safeRestart("LOW_MEMORY block=" + String(block));
  }
}

// ========================================================
// --- LIVE FRAME ---
// ========================================================
void uploadLiveFrame() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] Frame capture failed");
    if (++consecutiveFailures >= 10) safeRestart("CAMERA_CAPTURE_FAILED");
    return;
  }

  bool ok = uploadJpeg(LIVE_PATH, fb->buf, fb->len, true);
  size_t len = fb->len;
  esp_camera_fb_return(fb);

  if (ok) {
    consecutiveFailures = 0;
    Serial.printf("[LIVE] Frame uploaded (%u KB)\n", (unsigned)(len / 1024));
  } else if (++consecutiveFailures >= 10) {
    safeRestart("UPLOAD_FAILED_10x");
  }
}

// ========================================================
// --- SETUP ---
// ========================================================
void setup() {
  // NOTE: brownout detector is left ON on purpose. If power dips, the board resets
  // cleanly and reports BROWNOUT_POWER_DIP instead of freezing/crashing randomly.
  Serial.begin(115200);
  delay(500);

  prefs.begin("pig_cam", false);
  bootReason = resetReasonText();
  if (bootReason == "SOFTWARE_RESTART") {
    String why = prefs.getString("restart_why", "");
    if (why.length()) bootReason = "PLANNED:" + why;
  }
  prefs.remove("restart_why");
  Serial.println("[BOOT] Reset reason: " + bootReason);

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);   // keep the white LED off

  if (!setupCamera()) {
    delay(3000);
    safeRestart("CAMERA_INIT_FAILED");
  }

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("PigCam-Setup")) {
    safeRestart("WIFI_SETUP_TIMEOUT");
  }
  WiFi.setSleep(true);           // modem sleep ON: less heat + smaller current spikes
  WiFi.setAutoReconnect(true);
  Serial.print("[WIFI] Connected, IP: ");
  Serial.println(WiFi.localIP());

  configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  secureClient.setInsecure();

  fetchSettings();
  reportStatus();
  Serial.println("[BOOT] ESP32-CAM ready");
}

// ========================================================
// --- LOOP ---
// ========================================================
void loop() {
  if (millis() - lastWifiCheck > 10000) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WIFI] Reconnecting...");
      secureClient.stop();
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

  if (millis() - lastStatusReport > STATUS_INTERVAL_MS) {
    lastStatusReport = millis();
    reportStatus();
    checkHeap();
  }

  delay(10);
}
