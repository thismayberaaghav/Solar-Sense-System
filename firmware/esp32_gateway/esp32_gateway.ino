/*
  SolarSense ESP32 gateway
  - Reads UNO UART telemetry: DATA,<voltage>,<current>
  - Publishes ThingSpeak Field 1 = voltage (V), Field 2 = current (A)
  - Polls Firestore for a single queued CLEAN_ONCE command
  - Relays one command to UNO and writes running/completed/stopped/failed status

  Libraries: ArduinoJson 6.x
  Board: ESP32 Dev Module
  UART2: RX2 GPIO16, TX2 GPIO17, 9600 baud
  Set Wi-Fi, ThingSpeak WRITE key and an ACTIVE ENGINEER Firebase account below.
  Do not use a client account for the device.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "Raaghav's Note 15 Pro 5G";
const char* WIFI_PASSWORD = "Raaghav@15";

const char* FIREBASE_API_KEY = "AIzaSyCwpviKRcWii33vVD7VB_LtpOYDr-tU8BA";
const char* FIREBASE_PROJECT_ID = "solarpanelmonitoring-930f5";
const char* DEVICE_ENGINEER_EMAIL = "keshavbhardwaj141@gmail.com";
const char* DEVICE_ENGINEER_PASSWORD = "Keshav@1234";

const char* THINGSPEAK_CHANNEL_ID = "3531242";
const char* THINGSPEAK_WRITE_API_KEY = "74KDQDZSO0IOLMQ5";

const char* DEVICE_ID = "solarsense-01";
const char* UNO_DONE_TOKEN = "ACK:COMPLETED";
const unsigned long COMMAND_POLL_MS = 10000;
const unsigned long TOKEN_REFRESH_MS = 3000000UL;
const unsigned long THINGSPEAK_MIN_WRITE_MS = 16000;

HardwareSerial UnoSerial(2);
WiFiClientSecure secureClient;
String idToken;
String refreshToken;
unsigned long tokenAt = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastThingSpeakWrite = 0;
String activeCommandPath;
bool commandRunning = false;
float latestVoltage = NAN, latestCurrent = NAN;
String serialLine;

String firestoreBase() {
  return String("https://firestore.googleapis.com/v1/projects/") + FIREBASE_PROJECT_ID +
         "/databases/(default)/documents";
}

bool firebaseSignIn() {
  WiFiClientSecure client;
  client.setInsecure(); // prototype TLS; use certificate pinning for production
  HTTPClient https;
  String url = String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=") + FIREBASE_API_KEY;
  if (!https.begin(client, url)) return false;
  https.addHeader("Content-Type", "application/json");
  StaticJsonDocument<256> body;
  body["email"] = DEVICE_ENGINEER_EMAIL;
  body["password"] = DEVICE_ENGINEER_PASSWORD;
  body["returnSecureToken"] = true;
  String payload; serializeJson(body, payload);
  int code = https.POST(payload);
  String response = https.getString();
  https.end();
  if (code != 200) {
    Serial.printf("Firebase sign-in failed: %d %s\n", code, response.c_str());
    return false;
  }
  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, response)) return false;
  idToken = doc["idToken"].as<String>();
  refreshToken = doc["refreshToken"].as<String>();
  tokenAt = millis();
  return idToken.length() > 0;
}

bool ensureToken() {
  if (idToken.length() && millis() - tokenAt < TOKEN_REFRESH_MS) return true;
  return firebaseSignIn();
}

bool firestorePatchStatus(const String& documentPath, const char* status) {
  if (!ensureToken()) return false;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient https;
  String url = firestoreBase() + "/" + documentPath + "?updateMask.fieldPaths=status";
  if (!https.begin(client, url)) return false;
  https.addHeader("Authorization", "Bearer " + idToken);
  https.addHeader("Content-Type", "application/json");
  StaticJsonDocument<256> doc;
  doc["fields"]["status"]["stringValue"] = status;
  String payload; serializeJson(doc, payload);
  int code = https.PATCH(payload);
  String response = https.getString();
  https.end();
  if (code < 200 || code >= 300) Serial.printf("Firestore status update failed %d: %s\n", code, response.c_str());
  return code >= 200 && code < 300;
}

bool getQueuedCommand(String& path, String& commandId, String& status) {
  if (!ensureToken()) return false;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient https;
  String url = firestoreBase() + ":runQuery";
  if (!https.begin(client, url)) return false;
  https.addHeader("Authorization", "Bearer " + idToken);
  https.addHeader("Content-Type", "application/json");

  StaticJsonDocument<512> query;
  JsonObject structured = query.createNestedObject("structuredQuery");
  JsonArray from = structured.createNestedArray("from");
  from.createNestedObject()["collectionId"] = "cleaningCommands";
  JsonObject filter = structured.createNestedObject("where").createNestedObject("fieldFilter");
  filter["field"]["fieldPath"] = "deviceId";
  filter["op"] = "EQUAL";
  filter["value"]["stringValue"] = DEVICE_ID;
  structured["limit"] = 25;

  String payload; serializeJson(query, payload);
  int code = https.POST(payload);
  String response = https.getString();
  https.end();
  if (code != 200) {
    Serial.printf("Firestore query failed %d: %s\n", code, response.c_str());
    return false;
  }
  DynamicJsonDocument result(8192);
  if (deserializeJson(result, response)) return false;
  for (JsonObject row : result.as<JsonArray>()) {
    if (!row.containsKey("document")) continue;
    JsonObject document = row["document"];
    JsonObject fields = document["fields"];
    String candidateStatus = fields["status"]["stringValue"].as<String>();
    if (candidateStatus != "queued" && candidateStatus != "stop-requested") continue;
    status = candidateStatus;
    String name = document["name"].as<String>();
    int cut = name.lastIndexOf('/');
    if (cut < 0) continue;
    path = "cleaningCommands/" + name.substring(cut + 1);
    commandId = name.substring(cut + 1);
    return true;
  }
  return false;
}

bool writeThingSpeak(float voltage, float current) {
  if (WiFi.status() != WL_CONNECTED || millis() - lastThingSpeakWrite < THINGSPEAK_MIN_WRITE_MS) return false;
  WiFiClientSecure client;
  client.setInsecure(); // prototype TLS; validate certificates before production
  HTTPClient http;
  String url = String("https://api.thingspeak.com/update?api_key=") + THINGSPEAK_WRITE_API_KEY +
               "&field1=" + String(voltage, 2) + "&field2=" + String(current, 3);
  if (!http.begin(client, url)) return false;
  int code = http.GET();
  String response = http.getString();
  http.end();
  lastThingSpeakWrite = millis();
  if (code == 200 && response.toInt() > 0) {
    Serial.printf("ThingSpeak update entry %s\n", response.c_str());
    return true;
  }
  Serial.printf("ThingSpeak write failed %d: %s\n", code, response.c_str());
  return false;
}

void processUnoLine(const String& line) {
  if (line.startsWith("DATA,")) {
    int comma = line.indexOf(',', 5);
    if (comma > 0) {
      latestVoltage = line.substring(5, comma).toFloat();
      latestCurrent = line.substring(comma + 1).toFloat();
      writeThingSpeak(latestVoltage, latestCurrent);
    }
  } else if (line == "ACK:STARTED" && commandRunning) {
    firestorePatchStatus(activeCommandPath, "running");
  } else if (line == "ACK:COMPLETED" && commandRunning) {
    firestorePatchStatus(activeCommandPath, "completed");
    commandRunning = false;
    activeCommandPath = "";
  } else if (line == "ACK:STOPPED" && commandRunning) {
    firestorePatchStatus(activeCommandPath, "stopped");
    commandRunning = false;
    activeCommandPath = "";
  }
}

void setup() {
  Serial.begin(115200);
  UnoSerial.begin(9600, SERIAL_8N1, 16, 17);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting Wi-Fi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) {
    delay(500); Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(WiFi.localIP());
    firebaseSignIn();
  } else {
    Serial.println("Wi-Fi unavailable; UART still active.");
  }
}

void loop() {
  while (UnoSerial.available()) {
    char c = (char)UnoSerial.read();
    if (c == '\n') {
      serialLine.trim();
      if (serialLine.length()) processUnoLine(serialLine);
      serialLine = "";
    } else if (c != '\r' && serialLine.length() < 160) {
      serialLine += c;
    }
  }

  if (WiFi.status() == WL_CONNECTED && millis() - lastCommandPoll >= COMMAND_POLL_MS) {
    lastCommandPoll = millis();
    if (!commandRunning) {
      String path, id, status;
      if (getQueuedCommand(path, id, status)) {
        if (status == "queued") {
          activeCommandPath = path;
          commandRunning = true;
          UnoSerial.println("CLEAN_ONCE");
          Serial.printf("Forwarded one-shot cleaning command %s to UNO\n", id.c_str());
        } else if (status == "stop-requested") {
          // A stop request is only meaningful while a command is active.
          firestorePatchStatus(path, "stopped");
        }
      }
    } else {
      // While a command is running, look for a client stop request in the same queue.
      String path, id, status;
      if (getQueuedCommand(path, id, status) && status == "stop-requested" && path == activeCommandPath) {
        UnoSerial.println("STOP");
      }
    }
  }
  delay(5);
}
