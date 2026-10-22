import { afterEach, expect, test } from "bun:test"
import {
  ZebraPrinter,
  getAuthorizedPrinters,
  getSupport,
  createLabel,
  StripesError,
} from "../index.js"
import type { ErrorCode } from "../index.js"
import { hostStatus, installUSB, MockDevice } from "./usb-mock.js"

let mock: ReturnType<typeof installUSB> | undefined
afterEach(() => {
  mock?.restore()
  mock = undefined
})
function setup(device = new MockDevice()) {
  mock = installUSB(device)
  return mock
}
const label = { lines: [{ text: "Hello" }] }

async function errorCode(promise: Promise<unknown>, code: ErrorCode) {
  try {
    await promise
    throw new Error("Expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(StripesError)
    expect((error as StripesError).code).toBe(code)
    return error as StripesError
  }
}

test("SSR-safe construction and capability detection", () => {
  const m = setup()
  Reflect.deleteProperty(globalThis, "navigator")
  Reflect.deleteProperty(globalThis, "isSecureContext")
  expect(new ZebraPrinter().state).toBe("disconnected")
  expect(getSupport()).toEqual({
    supported: false,
    reason: "insecure-context",
  })
  expect(m.requests).toBe(0)
})
test("discovery does not open devices; authorized reconnect bypasses picker", async () => {
  const m = setup()
  expect(getSupport()).toEqual({ supported: true })
  const devices = await getAuthorizedPrinters()
  expect(devices).toEqual([m.device])
  expect(m.device.events).toEqual([])
  const printer = new ZebraPrinter()
  const states: string[] = []
  const unsubscribe = printer.onStateChange((state) => states.push(state))
  const info = await printer.connect(devices[0])
  expect(info.serialNumber).toBe("TEST-001")
  expect(m.requests).toBe(0)
  expect(printer.connected).toBe(true)
  await printer.disconnect()
  expect(states).toEqual([
    "connecting",
    "connected",
    "disconnecting",
    "disconnected",
  ])
  expect(m.listeners.size).toBe(0)
  unsubscribe()
})
test("connect has no transfers and cleans up claim failures", async () => {
  const m = setup()
  m.device.claimError = true
  const printer = new ZebraPrinter()
  await errorCode(printer.connect(), "device-busy")
  expect(m.device.events).toEqual(["open", "claim", "close"])
  expect(printer.state).toBe("disconnected")
})
test("permission cancellation and unsupported environments have stable codes", async () => {
  const m = setup()
  m.usb.requestDevice = async () => {
    throw new DOMException("Canceled", "NotFoundError")
  }
  await errorCode(new ZebraPrinter().connect(), "permission-canceled")
  Object.defineProperty(globalThis, "isSecureContext", {
    configurable: true,
    value: false,
  })
  await errorCode(new ZebraPrinter().connect(), "unsupported")
})
test("concurrent lifecycle operations reject", async () => {
  setup()
  const printer = new ZebraPrinter()
  const connection = printer.connect()
  await errorCode(printer.connect(), "operation-in-progress")
  await errorCode(printer.disconnect(), "operation-in-progress")
  await connection
  const close = printer.disconnect()
  await errorCode(printer.connect(), "operation-in-progress")
  await errorCode(printer.printLabel(label), "operation-in-progress")
  await close
})
test("every queued label checks fresh status, then disconnect drains accepted jobs", async () => {
  const m = setup()
  const printer = new ZebraPrinter()
  await printer.connect()
  const first = printer.printLabel(label)
  const second = printer.printLabel(label)
  const close = printer.disconnect()
  const result = await first
  await second
  await close
  expect(result.physicalPrintConfirmed).toBe(false)
  expect(result.preflightStatus.readiness).toBe("ready")
  expect(result.bytesSent).toBe(
    new TextEncoder().encode(createLabel(label)).length,
  )
  expect(m.device.events).toEqual([
    "open",
    "claim",
    "status",
    "print",
    "status",
    "print",
    "release",
    "close",
  ])
})
test("not-ready blocks all label bytes but leaves the connection available for rechecking", async () => {
  const m = setup()
  m.device.statusReplies = [hostStatus({ 2: "1" }), hostStatus()]
  const printer = new ZebraPrinter()
  await printer.connect()
  const error = await errorCode(printer.printLabel(label), "not-ready")
  expect((error.details.status as { reasons: string[] }).reasons).toEqual([
    "paused",
  ])
  expect(m.device.printBytes).toBe(0)
  expect(printer.connected).toBe(true)
  expect((await printer.printLabel(label)).status).toBe("sent")
  await printer.disconnect()
})
test("malformed status closes connection and prevents queued jobs from sending", async () => {
  const m = setup()
  m.device.statusReplies = [hostStatus().replace("030,0", "030,9")]
  const printer = new ZebraPrinter()
  await printer.connect()
  const first = printer.printLabel(label)
  const next = printer.printLabel(label)
  await errorCode(first, "status-unknown")
  await errorCode(next, "disconnected")
  expect(m.device.statusWrites).toBe(1)
  expect(m.device.printBytes).toBe(0)
  expect(printer.connected).toBe(false)
})
test("silent status times out as unknown and cannot produce late follow-up reads", async () => {
  const m = setup()
  m.device.neverReply = true
  const printer = new ZebraPrinter()
  await printer.connect()
  const status = await printer.getStatus({ timeoutMs: 5 })
  expect(status.readiness).toBe("unknown")
  expect(printer.state).toBe("disconnected")
  expect(m.device.printBytes).toBe(0)
  expect(m.listeners.size).toBe(0)
})
test("missing input endpoint is unknown and blocks graphics", async () => {
  const m = setup(new MockDevice(false))
  const printer = new ZebraPrinter()
  await printer.connect()
  expect((await printer.getStatus()).readiness).toBe("unknown")
  await errorCode(
    printer.printGraphic({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255]),
    }),
    "status-unknown",
  )
  expect(m.device.writes.length).toBe(0)
  await printer.disconnect()
})
test("partial writes preserve every byte and graphics share the same gate", async () => {
  const m = setup()
  m.device.maxWrite = 7
  const printer = new ZebraPrinter()
  await printer.connect()
  const result = await printer.printLabel(label)
  const raw = Buffer.concat(m.device.writes)
  expect(raw.toString()).toBe("~HS" + createLabel(label))
  expect(result.bytesSent).toBe(raw.length - 3)
  m.device.writes = []
  await printer.printGraphic({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([0, 0, 0, 255]),
  })
  expect(Buffer.concat(m.device.writes).toString()).toContain("^GFA,1,1,1,80")
  await printer.disconnect()
})
test("failed print reports confirmed bytes, closes, and never retries", async () => {
  const m = setup()
  m.device.maxWrite = 7
  m.device.failPrintAt = 7
  const printer = new ZebraPrinter()
  await printer.connect()
  const first = printer.printLabel(label)
  const second = printer.printLabel(label)
  const error = await errorCode(first, "print-outcome-unknown")
  await errorCode(second, "disconnected")
  expect(error.details.bytesSent).toBe(7)
  expect(m.device.events.filter((e) => e === "print-failed").length).toBe(1)
  expect(printer.connected).toBe(false)
})
test("unplug updates state, rejects work, and removes device listener", async () => {
  const m = setup()
  const printer = new ZebraPrinter()
  await printer.connect()
  const states: string[] = []
  printer.onStateChange((state) => states.push(state))
  m.unplug()
  expect(states).toEqual(["disconnected"])
  expect(printer.info).toBeNull()
  expect(m.listeners.size).toBe(0)
  await errorCode(printer.printLabel(label), "disconnected")
})
test("fragmented status records are accumulated across USB reads", async () => {
  const m = setup()
  const response = hostStatus()
  let offset = 0
  m.device.transferIn = async () => {
    const bytes = new TextEncoder().encode(response.slice(offset, offset + 5))
    offset += 5
    return { status: "ok", data: new DataView(bytes.buffer) }
  }
  const printer = new ZebraPrinter()
  await printer.connect()
  expect((await printer.getStatus()).readiness).toBe("ready")
  await printer.disconnect()
})
test("read-only speed query shares queue and does not print", async () => {
  const m = setup()
  const printer = new ZebraPrinter()
  await printer.connect()
  const speed = await printer.getPrintSpeed()
  expect(speed.printSpeedIps).toBe(6)
  expect(speed.settingChanged).toBe(false)
  expect(Buffer.concat(m.device.writes).toString()).toBe(
    '! U1 getvar "media.speed"\r\n',
  )
  expect(m.device.printBytes).toBe(0)
  await printer.disconnect()
})
test("bad query options and invalid labels never reach USB", async () => {
  const m = setup()
  const printer = new ZebraPrinter()
  await printer.connect()
  await errorCode(printer.getStatus({ timeoutMs: 0 }), "invalid-input")
  await errorCode(printer.printLabel({ lines: [] }), "invalid-input")
  expect(m.device.writes.length).toBe(0)
  await printer.disconnect()
})
test("a second instance cannot claim or close the first instance’s device", async () => {
  const m = setup()
  const first = new ZebraPrinter()
  const second = new ZebraPrinter()
  await first.connect()
  await errorCode(second.connect(m.device), "device-busy")
  expect(first.connected).toBe(true)
  expect(m.device.events).toEqual(["open", "claim"])
  await first.disconnect()
  await second.connect(m.device)
  await second.disconnect()
})
test("configuration selection and alternate endpoint discovery use descriptor values", async () => {
  const device = new MockDevice()
  const alternate = {
    alternateSetting: 3,
    interfaceClass: 7,
    endpoints: [
      { endpointNumber: 4, direction: "out" as const, type: "bulk" as const },
      { endpointNumber: 5, direction: "in" as const, type: "bulk" as const },
    ],
  }
  device.configurations = [
    {
      configurationValue: 9,
      interfaces: [
        {
          interfaceNumber: 2,
          alternate: { ...alternate, alternateSetting: 0 },
          alternates: [alternate],
        },
      ],
    },
  ]
  device.configuration = null
  setup(device)
  const printer = new ZebraPrinter()
  const info = await printer.connect()
  expect(info.interface).toBe(2)
  expect(info.inputEndpoint).toBe(5)
  expect(info.outputEndpoint).toBe(4)
  expect(device.events).toEqual(["open", "configure", "claim", "alternate"])
  await printer.disconnect()
})
test("invalid write acknowledgements invalidate the session without retries", async () => {
  const m = setup()
  const transfer = m.device.transferOut.bind(m.device)
  m.device.transferOut = async (endpoint, data) =>
    data[0] === 94
      ? { status: "ok", bytesWritten: data.length + 1 }
      : transfer(endpoint, data)
  const printer = new ZebraPrinter()
  await printer.connect()
  const error = await errorCode(
    printer.printLabel(label),
    "print-outcome-unknown",
  )
  expect(error.details.bytesSent).toBe(0)
  expect(printer.state).toBe("disconnected")
})
test("speed timeout closes the device without changing a setting", async () => {
  const m = setup()
  m.device.neverReply = true
  const printer = new ZebraPrinter()
  await printer.connect()
  await errorCode(printer.getPrintSpeed({ timeoutMs: 5 }), "query-failed")
  expect(printer.state).toBe("disconnected")
  expect(m.device.printBytes).toBe(0)
})
test("late query reply cannot spill into a reconnected session", async () => {
  const m = setup()
  let finish: ((value: { status: string; data: DataView }) => void) | undefined
  const original = m.device.transferIn.bind(m.device)
  m.device.transferIn = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const printer = new ZebraPrinter()
  await printer.connect()
  expect((await printer.getStatus({ timeoutMs: 5 })).readiness).toBe("unknown")
  m.device.reads = []
  m.device.transferIn = original
  await printer.connect(m.device)
  const bytes = new TextEncoder().encode(hostStatus({ 1: "1" }))
  finish!({ status: "ok", data: new DataView(bytes.buffer) })
  expect((await printer.getStatus()).readiness).toBe("ready")
  await printer.disconnect()
})
test("observer exceptions cannot affect printing or cleanup", async () => {
  setup()
  const printer = new ZebraPrinter()
  printer.onStateChange(() => {
    throw new Error("UI failure")
  })
  await printer.connect()
  expect((await printer.printLabel(label)).status).toBe("sent")
  await printer.disconnect()
})
