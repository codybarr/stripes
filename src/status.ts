export type Readiness = "ready" | "not-ready" | "unknown"
export type NotReadyReason =
  | "paper-out"
  | "paused"
  | "buffer-full"
  | "diagnostic-mode"
  | "partial-format"
  | "corrupt-ram"
  | "under-temperature"
  | "over-temperature"
  | "head-open"
  | "ribbon-out"
  | "label-waiting"
export interface PrinterStatus {
  readonly readiness: Readiness
  readonly reasons: readonly NotReadyReason[]
  readonly observedAt: string
  readonly rawReply?: string
  readonly formatsBuffered?: number
  readonly labelsRemaining?: number
  readonly thermalTransfer?: boolean
  readonly unknownReason?: string
}

export function unknownStatus(reason: string): PrinterStatus {
  return Object.freeze({
    readiness: "unknown",
    reasons: Object.freeze([]),
    observedAt: new Date().toISOString(),
    unknownReason: reason,
  })
}

/** Strictly parse all three STX/ETX-framed ~HS records. undefined = incomplete.
 * Reference: https://docs.zebra.com/us/en/printers/software/zpl-pg/c-zpl-zpl-commands/r-zpl-hs.html
 * ~HS can remain silent in fault states; callers must handle timeouts as unknown.
 */
export function parseHostStatus(raw: string): PrinterStatus | undefined {
  const frames = [...raw.matchAll(/\x02([^\x02\x03]*)\x03/g)]
  if (frames.length < 3) return undefined
  if (
    frames.length !== 3 ||
    raw.replace(/\x02[^\x02\x03]*\x03/g, "").trim() !== ""
  ) {
    throw new Error("Unexpected host-status framing.")
  }
  const a = frames[0]![1]!.split(",")
  const b = frames[1]![1]!.split(",")
  const c = frames[2]![1]!.split(",")
  if (
    a.length !== 12 ||
    b.length !== 11 ||
    c.length !== 2 ||
    !a.every((value) => /^\d+$/.test(value)) ||
    !b.every((value, index) =>
      index === 5 ? /^[0-9KSA]$/.test(value) : /^\d+$/.test(value),
    ) ||
    !c.every((value) => /^\d+$/.test(value))
  ) {
    throw new Error("Malformed host-status fields.")
  }
  const flag = (fields: string[], index: number): boolean => {
    if (fields[index] !== "0" && fields[index] !== "1")
      throw new Error("Invalid host-status flag.")
    return fields[index] === "1"
  }
  const reasons: NotReadyReason[] = []
  const add = (condition: boolean, reason: NotReadyReason) => {
    if (condition) reasons.push(reason)
  }
  add(flag(a, 1), "paper-out")
  add(flag(a, 2), "paused")
  add(flag(a, 5), "buffer-full")
  add(flag(a, 6), "diagnostic-mode")
  add(flag(a, 7), "partial-format")
  add(flag(a, 9), "corrupt-ram")
  add(flag(a, 10), "under-temperature")
  add(flag(a, 11), "over-temperature")
  add(flag(b, 2), "head-open")
  const ribbonOut = flag(b, 3)
  const thermalTransfer = flag(b, 4)
  add(ribbonOut && thermalTransfer, "ribbon-out")
  add(flag(b, 7), "label-waiting")
  flag(b, 9)
  flag(c, 1)
  if (a[8] !== "000" || b[1] !== "0")
    throw new Error("Unexpected reserved host-status fields.")
  const formatsBuffered = Number(a[4])
  const labelsRemaining = Number(b[8])
  if (
    ![...a, ...b.filter((_, index) => index !== 5), ...c].every((value) =>
      Number.isSafeInteger(Number(value)),
    )
  ) {
    throw new Error("Host-status numeric field exceeds safe limits.")
  }
  return Object.freeze({
    readiness: reasons.length ? "not-ready" : "ready",
    reasons: Object.freeze(reasons),
    observedAt: new Date().toISOString(),
    rawReply: raw.trim(),
    formatsBuffered,
    labelsRemaining,
    thermalTransfer,
  })
}
