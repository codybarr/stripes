// Structural WebUSB types keep consumer declarations independent of ambient
// @types packages. Native USBDevice/USB instances satisfy these interfaces.
export interface PrinterEndpoint {
  readonly endpointNumber: number
  readonly direction: "in" | "out"
  readonly type: "bulk" | "interrupt" | "isochronous"
}
export interface PrinterAlternate {
  readonly alternateSetting: number
  readonly interfaceClass: number
  readonly endpoints: readonly PrinterEndpoint[]
}
export interface PrinterInterface {
  readonly interfaceNumber: number
  readonly alternate: PrinterAlternate
  readonly alternates: readonly PrinterAlternate[]
}
export interface PrinterConfiguration {
  readonly configurationValue: number
  readonly interfaces: readonly PrinterInterface[]
}
/** Opaque connection target returned by getAuthorizedPrinters(). Do not open it yourself. */
export interface PrinterDevice {
  readonly vendorId: number
  readonly productId: number
  readonly productName?: string
  readonly manufacturerName?: string
  readonly serialNumber?: string
  readonly opened: boolean
  readonly configuration: PrinterConfiguration | null
  readonly configurations: readonly PrinterConfiguration[]
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(value: number): Promise<void>
  claimInterface(value: number): Promise<void>
  releaseInterface(value: number): Promise<void>
  selectAlternateInterface(iface: number, alternate: number): Promise<void>
  transferOut(
    endpoint: number,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: string; bytesWritten: number }>
  transferIn(
    endpoint: number,
    length: number,
  ): Promise<{ status: string; data?: DataView }>
}
export interface USBAccess {
  requestDevice(options: {
    filters: readonly { vendorId: number; productId: number }[]
  }): Promise<PrinterDevice>
  getDevices(): Promise<PrinterDevice[]>
  addEventListener(
    type: "disconnect",
    listener: (event: { device: PrinterDevice }) => void,
  ): void
  removeEventListener(
    type: "disconnect",
    listener: (event: { device: PrinterDevice }) => void,
  ): void
}
export function usbAccess(): USBAccess | undefined {
  return (globalThis.navigator as (Navigator & { usb?: USBAccess }) | undefined)
    ?.usb
}
