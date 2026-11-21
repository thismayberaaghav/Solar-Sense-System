# SolarSense — Hardware Cleaning Sequence + ThingSpeak Integration

This build preserves the existing Firebase authentication, Admin/Client/Engineer roles,
Cleaning History, Cleaning Schedules and Engineer Maintenance Records. It replaces the
client dashboard's 8-second browser-only cleaning animation with a Firestore-backed,
one-shot hardware command.

## What the updated sequence does

1. An authenticated, active Client presses **Execute Sweep Sequence**.
2. The dashboard creates one `CLEAN_ONCE` document in `cleaningCommands`.
3. The ESP32 signs in using an **active Engineer account**, polls only commands for
   `solarsense-01`, and forwards one `CLEAN_ONCE` line to the UNO.
4. The UNO moves the SG90 from its calibrated home position across the sweep range
   and back once, then reports `ACK:COMPLETED`.
5. The ESP32 updates the Firestore command status. The dashboard listens for that
   acknowledgement and only then shows the cycle as completed.
6. **Halt Actuator** changes the command to `stop-requested`; the ESP32 forwards
   `STOP` to the UNO, which returns the servo to home and reports `ACK:STOPPED`.

The dashboard does not create a simulated “completed” cleaning-history record for
this hardware request. Existing simulation records remain labelled as simulated.

## Before uploading

### 1. Firestore rules

Publish the updated `firestore.rules` in Firebase Console → Firestore Database → Rules.
This adds `cleaningCommands` rules:
- Active Clients can create a command for their own UID and read only their own command.
- Active Engineers can read and update commands for `solarsense-01`.
- Other users cannot create, read or update these commands.

Keep the existing user, schedule, cleaning-history and maintenance-record rules intact.

### 2. Create/use an Engineer device account

Use an existing Firebase account whose Firestore profile is active and has the `engineer`
role. Put that account's email/password in the ESP32 sketch. Do not use a Client account.
The ESP32 account credentials are stored on the device; keep the board physically secure.
Do not commit real Wi-Fi or account credentials into a public repository.

### 3. ThingSpeak

Channel `3531242` is retained:
- Field 1: panel voltage in volts
- Field 2: panel current in amperes

Put the channel **Write API Key** into `THINGSPEAK_WRITE_API_KEY` in the ESP32 sketch.
The existing dashboard Read API Key remains in the dashboard configuration. The write key
is not placed in browser JavaScript.

### 4. Hardware wiring

UNO ↔ ESP32 UART (9600 baud):
- UNO D10 (TX) → 1 kΩ resistor → junction → ESP32 GPIO16 (RX2)
- junction → 2 kΩ resistor → GND (5 V to 3.3 V divider)
- ESP32 GPIO17 (TX2) → UNO D11 (RX)
- UNO GND ↔ ESP32 GND

Sensor/actuator pins retained from the established wiring:
- Voltage sensor S → UNO A2
- ACS712 OUT → UNO A3
- SG90 signal → UNO D12

Power both development boards from their own USB supplies during initial testing.
Do not connect the 5 V rails together. For the SG90 under wiper load, use a separate
regulated 5 V supply with adequate current and connect its ground to UNO GND.
Do not power a loaded servo from the UNO 5 V pin.

### 5. Upload order

1. Install ArduinoJson 6.x in Arduino IDE.
2. Open `firmware/uno_controller/uno_controller.ino`, select Arduino UNO and upload.
3. Open `firmware/esp32_gateway/esp32_gateway.ino`, select ESP32 Dev Module.
4. Fill Wi-Fi SSID/password, active Engineer email/password and ThingSpeak Write API Key.
5. Upload to ESP32 and open Serial Monitor at 115200 baud.
6. Confirm Wi-Fi and Firebase sign-in succeed; confirm ThingSpeak receives Field 1/2.
7. Sign in to the website as an active Client and press Execute Sweep Sequence once.
8. Verify one servo sweep and that the command status changes queued → running → completed.

## Calibration / safety notes

- The UNO sketch assumes a common 0–25 V divider ratio of 5.0 and an ACS712 5 A
  sensitivity of 185 mV/A. These are provisional assumptions, not calibrated facts.
  Verify the actual sensor variant, divider ratio and ADC reference against a multimeter
  before trusting telemetry.
- ACS712 zero offset is averaged at startup; ensure no current is flowing during that
  calibration.
- Servo endpoints 30° and 150° are provisional. Test with the linkage disconnected or
  unloaded first, then adjust `SERVO_MIN`, `SERVO_MAX` and `SERVO_HOME` to avoid binding.
- The current actuator sequence is one dry servo sweep. Pump/relay operation is not
  included, as previously agreed.
- The ESP32 uses `setInsecure()` for HTTPS in this prototype. Use certificate validation
  before production deployment.
- ThingSpeak channel writes are rate-limited; telemetry is sent at approximately 15-second
  intervals. A command may wait for the ESP32's 10-second polling interval.
- A browser timeout or lost network does not prove the actuator stopped. Check the
  controller and command status before issuing another cycle.
