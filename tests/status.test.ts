import { expect, test } from "bun:test"
import { parseHostStatus } from "../src/status.js"
import { hostStatus } from "./usb-mock.js"

test("complete ready response exposes counters and timestamp", () => {
  const status = parseHostStatus(hostStatus({ 4: "012" }, { 8: "00000003" }))!
  expect(status.readiness).toBe("ready")
  expect(status.formatsBuffered).toBe(12)
  expect(status.labelsRemaining).toBe(3)
  expect(Date.parse(status.observedAt)).not.toBeNaN()
})
for (const [index, reason] of [
  [1, "paper-out"],
  [2, "paused"],
  [5, "buffer-full"],
  [6, "diagnostic-mode"],
  [7, "partial-format"],
  [9, "corrupt-ram"],
  [10, "under-temperature"],
  [11, "over-temperature"],
] as const) {
  test(`first record flag: ${reason}`, () => {
    expect(parseHostStatus(hostStatus({ [index]: "1" }))!.reasons).toEqual([
      reason,
    ])
  })
}
test("head-open and label-waiting are not ready", () => {
  expect(parseHostStatus(hostStatus({}, { 2: "1", 7: "1" }))!.reasons).toEqual([
    "head-open",
    "label-waiting",
  ])
})
test("ribbon-out only blocks when thermal transfer is selected", () => {
  expect(parseHostStatus(hostStatus({}, { 3: "1", 4: "0" }))!.readiness).toBe(
    "ready",
  )
  expect(parseHostStatus(hostStatus({}, { 3: "1", 4: "1" }))!.reasons).toEqual([
    "ribbon-out",
  ])
})
test("incomplete, malformed, extra, or unframed replies never report ready", () => {
  const raw = hostStatus()
  for (let i = 0; i < raw.lastIndexOf("\x03"); i++)
    expect(parseHostStatus(raw.slice(0, i))).toBeUndefined()
  for (const invalid of [
    raw + raw,
    "garbage" + raw,
    hostStatus({ 2: "2" }),
    hostStatus({ 4: "NaN" }),
    hostStatus({ 4: "999999999999999999" }),
    hostStatus({}, { 5: "Z" }),
    raw.replace("0000,0", "0000,9"),
  ])
    expect(() => parseHostStatus(invalid)).toThrow()
})
