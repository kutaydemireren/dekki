// Renders the Dekki app icon with CoreGraphics. No dependencies.
// usage: swift render.swift <out dir>   -> AppIcon.iconset/*.png, preview.png, contact.png
import AppKit
import CoreGraphics

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}
let cs = CGColorSpace(name: CGColorSpace.sRGB)!

// Draws the icon in a 1024x1024 y-down space.
func draw(_ c: CGContext) {
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = CGPath(roundedRect: body, cornerWidth: 184, cornerHeight: 184, transform: nil)

    // soft drop shadow
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -14), blur: 28, color: rgb(0x000000, 0.38))
    c.setFillColor(rgb(0x0b4f80)); c.addPath(bodyPath); c.fillPath()
    c.restoreGState()

    // body gradient (accent blue of the web UI #0e639c, lightened on top)
    c.saveGState()
    c.addPath(bodyPath); c.clip()
    let g = CGGradient(colorsSpace: cs, colors: [rgb(0x3aa0e6), rgb(0x0e639c), rgb(0x0a3f6b)] as CFArray, locations: [0, 0.55, 1])!
    c.drawLinearGradient(g, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    let sh = CGGradient(colorsSpace: cs, colors: [rgb(0xffffff, 0.22), rgb(0xffffff, 0)] as CFArray, locations: [0, 1])!
    c.drawLinearGradient(sh, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 420), options: [])

    // cards fanned from a pivot near the bottom
    let pivot = CGPoint(x: 512, y: 800)
    let cw: CGFloat = 330, ch: CGFloat = 470
    func card(_ angle: CGFloat, _ fill: UInt32, _ edge: UInt32, _ extra: (() -> Void)? = nil) {
        c.saveGState()
        c.translateBy(x: pivot.x, y: pivot.y)
        c.rotate(by: angle * .pi / 180)
        let r = CGRect(x: -cw / 2, y: -ch, width: cw, height: ch)
        let p = CGPath(roundedRect: r, cornerWidth: 46, cornerHeight: 46, transform: nil)
        c.saveGState()
        c.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: rgb(0x00182e, 0.45))
        c.setFillColor(rgb(fill)); c.addPath(p); c.fillPath()
        c.restoreGState()
        c.setStrokeColor(rgb(edge)); c.setLineWidth(8); c.addPath(p); c.strokePath()
        extra?()
        c.restoreGState()
    }
    card(-27, 0xff8a65, 0xe2613d)
    card(27, 0xffd166, 0xe0a82e)
    card(0, 0xfff8ec, 0xe9dcc3) {
        // robot face, local coords: card spans y -470..0
        c.setStrokeColor(rgb(0x1b2b3d)); c.setLineWidth(14); c.setLineCap(.round)
        c.move(to: CGPoint(x: 0, y: -ch)); c.addLine(to: CGPoint(x: 0, y: -ch - 52)); c.strokePath()
        c.saveGState()
        c.setShadow(offset: .zero, blur: 34, color: rgb(0x34e08a, 0.95))
        c.setFillColor(rgb(0x34e08a)); c.fillEllipse(in: CGRect(x: -40, y: -ch - 52 - 62, width: 80, height: 80))
        c.restoreGState()
        c.setFillColor(rgb(0xd5ffe8)); c.fillEllipse(in: CGRect(x: -22, y: -ch - 52 - 46, width: 24, height: 24))
        let ey: CGFloat = -ch + 190
        for x: CGFloat in [-72, 72] {
            c.setFillColor(rgb(0x1b2b3d)); c.fillEllipse(in: CGRect(x: x - 44, y: ey - 44, width: 88, height: 88))
            c.setFillColor(rgb(0xffffff)); c.fillEllipse(in: CGRect(x: x - 22, y: ey - 30, width: 26, height: 26))
        }
        c.setFillColor(rgb(0xff9f95, 0.75))
        for x: CGFloat in [-112, 112] { c.fillEllipse(in: CGRect(x: x - 24, y: ey + 56, width: 48, height: 30)) }
        c.setStrokeColor(rgb(0x1b2b3d)); c.setLineWidth(18); c.setLineCap(.round)
        c.move(to: CGPoint(x: -46, y: ey + 78))
        c.addQuadCurve(to: CGPoint(x: 46, y: ey + 78), control: CGPoint(x: 0, y: ey + 140))
        c.strokePath()
    }
    c.restoreGState()
}

func render(size: Int) -> CGImage {
    let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    c.setShouldAntialias(true)
    let s = CGFloat(size) / 1024
    c.translateBy(x: 0, y: CGFloat(size)); c.scaleBy(x: s, y: -s) // y-down 1024 space
    draw(c)
    return c.makeImage()!
}

func writePNG(_ img: CGImage, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let set = out + "/AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    writePNG(render(size: base), "\(set)/icon_\(base)x\(base).png")
    writePNG(render(size: base * 2), "\(set)/icon_\(base)x\(base)@2x.png")
}
writePNG(render(size: 1024), out + "/preview.png")

// contact sheet: 1024 (shown 300 px), 256, 64, 32, 16 on light and dark rows
let W = 800, RH = 330
let sheet = CGContext(data: nil, width: W, height: 2 * RH, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
sheet.interpolationQuality = .high
for (row, bg) in [(1, UInt32(0xf2f2f2)), (0, UInt32(0x1e1e1e))] {
    sheet.setFillColor(rgb(bg)); sheet.fill(CGRect(x: 0, y: row * RH, width: W, height: RH))
    var x = 20
    for s in [1024, 256, 64, 32, 16] {
        let shown = s == 1024 ? 300 : s
        sheet.draw(render(size: s), in: CGRect(x: x, y: row * RH + 15, width: shown, height: shown))
        x += shown + 20
    }
}
writePNG(sheet.makeImage()!, out + "/contact.png")
