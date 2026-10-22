import { invalid } from "./errors.js"

export const DPI = 203
export type ResidentFont = "0" | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H"
export type PrintSpeedIps = 2 | 6
export interface LabelLine {
  text: string
  font?: ResidentFont
  fontSizeMm?: number
  xMm?: number
  yMm?: number
  align?: "left" | "center"
}
export interface LabelOptions {
  widthMm?: number
  heightMm?: number
  lines: readonly LabelLine[]
  copies?: number
  align?: "left" | "center"
  verticalAlign?: "top" | "center"
  printSpeedIps?: PrintSpeedIps
}
export const RESIDENT_FONTS = Object.freeze(
  [
    { id: "0", name: "Scalable", height: null, width: null },
    { id: "A", name: "Small bitmap", height: 9, width: 5 },
    { id: "B", name: "Uppercase bitmap", height: 11, width: 7 },
    { id: "C", name: "Bitmap", height: 18, width: 10 },
    { id: "D", name: "Bitmap", height: 18, width: 10 },
    { id: "E", name: "OCR-B", height: 28, width: 15 },
    { id: "F", name: "Bitmap", height: 26, width: 13 },
    { id: "G", name: "Large bitmap", height: 60, width: 40 },
    { id: "H", name: "OCR-A", height: 21, width: 13 },
  ].map((font) => Object.freeze(font)),
)
const dots = (mm: number) => Math.round((mm * DPI) / 25.4)
function number(value: number, name: string, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    invalid(`${name} must be a number between ${min} and ${max}.`)
  }
  return value
}
export function printSpeedCommand(speed?: PrintSpeedIps): string {
  if (speed === undefined) return ""
  if (speed !== 2 && speed !== 6)
    invalid("printSpeedIps must be 2 or 6 inches/second.")
  return `^PR${speed}`
}
export function fontMetrics(font: ResidentFont = "0", fontSizeMm = 4) {
  const definition = RESIDENT_FONTS.find((entry) => entry.id === font)
  if (!definition) invalid("font must be one of 0, A, B, C, D, E, F, G, H.")
  const requested = dots(number(fontSizeMm, "fontSizeMm", 1, 50))
  if (font === "0") {
    const height = Math.max(10, requested)
    return { font, height, width: height, heightMm: (height * 25.4) / DPI }
  }
  const scale = Math.max(1, Math.round(requested / definition.height!))
  if (scale > 10) invalid(`Font ${font} supports at most 10× its native size.`)
  const height = definition.height! * scale
  return {
    font,
    height,
    width: definition.width! * scale,
    heightMm: (height * 25.4) / DPI,
  }
}
/** Generate escaped ZPL. Pure function; no device access. */
export function createLabel(options: LabelOptions): string {
  if (!options || typeof options !== "object") invalid("Provide label options.")
  const {
    widthMm = 50.8,
    heightMm = 25.4,
    lines,
    copies = 1,
    align = "left",
    verticalAlign = "top",
    printSpeedIps,
  } = options
  const speed = printSpeedCommand(printSpeedIps)
  number(widthMm, "widthMm", 5, 56)
  number(heightMm, "heightMm", 5, 1000)
  number(copies, "copies", 1, 100)
  if (!Number.isInteger(copies)) invalid("copies must be an integer.")
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 100)
    invalid("Provide between 1 and 100 lines.")
  if (!["left", "center"].includes(align))
    invalid("align must be left or center.")
  if (!["top", "center"].includes(verticalAlign))
    invalid("verticalAlign must be top or center.")
  const metrics = Array.from(lines, (line, index) => {
    if (
      !line ||
      typeof line.text !== "string" ||
      line.text.length > 1000 ||
      /[\x00-\x1f\x7f]/.test(line.text)
    ) {
      invalid(
        `Line ${index + 1} needs text without control characters (max 1000 characters).`,
      )
    }
    return fontMetrics(line.font ?? "0", line.fontSizeMm ?? 4)
  })
  const blockHeight =
    metrics.reduce((sum, metric) => sum + metric.height, 0) +
    dots(1) * (lines.length - 1)
  if (verticalAlign === "center") {
    if (lines.some((line) => line.yMm !== undefined))
      invalid("Explicit yMm cannot be combined with vertical centering.")
    if (blockHeight > dots(heightMm) - 2 * dots(2))
      invalid(
        "Centered text block exceeds the label’s 2 mm top/bottom margins.",
      )
  }
  let nextY = dots(2)
  let centeredY = Math.round((dots(heightMm) - blockHeight) / 2)
  const fields = lines.map((line, index) => {
    const metric = metrics[index]!
    const x = dots(number(line.xMm ?? 2, "xMm", 0, widthMm))
    const y =
      line.yMm === undefined
        ? nextY
        : dots(number(line.yMm, "yMm", 0, heightMm))
    const yDots = verticalAlign === "center" ? centeredY : y
    centeredY += metric.height + dots(1)
    const lineAlign = line.align ?? align
    if (!["left", "center"].includes(lineAlign))
      invalid("Line align must be left or center.")
    const blockWidth = dots(widthMm) - 2 * x
    if (lineAlign === "center" && blockWidth <= 0)
      invalid(`Line ${index + 1} has no space between its symmetric margins.`)
    if (x >= dots(widthMm) || yDots + metric.height > dots(heightMm))
      invalid(`Line ${index + 1} is outside the label.`)
    nextY = y + metric.height + dots(1)
    // Every UTF-8 byte is escaped: untrusted text cannot inject ZPL commands.
    const text = Array.from(
      new TextEncoder().encode(line.text),
      (byte) => "_" + byte.toString(16).padStart(2, "0").toUpperCase(),
    ).join("")
    const block = lineAlign === "center" ? `^FB${blockWidth},1,0,C,0` : ""
    return `^FO${x},${yDots}^A${metric.font}N,${metric.height},${metric.width}${block}^FH_^FD${text}^FS`
  })
  return [
    "^XA",
    ...(speed ? [speed] : []),
    "^CI28",
    `^PW${dots(widthMm)}`,
    `^LL${dots(heightMm)}`,
    "^LH0,0",
    "^LS0",
    ...fields,
    `^PQ${copies}`,
    "^XZ",
  ].join("\n")
}
