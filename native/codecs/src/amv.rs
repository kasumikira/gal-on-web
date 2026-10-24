use crate::DecodeError;
use std::sync::OnceLock;

struct Reader<'a> {
    bytes: &'a [u8],
    bit: usize,
}
impl Reader<'_> {
    fn peek(&self, n: usize) -> u32 {
        if n == 0 {
            return 0;
        }
        let at = self.bit / 8;
        let word = if at + 4 <= self.bytes.len() {
            u32::from_be_bytes(self.bytes[at..at + 4].try_into().unwrap())
        } else {
            let mut tail = [0; 4];
            if at < self.bytes.len() {
                let count = (self.bytes.len() - at).min(4);
                tail[..count].copy_from_slice(&self.bytes[at..at + count]);
            }
            u32::from_be_bytes(tail)
        };
        (word << (self.bit & 7)) >> (32 - n)
    }
    fn read(&mut self, n: usize) -> Result<u32, DecodeError> {
        if self.bit + n > self.bytes.len() * 8 {
            return Err(DecodeError::Invalid);
        }
        let value = self.peek(n);
        self.bit += n;
        Ok(value)
    }
}

struct Huffman {
    fast: [(u8, u8); 512],
    max: [i32; 17],
    offset: [i32; 17],
    symbols: &'static [u8],
}
impl Huffman {
    fn new(counts: &[u8], symbols: &'static [u8]) -> Self {
        let mut table = Self {
            fast: [(0, 0); 512],
            max: [-1; 17],
            offset: [0; 17],
            symbols,
        };
        let (mut code, mut index) = (0usize, 0usize);
        for length in 1..=16 {
            table.offset[length] = index as i32 - code as i32;
            for _ in 0..counts[length] {
                if length <= 9 {
                    let first = code << (9 - length);
                    table.fast[first..first + (1 << (9 - length))]
                        .fill((length as u8, symbols[index]));
                }
                code += 1;
                index += 1;
            }
            if counts[length] != 0 {
                table.max[length] = code as i32 - 1;
            }
            code <<= 1;
        }
        table
    }
    fn decode(&self, reader: &mut Reader) -> Result<u8, DecodeError> {
        let (bits, symbol) = self.fast[reader.peek(9) as usize];
        if bits != 0 {
            reader.read(bits as usize)?;
            return Ok(symbol);
        }
        let mut code = reader.read(9)? as i32;
        for length in 10..=16 {
            code = (code << 1) | reader.read(1)? as i32;
            if code <= self.max[length] {
                return self
                    .symbols
                    .get((self.offset[length] + code) as usize)
                    .copied()
                    .ok_or(DecodeError::Invalid);
            }
        }
        Err(DecodeError::Invalid)
    }
}
fn signed(reader: &mut Reader, size: usize) -> Result<i32, DecodeError> {
    if size == 0 {
        return Ok(0);
    }
    let value = reader.read(size)? as i32;
    Ok(if value < 1 << (size - 1) {
        value + 1 - (1 << size)
    } else {
        value
    })
}
struct Tables {
    dc_y: Huffman,
    dc_c: Huffman,
    ac_y: Huffman,
    ac_c: Huffman,
}
fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| Tables {
        dc_y: Huffman::new(&DCLUMABITS, &DCVALUES),
        dc_c: Huffman::new(&DCCHROMABITS, &DCVALUES),
        ac_y: Huffman::new(&ACLUMABITS, &ACLUMAVALUES),
        ac_c: Huffman::new(&ACCHROMABITS, &ACCHROMAVALUES),
    })
}

// libjpeg islow butterfly. i64 keeps the JS reference's non-wrapping products;
// the column workspace is explicitly narrowed to match its Int32Array.
fn butterfly(v: [i64; 8]) -> [i64; 8] {
    let z1 = (v[2] + v[6]) * 4433;
    let tmp2 = z1 - v[6] * 15137;
    let tmp3 = z1 + v[2] * 6270;
    let tmp0 = (v[0] + v[4]) * 8192;
    let tmp1 = (v[0] - v[4]) * 8192;
    let tmp10 = tmp0 + tmp3;
    let tmp13 = tmp0 - tmp3;
    let tmp11 = tmp1 + tmp2;
    let tmp12 = tmp1 - tmp2;
    let (a, b, c, d) = (v[7], v[5], v[3], v[1]);
    let z1 = (a + d) * -7373;
    let z2 = (b + c) * -20995;
    let z5 = (a + c + b + d) * 9633;
    let z3 = (a + c) * -16069 + z5;
    let z4 = (b + d) * -3196 + z5;
    let t0 = a * 2446 + z1 + z3;
    let t1 = b * 16819 + z2 + z4;
    let t2 = c * 25172 + z2 + z3;
    let t3 = d * 12299 + z1 + z4;
    [
        tmp10 + t3,
        tmp11 + t2,
        tmp12 + t1,
        tmp13 + t0,
        tmp13 - t0,
        tmp12 - t1,
        tmp11 - t2,
        tmp10 - t3,
    ]
}
fn range(value: i64) -> u8 {
    match (value & 1023) as usize {
        i @ 0..=127 => (i + 128) as u8,
        128..=511 => 255,
        512..=895 => 0,
        i => (i - 896) as u8,
    }
}
fn idct(quant: &[i16; 64], coef: &[i16; 64], plane: &mut [u8], offset: usize, pitch: usize) {
    let mut work = [0i32; 64];
    for col in 0..8 {
        if (1..8).all(|row| coef[col + row * 8] == 0) {
            let dc = (coef[col] as i32 * quant[col] as i32).wrapping_shl(2);
            for row in 0..8 {
                work[col + row * 8] = dc;
            }
        } else {
            let v =
                std::array::from_fn(|row| coef[col + row * 8] as i64 * quant[col + row * 8] as i64);
            let result = butterfly(v);
            for row in 0..8 {
                work[col + row * 8] = ((result[row] + 1024) >> 11) as i32;
            }
        }
    }
    for row in 0..8 {
        let w = &work[row * 8..row * 8 + 8];
        let out = offset + row * pitch;
        if w[1..].iter().all(|&x| x == 0) {
            plane[out..out + 8].fill(range((w[0].wrapping_add(16) >> 5) as i64));
        } else {
            let result = butterfly(std::array::from_fn(|i| w[i] as i64));
            for i in 0..8 {
                plane[out + i] = range((result[i] + 131072) >> 18);
            }
        }
    }
}
fn block(
    reader: &mut Reader,
    dc: &Huffman,
    ac: &Huffman,
    previous: &mut i32,
    quant: &[i16; 64],
    plane: &mut [u8],
    offset: usize,
    pitch: usize,
) -> Result<(), DecodeError> {
    let mut coef = [0i16; 64];
    let size = dc.decode(reader)? as usize;
    *previous = previous.wrapping_add(signed(reader, size)?);
    coef[0] = *previous as i16;
    let mut index = 1usize;
    while index < 64 {
        let symbol = ac.decode(reader)?;
        let size = (symbol & 15) as usize;
        let run = (symbol >> 4) as usize;
        let value = signed(reader, size)?;
        if value != 0 {
            index += run;
            if let Some(&natural) = NATURAL_ORDER.get(index) {
                coef[natural as usize] = value as i16;
            }
        } else {
            if run != 15 {
                break;
            }
            index += 15;
        }
        index += 1;
    }
    if index == 1 {
        let value = ((coef[0] as i64 * quant[0] as i64) / 8 + 128).clamp(0, 255) as u8;
        for row in 0..8 {
            plane[offset + row * pitch..offset + row * pitch + 8].fill(value);
        }
    } else {
        idct(quant, &coef, plane, offset, pitch);
    }
    Ok(())
}

pub(crate) struct Decoder {
    quant: [[i16; 64]; 3],
    input: Vec<u8>,
    planes: [Vec<u8>; 4],
    rgba: Vec<u8>,
}
impl Decoder {
    fn new(quant: &[u8]) -> Self {
        Self {
            quant: std::array::from_fn(|p| std::array::from_fn(|i| quant[p * 64 + i] as i16)),
            input: Vec::new(),
            planes: std::array::from_fn(|_| Vec::new()),
            rgba: Vec::new(),
        }
    }
    fn decode(
        &mut self,
        scan_len: usize,
        alpha_len: usize,
        width: usize,
        height: usize,
        separate: bool,
        simd: bool,
    ) -> Result<(), DecodeError> {
        let pitch = (width + 15) & !15;
        let luma = pitch.checked_mul(height).ok_or(DecodeError::Invalid)?;
        let chroma = (pitch / 2) * (height / 2);
        let output = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4))
            .ok_or(DecodeError::Invalid)?;
        for (i, p) in self.planes.iter_mut().enumerate() {
            let len = if i == 1 || i == 2 { chroma } else { luma };
            p.resize(len, 0);
            if i != 3 || !separate {
                p.fill(0);
            }
        }
        self.rgba.resize(output, 0);
        let bytes = self.input.get(..scan_len).ok_or(DecodeError::Invalid)?;
        let mut reader = Reader { bytes, bit: 0 };
        let mut previous = [0i32; 2];
        let tab = tables();
        for row in 0..height / 16 {
            for col in 0..width / 16 {
                // AMV interleaves Cb, Cr, Y(2x2), A(2x2), sharing the
                // chroma predictor and the luma/alpha predictor, unlike JPEG.
                for &component in &[1, 2, 0, 3][..if separate { 3 } else { 4 }] {
                    let (plane, q, dc, ac, step, base) = match component {
                        0 => (
                            0,
                            0,
                            &tab.dc_y,
                            &tab.ac_y,
                            pitch,
                            row * 16 * pitch + col * 16,
                        ),
                        1 => (
                            1,
                            1,
                            &tab.dc_c,
                            &tab.ac_c,
                            pitch / 2,
                            row * 8 * (pitch / 2) + col * 8,
                        ),
                        2 => (
                            2,
                            1,
                            &tab.dc_c,
                            &tab.ac_c,
                            pitch / 2,
                            row * 8 * (pitch / 2) + col * 8,
                        ),
                        _ => (
                            3,
                            2,
                            &tab.dc_y,
                            &tab.ac_y,
                            pitch,
                            row * 16 * pitch + col * 16,
                        ),
                    };
                    let offsets = [0, 8, step * 8, step * 8 + 8];
                    let count = if component == 0 || component == 3 {
                        4
                    } else {
                        1
                    };
                    for &off in &offsets[..count] {
                        block(
                            &mut reader,
                            dc,
                            ac,
                            &mut previous[if component == 1 || component == 2 {
                                1
                            } else {
                                0
                            }],
                            &self.quant[q],
                            &mut self.planes[plane],
                            base + off,
                            step,
                        )?;
                    }
                }
            }
        }
        if separate && alpha_len != 0 {
            let alpha = self
                .input
                .get(scan_len..scan_len + alpha_len)
                .ok_or(DecodeError::Invalid)?;
            self.planes[3].fill(0);
            for (row, src) in alpha.chunks(width).take(height).enumerate() {
                self.planes[3][row * pitch..row * pitch + src.len()].copy_from_slice(src);
            }
        }
        composite(&self.planes, width, height, pitch, &mut self.rgba, simd);
        Ok(())
    }
}
fn composite(
    planes: &[Vec<u8>; 4],
    width: usize,
    height: usize,
    pitch: usize,
    out: &mut [u8],
    simd: bool,
) {
    for row in 0..height {
        let y = &planes[0][row * pitch..];
        let a = &planes[3][row * pitch..];
        let u = &planes[1][(row / 2) * (pitch / 2)..];
        let v = &planes[2][(row / 2) * (pitch / 2)..];
        let dst = &mut out[row * width * 4..(row + 1) * width * 4];
        let mut x = 0;
        #[cfg(target_arch = "wasm32")]
        if simd {
            unsafe {
                x = composite_simd(y, u, v, a, dst, width);
            }
        }
        let _ = simd;
        while x < width {
            let yy = y[x] as i32;
            let cb = u[x / 2] as i32 - 128;
            let cr = v[x / 2] as i32 - 128;
            dst[x * 4] = (yy + ((91881 * cr) >> 16)).clamp(0, 255) as u8;
            dst[x * 4 + 1] = (yy - ((22554 * cb + 46802 * cr) >> 16)).clamp(0, 255) as u8;
            dst[x * 4 + 2] = (yy + ((116130 * cb) >> 16)).clamp(0, 255) as u8;
            dst[x * 4 + 3] = a[x];
            x += 1;
        }
    }
}
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn composite_simd(
    y: &[u8],
    u: &[u8],
    v: &[u8],
    a: &[u8],
    out: &mut [u8],
    width: usize,
) -> usize {
    use std::arch::wasm32::*;
    let mut x = 0;
    while x + 4 <= width {
        let yy = i32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(
            y.as_ptr().add(x) as *const u32,
        )));
        let aa = i32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(
            a.as_ptr().add(x) as *const u32,
        )));
        let cb = i32x4(
            u[x / 2] as i32 - 128,
            u[x / 2] as i32 - 128,
            u[x / 2 + 1] as i32 - 128,
            u[x / 2 + 1] as i32 - 128,
        );
        let cr = i32x4(
            v[x / 2] as i32 - 128,
            v[x / 2] as i32 - 128,
            v[x / 2 + 1] as i32 - 128,
            v[x / 2 + 1] as i32 - 128,
        );
        let clamp = |n| i32x4_min(i32x4_max(n, i32x4_splat(0)), i32x4_splat(255));
        let r = clamp(i32x4_add(
            yy,
            i32x4_shr(i32x4_mul(cr, i32x4_splat(91881)), 16),
        ));
        let green = i32x4_add(
            i32x4_mul(cb, i32x4_splat(22554)),
            i32x4_mul(cr, i32x4_splat(46802)),
        );
        let g = clamp(i32x4_sub(yy, i32x4_shr(green, 16)));
        let b = clamp(i32x4_add(
            yy,
            i32x4_shr(i32x4_mul(cb, i32x4_splat(116130)), 16),
        ));
        let planar = u8x16_narrow_i16x8(i16x8_narrow_i32x4(r, g), i16x8_narrow_i32x4(b, aa));
        let rgba =
            i8x16_shuffle::<0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15>(planar, planar);
        v128_store(out.as_mut_ptr().add(x * 4) as *mut v128, rgba);
        x += 4;
    }
    x
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_amv_create(quant: *const u8) -> *mut Decoder {
    Box::into_raw(Box::new(Decoder::new(core::slice::from_raw_parts(
        quant, 192,
    ))))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_amv_free(decoder: *mut Decoder) {
    drop(Box::from_raw(decoder));
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_amv_input(decoder: *mut Decoder, len: usize) -> *mut u8 {
    let ctx = &mut *decoder;
    ctx.input.resize(len, 0);
    ctx.input.as_mut_ptr()
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_amv_decode(
    decoder: *mut Decoder,
    scan_len: usize,
    alpha_len: usize,
    width: usize,
    height: usize,
    separate: u32,
    simd: u32,
) -> *const u8 {
    let ctx = &mut *decoder;
    match ctx.decode(scan_len, alpha_len, width, height, separate != 0, simd != 0) {
        Ok(()) => ctx.rgba.as_ptr(),
        Err(_) => core::ptr::null(),
    }
}
const DCLUMABITS: [u8; 17] = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DCVALUES: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const ACLUMABITS: [u8; 17] = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const ACLUMAVALUES: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];
const DCCHROMABITS: [u8; 17] = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const ACCHROMABITS: [u8; 17] = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const ACCHROMAVALUES: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];
const NATURAL_ORDER: [u8; 80] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63,
    63, 63, 63, 63, 63, 63,
];
