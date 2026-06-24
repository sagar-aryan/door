#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <esp_arduino_version.h>

// ===========================
// Wi-Fi credentials
// ===========================
const char *WIFI_SSID = "ssid name";
const char *WIFI_PASSWORD = "ssid password";

// ===========================
// Firebase configuration
// Firebase is now fallback/status only. MQTT is the fast command path.
// ===========================
const char *FIREBASE_API_KEY = "firebase api";
const char *FIREBASE_DATABASE_URL = "firebase api";
const char *FIREBASE_DEVICE_EMAIL = "username";
const char *FIREBASE_DEVICE_PASSWORD = "password";
const char *DEVICE_ID = "front-gate";

// ===========================
// MQTT configuration
// Use a cloud broker that supports MQTT over TLS on 8883 and browser WSS.
// Examples: HiveMQ Cloud or EMQX Serverless.
// ===========================
const char *MQTT_HOST = "mqtt host";
const int MQTT_PORT = 8883;
const char *MQTT_USERNAME = "name";
const char *MQTT_PASSWORD = "password";
const char *MQTT_TOPIC_PREFIX = "intercom/front-gate";

static const int SERVO_CAMERA_PIN = 4;
static const int SERVO_UNLOCK_PIN = 5;
static const int SERVO_CAMERA_CHANNEL = 0;
static const int SERVO_UNLOCK_CHANNEL = 1;

static const int SERVO_CAMERA_REST_ANGLE = 0;
static const int SERVO_CAMERA_PRESS_ANGLE = 30;
static const int SERVO_UNLOCK_REST_ANGLE = 180;
static const int SERVO_UNLOCK_PRESS_ANGLE = 150;

static const int PRESS_HOLD_MS = 550;
static const int RETURN_SETTLE_MS = 250;
static const unsigned long FALLBACK_POLL_INTERVAL_MS = 3000;
static const unsigned long STATUS_INTERVAL_MS = 60000;
static const unsigned long TOKEN_REFRESH_MS = 50UL * 60UL * 1000UL;
static const unsigned long MQTT_RECONNECT_INTERVAL_MS = 500;

static const int SERVO_PWM_HZ = 50;
static const int SERVO_PWM_BITS = 14;
static const int SERVO_MIN_US = 500;
static const int SERVO_MAX_US = 2500;

WiFiClientSecure requestClient;
WiFiClientSecure mqttSecureClient;
PubSubClient mqttClient(mqttSecureClient);

String idToken;
String lastProcessedCommandId = "";
String activeAction = "";
bool servoBusy = false;
unsigned long lastFallbackPollAt = 0;
unsigned long lastStatusAt = 0;
unsigned long lastLoginAt = 0;
unsigned long lastMqttConnectAttemptAt = 0;

String jsonEscape(const String &value) {
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (c == '\\' || c == '"') out += '\\';
    out += c;
  }
  return out;
}

String extractJsonString(const String &json, const String &key) {
  String marker = "\"" + key + "\"";
  int keyIndex = json.indexOf(marker);
  if (keyIndex < 0) return "";
  int colon = json.indexOf(':', keyIndex + marker.length());
  if (colon < 0) return "";
  int start = json.indexOf('"', colon + 1);
  if (start < 0) return "";
  String value;
  bool escaping = false;
  for (int i = start + 1; i < json.length(); i++) {
    char c = json[i];
    if (escaping) {
      value += c;
      escaping = false;
    } else if (c == '\\') {
      escaping = true;
    } else if (c == '"') {
      return value;
    } else {
      value += c;
    }
  }
  return "";
}

String firebasePath(const String &path) {
  String url = String(FIREBASE_DATABASE_URL);
  if (url.endsWith("/")) url.remove(url.length() - 1);
  url += path;
  url += ".json?auth=";
  url += idToken;
  return url;
}

bool mqttConfigured() {
  return strlen(MQTT_HOST) > 0 && strcmp(MQTT_HOST, "your-cluster-host.example.com") != 0;
}

String topic(const char *suffix) {
  return String(MQTT_TOPIC_PREFIX) + suffix;
}

int angleToDuty(int angle) {
  angle = constrain(angle, 0, 180);
  int pulseUs = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
  return (pulseUs * ((1 << SERVO_PWM_BITS) - 1)) / 20000;
}

void attachServoPin(int pin, int channel) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  if (!ledcAttach(pin, SERVO_PWM_HZ, SERVO_PWM_BITS)) {
    Serial.printf("Failed to attach servo pin %d\n", pin);
  }
#else
  ledcSetup(channel, SERVO_PWM_HZ, SERVO_PWM_BITS);
  ledcAttachPin(pin, channel);
#endif
}

void writeServoAngle(int pin, int channel, int angle) {
  int duty = angleToDuty(angle);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, duty);
#else
  ledcWrite(channel, duty);
#endif
}

void moveToRest() {
  writeServoAngle(SERVO_CAMERA_PIN, SERVO_CAMERA_CHANNEL, SERVO_CAMERA_REST_ANGLE);
  writeServoAngle(SERVO_UNLOCK_PIN, SERVO_UNLOCK_CHANNEL, SERVO_UNLOCK_REST_ANGLE);
}

bool firebaseRequest(const char *method, const String &url, const String &body, String *response) {
  HTTPClient http;
  http.setTimeout(1200);
  if (!http.begin(requestClient, url)) {
    Serial.println("HTTP begin failed");
    return false;
  }
  http.addHeader("Content-Type", "application/json");

  int code = 0;
  if (strcmp(method, "GET") == 0) code = http.GET();
  else if (strcmp(method, "PUT") == 0) code = http.PUT(body);
  else if (strcmp(method, "PATCH") == 0) code = http.PATCH(body);
  else if (strcmp(method, "POST") == 0) code = http.POST(body);

  String payload = http.getString();
  http.end();

  if (response) *response = payload;
  if (code == 401 || code == 403) {
    Serial.printf("Firebase auth error %d: %s\n", code, payload.c_str());
    idToken = "";
  }
  return code >= 200 && code < 300;
}

bool firebaseLogin() {
  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + String(FIREBASE_API_KEY);
  String body = "{\"email\":\"" + jsonEscape(FIREBASE_DEVICE_EMAIL) + "\",\"password\":\"" + jsonEscape(FIREBASE_DEVICE_PASSWORD) + "\",\"returnSecureToken\":true}";
  String response;
  bool ok = firebaseRequest("POST", url, body, &response);
  if (!ok) {
    Serial.println("Firebase login failed");
    Serial.println(response);
    return false;
  }

  idToken = extractJsonString(response, "idToken");
  lastLoginAt = millis();
  if (idToken.length() == 0) {
    Serial.println("Firebase login response did not contain idToken");
    Serial.println(response);
    return false;
  }

  Serial.println("Firebase login OK");
  return true;
}

bool ensureFirebaseToken() {
  if (idToken.length() == 0) return firebaseLogin();
  if (millis() - lastLoginAt > TOKEN_REFRESH_MS) return firebaseLogin();
  return true;
}

void publishMqttStatus(const String &message) {
  if (!mqttClient.connected()) return;
  String body = "{\"online\":true,\"busy\":" + String(servoBusy ? "true" : "false") + ",\"activeButton\":\"" + jsonEscape(activeAction) + "\",\"message\":\"" + jsonEscape(message) + "\"}";
  mqttClient.publish(topic("/status").c_str(), body.c_str(), true);
}

void publishMqttAck(const String &commandId, const String &action, const String &stage) {
  if (!mqttClient.connected()) return;
  String body = "{\"id\":\"" + jsonEscape(commandId) + "\",\"action\":\"" + jsonEscape(action) + "\",\"stage\":\"" + jsonEscape(stage) + "\",\"deviceMillis\":" + String((unsigned long long)millis()) + "}";
  mqttClient.publish(topic("/ack").c_str(), body.c_str(), false);
}

void updateFirebaseStatus(const String &message) {
  if (!ensureFirebaseToken()) return;
  String path = "/devices/" + String(DEVICE_ID) + "/status";
  String body = "{"
    "\"busy\":" + String(servoBusy ? "true" : "false") + ","
    "\"activeButton\":\"" + jsonEscape(activeAction) + "\","
    "\"lastSeen\":" + String((unsigned long long)millis()) + ","
    "\"lastSeenEpoch\":{\".sv\":\"timestamp\"},"
    "\"lastCompletedCommandId\":\"" + jsonEscape(lastProcessedCommandId) + "\","
    "\"lastCommandAction\":\"" + jsonEscape(activeAction) + "\","
    "\"message\":\"" + jsonEscape(message) + "\""
  "}";
  firebaseRequest("PATCH", firebasePath(path), body, nullptr);
}

void markCommandDone(const String &commandId, const String &action) {
  publishMqttAck(commandId, action, "done");
  publishMqttStatus("Ready");

  if (!ensureFirebaseToken()) return;
  String path = "/devices/" + String(DEVICE_ID) + "/status";
  String body = "{"
    "\"busy\":false,"
    "\"activeButton\":\"\","
    "\"lastSeen\":" + String((unsigned long long)millis()) + ","
    "\"lastSeenEpoch\":{\".sv\":\"timestamp\"},"
    "\"lastCompletedCommandId\":\"" + jsonEscape(commandId) + "\","
    "\"lastCompletedAction\":\"" + jsonEscape(action) + "\","
    "\"lastCommandAction\":\"" + jsonEscape(action) + "\","
    "\"message\":\"Ready\""
  "}";
  firebaseRequest("PATCH", firebasePath(path), body, nullptr);
}

void pressServo(const String &action, const String &commandId) {
  servoBusy = true;
  activeAction = action;
  publishMqttStatus("Pressing " + action);

  if (action == "camera") {
    writeServoAngle(SERVO_CAMERA_PIN, SERVO_CAMERA_CHANNEL, SERVO_CAMERA_PRESS_ANGLE);
    Serial.println("SERVO_START camera " + commandId);
    publishMqttAck(commandId, action, "started");
    delay(PRESS_HOLD_MS);
    writeServoAngle(SERVO_CAMERA_PIN, SERVO_CAMERA_CHANNEL, SERVO_CAMERA_REST_ANGLE);
  } else if (action == "unlock") {
    writeServoAngle(SERVO_UNLOCK_PIN, SERVO_UNLOCK_CHANNEL, SERVO_UNLOCK_PRESS_ANGLE);
    Serial.println("SERVO_START unlock " + commandId);
    publishMqttAck(commandId, action, "started");
    delay(PRESS_HOLD_MS);
    writeServoAngle(SERVO_UNLOCK_PIN, SERVO_UNLOCK_CHANNEL, SERVO_UNLOCK_REST_ANGLE);
  }

  delay(RETURN_SETTLE_MS);
  servoBusy = false;
}

bool runCommandFromJson(const String &json, const String &source) {
  if (json == "null" || json.length() == 0) return false;

  String commandId = extractJsonString(json, "id");
  String action = extractJsonString(json, "action");
  if (commandId.length() == 0 || action.length() == 0 || action == "none") return false;
  if (commandId == lastProcessedCommandId) return false;

  if (action != "camera" && action != "unlock") {
    Serial.println("Ignoring unknown action from " + source + ": " + action);
    lastProcessedCommandId = commandId;
    return false;
  }

  Serial.println("Running command from " + source + ": " + commandId + " action=" + action + " at " + String((unsigned long long)millis()));
  pressServo(action, commandId);
  lastProcessedCommandId = commandId;
  activeAction = "";
  markCommandDone(commandId, action);
  return true;
}

void syncInitialCommandId() {
  if (!ensureFirebaseToken()) return;

  String path = "/devices/" + String(DEVICE_ID) + "/command";
  String response;
  if (!firebaseRequest("GET", firebasePath(path), "", &response)) return;
  if (response == "null" || response.length() == 0) return;

  String commandId = extractJsonString(response, "id");
  if (commandId.length() > 0) {
    lastProcessedCommandId = commandId;
    Serial.println("Initial command synced without replay: " + commandId);
  }
}

void fallbackPollCommand() {
  if (!ensureFirebaseToken()) return;

  String path = "/devices/" + String(DEVICE_ID) + "/command";
  String response;
  if (!firebaseRequest("GET", firebasePath(path), "", &response)) return;
  runCommandFromJson(response, "firebase fallback poll");
}

void mqttCallback(char *messageTopic, byte *payload, unsigned int length) {
  String expectedTopic = topic("/command");
  if (String(messageTopic) != expectedTopic) return;

  String json;
  json.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) json += (char)payload[i];
  runCommandFromJson(json, "mqtt");
}

bool connectMqtt() {
  if (!mqttConfigured()) return false;
  if (mqttClient.connected()) return true;

  unsigned long now = millis();
  if (now - lastMqttConnectAttemptAt < MQTT_RECONNECT_INTERVAL_MS) return false;
  lastMqttConnectAttemptAt = now;

  String clientId = "esp32c3-" + String(DEVICE_ID) + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  String statusTopic = topic("/status");
  String offlinePayload = "{\"online\":false,\"busy\":false,\"activeButton\":\"\",\"message\":\"MQTT disconnected\"}";

  Serial.println("Connecting MQTT...");
  bool ok;
  if (strlen(MQTT_USERNAME) > 0) {
    ok = mqttClient.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD, statusTopic.c_str(), 1, true, offlinePayload.c_str());
  } else {
    ok = mqttClient.connect(clientId.c_str(), statusTopic.c_str(), 1, true, offlinePayload.c_str());
  }

  if (!ok) {
    Serial.printf("MQTT connect failed, state=%d\n", mqttClient.state());
    return false;
  }

  String commandTopic = topic("/command");
  mqttClient.subscribe(commandTopic.c_str(), 1);
  publishMqttStatus("Ready");
  Serial.println("MQTT connected and subscribed to " + commandTopic);
  return true;
}

void processMqtt() {
  if (!mqttConfigured()) return;
  if (connectMqtt()) mqttClient.loop();
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  Serial.print("WiFi connected: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  Serial.println();

  attachServoPin(SERVO_CAMERA_PIN, SERVO_CAMERA_CHANNEL);
  attachServoPin(SERVO_UNLOCK_PIN, SERVO_UNLOCK_CHANNEL);
  moveToRest();

  connectWiFi();
  requestClient.setInsecure();
  mqttSecureClient.setInsecure();
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(768);
  mqttClient.setKeepAlive(15);
  mqttClient.setSocketTimeout(1);

  ensureFirebaseToken();
  syncInitialCommandId();
  updateFirebaseStatus("Ready");
  connectMqtt();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected; reconnecting");
    connectWiFi();
  }

  unsigned long now = millis();
  processMqtt();

  if ((!mqttConfigured() || !mqttClient.connected()) && now - lastFallbackPollAt >= FALLBACK_POLL_INTERVAL_MS) {
    lastFallbackPollAt = now;
    fallbackPollCommand();
  }

  if (now - lastStatusAt >= STATUS_INTERVAL_MS) {
    lastStatusAt = now;
    updateFirebaseStatus(servoBusy ? "Busy" : "Ready");
    publishMqttStatus(servoBusy ? "Busy" : "Ready");
  }
}
