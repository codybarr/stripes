import { expect, test } from "bun:test"
import {
  createLabel,
  createGraphicLabel,
  fontMetrics,
  monochrome,
  RESIDENT_FONTS,
} from "../index.js"
import type { LabelOptions, ResidentFont } from "../index.js"

test("default geometry, flow, and byte-by-byte ZPL escaping", () => {
  const zpl = createLabel({
    lines: [
      { text: "^XZ~JA_é", fontSizeMm: 5 },
      { text: "World", fontSizeMm: 3 },
    ],
  })
  expect(zpl).toContain("^PW406\n^LL203")
  expect(zpl).toContain("^FO16,16^A0N,40,40")
  expect(zpl).toContain("^FO16,64^A0N,24,24")
  expect(zpl).toContain("_5E_58_5A_7E_4A_41_5F_C3_A9")
  expect(zpl.match(/\^XZ/g)?.length).toBe(1)
  expect(zpl).not.toContain("~JA")
})
test("centering uses resolved dot heights and resident font dimensions", () => {
  const zpl = createLabel({
    align: "center",
    verticalAlign: "center",
    lines: [
      { text: "FIRST", font: "G", fontSizeMm: 3 },
      { text: "SECOND", font: "A", fontSizeMm: 3 },
    ],
  })
  expect(zpl).toContain("^FO16,54^AGN,60,40^FB374")
  expect(zpl).toContain("^FO16,122^AAN,27,15")
  for (const font of RESIDENT_FONTS) {
    const metrics = fontMetrics(font.id as ResidentFont, 5)
    expect(
      createLabel({
        lines: [{ text: "TEST", font: font.id as ResidentFont, fontSizeMm: 5 }],
      }),
    ).toContain(`^A${font.id}N,${metrics.height},${metrics.width}`)
  }
})
test("invalid sizes, fonts, positions, controls, and alignment fail safely", () => {
  for (const options of [
    { widthMm: 57 },
    { copies: 1.5 },
    { copies: NaN },
    { heightMm: Infinity },
    { align: "right" },
    { lines: [] },
    { lines: [{ text: "a\nb" }] },
    { lines: [{ text: "a", yMm: 24 }] },
    { lines: [{ text: "a", xMm: 50.8 }] },
    { lines: [{ text: "a", font: "0^XZ" }] },
    { verticalAlign: "center", lines: [{ text: "a", yMm: 2 }] },
    { verticalAlign: "center", lines: [{ text: "a", fontSizeMm: 25 }] },
  ])
    expect(() =>
      createLabel({ lines: [{ text: "TEST" }], ...options } as LabelOptions),
    ).toThrow()
  expect(() => fontMetrics("A", 50)).toThrow()
})
test("speed is optional and only accepts 2 or 6 ips", () => {
  const options = { lines: [{ text: "TEST" }] }
  expect(createLabel(options)).not.toContain("^PR")
  expect(createLabel({ ...options, printSpeedIps: 2 })).toContain("^PR2")
  expect(() =>
    createLabel({ ...options, printSpeedIps: 3 } as unknown as LabelOptions),
  ).toThrow()
})
test("raster bit order, row padding, alpha, and preview are exact", () => {
  const data = new Uint8ClampedArray(9 * 2 * 4).fill(255)
  for (const p of [0, 8, 9]) data.set([0, 0, 0, 255], p * 4)
  data.set([0, 0, 0, 0], 4) // transparent black prints white
  const image = { width: 9, height: 2, data }
  const mono = monochrome(image)
  expect([...mono.bytes]).toEqual([0x80, 0x80, 0x80, 0])
  expect(mono.pixels.slice(4, 8)).toEqual(
    new Uint8ClampedArray([255, 255, 255, 255]),
  )
  expect(createGraphicLabel(image)).toContain("^GFA,4,4,2,80808000")
})
test("invalid raster input and copy/threshold limits are rejected", () => {
  const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) }
  expect(() => monochrome({ ...image, width: 449 })).toThrow()
  expect(() =>
    monochrome({ ...image, data: new Uint8ClampedArray(3) }),
  ).toThrow()
  expect(() => monochrome(image, 0)).toThrow()
  expect(() => createGraphicLabel(image, { copies: 101 })).toThrow()
})
