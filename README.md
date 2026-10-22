# @nosweat/stripes

Dependency-free, browser-only TypeScript API for direct USB printing to the **Zebra ZD411, 203 dpi**. No Zebra Browser Print, local service, or print driver bridge. Tree-shakeable ESM with TypeScript declarations; imports are safe in SSR builds, but device operations run only in the browser.

> Hardware verification: the maintainer has completed physical ZD411 checks for readiness and fault handling, text and raster printing, reconnect behavior, speed settings, and USB client contention. Behavior can vary with firmware, media, and browser; the limitations below still apply.

## Requirements

- Chromium with WebUSB on HTTPS or localhost. Safari and Firefox are unsupported.
- First connection must run directly from a user click to open the USB permission picker.
- Quit Zebra Browser Print and other USB clients. Use one instance/tab/application per printer.
- Embedded applications need an appropriate USB Permissions Policy and browser permission delegation.
- Only USB vendor `0x0a5f`, product `0x0181` is accepted. Use with the 203 dpi ZD411; the package does not interrogate printer resolution.

## Install

```sh
bun add @nosweat/stripes
```

The unscoped npm name `stripes` belongs to an unrelated package. Use `@nosweat/stripes`.

## Connect and print

```ts
import { ZebraPrinter, getSupport, StripesError } from '@nosweat/stripes';

const printer = new ZebraPrinter();
const support = getSupport(); // synchronous, safe in SSR; no permission request

const unsubscribe = printer.onStateChange(state => {
  console.log(state, printer.info);
});

connectButton.onclick = async () => {
  try {
    await printer.connect(); // call before any unrelated await in the click handler
  } catch (error) {
    if (error instanceof StripesError) console.error(error.code, error.message);
  }
};

printButton.onclick = async () => {
  try {
    const result = await printer.printLabel({
      widthMm: 50.8,
      heightMm: 25.4,
      align: 'center',
      verticalAlign: 'center',
      lines: [
        { text: 'PRODUCT NAME', fontSizeMm: 5 },
        { text: 'Batch 0123', fontSizeMm: 3 },
      ],
    });
    console.log(result.bytesSent, result.preflightStatus);
    // result.physicalPrintConfirmed is always false.
  } catch (error) {
    if (error instanceof StripesError) console.error(error.code, error.details);
    // Never automatically retry a failed print.
  }
};

// When finished:
await printer.disconnect();
unsubscribe();
```

### Discovery and reconnect

```ts
import { getAuthorizedPrinters } from '@nosweat/stripes';

const devices = await getAuthorizedPrinters();
// Only authorized, currently attached ZD411 devices. Nothing is opened or claimed.
// Let the user/application choose; do not silently pick an arbitrary printer.
if (devices[0]) await printer.connect(devices[0]);
```

No automatic discovery, connection, reconnection, polling, or printing occurs on import or construction. Permission does not imply availability: another tab/service can own the interface. `connect()` without a device always opens the picker unless this instance is already connected. Connecting again to the same current device is idempotent; switching devices requires disconnecting first.

## Connection is not readiness

`printer.state` is `disconnected | connecting | connected | disconnecting`.
`printer.connected` is a convenience boolean; `printer.info` is device/endpoint information or `null`. `onStateChange()` subscribes to future changes, including USB unplugging, and returns an unsubscribe function. A connected printer has an open, claimed USB interface—not a guarantee that it can print.

```ts
const status = await printer.getStatus({ timeoutMs: 5000 });
// status.readiness: 'ready' | 'not-ready' | 'unknown'
// status.reasons: e.g. ['paper-out', 'head-open']
// status.observedAt: ISO timestamp
```

**Every queued print performs a fresh `~HS` query immediately before sending label bytes. There is no bypass.** A complete validated reply is required. A known fault rejects with `not-ready`; an unavailable/unreliable response rejects with `status-unknown`. Neither sends label bytes.

Reported blockers include paper-out, pause, buffer-full, diagnostic mode, partial format, corrupt RAM, under/over-temperature, head-open, ribbon-out **when thermal transfer is selected**, and a label waiting for removal. Buffered formats and remaining label counts are exposed but do not themselves make the printer not-ready.

Important limitations:

- [Zebra documents that `~HS` may not respond in media-out, ribbon-out, head-open, rewinder-full, or head-over-temperature conditions.](https://docs.zebra.com/us/en/printers/software/zpl-pg/c-zpl-zpl-commands/r-zpl-hs.html) Silence is **unknown**, not proof of readiness and not a reliable diagnosis of a specific fault. Some models/firmware may report these flags instead; verify your hardware.
- Timeout, malformed reply, or failed query transfer closes the connection to cancel pending reads and avoid stale responses. Explicitly reconnect after checking the printer. If no bulk IN endpoint exists, status is unknown and printing is blocked without sending a query.
- A disconnected call rejects with `disconnected`; `unknown` describes a status interrogation that could not determine readiness on an existing connection.
- Status is a timestamped snapshot. Media can run out immediately afterward. Sensor status does not prove correct calibration, absence of every jam, or print quality.
- A successful print result means USB accepted the bytes. **It never confirms a physical label was printed.**

Queries default to 5 seconds; `timeoutMs` must be an integer from 1 to 30000. Pass it as the second argument to `printLabel()` or the third argument to `printGraphic()` to configure the preflight query. This timeout applies to interrogation, not total time waiting in the queue or sending a label.

## Labels and graphics

### Resident-font text

`printLabel(options)` defaults to 50.8 × 25.4 mm, one copy, left/top alignment, font `0`, and a 4 mm font height. Default margins are 2 mm and line gaps are 1 mm. Positions and sizes are millimeters; all layout resolves to integer printer dots.

- Per-line `xMm`, `yMm`, `fontSizeMm`, `font`, and `align` overrides.
- `align: 'center'` uses printer-side glyph justification; `xMm` becomes symmetric horizontal margins.
- `verticalAlign: 'center'` centers the whole block, cannot combine with explicit `yMm`, and checks 2 mm top/bottom margins.
- Resident fonts: `0`, `A`–`H`. Bitmap sizes snap to native-size multiples (1×–10×); `fontMetrics()` exposes resolved dimensions. Only font 0 was physically verified in the prototype.
- Text is byte-escaped UTF-8 to prevent ZPL injection. Resident glyph coverage depends on font/firmware; ASCII is the verified baseline.
- Text does not automatically wrap/scale. Horizontal fit is not validated: left-aligned text can clip, and overlong centered text can overwrite on printer-side wrapping. Keep lines short and test on actual media.
- Width: 5–56 mm; height: 5–1000 mm; copies: 1–100; lines: 1–100; text: at most 1000 characters per line without control characters.

`createLabel(options)` is a pure ZPL generator for inspection/testing; there is intentionally no raw-ZPL transport API.

### Browser-rendered graphics

```ts
const canvas = document.createElement('canvas');
canvas.width = 406;
canvas.height = 203;
const ctx = canvas.getContext('2d')!;
// Load your website fonts before drawing; your application owns rendering/layout.
ctx.fillStyle = 'white';
ctx.fillRect(0, 0, 406, 203);
ctx.fillStyle = 'black';
ctx.font = '24px monospace';
ctx.fillText('Hello', 16, 40);

await printer.printGraphic(ctx.getImageData(0, 0, 406, 203), {
  threshold: 128,
  copies: 1,
});
```

Accepts `ImageData` or `{ width, height, data: Uint8ClampedArray }`. Dimensions are printer dots (406 × 203 for a 2 × 1 inch label), not CSS pixels. Limits: 1–448 dots wide, 1–8000 dots high. Alpha composites onto white; luminance is thresholded to one bit, MSB-first with white row padding. `monochrome()` returns packed bytes and exact preview pixels. `createGraphicLabel()` generates inline `^GFA` ZPL. No fonts/assets are bundled or uploaded to printer storage. Cross-origin canvas assets must permit pixel reads.

### Speed

Both print methods accept `printSpeedIps: 2 | 6`. Omission leaves the current printer speed unchanged; it does not restore a previous speed. Explicit changes may affect later jobs; firmware/media can constrain effective speed. No save-to-flash command is sent.

```ts
const reading = await printer.getPrintSpeed();
// { printSpeedIps, observedAt, product, serialNumber, rawReply, settingChanged: false }
```

This sends only `! U1 getvar "media.speed"` and reads its reply. It reports the configured setting, not measured throughput or proof of a factory default. Query failure rejects with `query-failed` and closes USB. It shares the same operation queue as status and printing.

## Queue and failures

Calls snapshot validated print inputs and serialize device traffic. `disconnect()` immediately stops accepting new work, then drains jobs accepted before the call. Overlapping connection operations reject. USB disconnect events clear connection state and invalidate queued work.

After an uncertain label transfer, the current job rejects with `print-outcome-unknown`, `details.bytesSent` contains confirmed bytes, USB closes, and remaining jobs tied to that session reject. Partial successful writes are continued from their accepted offset; failed writes are **never retried**. A device may have accepted more bytes than reported before a failure. Inspect/recover the printer's partial format using its controls before reconnecting.

`StripesError.code` is stable; do not parse message text:

| Code | Meaning |
| --- | --- |
| `unsupported` | Insecure context or WebUSB unavailable |
| `permission-canceled` | Device picker dismissed/no device selected |
| `device-busy` | Device already open or claiming its interface failed |
| `connection-failed` | Open/configuration/cleanup failure |
| `operation-in-progress` | Conflicting lifecycle operation/new work during disconnect |
| `disconnected` | Missing or invalidated connection |
| `invalid-input` | Invalid dimensions, text, pixels, options, or target device |
| `not-ready` | Preflight identified a blocker; `details.status` has reasons |
| `status-unknown` | Preflight could not prove readiness; `details.status` has observation |
| `query-failed` | Read-only speed interrogation failed |
| `print-outcome-unknown` | Label write failed; inspect before reconnecting |

No calibration, reset, darkness, firmware, or persistent configuration commands are sent. Label jobs set active width, length, origin, text encoding (text labels), copies, and optionally speed.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
bun run example
# http://127.0.0.1:8792
```

The Bun server only serves the example; **all printer traffic stays in the browser**. `PORT=8793 bun run example` selects a different port. The example has explicit status/speed actions and text/graphic prints; it does not print on connection or page load.

Build outputs browser ESM and declarations into `dist/`. Package runtime dependencies: none. Run `bun publish --dry-run` to validate and inspect the package, then `bun publish` with authorized npm credentials to publish publicly as `@nosweat/stripes`. The prepublish hook runs type checking, tests, and the build.

## License

MIT. See [LICENSE](./LICENSE).
