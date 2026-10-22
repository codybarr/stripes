import { invalid } from "./errors.js"
import { printSpeedCommand } from "./label.js"
import type { PrintSpeedIps } from "./label.js"

/** ImageData-compatible RGBA pixels. Dimensions are printer dots, not CSS pixels. */
export interface GraphicImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}
export interface GraphicOptions {
  threshold?: number
  copies?: number
  printSpeedIps?: PrintSpeedIps
}
/** Transparent pixels are composited onto white; each row is padded to a byte. */
export function monochrome(image: GraphicImage, threshold = 128) {
  const { width, height, data } = image ?? {}
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 448 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 8000 ||
    !(data instanceof Uint8ClampedArray) ||
    data.length !== width * height * 4
  ) {
    invalid("Provide RGBA ImageData, width 1–448 and height 1–8000 dots.")
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255)
    invalid("threshold must be an integer between 1 and 255.")
  const rowBytes = Math.ceil(width / 8)
  const bytes = new Uint8Array(rowBytes * height)
  const pixels = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const alpha = data[p + 3]! / 255
      const gray =
        (0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!) *
          alpha +
        255 * (1 - alpha)
      const black = gray < threshold
      if (black) {
        const offset = y * rowBytes + (x >> 3)
        bytes[offset] = bytes[offset]! | (0x80 >> (x & 7))
      }
      pixels[p] = pixels[p + 1] = pixels[p + 2] = black ? 0 : 255
      pixels[p + 3] = 255
    }
  }
  return { width, height, rowBytes, bytes, pixels }
}
export function createGraphicLabel(
  image: GraphicImage,
  options: GraphicOptions = {},
): string {
  if (!options || typeof options !== "object")
    invalid("Provide graphic options as an object.")
  const { threshold = 128, copies = 1, printSpeedIps } = options
  const speed = printSpeedCommand(printSpeedIps)
  if (!Number.isInteger(copies) || copies < 1 || copies > 100)
    invalid("copies must be 1–100.")
  const { width, height, rowBytes, bytes } = monochrome(image, threshold)
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase(),
  ).join("")
  return `^XA\n${speed ? speed + "\n" : ""}^PW${width}\n^LL${height}\n^LH0,0\n^LS0\n^FO0,0^GFA,${bytes.length},${bytes.length},${rowBytes},${hex}^FS\n^PQ${copies}\n^XZ`
}
