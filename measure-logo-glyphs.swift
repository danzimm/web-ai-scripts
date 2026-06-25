#!/usr/bin/env swift

import AppKit
import Foundation

struct Region {
    let name: String
    var x0: Int
    var y0: Int
    var x1: Int
    var y1: Int
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("error: \(message)\n").utf8))
    exit(2)
}

func usage() -> Never {
    print("""
Usage: swift measure-logo-glyphs.swift --image PATH [options]

Measures visible glyph bounds in screenshot regions. Coordinates are pixels in
the input image, specified as x0,y0,x1,y1. When no region is supplied, the whole
image is measured.

Options:
  --threshold NUMBER       Ink threshold from 0 to 1 (default: 0.80).
  --min-row-pixels NUMBER  Minimum ink pixels for a row (default: 3).
  --region REGION          Named region as name:x0,y0,x1,y1. Repeatable.
  --NAME REGION            Shorthand for --region NAME:x0,y0,x1,y1.
""")
    exit(0)
}

func parseRegionCoordinates(_ value: String, name: String) -> Region {
    let values = value.split(separator: ",").compactMap { Int($0) }
    guard values.count == 4, values[0] < values[2], values[1] < values[3] else {
        fail("--\(name) requires x0,y0,x1,y1")
    }
    return Region(name: name, x0: values[0], y0: values[1], x1: values[2], y1: values[3])
}

func parseNamedRegion(_ value: String) -> Region {
    let parts = value.split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2, !parts[0].isEmpty else {
        fail("--region requires name:x0,y0,x1,y1")
    }
    return parseRegionCoordinates(parts[1], name: parts[0])
}

var imagePath: String?
var threshold: CGFloat = 0.80
var minRowPixels = 3
var regions: [Region] = []
var arguments = Array(CommandLine.arguments.dropFirst())

while !arguments.isEmpty {
    let option = arguments.removeFirst()
    if option == "--help" || option == "-h" { usage() }
    guard let value = arguments.first else { fail("missing value for \(option)") }
    arguments.removeFirst()

    switch option {
    case "--image": imagePath = value
    case "--threshold":
        guard let parsed = Double(value), (0...1).contains(parsed) else {
            fail("--threshold requires a value from 0 to 1")
        }
        threshold = CGFloat(parsed)
    case "--min-row-pixels":
        guard let parsed = Int(value), parsed > 0 else {
            fail("--min-row-pixels requires a positive integer")
        }
        minRowPixels = parsed
    case "--region":
        regions.append(parseNamedRegion(value))
    default:
        guard option.hasPrefix("--") else { fail("unknown option \(option)") }
        let name = String(option.dropFirst(2))
        regions.append(parseRegionCoordinates(value, name: name))
    }
}

guard let imagePath else { usage() }
guard let image = NSImage(contentsOfFile: imagePath),
      let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!) else {
    fail("could not read image at \(imagePath)")
}

if regions.isEmpty {
    regions.append(Region(name: "image", x0: 0, y0: 0, x1: bitmap.pixelsWide, y1: bitmap.pixelsHigh))
}

func hasInk(_ x: Int, _ y: Int) -> Bool {
    guard let color = bitmap.colorAt(x: x, y: y) else { return false }
    return min(color.redComponent, color.greenComponent, color.blueComponent) < threshold
}

for region in regions {
    guard region.x0 >= 0, region.y0 >= 0,
          region.x1 <= bitmap.pixelsWide, region.y1 <= bitmap.pixelsHigh else {
        fail("\(region.name) region is outside the \(bitmap.pixelsWide)x\(bitmap.pixelsHigh) image")
    }

    var activeRunStart: Int?
    var runs: [(Int, Int, Int)] = []

    for y in region.y0..<region.y1 {
        var count = 0
        for x in region.x0..<region.x1 where hasInk(x, y) { count += 1 }

        if count >= minRowPixels {
            if activeRunStart == nil { activeRunStart = y }
        } else if let start = activeRunStart {
            runs.append((start, y - 1, 0))
            activeRunStart = nil
        }
    }
    if let start = activeRunStart { runs.append((start, region.y1 - 1, 0)) }

    let labels = runs.map { "\($0.0)-\($0.1) [\($0.1 - $0.0 + 1)px]" }.joined(separator: ", ")
    print("\(region.name): \(labels.isEmpty ? "no ink detected" : labels)")
}
