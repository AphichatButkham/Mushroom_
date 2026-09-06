#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <ArduinoJson.h>

// =====================================================
// PIN & DEVICE CONFIG
// =====================================================
#define RELAY_PIN       23   // ขาสำหรับต่อโมดูลรีเลย์พ่นหมอก
#define RELAY_FAN_PIN   19   // ขาสำหรับต่อโมดูลรีเลย์พัดลม (ทำงานพร้อมกับพ่นหมอก ตามความชื้นเดียวกัน)
#define LED_PIN         2    // ขาไฟ LED ติดบอร์ด ESP32 (GPIO 2)
#define ONE_WIRE_BUS    4    // ขาสำหรับ DS18B20 (โพรบวัดอุณหภูมิเห็ด)

// SHT31 สองตัวอยู่บน I2C บัสเดียวกัน ต้องคนละ Address:
//   - ตัวใน (ในตู้)  : ขา ADDR ต่อ GND (หรือปล่อยลอย) -> address 0x44 (ค่า default)
//   - ตัวนอก (รอบตู้) : ขา ADDR ต่อ VDD (3.3V)          -> address 0x45
#define SHT31_IN_ADDRESS   0x44
#define SHT31_OUT_ADDRESS  0x45

// =====================================================
// BLE UUIDs
// =====================================================
#define BLE_NAME        "ESP32_MUSHROOM"
#define SERVICE_UUID    "d4a10000-1000-4bbb-9000-00a1b2c3d4e5"
#define CHAR_TELEMETRY  "d4a10001-1000-4bbb-9000-00a1b2c3d4e5"
#define CHAR_CONFIG     "d4a10002-1000-4bbb-9000-00a1b2c3d4e5"

// =====================================================
// SENSORS & GLOBALS
// =====================================================
Adafruit_SHT31 sht31In  = Adafruit_SHT31();  // วัดในตู้
Adafruit_SHT31 sht31Out = Adafruit_SHT31();  // วัดภายนอกตู้ (อ้างอิง)
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature ds18b20(&oneWire);

bool sht31InOk = false;
bool sht31OutOk = false;

BLEServer* pServer = NULL;
BLECharacteristic* pCharTelemetry = NULL;
BLECharacteristic* pCharConfig = NULL;
bool deviceConnected = false;

// ตัวแปรเก็บค่าเซนเซอร์และการตั้งค่า
float currentHum = 0.0;      // ความชื้นในตู้
float currentTAir = 0.0;     // อุณหภูมิอากาศในตู้
float currentTSoil = 0.0;    // อุณหภูมิเห็ด (DS18B20)
float currentTAirOut = 0.0;  // อุณหภูมิอากาศภายนอกตู้
float currentHumOut = 0.0;   // ความชื้นภายนอกตู้
bool isMistOn = false;
float targetHum = 75.0; // ค่าความชื้นเป้าหมายเริ่มต้น (%) — ใช้ค่าความชื้น "ในตู้" ควบคุมพ่นหมอก

// =====================================================
// FUNCTION CONTROLS
// =====================================================
void turnOnMist() {
  digitalWrite(RELAY_PIN, HIGH);      // เปิด Relay พ่นหมอก
  digitalWrite(RELAY_FAN_PIN, HIGH);  // เปิด Relay พัดลม (ทำงานพร้อมกัน)
  digitalWrite(LED_PIN, HIGH);        // เปิดไฟ LED บนบอร์ด
  isMistOn = true;
}

void turnOffMist() {
  digitalWrite(RELAY_PIN, LOW);      // ปิด Relay พ่นหมอก
  digitalWrite(RELAY_FAN_PIN, LOW);  // ปิด Relay พัดลม (ทำงานพร้อมกัน)
  digitalWrite(LED_PIN, LOW);        // ปิดไฟ LED บนบอร์ด
  isMistOn = false;
}

// =====================================================
// BLE CALLBACKS
// =====================================================
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      Serial.println("BLE: Connected");
    }
    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      Serial.println("BLE: Disconnected");
      pServer->startAdvertising();
    }
};

class ConfigCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue();
      if (rxValue.length() > 0) {
        Serial.println("Received Config Data:");
        Serial.println(rxValue);

        StaticJsonDocument<128> doc;
        DeserializationError error = deserializeJson(doc, rxValue);
        
        if (error) {
          Serial.print("deserializeJson() failed: ");
          Serial.println(error.c_str());
          return;
        }

        if (doc.containsKey("targetHum")) {
          targetHum = doc["targetHum"];
          Serial.printf("Updated TargetHum: %.1f%%\n", targetHum);
        }
      }
    }
};

// =====================================================
// SETUP
// =====================================================
void setup() {
    Serial.begin(115200);
    delay(1000);

    pinMode(RELAY_PIN, OUTPUT);
    pinMode(RELAY_FAN_PIN, OUTPUT);
    pinMode(LED_PIN, OUTPUT);
    turnOffMist(); 

    Serial.println("================================");
    Serial.println(" SHT31 x2 + DS18B20 + BLE Control");
    Serial.println("================================");

    if (!sht31In.begin(SHT31_IN_ADDRESS)) {
        Serial.println("ERROR: Couldn't find SHT31 (ในตู้, 0x44)!");
        sht31InOk = false;
    } else {
        Serial.println("SHT31 ในตู้ (0x44): OK");
        sht31InOk = true;
    }

    if (!sht31Out.begin(SHT31_OUT_ADDRESS)) {
        Serial.println("ERROR: Couldn't find SHT31 (นอกตู้, 0x45)! ตรวจสอบว่าต่อขา ADDR เข้า VDD แล้วหรือยัง");
        sht31OutOk = false;
    } else {
        Serial.println("SHT31 นอกตู้ (0x45): OK");
        sht31OutOk = true;
    }

    ds18b20.begin();

    // BLE Setup
    BLEDevice::init(BLE_NAME);
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    BLEService *pService = pServer->createService(SERVICE_UUID);

    pCharTelemetry = pService->createCharacteristic(
                       CHAR_TELEMETRY,
                       BLECharacteristic::PROPERTY_NOTIFY
                     );
    pCharTelemetry->addDescriptor(new BLE2902());

    pCharConfig = pService->createCharacteristic(
                      CHAR_CONFIG,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_WRITE
                    );
    pCharConfig->setCallbacks(new ConfigCallbacks());

    // ส่งค่า Initial Config
    StaticJsonDocument<128> cfgDoc;
    cfgDoc["targetHum"] = targetHum;
    String cfgStr;
    serializeJson(cfgDoc, cfgStr);
    pCharConfig->setValue(cfgStr.c_str());

    pService->start();
    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pServer->getAdvertising()->start();
    
    Serial.println("BLE Started. Waiting for connections...");
}

// =====================================================
// LOOP
// =====================================================
void loop() {
    static unsigned long lastReadTime = 0;
    unsigned long currentMillis = millis();

    // อ่านค่าเซนเซอร์ทุก 2 วินาที
    if (currentMillis - lastReadTime >= 2000) {
        lastReadTime = currentMillis;

        currentTAir = sht31In.readTemperature();
        currentHum = sht31In.readHumidity();

        currentTAirOut = sht31Out.readTemperature();
        currentHumOut = sht31Out.readHumidity();

        ds18b20.requestTemperatures();
        currentTSoil = ds18b20.getTempCByIndex(0);

        if (isnan(currentTAir)) currentTAir = 0;
        if (isnan(currentHum)) currentHum = 0;
        if (isnan(currentTAirOut)) currentTAirOut = 0;
        if (isnan(currentHumOut)) currentHumOut = 0;
        if (currentTSoil == DEVICE_DISCONNECTED_C) currentTSoil = 0;

        Serial.printf("In: %.1fC/%.1f%% | Out: %.1fC/%.1f%% | Mushroom: %.1fC | Target: %.1f%% | Mist: %s\n",
                      currentTAir, currentHum, currentTAirOut, currentHumOut, currentTSoil, targetHum, isMistOn ? "ON" : "OFF");

        if (deviceConnected) {
            StaticJsonDocument<256> doc;
            doc["h"] = currentHum;
            doc["tAir"] = currentTAir;
            doc["tSoil"] = currentTSoil;
            doc["tAirOut"] = currentTAirOut;
            doc["hOut"] = currentHumOut;
            doc["mist"] = isMistOn;
            doc["fan"] = isMistOn;   // พัดลมทำงานพร้อมกับพ่นหมอกเสมอ

            String jsonString;
            serializeJson(doc, jsonString);
            
            pCharTelemetry->setValue(jsonString.c_str());
            pCharTelemetry->notify();
        }
    }

    // ระบบควบคุม: ต่ำกว่า targetHum เปิดพ่น / เท่ากับหรือมากกว่า targetHum ปิดพ่น
    if (currentHum < targetHum && currentHum > 0) {
        if (!isMistOn) turnOnMist();
    } else if (currentHum >= targetHum) {
        if (isMistOn) turnOffMist();
    }
}