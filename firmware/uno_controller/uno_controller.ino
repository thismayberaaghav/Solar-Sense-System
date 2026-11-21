/*
  SolarSense UNO actuator + sensor node
  Current wiring confirmed in project notes:
    Voltage sensor S -> A2
    ACS712 OUT -> A3
    SG90 signal -> D12
    ESP32 UART: UNO D10 (TX) -> level shifter -> ESP32 GPIO16 (RX2)
                ESP32 GPIO17 (TX2) -> UNO D11 (RX)
    Common GND. Do not connect the 5V rails together.
  Install: built-in Servo and SoftwareSerial libraries.
  This first hardware-control build performs one servo sweep per CLEAN_ONCE command.
*/
#include <Servo.h>
#include <SoftwareSerial.h>

const uint8_t VOLTAGE_PIN = A2;
const uint8_t CURRENT_PIN = A3;
const uint8_t SERVO_PIN = 12;
const uint8_t ESP_RX_PIN = 11; // UNO receives ESP32 TX
const uint8_t ESP_TX_PIN = 10; // UNO transmits to ESP32 RX through divider

// CALIBRATE these against a multimeter and a known current before relying on readings.
const float ADC_REFERENCE_V = 5.00f;
const float VOLTAGE_DIVIDER_RATIO = 5.00f; // provisional for common 0-25V modules
const float ACS712_SENSITIVITY_V_PER_A = 0.185f; // 5A ACS712 variant only
float acsZeroVoltage = 2.50f; // calibrated at startup with zero current

const int SERVO_HOME = 90;
const int SERVO_MIN = 30;   // calibrate to the actual wiper linkage
const int SERVO_MAX = 150;  // calibrate to the actual wiper linkage
const int SERVO_STEP_DELAY_MS = 18;

Servo wiper;
SoftwareSerial espSerial(ESP_RX_PIN, ESP_TX_PIN);
bool cleaning = false;
bool stopRequested = false;
unsigned long lastTelemetryMs = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 15000;

float readVoltage() {
  const float adc = analogRead(VOLTAGE_PIN);
  const float moduleOut = adc * ADC_REFERENCE_V / 1023.0f;
  return moduleOut * VOLTAGE_DIVIDER_RATIO;
}

float readCurrent() {
  const float adcVoltage = analogRead(CURRENT_PIN) * ADC_REFERENCE_V / 1023.0f;
  return (adcVoltage - acsZeroVoltage) / ACS712_SENSITIVITY_V_PER_A;
}

void sendTelemetry() {
  float v = readVoltage();
  float a = readCurrent();
  if (a < 0 && a > -0.15f) a = 0; // suppress small zero-current offset noise
  espSerial.print(F("DATA,"));
  espSerial.print(v, 2);
  espSerial.print(',');
  espSerial.println(a, 3);
}

void checkStopDuringSweep() {
  while (espSerial.available()) {
    String command = espSerial.readStringUntil('\n');
    command.trim();
    if (command == "STOP") stopRequested = true;
  }
}

bool sweepOnce() {
  cleaning = true;
  stopRequested = false;
  espSerial.println(F("ACK:STARTED"));

  for (int angle = SERVO_MIN; angle <= SERVO_MAX; angle += 2) {
    checkStopDuringSweep();
    if (stopRequested) break;
    wiper.write(angle);
    delay(SERVO_STEP_DELAY_MS);
  }
  for (int angle = SERVO_MAX; angle >= SERVO_MIN; angle -= 2) {
    checkStopDuringSweep();
    if (stopRequested) break;
    wiper.write(angle);
    delay(SERVO_STEP_DELAY_MS);
  }
  wiper.write(SERVO_HOME);
  delay(350);
  cleaning = false;

  if (stopRequested) {
    espSerial.println(F("ACK:STOPPED"));
    return false;
  }
  espSerial.println(F("ACK:COMPLETED"));
  return true;
}

void setup() {
  Serial.begin(115200);
  espSerial.begin(9600);
  espSerial.setTimeout(50);
  wiper.attach(SERVO_PIN);
  wiper.write(SERVO_HOME);

  // Average the ACS712 zero point at startup. Ensure no current flows during boot calibration.
  long sum = 0;
  for (int i = 0; i < 100; i++) {
    sum += analogRead(CURRENT_PIN);
    delay(5);
  }
  acsZeroVoltage = (sum / 100.0f) * ADC_REFERENCE_V / 1023.0f;

  espSerial.println(F("UNO:READY"));
}

void loop() {
  while (espSerial.available()) {
    String command = espSerial.readStringUntil('\n');
    command.trim();
    if (command == "CLEAN_ONCE" && !cleaning) {
      sweepOnce();
    } else if (command == "STOP") {
      stopRequested = true;
      if (!cleaning) {
        wiper.write(SERVO_HOME);
        espSerial.println(F("ACK:STOPPED"));
      }
    } else if (command == "STATUS") {
      espSerial.println(cleaning ? F("ACK:RUNNING") : F("ACK:IDLE"));
    }
  }

  if (millis() - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = millis();
    sendTelemetry();
  }
}
