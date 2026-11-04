#include <Arduino.h>
#include <Wire.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <Adafruit_MLX90614.h>
#include <driver/i2s.h>
#include <vector>
#include <time.h>

// ========================================================
// --- PIN DEFINITIONS & HARDWARE MAPPING ---
// ========================================================
#define SIM_RX_PIN 16
#define SIM_TX_PIN 17
#define CAM_RX_PIN 26
#define CAM_TX_PIN 27   // -> wire to ESP32-CAM GPIO13 (plus common GND)

#define PIR_PIN 13
#define RELAY_IN1 14  // Heating Bulb Relay
#define RELAY_IN2 12  // Water Solenoid Relay

// Active-Low Relay Logic (LOW = ON, HIGH = OFF)
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// INMP441 I2S Microphone Pins
#define I2S_WS 25
#define I2S_SD 35
#define I2S_SCK 33
#define I2S_PORT I2S_NUM_0

// ========================================================
// --- HARDWARE & STORAGE OBJECTS ---
// ========================================================
HardwareSerial sim800(2);
HardwareSerial camSerial(1);
Adafruit_MLX90614 mlx = Adafruit_MLX90614();
Preferences preferences;
SemaphoreHandle_t i2sMutex;   // Only ONE reader of the I2S port at a time

// ========================================================
// --- SUPABASE CONFIGURATION ---
// ========================================================
#define SUPABASE_URL "https://rembfnigpvtuxoyjjexf.supabase.co"
const char* supabaseSettingsUrl = SUPABASE_URL "/rest/v1/system_settings";
const char* supabaseContactsUrl = SUPABASE_URL "/rest/v1/contacts?is_active=eq.true";
const char* supabaseAudioUrl    = SUPABASE_URL "/storage/v1/object/audio/periodic_sound.wav";
const char* supabaseAudioPublic = SUPABASE_URL "/storage/v1/object/public/audio/periodic_sound.wav";
const char* supabaseSensorUrl   = SUPABASE_URL "/rest/v1/sensor_logs";
const char* supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlbWJmbmlncHZ0dXhveWpqZXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NDUzMTksImV4cCI6MjEwNDIyMTMxOX0.HIZvxN9LRPQl_9vh-bY1rqaMbh2mHhvGWIqZrR9ZftA";

// ========================================================
// --- AUDIO RECORDING SETTINGS ---
// ========================================================
#define AUDIO_SAMPLE_RATE   16000
#define AUDIO_SECONDS       5         // 5s clip -> model analyzes 5 x 1s chunks
#define AUDIO_GAIN_SHIFT    14        // 16 = no gain, 15 = 2x, 14 = 4x (clipped safely)
#define AUDIO_FILE          "/periodic_sound.wav"

// Shared variables
volatile int currentAudioLevel = 0;
const int AUDIO_NOISE_THRESHOLD = 50000;
unsigned long lastSyncUpdate = 0;
unsigned long syncInterval = 15000;          // Cloud telemetry sync: every 15s
unsigned long lastAudioUpload = 0;
unsigned long audioInterval = 60000;         // Audio clip upload: every 60s (setting: audio_interval_seconds)
unsigned long lastSettingsFetch = 0;
const unsigned long settingsFetchInterval = 10000; // Check DB every 10s for manual controls

// --- SMS TIMERS ---
int lastReportedHour = -1;                 // Tracks hourly SMS
unsigned long lastHourlySMSFallback = 0;   // Fallback if NTP is offline
const unsigned long ONE_HOUR_MS = 3600000; // 1 Hour in milliseconds

unsigned long lastAlertSMSTime = 0;        // Emergency alert cooldown
const unsigned long ALERT_COOLDOWN_MS = 300000; // 5 minutes cooldown for emergency alerts

// --- CAMERA SNAPSHOT TRIGGER ---
unsigned long lastSnapCmdTime = 0;
const unsigned long SNAP_COOLDOWN_MS = 30000;   // Max 1 alert snapshot every 30s

// ========================================================
// --- RELAY MODES & AUTOMATION RULES ---
// ========================================================
String bulbMode = "auto";
String solenoidMode = "auto";

int bulbStartHour = 18;           // 6:00 PM (18:00)
int bulbEndHour = 6;              // 6:00 AM (06:00)
float solenoidTriggerTemp = 38.0; // Open solenoid at 38°C and up
float solenoidHysteresis = 1.0;   // Shut off < 37°C
bool solenoidAutoActive = false;

std::vector<String> activePhoneNumbers;

// ========================================================
// --- I2S MICROPHONE SETUP (INMP441) ---
// ========================================================
void setupI2S() {
  const i2s_config_t i2s_config = {
    .mode = i2s_mode_t(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = AUDIO_SAMPLE_RATE,
    .bits_per_sample = i2s_bits_per_sample_t(I2S_BITS_PER_SAMPLE_32BIT),
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_STAND_I2S),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,     // bigger DMA buffer (~256ms) so flash writes never drop samples
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  const i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_start(I2S_PORT);
}

// Background Audio Peak Meter (Core 0)
// Pauses automatically while recordAudioChunk() holds the I2S mutex.
void audioTask(void *pvParameters) {
  int32_t buffer[128];
  size_t bytesRead = 0;

  while (true) {
    if (xSemaphoreTake(i2sMutex, portMAX_DELAY) == pdTRUE) {
      i2s_read(I2S_PORT, &buffer, sizeof(buffer), &bytesRead, portMAX_DELAY);
      xSemaphoreGive(i2sMutex);

      int samplesRead = bytesRead / sizeof(int32_t);
      int32_t peakSignal = 0;
      for (int i = 0; i < samplesRead; i++) {
        int32_t val = abs(buffer[i]);
        if (val > peakSignal) peakSignal = val;
      }
      currentAudioLevel = peakSignal >> 8;
    }
    vTaskDelay(2);
  }
}

// ========================================================
// --- ROBUST SIM800L SMS TRANSMISSION ---
// ========================================================
bool sendSMS(String phoneNumber, String message) {
  while (sim800.available()) {
    sim800.read();
  }

  sim800.println("AT+CMGF=1");
  delay(150);

  sim800.print("AT+CMGS=\"");
  sim800.print(phoneNumber);
  sim800.println("\"");
  delay(200);

  sim800.print(message);
  delay(100);

  sim800.write(26); // Ctrl+Z to send

  unsigned long startWait = millis();
  bool success = false;
  while (millis() - startWait < 6000) {
    if (sim800.available()) {
      String response = sim800.readString();
      if (response.indexOf("OK") != -1 || response.indexOf("+CMGS") != -1) {
        success = true;
        break;
      } else if (response.indexOf("ERROR") != -1) {
        success = false;
        break;
      }
    }
    delay(100);
  }
  return success;
}

void broadcastSMS(String message) {
  int totalContacts = activePhoneNumbers.size();
  for (int i = 0; i < totalContacts; i++) {
    sendSMS(activePhoneNumbers[i], message);
    if (i < totalContacts - 1) {
      delay(3000);
    }
  }
}

// ========================================================
// --- FETCH CLOUD CONFIGURATION & CONTACTS ---
// ========================================================
void fetchCloudData() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;

  // 1. Fetch System Settings
  if (https.begin(client, supabaseSettingsUrl)) {
    https.addHeader("apikey", supabaseKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseKey);

    int code = https.GET();
    if (code == 200) {
      JsonDocument doc;
      if (!deserializeJson(doc, https.getString())) {
        for (JsonObject elem : doc.as<JsonArray>()) {
          String key = elem["setting_key"].as<String>();
          String val = elem["setting_value"].as<String>();

          if (key == "sync_interval_seconds" && val.toInt() > 0) {
            syncInterval = val.toInt() * 1000UL;
          } else if (key == "audio_interval_seconds" && val.toInt() >= 10) {
            audioInterval = val.toInt() * 1000UL;
          } else if (key == "bulb_mode") {
            bulbMode = val; bulbMode.toLowerCase();
          } else if (key == "solenoid_mode") {
            solenoidMode = val; solenoidMode.toLowerCase();
          } else if (key == "solenoid_trigger_temp") {
            solenoidTriggerTemp = val.toFloat();
          } else if (key == "bulb_start_hour") {
            bulbStartHour = val.toInt();
          } else if (key == "bulb_end_hour") {
            bulbEndHour = val.toInt();
          }
        }
        // Persist so the farm keeps the last known settings if it reboots offline
        preferences.putULong("sync_interval", syncInterval);
        preferences.putULong("audio_interval", audioInterval);
        preferences.putString("bulb_mode", bulbMode);
        preferences.putString("sol_mode", solenoidMode);
        preferences.putFloat("sol_temp", solenoidTriggerTemp);
        preferences.putInt("bulb_start", bulbStartHour);
        preferences.putInt("bulb_end", bulbEndHour);
      }
    } else {
      Serial.printf("[SETTINGS] Fetch failed: HTTP %d\n", code);
    }
    https.end();
  }

  // 2. Fetch Active Contacts
  if (https.begin(client, supabaseContactsUrl)) {
    https.addHeader("apikey", supabaseKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseKey);

    if (https.GET() == 200) {
      JsonDocument doc;
      if (!deserializeJson(doc, https.getString())) {
        activePhoneNumbers.clear();
        for (JsonObject elem : doc.as<JsonArray>()) {
          String phone = elem["phone_number"].as<String>();
          if (phone.length() > 0) activePhoneNumbers.push_back(phone);
        }
      }
    }
    https.end();
  }
}

// ========================================================
// --- RECORD AUDIO (16kHz, 16-bit mono WAV) ---
// ========================================================
void writeWavHeader(File &file, uint32_t dataSize) {
  uint32_t sampleRate = AUDIO_SAMPLE_RATE;
  uint32_t byteRate = AUDIO_SAMPLE_RATE * 2;
  uint32_t fileSize = 36 + dataSize;
  uint32_t subChunk1Size = 16;
  uint16_t audioFormat = 1;
  uint16_t numChannels = 1;
  uint16_t blockAlign = 2;
  uint16_t bitsPerSample = 16;

  file.write((const uint8_t*)"RIFF", 4);
  file.write((const uint8_t*)&fileSize, 4);
  file.write((const uint8_t*)"WAVE", 4);
  file.write((const uint8_t*)"fmt ", 4);
  file.write((const uint8_t*)&subChunk1Size, 4);
  file.write((const uint8_t*)&audioFormat, 2);
  file.write((const uint8_t*)&numChannels, 2);
  file.write((const uint8_t*)&sampleRate, 4);
  file.write((const uint8_t*)&byteRate, 4);
  file.write((const uint8_t*)&blockAlign, 2);
  file.write((const uint8_t*)&bitsPerSample, 2);
  file.write((const uint8_t*)"data", 4);
  file.write((const uint8_t*)&dataSize, 4);
}

bool recordAudioChunk() {
  File file = LittleFS.open(AUDIO_FILE, FILE_WRITE);
  if (!file) {
    Serial.println("[AUDIO] Cannot open file for writing");
    return false;
  }

  const uint32_t totalSamples = AUDIO_SAMPLE_RATE * AUDIO_SECONDS;
  writeWavHeader(file, totalSamples * 2);

  static int32_t i2sBuffer[512];
  static int16_t outBuffer[512];
  size_t bytesRead = 0;
  uint32_t samplesWritten = 0;
  int32_t peak = 0;

  // Take exclusive ownership of the mic so the peak-meter task can't steal samples
  xSemaphoreTake(i2sMutex, portMAX_DELAY);

  // Discard ~100ms of stale DMA data so the clip starts "now"
  uint32_t discarded = 0;
  while (discarded < AUDIO_SAMPLE_RATE / 10) {
    i2s_read(I2S_PORT, &i2sBuffer, sizeof(i2sBuffer), &bytesRead, portMAX_DELAY);
    discarded += bytesRead / sizeof(int32_t);
  }

  while (samplesWritten < totalSamples) {
    i2s_read(I2S_PORT, &i2sBuffer, sizeof(i2sBuffer), &bytesRead, portMAX_DELAY);
    int numRead = bytesRead / sizeof(int32_t);
    int outCount = 0;

    for (int i = 0; i < numRead && samplesWritten < totalSamples; i++) {
      int32_t s = i2sBuffer[i] >> AUDIO_GAIN_SHIFT;
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;
      outBuffer[outCount++] = (int16_t)s;
      int32_t a = abs(i2sBuffer[i]);
      if (a > peak) peak = a;
      samplesWritten++;
    }
    // One write per block instead of 2 bytes at a time (much faster on LittleFS)
    file.write((uint8_t*)outBuffer, outCount * sizeof(int16_t));
  }

  xSemaphoreGive(i2sMutex);
  file.close();

  currentAudioLevel = peak >> 8;
  Serial.printf("[AUDIO] Recorded %us clip (%u bytes)\n", AUDIO_SECONDS, totalSamples * 2 + 44);
  return true;
}

// Returns the public URL (with cache-buster) on success, "" on failure
String uploadAudioToSupabase() {
  if (WiFi.status() != WL_CONNECTED) return "";
  if (!LittleFS.exists(AUDIO_FILE)) return "";
  File file = LittleFS.open(AUDIO_FILE, "r");
  if (!file) return "";

  String result = "";
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  https.setTimeout(20000);

  if (https.begin(client, supabaseAudioUrl)) {
    https.addHeader("apikey", supabaseKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseKey);
    https.addHeader("Content-Type", "audio/wav");
    https.addHeader("x-upsert", "true");          // <-- REQUIRED to overwrite the same file
    https.addHeader("cache-control", "max-age=0"); // don't let the CDN serve an old clip

    int code = https.sendRequest("POST", &file, file.size());
    if (code == 200) {
      time_t now = time(nullptr);
      unsigned long stamp = (now > 1700000000) ? (unsigned long)now : millis();
      result = String(supabaseAudioPublic) + "?t=" + String(stamp);
      Serial.println("[AUDIO] Upload OK");
    } else {
      Serial.printf("[AUDIO] Upload failed: HTTP %d -> %s\n", code, https.getString().c_str());
    }
    https.end();
  }
  file.close();
  return result;
}

void uploadTelemetryToSupabase(float ambient, float floor, int audioLvl, bool motion, String audioUrl) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  if (https.begin(client, supabaseSensorUrl)) {
    https.addHeader("apikey", supabaseKey);
    https.addHeader("Authorization", String("Bearer ") + supabaseKey);
    https.addHeader("Content-Type", "application/json");
    https.addHeader("Prefer", "return=minimal");

    JsonDocument doc;
    doc["ambient_temp"] = ambient;
    doc["floor_temp"] = floor;
    doc["audio_level"] = audioLvl;
    doc["motion_detected"] = motion;
    // Only rows that carry a NEW clip get an audio_url -> audio_worker.py classifies those
    if (audioUrl.length() > 0) doc["audio_url"] = audioUrl;
    else doc["audio_url"] = nullptr;

    String jsonBody;
    serializeJson(doc, jsonBody);
    int code = https.POST(jsonBody);
    if (code != 201 && code != 200) {
      Serial.printf("[TELEMETRY] Insert failed: HTTP %d\n", code);
    }
    https.end();
  }
}

// ========================================================
// --- SYSTEM SETUP ---
// ========================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  if (!LittleFS.begin(true)) {
    Serial.println("[ERROR] LittleFS Mount Failed");
  }

  preferences.begin("pig_farm", false);
  syncInterval = preferences.getULong("sync_interval", 15000);
  audioInterval = preferences.getULong("audio_interval", 60000);
  bulbMode = preferences.getString("bulb_mode", "auto");
  solenoidMode = preferences.getString("sol_mode", "auto");
  solenoidTriggerTemp = preferences.getFloat("sol_temp", 38.0);
  bulbStartHour = preferences.getInt("bulb_start", 18);
  bulbEndHour = preferences.getInt("bulb_end", 6);

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("PigFarm-Setup")) {
    Serial.println("[WARNING] Wi-Fi setup timed out. Running in Offline Mode.");
  } else {
    configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  }
  WiFi.setAutoReconnect(true);

  sim800.begin(9600, SERIAL_8N1, SIM_RX_PIN, SIM_TX_PIN);
  camSerial.begin(115200, SERIAL_8N1, CAM_RX_PIN, CAM_TX_PIN);

  Wire.begin(21, 22);
  mlx.begin();

  pinMode(PIR_PIN, INPUT);
  pinMode(RELAY_IN1, OUTPUT);
  pinMode(RELAY_IN2, OUTPUT);

  digitalWrite(RELAY_IN1, RELAY_OFF);
  digitalWrite(RELAY_IN2, RELAY_OFF);

  i2sMutex = xSemaphoreCreateMutex();
  setupI2S();
  xTaskCreatePinnedToCore(audioTask, "AudioTask", 4096, NULL, 1, NULL, 0);

  fetchCloudData();
  Serial.println("[BOOT] Clean system fully initialized.");
}

// ========================================================
// --- MAIN LOOP ---
// ========================================================
void loop() {
  float ambientTemp = mlx.readAmbientTempC();
  float floorTemp = mlx.readObjectTempC();
  int motionState = digitalRead(PIR_PIN);
  float currentMaxTemp = (ambientTemp > floorTemp) ? ambientTemp : floorTemp;

  struct tm timeinfo;
  bool hasTime = getLocalTime(&timeinfo, 50);

  // --- 1. HEATING BULB CONTROL ---
  bool bulbShouldBeOn = false;
  if (bulbMode == "on") {
    bulbShouldBeOn = true;
  } else if (bulbMode == "off") {
    bulbShouldBeOn = false;
  } else if (hasTime) {
    if (timeinfo.tm_hour >= bulbStartHour || timeinfo.tm_hour < bulbEndHour) {
      bulbShouldBeOn = true;
    }
  }
  digitalWrite(RELAY_IN1, bulbShouldBeOn ? RELAY_ON : RELAY_OFF);

  // --- 2. WATER SOLENOID CONTROL ---
  bool solenoidShouldBeOpen = false;
  if (solenoidMode == "on") {
    solenoidShouldBeOpen = true;
  } else if (solenoidMode == "off") {
    solenoidShouldBeOpen = false;
  } else {
    if (!solenoidAutoActive && currentMaxTemp >= solenoidTriggerTemp) {
      solenoidAutoActive = true;
    } else if (solenoidAutoActive && currentMaxTemp < (solenoidTriggerTemp - solenoidHysteresis)) {
      solenoidAutoActive = false;
    }
    solenoidShouldBeOpen = solenoidAutoActive;
  }
  digitalWrite(RELAY_IN2, solenoidShouldBeOpen ? RELAY_ON : RELAY_OFF);

  // --- 3. ANOMALY DETECTION & EMERGENCY SMS ---
  bool isHighTempAlert = (currentMaxTemp >= solenoidTriggerTemp);
  bool isNoiseAlert    = (currentAudioLevel > AUDIO_NOISE_THRESHOLD);
  bool isMotionAlert   = (motionState == HIGH);

  if (isHighTempAlert || isNoiseAlert || isMotionAlert) {
    // Tell the ESP32-CAM to save an alert snapshot (rate-limited, with reason)
    if (millis() - lastSnapCmdTime > SNAP_COOLDOWN_MS || lastSnapCmdTime == 0) {
      lastSnapCmdTime = millis();
      String reason = isHighTempAlert ? "TEMP" : (isNoiseAlert ? "NOISE" : "MOTION");
      camSerial.println("SNAP:" + reason);
    }

    if (millis() - lastAlertSMSTime > ALERT_COOLDOWN_MS || lastAlertSMSTime == 0) {
      lastAlertSMSTime = millis();
      String alertMsg = "🚨 PIG FARM ALERT!\nTemp: " + String(currentMaxTemp, 1) + "C\nNoise: " + String(currentAudioLevel);
      broadcastSMS(alertMsg);
    }
  }

  // --- 4. HOURLY STATUS REPORT ---
  bool triggerHourlyReport = false;
  if (hasTime) {
    if (timeinfo.tm_hour != lastReportedHour) {
      triggerHourlyReport = true;
      lastReportedHour = timeinfo.tm_hour;
    }
  } else if (millis() - lastHourlySMSFallback > ONE_HOUR_MS) {
    triggerHourlyReport = true;
    lastHourlySMSFallback = millis();
  }

  if (triggerHourlyReport) {
    String hourlyMsg = "📋 HOURLY STATUS\nTemp: " + String(currentMaxTemp, 1) + "C\nBulb: " + (bulbShouldBeOn ? "ON" : "OFF") + "\nSolenoid: " + (solenoidShouldBeOpen ? "OPEN" : "CLOSED");
    broadcastSMS(hourlyMsg);
  }

  // --- 5. CLOUD SETTINGS SYNC (Every 10s) ---
  if (millis() - lastSettingsFetch > settingsFetchInterval) {
    lastSettingsFetch = millis();
    fetchCloudData();
  }

  // --- 6. PERIODIC TELEMETRY SYNC (Every 15s) + AUDIO CLIP (Every 60s) ---
  if (millis() - lastSyncUpdate > syncInterval) {
    lastSyncUpdate = millis();

    String newAudioUrl = "";
    if (WiFi.status() == WL_CONNECTED &&
        (lastAudioUpload == 0 || millis() - lastAudioUpload > audioInterval)) {
      lastAudioUpload = millis();
      if (recordAudioChunk()) {
        newAudioUrl = uploadAudioToSupabase();
      }
    }

    uploadTelemetryToSupabase(ambientTemp, floorTemp, currentAudioLevel, motionState, newAudioUrl);
  }

  // Only listen to SIM800L module responses
  while (sim800.available()) {
    Serial.write(sim800.read());
  }

  delay(500);
}
