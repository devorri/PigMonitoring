/*
 * ========================================================
 *  PIG MONITORING SYSTEM - MAIN ESP32
 *  This is the version that ran without crashing, with ONLY these changes:
 *   1. SIM800L / camera link / SMS removed (not on this board anymore)
 *   2. Pins updated to the current wiring (see below)
 *   3. Relays only follow Supabase (nothing stored on the board, OFF until loaded)
 *   4. Serial shows the mic level after each clip
 *  Audio is recorded to LittleFS then uploaded, exactly like that version.
 * ========================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <Adafruit_MLX90614.h>
#include <driver/i2s.h>
#include <esp_system.h>
#include <time.h>

// ========================================================
// --- PIN DEFINITIONS (change here if your wiring differs) ---
// ========================================================
#define RELAY_IN1 14  // Heating Bulb Relay   (2-ch module IN1)
#define RELAY_IN2 12  // Water Solenoid Relay (2-ch module IN2)

// Active-Low Relay Logic (LOW = ON, HIGH = OFF)
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// INMP441 I2S Microphone Pins (VDD -> 3.3V, GND -> GND, L/R -> GND)
#define I2S_SCK 18
#define I2S_WS  19
#define I2S_SD  23
#define I2S_PORT I2S_NUM_0

// MLX90614: SDA 21, SCL 22

// ========================================================
// --- HARDWARE & STORAGE OBJECTS ---
// ========================================================
Adafruit_MLX90614 mlx = Adafruit_MLX90614();
Preferences preferences;
SemaphoreHandle_t i2sMutex;      // Only ONE reader of the I2S port at a time
WiFiClientSecure secureClient;   // ONE shared TLS connection (no new handshake every request)

// ========================================================
// --- SUPABASE CONFIGURATION ---
// ========================================================
#define SUPABASE_URL "https://rembfnigpvtuxoyjjexf.supabase.co"
const char* supabaseSettingsUrl = SUPABASE_URL "/rest/v1/system_settings";
const char* supabaseAudioUrl    = SUPABASE_URL "/storage/v1/object/audio/periodic_sound.wav";
const char* supabaseAudioPublic = SUPABASE_URL "/storage/v1/object/public/audio/periodic_sound.wav";
const char* supabaseSensorUrl   = SUPABASE_URL "/rest/v1/sensor_logs";
const char* supabaseStatusUrl   = SUPABASE_URL "/rest/v1/system_settings?setting_key=eq.main_status";
const char* supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlbWJmbmlncHZ0dXhveWpqZXhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NDUzMTksImV4cCI6MjEwNDIyMTMxOX0.HIZvxN9LRPQl_9vh-bY1rqaMbh2mHhvGWIqZrR9ZftA";

// ========================================================
// --- AUDIO RECORDING SETTINGS ---
// ========================================================
#define AUDIO_SAMPLE_RATE   16000
#define AUDIO_SECONDS       5         // 5s clip -> model analyzes 5 x 1s chunks
#define AUDIO_GAIN_SHIFT    14        // 16 = no gain, 15 = 2x, 14 = 4x (clipped safely)
#define AUDIO_FILE          "/periodic_sound.wav"

// ========================================================
// --- CRASH PROTECTION ---
// ========================================================
#define MIN_SAFE_HEAP_BLOCK 30000     // a TLS connection needs ~30KB in one block
unsigned long lastStatusReport = 0;
const unsigned long STATUS_INTERVAL_MS = 60000;
String bootReason = "";

// Shared variables
volatile int currentAudioLevel = 0;
unsigned long lastSyncUpdate = 0;
unsigned long syncInterval = 15000;          // Cloud telemetry sync: every 15s
unsigned long lastAudioUpload = 0;
unsigned long audioInterval = 60000;         // Audio clip: every 60s (setting: audio_interval_seconds)
unsigned long lastSettingsFetch = 0;
const unsigned long settingsFetchInterval = 10000; // Check DB every 10s for manual controls

// ========================================================
// --- RELAY MODES & RULES (all from Supabase) ---
// ========================================================
bool settingsLoaded = false;      // relays stay OFF until settings arrive from Supabase
String bulbMode = "off";
String solenoidMode = "off";

int bulbStartHour = 18;           // 6:00 PM (18:00)
int bulbEndHour = 6;              // 6:00 AM (06:00)
float solenoidTriggerTemp = 38.0; // Open solenoid at 38°C and up
float solenoidHysteresis = 1.0;   // Shut off < 37°C
bool solenoidAutoActive = false;

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
  preferences.putString("restart_why", why);
  digitalWrite(RELAY_IN1, RELAY_OFF);
  digitalWrite(RELAY_IN2, RELAY_OFF);
  delay(200);
  ESP.restart();
}

void checkHeap() {
  if (ESP.getMaxAllocHeap() < MIN_SAFE_HEAP_BLOCK) {
    safeRestart("LOW_MEMORY heap=" + String(ESP.getFreeHeap()) +
                " block=" + String(ESP.getMaxAllocHeap()));
  }
}

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
// --- SHARED HTTPS HELPERS ---
// ========================================================
bool beginRequest(HTTPClient& https, const char* url) {
  if (WiFi.status() != WL_CONNECTED) return false;
  https.setReuse(true);
  https.setTimeout(15000);
  if (!https.begin(secureClient, url)) return false;
  https.addHeader("apikey", supabaseKey);
  https.addHeader("Authorization", String("Bearer ") + supabaseKey);
  return true;
}

// Negative codes = connection problem -> drop the socket so the next call reconnects clean
void finishRequest(HTTPClient& https, int code) {
  https.end();
  if (code < 0) secureClient.stop();
}

// ========================================================
// --- FETCH SETTINGS FROM SUPABASE ---
// ========================================================
void fetchCloudData() {
  HTTPClient https;
  if (!beginRequest(https, supabaseSettingsUrl)) return;

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
      if (!settingsLoaded) {
        settingsLoaded = true;
        Serial.printf("[SETTINGS] Loaded from Supabase: bulb=%s solenoid=%s\n",
                      bulbMode.c_str(), solenoidMode.c_str());
      }
    }
  } else {
    Serial.printf("[SETTINGS] Fetch failed: HTTP %d\n", code);
  }
  finishRequest(https, code);
}

// ========================================================
// --- STATUS REPORT (visible in system_settings -> main_status) ---
// ========================================================
void reportStatus() {
  HTTPClient https;
  if (!beginRequest(https, supabaseStatusUrl)) return;
  https.addHeader("Content-Type", "application/json");
  https.addHeader("Prefer", "return=minimal");

  String status = "uptime=" + String(millis() / 60000) + "min"
                + " heap=" + String(ESP.getFreeHeap())
                + " minheap=" + String(ESP.getMinFreeHeap())
                + " block=" + String(ESP.getMaxAllocHeap())
                + " rssi=" + String(WiFi.RSSI())
                + " boot=" + bootReason;

  JsonDocument doc;
  doc["setting_value"] = status;
  String body;
  serializeJson(doc, body);

  int code = https.sendRequest("PATCH", body);
  finishRequest(https, code);
  Serial.println("[STATUS] " + status);
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
  Serial.printf("[AUDIO] Recorded %us clip | mic peak level: %d (0 = silence)\n",
                AUDIO_SECONDS, (int)currentAudioLevel);
  return true;
}

// Returns the public URL (with cache-buster) on success, "" on failure
String uploadAudioToSupabase() {
  if (!LittleFS.exists(AUDIO_FILE)) return "";
  File file = LittleFS.open(AUDIO_FILE, "r");
  if (!file) return "";

  String result = "";
  HTTPClient https;
  if (beginRequest(https, supabaseAudioUrl)) {
    https.setTimeout(20000);
    https.addHeader("Content-Type", "audio/wav");
    https.addHeader("x-upsert", "true");          // REQUIRED to overwrite the same file
    https.addHeader("cache-control", "max-age=0"); // don't let the CDN serve an old clip

    int code = https.sendRequest("POST", &file, file.size());
    if (code == 200) {
      time_t now = time(nullptr);
      unsigned long stamp = (now > 1700000000) ? (unsigned long)now : millis();
      result = String(supabaseAudioPublic) + "?t=" + String(stamp);
      Serial.println("[AUDIO] Upload OK");
    } else {
      Serial.printf("[AUDIO] Upload failed: HTTP %d\n", code);
    }
    finishRequest(https, code);
  }
  file.close();
  return result;
}

void uploadTelemetryToSupabase(float ambient, float floor, int audioLvl, String audioUrl) {
  HTTPClient https;
  if (!beginRequest(https, supabaseSensorUrl)) return;
  https.addHeader("Content-Type", "application/json");
  https.addHeader("Prefer", "return=minimal");

  JsonDocument doc;
  doc["ambient_temp"] = ambient;
  doc["floor_temp"] = floor;
  doc["audio_level"] = audioLvl;
  doc["motion_detected"] = false;   // no PIR installed
  // Only rows that carry a NEW clip get an audio_url
  if (audioUrl.length() > 0) doc["audio_url"] = audioUrl;
  else doc["audio_url"] = nullptr;

  String jsonBody;
  serializeJson(doc, jsonBody);
  int code = https.POST(jsonBody);
  if (code != 201 && code != 200) {
    Serial.printf("[TELEMETRY] Insert failed: HTTP %d\n", code);
  }
  finishRequest(https, code);
}

// ========================================================
// --- SYSTEM SETUP ---
// ========================================================
void setup() {
  // Relays OFF first thing, BEFORE switching to output, so nothing clicks ON at boot
  digitalWrite(RELAY_IN1, RELAY_OFF);
  digitalWrite(RELAY_IN2, RELAY_OFF);
  pinMode(RELAY_IN1, OUTPUT);
  pinMode(RELAY_IN2, OUTPUT);

  Serial.begin(115200);
  delay(1000);

  if (!LittleFS.begin(true)) {
    Serial.println("[ERROR] LittleFS Mount Failed");
  }

  preferences.begin("pig_farm", false);

  // Why did we (re)boot? If it was our own planned restart, show that reason instead
  bootReason = resetReasonText();
  if (bootReason == "SOFTWARE_RESTART") {
    String why = preferences.getString("restart_why", "");
    if (why.length()) bootReason = "PLANNED:" + why;
  }
  preferences.remove("restart_why");
  Serial.println("[BOOT] Reset reason: " + bootReason);

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("PigFarm-Setup")) {
    Serial.println("[WARNING] Wi-Fi setup timed out.");
  } else {
    configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  }
  WiFi.setAutoReconnect(true);
  secureClient.setInsecure();

  Wire.begin(21, 22);
  mlx.begin();

  i2sMutex = xSemaphoreCreateMutex();
  setupI2S();
  xTaskCreatePinnedToCore(audioTask, "AudioTask", 4096, NULL, 1, NULL, 0);

  fetchCloudData();
  reportStatus();
  Serial.println("[BOOT] Clean system fully initialized.");
}

// ========================================================
// --- MAIN LOOP ---
// ========================================================
void loop() {
  // Read the MLX only while the mic is paused (never both at the same time)
  xSemaphoreTake(i2sMutex, portMAX_DELAY);
  float ambientTemp = mlx.readAmbientTempC();
  float floorTemp = mlx.readObjectTempC();
  xSemaphoreGive(i2sMutex);
  float currentMaxTemp = (ambientTemp > floorTemp) ? ambientTemp : floorTemp;

  struct tm timeinfo;
  bool hasTime = getLocalTime(&timeinfo, 50);

  // --- 1. HEATING BULB CONTROL (follows Supabase) ---
  bool bulbShouldBeOn = false;
  if (!settingsLoaded) {
    bulbShouldBeOn = false;
  } else if (bulbMode == "on") {
    bulbShouldBeOn = true;
  } else if (bulbMode == "off") {
    bulbShouldBeOn = false;
  } else if (hasTime) {
    if (timeinfo.tm_hour >= bulbStartHour || timeinfo.tm_hour < bulbEndHour) {
      bulbShouldBeOn = true;
    }
  }
  digitalWrite(RELAY_IN1, bulbShouldBeOn ? RELAY_ON : RELAY_OFF);

  // --- 2. WATER SOLENOID CONTROL (follows Supabase) ---
  bool solenoidShouldBeOpen = false;
  if (!settingsLoaded) {
    solenoidShouldBeOpen = false;
  } else if (solenoidMode == "on") {
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

  // --- 3. CLOUD SETTINGS SYNC (Every 10s) ---
  if (millis() - lastSettingsFetch > settingsFetchInterval) {
    lastSettingsFetch = millis();
    fetchCloudData();
  }

  // --- 4. PERIODIC TELEMETRY SYNC (Every 15s) + AUDIO CLIP (Every 60s) ---
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

    uploadTelemetryToSupabase(ambientTemp, floorTemp, currentAudioLevel, newAudioUrl);
  }

  // --- 5. HEALTH REPORT + MEMORY GUARD (Every 60s) ---
  if (millis() - lastStatusReport > STATUS_INTERVAL_MS) {
    lastStatusReport = millis();
    reportStatus();
    checkHeap();
  }

  delay(500);
}
