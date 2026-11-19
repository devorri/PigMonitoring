/*
 * ========================================================
 *  PIG MONITORING SYSTEM - ESP32-CAM (AI-Thinker)  -  USB CAMERA FOR THE PI
 * ========================================================
 *  The ESP32-CAM no longer uses Wi-Fi or Supabase.
 *  It sits on the ESP32-CAM-MB (USB) board, plugged into the Raspberry Pi 4.
 *  The Pi (pi/app.py) asks for a photo, runs the AI and uploads everything.
 *  (Old Wi-Fi version: firmware/old_pig_esp32cam_wifi)
 *
 *  PROTOCOL (921600 baud, every line ends with \n):
 *    Pi -> "PING"   Cam -> "PONG"
 *    Pi -> "INFO"   Cam -> "INFO boot=<reset reason> psram=<bytes> heap=<bytes> fails=<n>"
 *    Pi -> "SNAP0"  Cam -> "IMG:<len>" + <len> raw JPEG bytes + "\nEND"
 *    Pi -> "SNAP1"  same, with the white flash LED on
 *    Error          Cam -> "ERR:<reason>"
 *    Boot           Cam -> "READY" (or "ERR:CAM_INIT")
 *
 *  WIRING:
 *    ESP32-CAM on the ESP32-CAM-MB board -> micro-USB cable -> Pi 4 USB port
 *    Nothing else. Use the official 5V/3A Pi power supply.
 *
 *  ARDUINO IDE:
 *    Board: "AI Thinker ESP32-CAM"   PSRAM: Enabled
 *    Partition: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *    No extra libraries needed.
 *    Upload: hold IO0, tap RST, upload, then tap RST again.
 *    (Close the Pi service / Serial Monitor first, only one program can use the port)
 * ========================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <esp_system.h>
#include "esp_camera.h"
#include "esp_log.h"

// ========================================================
// --- AI-THINKER ESP32-CAM PIN MAP (fixed on the board) ---
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

#define FLASH_LED_PIN      4   // white flash LED (HIGH = on)

#define SERIAL_BAUD   921600
#define JPEG_QUALITY  12       // 10 = better quality / bigger file, 20 = smaller

bool cameraOk = false;
int  failCount = 0;
char cmdBuf[32];
uint8_t cmdLen = 0;
const char* bootReason = "OTHER";

// ========================================================
// --- RESET REASON ---
// ========================================================
const char* resetReasonText() {
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

// ========================================================
// --- CAMERA SETUP ---
// ========================================================
bool initCamera() {
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
    config.frame_size   = FRAMESIZE_VGA;   // 640x480 (YOLO runs at 640 on the Pi)
    config.jpeg_quality = JPEG_QUALITY;
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

  if (esp_camera_init(&config) != ESP_OK) return false;

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_brightness(s, 1);
    s->set_saturation(s, 0);
    s->set_whitebal(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_gain_ctrl(s, 1);
    // Flip if the camera is mounted upside-down:
    // s->set_vflip(s, 1);
    // s->set_hmirror(s, 1);
  }

  // Let auto-exposure settle (first frames are dark/green)
  for (int i = 0; i < 4; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
    delay(100);
  }
  return true;
}

// ========================================================
// --- TAKE AND SEND ONE PHOTO ---
// ========================================================
void sendSnapshot(bool useFlash) {
  if (!cameraOk) {
    esp_camera_deinit();
    cameraOk = initCamera();
    if (!cameraOk) {
      Serial.print("ERR:CAM_INIT\n");
      if (++failCount >= 3) ESP.restart();
      return;
    }
  }

  if (useFlash) {
    digitalWrite(FLASH_LED_PIN, HIGH);
    delay(150);
  }

  // Throw away one frame so the photo is from "now" (and lit by the flash)
  camera_fb_t* fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();

  digitalWrite(FLASH_LED_PIN, LOW);

  if (!fb) {
    Serial.print("ERR:CAPTURE\n");
    cameraOk = false;                // re-init on the next request
    if (++failCount >= 3) ESP.restart();
    return;
  }

  failCount = 0;
  Serial.printf("IMG:%u\n", (unsigned)fb->len);
  Serial.write(fb->buf, fb->len);
  Serial.print("\nEND\n");
  Serial.flush();
  esp_camera_fb_return(fb);
}

// ========================================================
// --- COMMAND HANDLER ---
// ========================================================
void handleCommand(const char* cmd) {
  if (strcmp(cmd, "PING") == 0) {
    Serial.print("PONG\n");
  } else if (strcmp(cmd, "INFO") == 0) {
    Serial.printf("INFO boot=%s psram=%u heap=%u fails=%d\n",
                  bootReason, (unsigned)ESP.getFreePsram(),
                  (unsigned)ESP.getFreeHeap(), failCount);
  } else if (strcmp(cmd, "SNAP0") == 0 || strcmp(cmd, "SNAP") == 0) {
    sendSnapshot(false);
  } else if (strcmp(cmd, "SNAP1") == 0) {
    sendSnapshot(true);
  } else if (cmd[0] != '\0') {
    Serial.print("ERR:UNKNOWN_CMD\n");
  }
}

// ========================================================
// --- SETUP ---
// ========================================================
void setup() {
  // NOTE: brownout detector is left ON on purpose. If power dips, the board resets
  // cleanly and the Pi reports boot=BROWNOUT_POWER_DIP in cam_status.
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);   // keep the white LED off

  WiFi.mode(WIFI_OFF);   // not used anymore -> less power, less heat, fewer brownouts
  btStop();

  Serial.begin(SERIAL_BAUD);
  Serial.setDebugOutput(false);
  esp_log_level_set("*", ESP_LOG_NONE);  // keep driver logs off the data line

  bootReason = resetReasonText();
  cameraOk = initCamera();
  Serial.print(cameraOk ? "READY\n" : "ERR:CAM_INIT\n");
}

// ========================================================
// --- LOOP ---
// ========================================================
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmdBuf[cmdLen] = '\0';
      if (cmdLen > 0) handleCommand(cmdBuf);
      cmdLen = 0;
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdLen = 0;  // garbage / overflow -> reset
    }
  }
  delay(2);
}
