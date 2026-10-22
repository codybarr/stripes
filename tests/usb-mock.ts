import type {
  PrinterDevice,
  PrinterConfiguration,
  USBAccess,
} from "../src/usb.js"

export function hostStatus(
  a: Record<number, string> = {},
  b: Record<number, string> = {},
): string {
  const first = [
    "030",
    "0",
    "0",
    "0203",
    "000",
    "0",
    "0",
    "0",
    "000",
    "0",
    "0",
    "0",
  ]
  const second = [
    "000",
    "0",
    "0",
    "0",
    "0",
    "2",
    "0",
    "0",
    "00000000",
    "1",
    "000",
  ]
  for (const [index, value] of Object.entries(a)) first[Number(index)] = value
  for (const [index, value] of Object.entries(b)) second[Number(index)] = value
  return [first.join(","), second.join(","), "0000,0"]
    .map((line) => `\x02${line}\x03\r\n`)
    .join("")
}

export class MockDevice implements PrinterDevice {
  vendorId = 0x0a5f
  productId = 0x0181
  productName = "ZTC ZD411"
  manufacturerName = "Zebra"
  serialNumber = "TEST-001"
  opened = false
  configuration: PrinterConfiguration | null
  configurations: readonly PrinterConfiguration[]
  events: string[] = []
  writes: Uint8Array[] = []
  reads: string[] = []
  statusReplies = [hostStatus()]
  speedReply = '"6"\r\n'
  maxWrite = 4096
  failPrintAt?: number
  printBytes = 0
  statusWrites = 0
  neverReply = false
  claimError = false
  #command = ""
  constructor(input = true) {
    const alternate = {
      alternateSetting: 0,
      interfaceClass: 7,
      endpoints: [
        { endpointNumber: 1, direction: "out" as const, type: "bulk" as const },
        ...(input
          ? [
              {
                endpointNumber: 2,
                direction: "in" as const,
                type: "bulk" as const,
              },
            ]
          : []),
      ],
    }
    this.configuration = {
      configurationValue: 1,
      interfaces: [{ interfaceNumber: 0, alternate, alternates: [alternate] }],
    }
    this.configurations = [this.configuration]
  }
  async open() {
    this.events.push("open")
    this.opened = true
  }
  async close() {
    this.events.push("close")
    this.opened = false
  }
  async claimInterface(_n: number) {
    this.events.push("claim")
    if (this.claimError) throw new Error("Busy")
  }
  async releaseInterface(_n: number) {
    this.events.push("release")
  }
  async selectConfiguration(_n: number) {
    this.events.push("configure")
    this.configuration = this.configurations[0]!
  }
  async selectAlternateInterface(_i: number, _a: number) {
    this.events.push("alternate")
  }
  async transferOut(_endpoint: number, data: Uint8Array<ArrayBuffer>) {
    const decoded = new TextDecoder().decode(data)
    const isCommand =
      this.#command !== "" || decoded.startsWith("~") || decoded.startsWith("!")
    if (
      !isCommand &&
      this.failPrintAt !== undefined &&
      this.printBytes >= this.failPrintAt
    ) {
      this.events.push("print-failed")
      return { status: "stall", bytesWritten: 0 }
    }
    const length = Math.min(this.maxWrite, data.length)
    const chunk = data.slice(0, length)
    this.writes.push(chunk)
    if (isCommand) {
      this.#command += new TextDecoder().decode(chunk)
      if (this.#command === "~HS") {
        this.statusWrites++
        this.events.push("status")
        this.reads.push(
          this.statusReplies[
            Math.min(this.statusWrites - 1, this.statusReplies.length - 1)
          ]!,
        )
        this.#command = ""
      } else if (this.#command.endsWith("\r\n")) {
        this.events.push("speed")
        this.reads.push(this.speedReply)
        this.#command = ""
      }
    } else {
      this.printBytes += length
      this.events.push("print")
    }
    return { status: "ok", bytesWritten: length }
  }
  async transferIn(
    _endpoint: number,
    _length: number,
  ): Promise<{ status: string; data?: DataView }> {
    if (this.neverReply) return new Promise(() => {})
    const raw = this.reads.shift()
    if (raw === undefined) return { status: "stall" }
    const bytes = new TextEncoder().encode(raw)
    return { status: "ok", data: new DataView(bytes.buffer) }
  }
}

export function installUSB(device = new MockDevice()) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  )
  const secureDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "isSecureContext",
  )
  const listeners = new Set<(event: { device: PrinterDevice }) => void>()
  let requests = 0
  const usb: USBAccess = {
    async requestDevice() {
      requests++
      return device
    },
    async getDevices() {
      return [device]
    },
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { usb },
  })
  Object.defineProperty(globalThis, "isSecureContext", {
    configurable: true,
    value: true,
  })
  return {
    device,
    usb,
    listeners,
    get requests() {
      return requests
    },
    unplug() {
      device.opened = false
      for (const listener of [...listeners]) listener({ device })
    },
    restore() {
      if (navigatorDescriptor)
        Object.defineProperty(globalThis, "navigator", navigatorDescriptor)
      else Reflect.deleteProperty(globalThis, "navigator")
      if (secureDescriptor)
        Object.defineProperty(globalThis, "isSecureContext", secureDescriptor)
      else Reflect.deleteProperty(globalThis, "isSecureContext")
    },
  }
}
