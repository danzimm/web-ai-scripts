#!/usr/bin/env node

const fs = require('fs');
const zlib = require('zlib');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPng(path) {
  const png = fs.readFileSync(path);
  if (!png.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error(`${path} is not a PNG`);
  }

  let offset = 8;
  let ihdr = null;
  const idat = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) {
    throw new Error(`${path} has no IHDR`);
  }
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0 || ![2, 6].includes(ihdr.colorType)) {
    throw new Error(`${path} must be an 8-bit non-interlaced RGB/RGBA PNG`);
  }

  const channels = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(ihdr.width * ihdr.height * channels);
  let inOffset = 0;
  let outOffset = 0;
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = inflated[inOffset];
    inOffset += 1;
    const scanline = inflated.subarray(inOffset, inOffset + stride);
    inOffset += stride;
    const recon = Buffer.alloc(stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? recon[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let value;

      if (filter === 0) {
        value = scanline[x];
      } else if (filter === 1) {
        value = scanline[x] + left;
      } else if (filter === 2) {
        value = scanline[x] + up;
      } else if (filter === 3) {
        value = scanline[x] + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = scanline[x] + predictor;
      } else {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }

      recon[x] = value & 0xff;
    }

    recon.copy(raw, outOffset);
    outOffset += stride;
    prev = recon;
  }

  return { ...ihdr, channels, data: raw };
}

function writeRgbaPng(path, width, height, rgba) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = 0;
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks = [
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ];
  fs.writeFileSync(path, Buffer.concat([PNG_SIG, ...chunks]));
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function transformChart(input, output) {
  const png = readPng(input);
  const out = Buffer.alloc(png.width * png.height * 4);

  for (let i = 0, j = 0; i < png.data.length; i += png.channels, j += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.channels === 4 ? png.data[i + 3] : 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max - min;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    if (a === 0 || (lum > 247 && sat < 10)) {
      out[j] = 255;
      out[j + 1] = 255;
      out[j + 2] = 255;
      out[j + 3] = 0;
      continue;
    }

    if (sat < 14 && lum > 210) {
      const alpha = Math.max(18, Math.min(70, Math.round((248 - lum) * 2.2)));
      out[j] = 176;
      out[j + 1] = 184;
      out[j + 2] = 184;
      out[j + 3] = Math.round((alpha * a) / 255);
      continue;
    }

    if (lum < 70 && sat < 28) {
      out[j] = 214;
      out[j + 1] = 222;
      out[j + 2] = 222;
      out[j + 3] = a;
      continue;
    }

    out[j] = Math.round(r * 0.62 + 255 * 0.38);
    out[j + 1] = Math.round(g * 0.62 + 255 * 0.38);
    out[j + 2] = Math.round(b * 0.62 + 255 * 0.38);
    out[j + 3] = a;
  }

  writeRgbaPng(output, png.width, png.height, out);
  console.log(`${input} -> ${output}`);
}

function transformDisks(input, output) {
  const png = readPng(input);
  const out = Buffer.alloc(png.width * png.height * 4);

  for (let i = 0, j = 0; i < png.data.length; i += png.channels, j += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.channels === 4 ? png.data[i + 3] : 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max - min;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    if (a === 0 || (lum > 248 && sat < 9)) {
      out[j] = 255;
      out[j + 1] = 255;
      out[j + 2] = 255;
      out[j + 3] = 0;
      continue;
    }

    // The plane is nearly neutral and light in the source image. Re-map it to
    // a subtle page-colored surface instead of a pale slab.
    if (sat < 7 && lum > 205) {
      const alpha = Math.max(35, Math.min(120, Math.round((250 - lum) * 3.8)));
      out[j] = 74;
      out[j + 1] = 81;
      out[j + 2] = 82;
      out[j + 3] = Math.round((alpha * a) / 255);
      continue;
    }

    // Black/gray curve strokes need to become light strokes in dark mode.
    if (sat < 35 && lum <= 205) {
      const stroke = Math.round(214 - lum * 0.18);
      out[j] = stroke;
      out[j + 1] = Math.min(235, stroke + 6);
      out[j + 2] = Math.min(235, stroke + 6);
      out[j + 3] = a;
      continue;
    }

    // Pastel disk fills are source-composited over white, so make them
    // translucent again. Saturated strokes remain more opaque.
    const isPastelFill = lum > 168 && sat < 125;
    const alpha = isPastelFill ? 155 : 230;
    if (isPastelFill) {
      const assumedAlpha = 0.48;
      out[j] = Math.max(0, Math.min(255, Math.round((r - (1 - assumedAlpha) * 255) / assumedAlpha)));
      out[j + 1] = Math.max(0, Math.min(255, Math.round((g - (1 - assumedAlpha) * 255) / assumedAlpha)));
      out[j + 2] = Math.max(0, Math.min(255, Math.round((b - (1 - assumedAlpha) * 255) / assumedAlpha)));
    } else {
      out[j] = Math.round(r * 0.9 + 255 * 0.1);
      out[j + 1] = Math.round(g * 0.9 + 255 * 0.1);
      out[j + 2] = Math.round(b * 0.9 + 255 * 0.1);
    }
    out[j + 3] = Math.round((alpha * a) / 255);
  }

  writeRgbaPng(output, png.width, png.height, out);
  console.log(`${input} -> ${output}`);
}

function usage() {
  console.log(`Usage: png-color-tools.js COMMAND INPUT [OUTPUT] [options]

Transforms simple RGB/RGBA PNG files without external dependencies.

Commands:
  chart-dark INPUT OUTPUT        Remap a light chart PNG for dark backgrounds
  disks-dark INPUT OUTPUT        Remap a light disk/line figure for dark backgrounds
  key-background INPUT [OUTPUT]  Make pixels near a target color transparent

Options for key-background:
  --target COLOR                 Hex (#383b3c) or r,g,b target (default: #383b3c)
  --radius NUMBER                Soft key radius in RGB space (default: 24)

Options:
  -h, --help                     Show this help
`);
}

function parseColor(value) {
  const hex = value.match(/^#?([0-9a-fA-F]{6})$/);
  if (hex) {
    const int = Number.parseInt(hex[1], 16);
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }

  const rgb = value.split(',').map((part) => Number(part));
  if (rgb.length === 3 && rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    return rgb;
  }

  throw new Error('--target must be #rrggbb or r,g,b');
}

function parseOptions(args) {
  const options = new Map();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target' || arg === '--radius') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      options.set(arg, value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.set(arg, true);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { options, positionals };
}

function keyBackground(input, output = input, rawTarget = '#383b3c', rawRadius = '24') {
  const target = parseColor(rawTarget);
  const softRadius = Number(rawRadius);
  if (!Number.isFinite(softRadius) || softRadius <= 0) {
    throw new Error('--radius must be a positive number');
  }

  const png = readPng(input);
  const out = Buffer.alloc(png.width * png.height * 4);

  for (let i = 0, j = 0; i < png.data.length; i += png.channels, j += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.channels === 4 ? png.data[i + 3] : 255;
    const distance = Math.hypot(r - target[0], g - target[1], b - target[2]);
    const alphaScale = Math.min(1, Math.max(0, distance / softRadius));

    out[j] = r;
    out[j + 1] = g;
    out[j + 2] = b;
    out[j + 3] = distance < softRadius ? Math.round(a * alphaScale) : a;
  }

  writeRgbaPng(output, png.width, png.height, out);
  console.log(`${input} -> ${output} (keyed ${target.join(',')} radius ${softRadius})`);
}

function main(argv = process.argv.slice(2)) {
  const { options, positionals } = parseOptions(argv);
  if (options.has('--help') || options.has('-h') || positionals.length === 0) {
    usage();
    return;
  }

  const [command, input, output] = positionals;
  if (!input) {
    throw new Error(`${command} requires INPUT`);
  }

  if (command === 'chart-dark') {
    if (!output) {
      throw new Error('chart-dark requires OUTPUT');
    }
    transformChart(input, output);
  } else if (command === 'disks-dark') {
    if (!output) {
      throw new Error('disks-dark requires OUTPUT');
    }
    transformDisks(input, output);
  } else if (command === 'key-background') {
    keyBackground(input, output || input, options.get('--target') || '#383b3c', options.get('--radius') || '24');
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  keyBackground,
  main,
  readPng,
  transformChart,
  transformDisks,
  writeRgbaPng,
};
