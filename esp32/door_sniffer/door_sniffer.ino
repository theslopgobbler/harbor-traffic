// Harbor door sniffer — first bench test.
// Puts the ESP32 in WiFi promiscuous (monitor) mode and prints every device it hears
// to the USB serial monitor: seconds-up, channel, RSSI, transmitter MAC, frame type.
// RECEIVE-ONLY (promiscuous never transmits), so it's safe to run without the antenna
// attached — range is just shorter. Hops channels 1/6/11 (where phones probe).
// Next step (later): report these over WiFi to the desktop instead of just printing.

#include <WiFi.h>
#include "esp_wifi.h"

static const uint8_t CHANNELS[] = {1, 6, 11};
static uint8_t ci = 0;

void onFrame(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (wifi_promiscuous_pkt_t *)buf;
  const uint8_t *p = pkt->payload;             // 802.11 frame
  const uint8_t *a2 = p + 10;                   // addr2 = transmitter (the device that sent it)
  if (a2[0] == 0xff && a2[1] == 0xff) return;   // skip broadcast source
  const char *t = (type == WIFI_PKT_MGMT) ? "mgmt"
                 : (type == WIFI_PKT_DATA) ? "data"
                 : (type == WIFI_PKT_CTRL) ? "ctrl" : "misc";
  Serial.printf("%6lus  ch%-2d  %4ddBm  %02X:%02X:%02X:%02X:%02X:%02X  %s\n",
                millis() / 1000, CHANNELS[ci], pkt->rx_ctrl.rssi,
                a2[0], a2[1], a2[2], a2[3], a2[4], a2[5], t);
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\n== Harbor door sniffer ==");
  Serial.println("sec   ch   rssi   transmitter MAC      type");
  WiFi.mode(WIFI_STA);        // bring the WiFi stack up...
  WiFi.disconnect();          // ...but don't join anything
  delay(100);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&onFrame);
  esp_wifi_set_channel(CHANNELS[ci], WIFI_SECOND_CHAN_NONE);
}

void loop() {
  delay(300);                                   // ~0.3 s per channel
  ci = (ci + 1) % (sizeof(CHANNELS) / sizeof(CHANNELS[0]));
  esp_wifi_set_channel(CHANNELS[ci], WIFI_SECOND_CHAN_NONE);
}
