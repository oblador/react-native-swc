// Inspect a PNG screenshot and emit a JSON verdict used by the E2E tests:
//   - redboxRatio:    fraction of top-quarter pixels whose color matches the
//                     React Native RedBox background (dominant dark red).
//   - distinctColors: number of unique quantized colors across a grid
//                     sampling of the full image. A rendered app has many;
//                     a blank / uniform-white / uniform-black screen has ~1.
//
// Usage: swift screencheck.swift <path-to-screenshot.png>

import AppKit
import Foundation

guard let path = CommandLine.arguments.dropFirst().first else {
    FileHandle.standardError.write("usage: screencheck.swift <path>\n".data(using: .utf8)!)
    exit(2)
}
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("failed to load image at \(path)\n".data(using: .utf8)!)
    exit(2)
}

let w = cg.width
let h = cg.height
let bpp = 4
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
var pixels = [UInt8](repeating: 0, count: w * h * bpp)
let ctx = CGContext(
    data: &pixels, width: w, height: h, bitsPerComponent: 8,
    bytesPerRow: w * bpp, space: colorSpace, bitmapInfo: bitmapInfo
)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

// RedBox detection: sample the top ~25% (where the red background fills the
// screen) on a coarse grid, counting pixels whose red channel dominates
// green and blue — covers both the legacy dark-red RCTRedBox (~#AA0000)
// and the modern LogBox pink-red header (~#EC5B67). Previously we required
// `g < 70 && b < 70` which the modern header's saturated pink fails.
var redHits = 0
var topSamples = 0
let topRows = max(1, h / 4)
for y in stride(from: 0, to: topRows, by: 4) {
    for x in stride(from: 0, to: w, by: 8) {
        let idx = (y * w + x) * bpp
        let r = Int(pixels[idx])
        let g = Int(pixels[idx + 1])
        let b = Int(pixels[idx + 2])
        topSamples += 1
        if r > 140 && r - g > 50 && r - b > 50 && g < 160 && b < 160 {
            redHits += 1
        }
    }
}
let redRatio = Double(redHits) / Double(max(1, topSamples))

// Distinct-color sampling: coarse 30x30 grid across the whole image,
// colors quantized to 5 bits per channel so JPEG-style jitter stays bucketed.
var uniq = Set<UInt32>()
for y in stride(from: 0, to: h, by: max(1, h / 30)) {
    for x in stride(from: 0, to: w, by: max(1, w / 30)) {
        let idx = (y * w + x) * bpp
        let r = UInt32(pixels[idx])
        let g = UInt32(pixels[idx + 1])
        let b = UInt32(pixels[idx + 2])
        let key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3)
        uniq.insert(key)
    }
}

print("{\"width\":\(w),\"height\":\(h),\"redboxRatio\":\(redRatio),\"distinctColors\":\(uniq.count)}")
