import { StripesError } from "./errors.js"
import { usbAccess } from "./usb.js"
import type { PrinterDevice, USBAccess } from "./usb.js"

export const ZEBRA_ZD411 = Object.freeze({
  vendorId: 0x0a5f,
  productId: 0x0181,
})
export type Support =
  | { supported: true }
  | { supported: false; reason: "insecure-context" | "webusb-unavailable" }

/** Safe during SSR and on unsupported browsers. Does not request permission. */
export function getSupport(): Support {
  if (!globalThis.isSecureContext)
    return { supported: false, reason: "insecure-context" }
  if (!usbAccess()) return { supported: false, reason: "webusb-unavailable" }
  return { supported: true }
}
export function requireUSB(): USBAccess {
  const support = getSupport()
  if (!support.supported) {
    throw new StripesError(
      "unsupported",
      "WebUSB requires Chromium on HTTPS or localhost.",
      { reason: support.reason },
    )
  }
  return usbAccess()!
}
export function isZD411(device: PrinterDevice): boolean {
  return (
    device.vendorId === ZEBRA_ZD411.vendorId &&
    device.productId === ZEBRA_ZD411.productId
  )
}
/** Authorized and currently attached devices, not necessarily available to claim. */
export async function getAuthorizedPrinters(): Promise<PrinterDevice[]> {
  return (await requireUSB().getDevices()).filter(isZD411)
}
