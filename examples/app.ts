import {
  ZebraPrinter,
  getSupport,
  getAuthorizedPrinters,
  StripesError,
} from "../index.js"
import type { PrinterDevice, PrinterStatus, PrintSpeedIps } from "../index.js"

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T
const button = (id: string) => element<HTMLButtonElement>(id)
const printer = new ZebraPrinter()
const support = getSupport()
let busy = false
let devices: PrinterDevice[] = []
const select = element<HTMLSelectElement>("devices")
const canvas = element<HTMLCanvasElement>("preview")
const ctx = canvas.getContext("2d", { willReadFrequently: true })!

function refresh() {
  element("connection").textContent = printer.state
  element("device").textContent = printer.info
    ? `${printer.info.product} / ${printer.info.serialNumber ?? "no serial"}`
    : "—"
  button("connect").disabled =
    busy || !support.supported || printer.state !== "disconnected"
  button("discover").disabled = busy || !support.supported
  button("reconnect").disabled =
    busy ||
    !support.supported ||
    printer.state !== "disconnected" ||
    select.value === ""
  for (const id of [
    "disconnect",
    "status",
    "read-speed",
    "print-text",
    "print-graphic",
  ])
    button(id).disabled = busy || !printer.connected
}
function showStatus(status: PrinterStatus) {
  element("readiness").textContent =
    `${status.readiness}${status.reasons.length ? " / " + status.reasons.join(", ") : ""} · observed ${new Date(status.observedAt).toLocaleTimeString()}`
}
function renderPreview() {
  ctx.fillStyle = "white"
  ctx.fillRect(0, 0, 406, 203)
  ctx.fillStyle = "black"
  ctx.font = "bold 24px monospace"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(element<HTMLInputElement>("text").value, 203, 101, 374)
}
function speed(): PrintSpeedIps | undefined {
  const value = element<HTMLSelectElement>("speed").value
  return value ? (Number(value) as PrintSpeedIps) : undefined
}
/** Invoke work synchronously, so connect() keeps the click's user activation. */
async function run(work: () => Promise<unknown>) {
  busy = true
  refresh()
  try {
    element("result").textContent = JSON.stringify(await work(), null, 2)
  } catch (error) {
    if (error instanceof StripesError && error.details.status)
      showStatus(error.details.status as PrinterStatus)
    element("result").textContent =
      error instanceof StripesError
        ? JSON.stringify(
            {
              code: error.code,
              message: error.message,
              details: error.details,
            },
            null,
            2,
          )
        : String(error)
  } finally {
    busy = false
    refresh()
  }
}
printer.onStateChange((state) => {
  if (state !== "connected") element("readiness").textContent = "unknown"
  refresh()
})
button("connect").onclick = () => void run(() => printer.connect())
button("disconnect").onclick = () => void run(() => printer.disconnect())
button("discover").onclick = () =>
  void run(async () => {
    devices = await getAuthorizedPrinters()
    select.replaceChildren()
    select.add(new Option("Choose printer", ""))
    devices.forEach((device, index) =>
      select.add(
        new Option(
          `${device.productName} / ${device.serialNumber ?? "no serial"}`,
          String(index),
        ),
      ),
    )
    return { authorizedAttachedDevices: devices.length }
  })
select.onchange = refresh
button("reconnect").onclick = () =>
  void run(() => printer.connect(devices[Number(select.value)]))
button("status").onclick = () =>
  void run(async () => {
    const status = await printer.getStatus()
    showStatus(status)
    return status
  })
button("read-speed").onclick = () => void run(() => printer.getPrintSpeed())
button("print-text").onclick = () =>
  void run(async () => {
    const result = await printer.printLabel({
      align: "center",
      verticalAlign: "center",
      printSpeedIps: speed(),
      lines: [{ text: element<HTMLInputElement>("text").value, fontSizeMm: 3 }],
    })
    showStatus(result.preflightStatus)
    return result
  })
button("print-graphic").onclick = () =>
  void run(async () => {
    const result = await printer.printGraphic(
      ctx.getImageData(0, 0, 406, 203),
      { printSpeedIps: speed() },
    )
    showStatus(result.preflightStatus)
    return result
  })
element<HTMLInputElement>("text").oninput = renderPreview
if (!support.supported)
  element("environment").textContent =
    `WebUSB unavailable (${support.reason}). Open in Chromium on HTTPS or localhost.`
renderPreview()
refresh()
