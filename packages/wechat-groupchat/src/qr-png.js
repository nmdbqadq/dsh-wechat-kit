/**
 * Turn the iLink login URL into a scannable image.
 *
 * The gateway's `qrcode_img_content` is an HTML page that renders the code with
 * JavaScript, so it cannot be used as `<img src>` anywhere. The URL string is
 * therefore encoded locally (vendored qrcode-generator, MIT) into both an SVG
 * for the login page and a PNG the agent can show directly in a chat.
 */
import zlib from "node:zlib";
import qrcodeFactory from "./ilink/qrcode.mjs";

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function qrMatrix(text) {
    const qr = qrcodeFactory(0, "M");
    qr.addData(text);
    qr.make();
    return qr;
}

/** SVG (scalable, what the login page embeds). */
export function qrSvg(text) {
    return qrMatrix(text).createSvgTag({ cellSize: 2, margin: 2, scalable: true });
}

/**
 * Grayscale PNG of the same code. Small and dependency-free on purpose: the
 * image is written next to the token so it can be opened, or shown inline by
 * whatever surface the operator is using, without a browser.
 */
export function qrPng(text, { scale = 6, margin = 4 } = {}) {
    const qr = qrMatrix(text);
    const count = qr.getModuleCount();
    const side = (count + margin * 2) * scale;
    const stride = side * 3 + 1;
    const pixels = Buffer.alloc(stride * side, 0xff);
    for (let y = 0; y < side; y += 1) {
        pixels[y * stride] = 0; // PNG filter: none
    }
    for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
            if (!qr.isDark(row, col)) continue;
            for (let dy = 0; dy < scale; dy += 1) {
                const y = (row + margin) * scale + dy;
                for (let dx = 0; dx < scale; dx += 1) {
                    const x = (col + margin) * scale + dx;
                    const offset = y * stride + 1 + x * 3;
                    pixels[offset] = 0;
                    pixels[offset + 1] = 0;
                    pixels[offset + 2] = 0;
                }
            }
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side, 0);
    header.writeUInt32BE(side, 4);
    header[8] = 8;  // bit depth
    header[9] = 2;  // colour type: truecolour
    header[10] = 0; // compression
    header[11] = 0; // filter
    header[12] = 0; // interlace
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(pixels, { level: 9 })),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}
