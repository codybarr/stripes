import { isZD411, requireUSB, ZEBRA_ZD411 } from "./discovery.js"
import { invalid, StripesError } from "./errors.js"
import { createLabel } from "./label.js"
import type { LabelOptions } from "./label.js"
import { createGraphicLabel } from "./raster.js"
import type { GraphicImage, GraphicOptions } from "./raster.js"
import { parseHostStatus, unknownStatus } from "./status.js"
import type { PrinterStatus } from "./status.js"
import type { PrinterDevice, USBAccess } from "./usb.js"

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
export interface PrinterInfo {
  readonly product?: string
  readonly manufacturer?: string
  readonly serialNumber?: string
  readonly vendorId: number
  readonly productId: number
  readonly interface: number
  readonly outputEndpoint: number
  readonly inputEndpoint?: number
}
export interface QueryOptions {
  timeoutMs?: number
}
export interface PrintResult {
  readonly status: "sent"
  readonly bytesSent: number
  readonly physicalPrintConfirmed: false
  /** Fresh preflight snapshot, not post-print confirmation. */
  readonly preflightStatus: PrinterStatus
}
export interface SpeedReading {
  readonly printSpeedIps: number
  readonly observedAt: string
  readonly product?: string
  readonly serialNumber?: string
  readonly rawReply: string
  readonly settingChanged: false
}
interface Session {
  device: PrinterDevice
  usb: USBAccess
  iface: number
  out: number
  input?: number
  onDisconnect: (event: { device: PrinterDevice }) => void
}
const owners = new WeakSet<PrinterDevice>()
const encode = (text: string) => new TextEncoder().encode(text)
function timeoutValue(options: QueryOptions): number {
  if (!options || typeof options !== "object")
    invalid("Provide query options as an object.")
  const value = options.timeoutMs ?? 5000
  if (!Number.isInteger(value) || value < 1 || value > 30000)
    invalid("timeoutMs must be 1–30000.")
  return value
}

/** One instance per printer. No browser APIs are touched until an operation is called. */
export class ZebraPrinter {
  #session?: Session
  #state: ConnectionState = "disconnected"
  #tail: Promise<unknown> = Promise.resolve()
  #listeners = new Set<(state: ConnectionState) => void>()
  #disconnectPending = false
  #invalidating = false

  get state(): ConnectionState {
    return this.#state
  }
  get connected(): boolean {
    return this.#state === "connected" && !!this.#session?.device.opened
  }
  get info(): PrinterInfo | null {
    const s = this.#session
    if (!s) return null
    return Object.freeze({
      product: s.device.productName,
      manufacturer: s.device.manufacturerName,
      serialNumber: s.device.serialNumber,
      vendorId: s.device.vendorId,
      productId: s.device.productId,
      interface: s.iface,
      outputEndpoint: s.out,
      inputEndpoint: s.input,
    })
  }
  /** Future changes only. Unsubscribe when your UI no longer needs updates. */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #setState(state: ConnectionState): void {
    if (state === this.#state) return
    this.#state = state
    // Observer exceptions must never turn successful transfers into apparent failures.
    for (const listener of [...this.#listeners]) {
      try {
        listener(state)
      } catch {
        /* isolate application observers */
      }
    }
  }

  /** No argument: invoke directly in a click handler for the permission picker.
   * With an authorized device: explicitly reconnect without showing a picker.
   */
  async connect(authorizedDevice?: PrinterDevice): Promise<PrinterInfo> {
    if (
      this.#state === "connecting" ||
      this.#state === "disconnecting" ||
      this.#disconnectPending ||
      this.#invalidating
    ) {
      throw new StripesError(
        "operation-in-progress",
        "Wait for the connection operation to finish.",
      )
    }
    if (this.connected) {
      if (authorizedDevice && authorizedDevice !== this.#session!.device) {
        throw new StripesError(
          "operation-in-progress",
          "Disconnect before selecting a different printer.",
        )
      }
      return this.info!
    }
    const usb = requireUSB()
    if (authorizedDevice && !isZD411(authorizedDevice))
      invalid("Only the Zebra ZD411 USB device is supported.")
    this.#setState("connecting")
    let device: PrinterDevice | undefined
    let claimed: number | undefined
    let ownsDevice = false
    let stage = "select"
    try {
      // requestDevice is called before the first await to preserve user activation.
      device =
        authorizedDevice ??
        (await usb.requestDevice({ filters: [ZEBRA_ZD411] }))
      if (!isZD411(device))
        invalid("Only the Zebra ZD411 USB device is supported.")
      if (owners.has(device) || device.opened) {
        throw new StripesError(
          "device-busy",
          "This device is already open. Use one instance per printer.",
        )
      }
      owners.add(device)
      ownsDevice = true
      stage = "open"
      await device.open()
      if (!device.configuration) {
        const configuration = device.configurations[0]
        if (!configuration) throw new Error("No USB configuration available.")
        await device.selectConfiguration(configuration.configurationValue)
      }
      const candidates = device.configuration!.interfaces.flatMap((iface) =>
        iface.alternates
          .filter(
            (a) =>
              a.interfaceClass === 7 &&
              a.endpoints.some(
                (e) => e.type === "bulk" && e.direction === "out",
              ),
          )
          .map((alternate) => ({ iface, alternate })),
      )
      // Prefer a bidirectional printer interface, needed for readiness queries.
      const candidate =
        candidates.find((c) =>
          c.alternate.endpoints.some(
            (e) => e.type === "bulk" && e.direction === "in",
          ),
        ) ?? candidates[0]
      if (!candidate) throw new Error("No USB printer bulk output found.")
      stage = "claim"
      await device.claimInterface(candidate.iface.interfaceNumber)
      claimed = candidate.iface.interfaceNumber
      if (
        candidate.iface.alternate.alternateSetting !==
        candidate.alternate.alternateSetting
      ) {
        await device.selectAlternateInterface(
          claimed,
          candidate.alternate.alternateSetting,
        )
      }
      const session: Session = {
        device,
        usb,
        iface: claimed,
        out: candidate.alternate.endpoints.find(
          (e) => e.type === "bulk" && e.direction === "out",
        )!.endpointNumber,
        input: candidate.alternate.endpoints.find(
          (e) => e.type === "bulk" && e.direction === "in",
        )?.endpointNumber,
        onDisconnect: (event) => {
          if (event.device === session.device && this.#session === session) {
            this.#forget(session)
            void session.device.close().catch(() => {})
          }
        },
      }
      if (!device.opened)
        throw new Error("Printer disconnected while connecting.")
      this.#session = session
      usb.addEventListener("disconnect", session.onDisconnect)
      this.#setState("connected")
      return this.info!
    } catch (cause) {
      if (ownsDevice && device && claimed !== undefined) {
        try {
          await device.releaseInterface(claimed)
        } catch {
          /* preserve failure */
        }
      }
      if (ownsDevice && device) {
        if (device.opened) {
          try {
            await device.close()
          } catch {
            /* preserve failure */
          }
        }
        owners.delete(device)
      }
      this.#setState("disconnected")
      if (cause instanceof StripesError) throw cause
      const name = cause instanceof Error ? cause.name : ""
      const code =
        stage === "select" && name === "NotFoundError"
          ? "permission-canceled"
          : stage === "claim"
            ? "device-busy"
            : "connection-failed"
      throw new StripesError(
        code,
        `Could not connect to the printer (${stage}).`,
        {},
        { cause },
      )
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.#tail.then(operation)
    this.#tail = job.catch(() => {})
    return job
  }
  #capture(): Session {
    if (this.#disconnectPending || this.#state === "disconnecting") {
      throw new StripesError(
        "operation-in-progress",
        "Disconnect is in progress; no new jobs are accepted.",
      )
    }
    if (
      !this.#session ||
      !this.#session.device.opened ||
      this.#state !== "connected"
    ) {
      throw new StripesError("disconnected", "Connect the printer first.")
    }
    return this.#session
  }
  #assertSession(session: Session): void {
    if (session !== this.#session || !session.device.opened) {
      throw new StripesError(
        "disconnected",
        "The printer connection is no longer available.",
      )
    }
  }
  #forget(session: Session): void {
    session.usb.removeEventListener("disconnect", session.onDisconnect)
    owners.delete(session.device)
    if (this.#session === session) {
      this.#session = undefined
      this.#setState("disconnected")
    }
  }
  async #invalidate(session: Session): Promise<void> {
    this.#invalidating = true
    try {
      // close cancels a pending transferIn and releases the interface. No reset.
      try {
        await session.device.close()
      } catch {
        /* unplugged or already closed */
      }
      this.#forget(session)
    } finally {
      this.#invalidating = false
    }
  }
  async #write(
    session: Session,
    data: Uint8Array<ArrayBuffer>,
    progress: (sent: number) => void = () => {},
  ): Promise<number> {
    let sent = 0
    while (sent < data.length) {
      this.#assertSession(session)
      const chunk = data.subarray(sent, sent + 4096)
      const result = await session.device.transferOut(session.out, chunk)
      if (
        result.status !== "ok" ||
        !Number.isInteger(result.bytesWritten) ||
        result.bytesWritten < 1 ||
        result.bytesWritten > chunk.length
      ) {
        throw new Error(`USB write failed (${result.status}).`)
      }
      sent += result.bytesWritten
      progress(sent)
      this.#assertSession(session)
    }
    return sent
  }
  async #query<T>(
    session: Session,
    command: string,
    parse: (raw: string) => T | undefined,
    timeoutMs: number,
  ): Promise<T> {
    this.#assertSession(session)
    if (session.input === undefined)
      throw new Error("Printer has no bulk IN endpoint.")
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    const query = async () => {
      await this.#write(session, encode(command))
      let raw = ""
      const decoder = new TextDecoder("utf-8", { fatal: true })
      while (raw.length < 4096) {
        if (expired) throw new Error("Query expired.")
        this.#assertSession(session)
        const result = await session.device.transferIn(session.input!, 512)
        if (expired) throw new Error("Query expired.")
        this.#assertSession(session)
        if (result.status !== "ok" || !result.data?.byteLength)
          throw new Error("USB query read failed.")
        raw += decoder.decode(result.data, { stream: true })
        if (raw.length > 4096)
          throw new Error("Printer reply exceeded the size limit.")
        const parsed = parse(raw)
        if (parsed !== undefined) return parsed
      }
      throw new Error("Printer reply was too long or malformed.")
    }
    try {
      return await Promise.race([
        query(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true
            reject(new Error("Printer query timed out."))
          }, timeoutMs)
        }),
      ])
    } catch (cause) {
      expired = true
      await this.#invalidate(session)
      throw new StripesError(
        "query-failed",
        "Printer query failed. Reconnect before trying again.",
        {},
        { cause },
      )
    } finally {
      clearTimeout(timer)
    }
  }
  async #status(session: Session, timeoutMs: number): Promise<PrinterStatus> {
    this.#assertSession(session)
    try {
      return await this.#query(session, "~HS", parseHostStatus, timeoutMs)
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.cause instanceof Error
            ? cause.cause.message
            : cause.message
          : "Printer status unavailable."
      return unknownStatus(message)
    }
  }
  /** A snapshot only; silence/failure is unknown, never ready. Query failure closes USB. */
  async getStatus(options: QueryOptions = {}): Promise<PrinterStatus> {
    const timeoutMs = timeoutValue(options)
    const session = this.#capture()
    return this.#enqueue(() => this.#status(session, timeoutMs))
  }
  async printLabel(
    label: LabelOptions,
    queryOptions: QueryOptions = {},
  ): Promise<PrintResult> {
    return this.#print(createLabel(label), queryOptions)
  }
  async printGraphic(
    image: GraphicImage,
    options: GraphicOptions = {},
    queryOptions: QueryOptions = {},
  ): Promise<PrintResult> {
    return this.#print(createGraphicLabel(image, options), queryOptions)
  }
  async #print(zpl: string, options: QueryOptions): Promise<PrintResult> {
    const timeoutMs = timeoutValue(options)
    const session = this.#capture()
    const data = encode(zpl) // Snapshot input before entering the queue.
    return this.#enqueue(async () => {
      const status = await this.#status(session, timeoutMs)
      if (status.readiness !== "ready") {
        throw new StripesError(
          status.readiness === "not-ready" ? "not-ready" : "status-unknown",
          "Printing blocked: the printer is not known to be ready.",
          { status },
        )
      }
      let sent = 0
      try {
        await this.#write(session, data, (value) => {
          sent = value
        })
      } catch (cause) {
        await this.#invalidate(session)
        throw new StripesError(
          "print-outcome-unknown",
          "Print outcome unknown. Inspect the printer before reconnecting; do not automatically retry.",
          { bytesSent: sent, physicalPrintConfirmed: false },
          { cause },
        )
      }
      return Object.freeze({
        status: "sent",
        bytesSent: sent,
        physicalPrintConfirmed: false,
        preflightStatus: status,
      })
    })
  }
  /** Read-only SGD query. Reports configured speed, not measured throughput. */
  async getPrintSpeed(options: QueryOptions = {}): Promise<SpeedReading> {
    const timeoutMs = timeoutValue(options)
    const session = this.#capture()
    return this.#enqueue(() =>
      this.#query(
        session,
        '! U1 getvar "media.speed"\r\n',
        (raw) => {
          const match = raw.match(/^\s*"(\d+(?:\.\d+)?)"\s*$/)
          if (!match) return undefined
          const speed = Number(match[1])
          if (!Number.isFinite(speed) || speed <= 0 || speed > 20)
            throw new Error("Invalid media.speed value.")
          return Object.freeze({
            printSpeedIps: speed,
            observedAt: new Date().toISOString(),
            product: session.device.productName,
            serialNumber: session.device.serialNumber,
            rawReply: raw.trim(),
            settingChanged: false as const,
          })
        },
        timeoutMs,
      ),
    )
  }
  /** Stops accepting new work immediately; drains previously accepted jobs. */
  async disconnect(): Promise<void> {
    if (this.#state === "connecting" || this.#disconnectPending) {
      throw new StripesError(
        "operation-in-progress",
        "A connection operation is already in progress.",
      )
    }
    const session = this.#session
    if (!session) return
    this.#disconnectPending = true
    this.#setState("disconnecting")
    try {
      await this.#enqueue(async () => {
        if (session !== this.#session) return
        try {
          await session.device.releaseInterface(session.iface)
        } finally {
          try {
            await session.device.close()
          } finally {
            this.#forget(session)
          }
        }
      })
    } catch (cause) {
      throw new StripesError(
        "connection-failed",
        "Could not cleanly release the printer.",
        {},
        { cause },
      )
    } finally {
      this.#disconnectPending = false
    }
  }
}
