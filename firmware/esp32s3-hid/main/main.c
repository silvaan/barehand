/*
 * barehand firmware for ESP32-S3 (DevKitC-1).
 *
 * Native USB (the "USB" port) -> target PC, enumerating as:
 *   - HID boot keyboard   (own interface, subclass/protocol boot: required by UEFI setup screens)
 *   - HID boot mouse      (relative)
 *   - HID absolute mouse  (tablet-style pointer for OS desktops)
 *   - CDC-ACM serial port (console for the rescue system)
 * UART0 (the "UART" port, via the on-board USB-UART bridge) -> controller PC,
 * speaking the line protocol in docs/protocol.md.
 * GPIO4/GPIO5 drive optocouplers on PWR_SW/RST_SW, GPIO6 senses the power LED.
 *
 * STATUS: written against ESP-IDF 5.x + espressif/esp_tinyusb 1.x, not yet
 * validated on hardware. See firmware/esp32s3-hid/README.md.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "tinyusb.h"
#include "class/hid/hid_device.h"
#include "class/cdc/cdc_device.h"

#define FW_VERSION "0.1.0"

#define LINK_UART UART_NUM_0
#define LINK_BAUD 921600
#define PIN_PWR_SW GPIO_NUM_4
#define PIN_RST_SW GPIO_NUM_5
#define PIN_PLED GPIO_NUM_6

#define LINE_MAX 512
#define CD_CHUNK 96 /* raw console bytes per "CD" line */

/* ---------------------------------------------------------------- USB descriptors */

enum { ITF_KBD = 0, ITF_MOUSE, ITF_ABS, ITF_CDC, ITF_CDC_DATA, ITF_TOTAL };
enum { HID_KBD = 0, HID_MOUSE = 1, HID_ABS = 2 }; /* TinyUSB HID instances, in interface order */

#define EP_KBD 0x81
#define EP_MOUSE 0x82
#define EP_ABS 0x83
#define EP_CDC_NOTIF 0x84
#define EP_CDC_OUT 0x05
#define EP_CDC_IN 0x85

static const uint8_t rd_kbd[] = {TUD_HID_REPORT_DESC_KEYBOARD()};
static const uint8_t rd_mouse[] = {TUD_HID_REPORT_DESC_MOUSE()};

/* Absolute pointer: 3 buttons, X/Y 0..32767, wheel. Report: btn(1) x(2) y(2) wheel(1). */
static const uint8_t rd_abs[] = {
    0x05, 0x01,       /* Usage Page (Generic Desktop) */
    0x09, 0x02,       /* Usage (Mouse) */
    0xA1, 0x01,       /* Collection (Application) */
    0x09, 0x01,       /*   Usage (Pointer) */
    0xA1, 0x00,       /*   Collection (Physical) */
    0x05, 0x09,       /*     Usage Page (Buttons) */
    0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01,
    0x95, 0x03, 0x75, 0x01, 0x81, 0x02, /* 3 button bits */
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03, /* 5 bits padding */
    0x05, 0x01,       /*     Usage Page (Generic Desktop) */
    0x09, 0x30, 0x09, 0x31, /* X, Y */
    0x16, 0x00, 0x00, 0x26, 0xFF, 0x7F, /* 0..32767 */
    0x75, 0x10, 0x95, 0x02, 0x81, 0x02, /* 2x16 bit, absolute */
    0x09, 0x38, 0x15, 0x81, 0x25, 0x7F, /* Wheel -127..127 */
    0x75, 0x08, 0x95, 0x01, 0x81, 0x06, /* relative */
    0xC0, 0xC0,
};

#define CFG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + 3 * TUD_HID_DESC_LEN + TUD_CDC_DESC_LEN)

static const uint8_t desc_cfg[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_TOTAL, 0, CFG_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_HID_DESCRIPTOR(ITF_KBD, 4, HID_ITF_PROTOCOL_KEYBOARD, sizeof(rd_kbd), EP_KBD, 8, 1),
    TUD_HID_DESCRIPTOR(ITF_MOUSE, 5, HID_ITF_PROTOCOL_MOUSE, sizeof(rd_mouse), EP_MOUSE, 8, 1),
    TUD_HID_DESCRIPTOR(ITF_ABS, 6, HID_ITF_PROTOCOL_NONE, sizeof(rd_abs), EP_ABS, 8, 1),
    TUD_CDC_DESCRIPTOR(ITF_CDC, 7, EP_CDC_NOTIF, 8, EP_CDC_OUT, EP_CDC_IN, 64),
};

static const tusb_desc_device_t desc_device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    /* IAD, because CDC spans two interfaces */
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = 0x303A, /* Espressif; TODO: request a PID from the Espressif/pid.codes pool */
    .idProduct = 0x8B4D,
    .bcdDevice = 0x0100,
    .iManufacturer = 1,
    .iProduct = 2,
    .iSerialNumber = 3,
    .bNumConfigurations = 1,
};

static const char *string_desc[] = {
    (const char[]){0x09, 0x04}, /* 0: English */
    "barehand",                 /* 1: manufacturer */
    "barehand HID",             /* 2: product */
    "BH000001",                 /* 3: serial */
    "barehand keyboard",        /* 4 */
    "barehand mouse",           /* 5 */
    "barehand pointer",         /* 6 */
    "barehand console",         /* 7 */
};

/* ---------------------------------------------------------------- link output */

static void link_write(const char *s) { uart_write_bytes(LINK_UART, s, strlen(s)); }

static void link_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void link_printf(const char *fmt, ...) {
    char buf[LINE_MAX + 64];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n > 0) uart_write_bytes(LINK_UART, buf, n < (int)sizeof buf ? n : (int)sizeof buf - 1);
}

/* ---------------------------------------------------------------- HID state */

static uint8_t kbd_mods;
static uint8_t kbd_keys[6];
static uint8_t mouse_buttons;
static bool last_move_abs;
static uint16_t abs_x, abs_y;

static bool hid_wait_ready(uint8_t inst) {
    for (int i = 0; i < 50; i++) { /* up to ~50 ms */
        if (tud_suspended()) tud_remote_wakeup();
        if (tud_hid_n_ready(inst)) return true;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return false;
}

static bool kbd_send(void) {
    if (!hid_wait_ready(HID_KBD)) return false;
    return tud_hid_n_keyboard_report(HID_KBD, 0, kbd_mods, kbd_keys);
}

static void kbd_add(uint8_t usage) {
    if (!usage) return;
    for (int i = 0; i < 6; i++) if (kbd_keys[i] == usage) return;
    for (int i = 0; i < 6; i++) if (!kbd_keys[i]) { kbd_keys[i] = usage; return; }
}

static void kbd_remove(uint8_t usage) {
    for (int i = 0; i < 6; i++) if (kbd_keys[i] == usage) kbd_keys[i] = 0;
}

static bool abs_send(int8_t wheel) {
    if (!hid_wait_ready(HID_ABS)) return false;
    uint8_t r[6] = {mouse_buttons, abs_x & 0xFF, abs_x >> 8, abs_y & 0xFF, abs_y >> 8, (uint8_t)wheel};
    return tud_hid_n_report(HID_ABS, 0, r, sizeof r);
}

static bool rel_send(int8_t dx, int8_t dy, int8_t wheel) {
    if (!hid_wait_ready(HID_MOUSE)) return false;
    return tud_hid_n_mouse_report(HID_MOUSE, 0, mouse_buttons, dx, dy, wheel, 0);
}

/* TinyUSB callbacks */
uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) {
    return instance == HID_KBD ? rd_kbd : instance == HID_MOUSE ? rd_mouse : rd_abs;
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t type, uint8_t *buf,
                               uint16_t reqlen) {
    return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t type, uint8_t const *buf,
                           uint16_t len) {
    /* Keyboard LED state (Num/Caps/Scroll Lock) tells the host what the target thinks. */
    if (instance == HID_KBD && type == HID_REPORT_TYPE_OUTPUT && len >= 1) link_printf("EV LED %02x\n", buf[0]);
}

void tud_mount_cb(void) { link_write("EV USB mounted\n"); }
void tud_umount_cb(void) { link_write("EV USB unmounted\n"); }
void tud_suspend_cb(bool remote_wakeup_en) { link_write("EV USB suspended\n"); }
void tud_resume_cb(void) { link_write("EV USB resumed\n"); }

/* ---------------------------------------------------------------- commands */

static bool usb_ok(void) {
    if (!tud_mounted()) {
        link_write("ERR target USB not mounted (target off, or port unpowered)\n");
        return false;
    }
    return true;
}

static void press_pin(gpio_num_t pin, int ms) {
    if (ms < 20) ms = 20;
    if (ms > 15000) ms = 15000;
    gpio_set_level(pin, 1);
    vTaskDelay(pdMS_TO_TICKS(ms));
    gpio_set_level(pin, 0);
}

static void handle(char *line) {
    char *cmd = strtok(line, " ");
    if (!cmd) return;
    char *a1 = strtok(NULL, " "), *a2 = strtok(NULL, " "), *a3 = strtok(NULL, " ");

    if (!strcmp(cmd, "PING")) {
        link_printf("OK barehand-fw %s usb=%s\n", FW_VERSION, tud_mounted() ? "mounted" : "unmounted");
    } else if (!strcmp(cmd, "KD") || !strcmp(cmd, "KU") || !strcmp(cmd, "KT")) {
        if (!a1 || !a2) { link_write("ERR usage: KD|KU|KT <mods> <usage> [hold_ms]\n"); return; }
        if (!usb_ok()) return;
        uint8_t mods = strtoul(a1, NULL, 16), usage = strtoul(a2, NULL, 16);
        bool ok = true;
        if (cmd[1] == 'D' || cmd[1] == 'T') {
            kbd_mods |= mods;
            kbd_add(usage);
            ok = kbd_send();
        }
        if (cmd[1] == 'T') vTaskDelay(pdMS_TO_TICKS(a3 ? atoi(a3) : 30));
        if (cmd[1] == 'U' || cmd[1] == 'T') {
            kbd_mods &= ~mods;
            kbd_remove(usage);
            ok = kbd_send() && ok;
        }
        link_write(ok ? "OK\n" : "ERR HID endpoint busy\n");
    } else if (!strcmp(cmd, "KR")) {
        kbd_mods = 0;
        memset(kbd_keys, 0, sizeof kbd_keys);
        mouse_buttons = 0;
        if (tud_mounted()) {
            kbd_send();
            last_move_abs ? abs_send(0) : rel_send(0, 0, 0);
        }
        link_write("OK\n");
    } else if (!strcmp(cmd, "MR")) {
        if (!a1 || !a2) { link_write("ERR usage: MR <dx> <dy>\n"); return; }
        if (!usb_ok()) return;
        int dx = atoi(a1), dy = atoi(a2);
        bool ok = true;
        last_move_abs = false;
        while ((dx || dy) && ok) { /* split into int8 steps */
            int sx = dx > 127 ? 127 : dx < -127 ? -127 : dx;
            int sy = dy > 127 ? 127 : dy < -127 ? -127 : dy;
            ok = rel_send(sx, sy, 0);
            dx -= sx;
            dy -= sy;
        }
        link_write(ok ? "OK\n" : "ERR HID endpoint busy\n");
    } else if (!strcmp(cmd, "MA")) {
        if (!a1 || !a2) { link_write("ERR usage: MA <x> <y>\n"); return; }
        if (!usb_ok()) return;
        abs_x = atoi(a1) & 0x7FFF;
        abs_y = atoi(a2) & 0x7FFF;
        last_move_abs = true;
        link_write(abs_send(0) ? "OK\n" : "ERR HID endpoint busy\n");
    } else if (!strcmp(cmd, "MB")) {
        if (!a1) { link_write("ERR usage: MB <mask>\n"); return; }
        if (!usb_ok()) return;
        mouse_buttons = atoi(a1) & 7;
        bool ok = last_move_abs ? abs_send(0) : rel_send(0, 0, 0);
        link_write(ok ? "OK\n" : "ERR HID endpoint busy\n");
    } else if (!strcmp(cmd, "MW")) {
        if (!a1) { link_write("ERR usage: MW <delta>\n"); return; }
        if (!usb_ok()) return;
        int w = atoi(a1);
        w = w > 127 ? 127 : w < -127 ? -127 : w;
        bool ok = last_move_abs ? abs_send(w) : rel_send(0, 0, w);
        link_write(ok ? "OK\n" : "ERR HID endpoint busy\n");
    } else if (!strcmp(cmd, "PP") || !strcmp(cmd, "PR")) {
        press_pin(cmd[1] == 'P' ? PIN_PWR_SW : PIN_RST_SW, a1 ? atoi(a1) : 300);
        link_write("OK\n");
    } else if (!strcmp(cmd, "PS")) {
        /* Optocoupler pulls the input low while the power LED is lit. */
        link_printf("OK %d\n", gpio_get_level(PIN_PLED) == 0 ? 1 : 0);
    } else if (!strcmp(cmd, "CW")) {
        if (!a1) { link_write("ERR usage: CW <base64>\n"); return; }
        uint8_t raw[LINE_MAX];
        size_t n = 0;
        if (mbedtls_base64_decode(raw, sizeof raw, &n, (const uint8_t *)a1, strlen(a1)) != 0) {
            link_write("ERR bad base64\n");
            return;
        }
        size_t off = 0;
        TickType_t start = xTaskGetTickCount();
        while (off < n && xTaskGetTickCount() - start < pdMS_TO_TICKS(500)) {
            off += tud_cdc_n_write(0, raw + off, n - off);
            tud_cdc_n_write_flush(0);
            if (off < n) vTaskDelay(pdMS_TO_TICKS(1));
        }
        link_write(off == n ? "OK\n" : "ERR console write timeout (is the target reading the port?)\n");
    } else {
        link_printf("ERR unknown command %s\n", cmd);
    }
}

/* Forward bytes the target wrote to its CDC port as "CD <base64>" lines. */
static void pump_console(void) {
    if (!tud_cdc_n_available(0)) return;
    uint8_t raw[CD_CHUNK];
    uint32_t n = tud_cdc_n_read(0, raw, sizeof raw);
    if (!n) return;
    /* One uart_write_bytes call per line: calls are atomic, so lines from the
       TinyUSB task (EV ...) can't interleave with this one. */
    unsigned char out[3 + CD_CHUNK * 2 + 2] = "CD ";
    size_t olen = 0;
    if (mbedtls_base64_encode(out + 3, sizeof out - 5, &olen, raw, n) == 0) {
        out[3 + olen] = '\n';
        uart_write_bytes(LINK_UART, (const char *)out, 3 + olen + 1);
    }
}

/* ---------------------------------------------------------------- setup */

static void gpio_setup(void) {
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << PIN_PWR_SW) | (1ULL << PIN_RST_SW),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&out);
    gpio_set_level(PIN_PWR_SW, 0);
    gpio_set_level(PIN_RST_SW, 0);
    gpio_config_t in = {
        .pin_bit_mask = 1ULL << PIN_PLED,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&in);
}

static void uart_setup(void) {
    uart_config_t cfg = {
        .baud_rate = LINK_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(LINK_UART, 4096, 4096, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(LINK_UART, &cfg));
}

void app_main(void) {
    gpio_setup();
    uart_setup();

    const tinyusb_config_t tusb_cfg = {
        .device_descriptor = &desc_device,
        .string_descriptor = string_desc,
        .string_descriptor_count = sizeof(string_desc) / sizeof(string_desc[0]),
        .external_phy = false,
        .configuration_descriptor = desc_cfg,
    };
    ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));

    link_printf("EV READY barehand-fw %s\n", FW_VERSION);

    char line[LINE_MAX];
    size_t len = 0;
    for (;;) {
        uint8_t c;
        /* Short timeout keeps the console pump responsive. */
        while (uart_read_bytes(LINK_UART, &c, 1, pdMS_TO_TICKS(2)) == 1) {
            if (c == '\n') {
                line[len] = 0;
                if (len && line[len - 1] == '\r') line[len - 1] = 0;
                handle(line);
                len = 0;
            } else if (len < LINE_MAX - 1) {
                line[len++] = (char)c;
            } else {
                len = 0; /* overlong line: drop it */
                link_write("ERR line too long\n");
            }
        }
        pump_console();
    }
}
