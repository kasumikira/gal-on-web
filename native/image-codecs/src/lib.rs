#![allow(clippy::needless_range_loop)]

use std::io::Cursor;

const GOLOMB_COMPRESSED: [[usize; 9]; 4] = [
    [3, 7, 15, 27, 63, 108, 223, 448, 130],
    [3, 5, 13, 24, 51, 95, 192, 384, 257],
    [2, 5, 12, 21, 39, 86, 155, 320, 384],
    [2, 3, 9, 18, 33, 61, 129, 258, 511],
];

#[derive(Debug)]
pub enum DecodeError {
    Invalid,
    Unsupported,
    Output,
}

fn le32(data: &[u8], at: usize) -> Result<u32, DecodeError> {
    let b = data.get(at..at + 4).ok_or(DecodeError::Invalid)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}
fn checked_len(w: u32, h: u32, channels: usize) -> Result<usize, DecodeError> {
    (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(channels))
        .ok_or(DecodeError::Invalid)
}
pub fn dimensions(data: &[u8]) -> Result<(u32, u32), DecodeError> {
    if data.len() < 11 {
        return Err(DecodeError::Invalid);
    }
    if data.starts_with(b"TLG5.0") {
        Ok((le32(data, 12)?, le32(data, 16)?))
    } else if data.starts_with(b"TLG6.0") {
        Ok((le32(data, 15)?, le32(data, 19)?))
    } else {
        Err(DecodeError::Invalid)
    }
}

fn lzss(
    data: &[u8],
    output: &mut [u8],
    text: &mut [u8; 4096],
    mut r: usize,
) -> Result<usize, DecodeError> {
    let (mut ip, mut op, mut flags) = (0usize, 0usize, 0usize);
    while ip < data.len() {
        flags >>= 1;
        if flags & 0x100 == 0 {
            flags = data[ip] as usize | 0xff00;
            ip += 1;
            if flags == 0xff00 && r < 4088 && ip < data.len().saturating_sub(8) {
                for _ in 0..8 {
                    if op >= output.len() {
                        return Ok(r);
                    }
                    let b = data[ip];
                    ip += 1;
                    output[op] = b;
                    text[r] = b;
                    op += 1;
                    r += 1;
                }
                flags = 0;
                continue;
            }
        }
        if flags & 1 != 0 {
            if ip + 2 > data.len() {
                return Err(DecodeError::Invalid);
            }
            let pair = u16::from_le_bytes([data[ip], data[ip + 1]]) as usize;
            ip += 2;
            let mut from = pair & 0xfff;
            let mut count = (pair >> 12) + 3;
            if count == 18 {
                count += *data.get(ip).ok_or(DecodeError::Invalid)? as usize;
                ip += 1;
            }
            while count > 0 {
                if op >= output.len() {
                    return Ok(r);
                }
                let b = text[from];
                output[op] = b;
                text[r] = b;
                op += 1;
                from = (from + 1) & 0xfff;
                r = (r + 1) & 0xfff;
                count -= 1;
            }
        } else {
            let b = *data.get(ip).ok_or(DecodeError::Invalid)?;
            ip += 1;
            if op >= output.len() {
                return Ok(r);
            }
            output[op] = b;
            text[r] = b;
            op += 1;
            r = (r + 1) & 0xfff;
        }
    }
    Ok(r)
}

#[target_feature(enable = "simd128")]
unsafe fn tlg5_compose_simd(
    upper: &[u8],
    residual: &[&[u8]],
    width: usize,
    colors: usize,
    out: &mut [u8],
) {
    use core::arch::wasm32::*;
    let zero = u8x16_splat(0);
    let mut carry = zero;
    let mut x = 0;
    while x + 4 <= width {
        let mut delta = [0u8; 16];
        for lane in 0..4 {
            let i = x + lane;
            let o = lane * 4;
            delta[o] = residual[2][i].wrapping_add(residual[1][i]);
            delta[o + 1] = residual[1][i];
            delta[o + 2] = residual[0][i].wrapping_add(residual[1][i]);
            if colors == 4 {
                delta[o + 3] = residual[3][i];
            }
        }
        let v = v128_load(delta.as_ptr() as *const v128);
        let s1 = i8x16_add(
            v,
            i8x16_shuffle::<16, 17, 18, 19, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11>(v, zero),
        );
        let s2 = i8x16_add(
            s1,
            i8x16_shuffle::<16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7>(s1, zero),
        );
        let accumulated = i8x16_add(s2, carry);
        carry = i8x16_shuffle::<12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15>(
            accumulated,
            accumulated,
        );
        let up = v128_load(upper.as_ptr().add(x * 4) as *const v128);
        let mut pixels = [0u8; 16];
        v128_store(pixels.as_mut_ptr() as *mut v128, i8x16_add(accumulated, up));
        if colors == 3 {
            for lane in 0..4 {
                pixels[lane * 4 + 3] = 255;
            }
        }
        v128_store(
            out.as_mut_ptr().add(x * 4) as *mut v128,
            v128_load(pixels.as_ptr() as *const v128),
        );
        x += 4;
    }
    let mut b = i8x16_extract_lane::<0>(carry) as u8;
    let mut g = i8x16_extract_lane::<1>(carry) as u8;
    let mut r = i8x16_extract_lane::<2>(carry) as u8;
    let mut a = i8x16_extract_lane::<3>(carry) as u8;
    for i in x..width {
        let p = i * 4;
        b = b.wrapping_add(residual[2][i].wrapping_add(residual[1][i]));
        g = g.wrapping_add(residual[1][i]);
        r = r.wrapping_add(residual[0][i].wrapping_add(residual[1][i]));
        out[p] = b.wrapping_add(upper[p]);
        out[p + 1] = g.wrapping_add(upper[p + 1]);
        out[p + 2] = r.wrapping_add(upper[p + 2]);
        if colors == 3 {
            out[p + 3] = 255;
        } else {
            a = a.wrapping_add(residual[3][i]);
            out[p + 3] = a.wrapping_add(upper[p + 3]);
        }
    }
}

fn decode_tlg5(data: &[u8], pixels: &mut [u8]) -> Result<(u32, u32), DecodeError> {
    let mut p = 11;
    let colors = *data.get(p).ok_or(DecodeError::Invalid)? as usize;
    p += 1;
    if colors != 3 && colors != 4 {
        return Err(DecodeError::Unsupported);
    }
    let width = le32(data, p)?;
    p += 4;
    let height = le32(data, p)?;
    p += 4;
    let block_h = le32(data, p)? as usize;
    p += 4;
    if block_h == 0 {
        return Err(DecodeError::Invalid);
    }
    let block_count = (height as usize)
        .checked_add(block_h - 1)
        .ok_or(DecodeError::Invalid)?
        / block_h;
    p = p
        .checked_add(block_count.checked_mul(4).ok_or(DecodeError::Invalid)?)
        .ok_or(DecodeError::Invalid)?;
    if p > data.len() {
        return Err(DecodeError::Invalid);
    }
    let w = width as usize;
    let h = height as usize;
    if pixels.len() != checked_len(width, height, 4)? {
        return Err(DecodeError::Output);
    }
    let block_bytes = block_h
        .checked_mul(w)
        .and_then(|x| x.checked_add(16))
        .ok_or(DecodeError::Invalid)?;
    let mut bufs: [Vec<u8>; 4] = core::array::from_fn(|_| vec![0; block_bytes]);
    let mut text = [0u8; 4096];
    let zero_line = vec![0u8; w * 4];
    let mut r = 0usize;
    for yblk in (0..h).step_by(block_h) {
        for c in 0..colors {
            let mark = *data.get(p).ok_or(DecodeError::Invalid)?;
            p += 1;
            let size = le32(data, p)? as usize;
            p += 4;
            let end = p.checked_add(size).ok_or(DecodeError::Invalid)?;
            let source = data.get(p..end).ok_or(DecodeError::Invalid)?;
            if mark == 0 {
                r = lzss(source, &mut bufs[c], &mut text, r)?;
            } else {
                if size > bufs[c].len() {
                    return Err(DecodeError::Invalid);
                }
                bufs[c][..size].copy_from_slice(source);
            }
            p = end;
        }
        let ylim = (yblk + block_h).min(h);
        for y in yblk..ylim {
            let row_start = y * w * 4;
            let (previous, current) = pixels.split_at_mut(row_start);
            let (row, _) = current.split_at_mut(w * 4);
            let upper = if y == 0 {
                &zero_line[..]
            } else {
                &previous[previous.len() - w * 4..]
            };
            let line = y - yblk;
            let residual: [&[u8]; 4] = core::array::from_fn(|c| &bufs[c][line * w..line * w + w]);
            unsafe { tlg5_compose_simd(upper, &residual, w, colors, row) };
        }
    }
    Ok((width, height))
}

fn fetch32(data: &[u8], at: usize) -> u32 {
    let mut b = [0u8; 4];
    for i in 0..4 {
        b[i] = data.get(at + i).copied().unwrap_or(0);
    }
    u32::from_le_bytes(b)
}
fn leading_zeros12(v: u32) -> u32 {
    let v = v & 0xfff;
    if v == 0 {
        0
    } else {
        v.trailing_zeros() + 1
    }
}
fn read_gamma(data: &[u8], pos: &mut usize, bit: &mut u32) -> u32 {
    let mut t = fetch32(data, *pos) >> *bit;
    let mut b = leading_zeros12(t);
    let mut count = b;
    while b == 0 {
        count += 12;
        *bit += 12;
        *pos += (*bit / 8) as usize;
        *bit &= 7;
        t = fetch32(data, *pos) >> *bit;
        b = leading_zeros12(t);
        count += b;
    }
    *bit += b;
    *pos += (*bit / 8) as usize;
    *bit &= 7;
    count -= 1;
    let n = 1u32.checked_shl(count).unwrap_or(0);
    let value = n + ((fetch32(data, *pos) >> *bit) & n.wrapping_sub(1));
    *bit += count;
    *pos += (*bit / 8) as usize;
    *bit &= 7;
    value
}
fn read_value(data: &[u8], pos: &mut usize, bit: &mut u32, k: u32) -> (u8, u32) {
    let mut t = fetch32(data, *pos) >> *bit;
    let mut b: u32;
    let mut count;
    if t != 0 {
        b = leading_zeros12(t);
        count = b;
        while b == 0 {
            count += 12;
            *bit += 12;
            *pos += (*bit / 8) as usize;
            *bit &= 7;
            t = fetch32(data, *pos) >> *bit;
            b = leading_zeros12(t);
            count += b;
        }
        count -= 1;
    } else {
        *pos += 5;
        count = data.get(pos.saturating_sub(1)).copied().unwrap_or(0) as u32;
        *bit = 0;
        t = fetch32(data, *pos);
        b = 0;
    }
    let mut v = (count << k) + ((t >> b) & ((1u32 << k) - 1));
    let sign = (v & 1).wrapping_sub(1);
    v >>= 1;
    let decoded = ((v ^ sign).wrapping_add(sign).wrapping_add(1) & 0xff) as u8;
    *bit += b + k;
    *pos += (*bit / 8) as usize;
    *bit &= 7;
    (decoded, v)
}
const fn golomb_table() -> [[u8; 1024]; 4] {
    let mut table = [[0u8; 1024]; 4];
    let mut n = 0;
    while n < 4 {
        let mut a = 0;
        let mut i = 0;
        while i < 9 {
            let mut j = 0;
            while j < GOLOMB_COMPRESSED[n][i] {
                if a < 1024 {
                    table[n][a] = i as u8;
                }
                a += 1;
                j += 1;
            }
            i += 1;
        }
        n += 1;
    }
    table
}
const GOLOMB_TABLE: [[u8; 1024]; 4] = golomb_table();
fn decode_golomb(
    buf: &mut [u8],
    pixel_count: usize,
    data: &[u8],
    start: usize,
    for_first: bool,
) -> Result<(), DecodeError> {
    let table = &GOLOMB_TABLE;
    let mut pos = start;
    let mut bit = 1u32;
    let mut zero = data.get(start).copied().unwrap_or(0) & 1 == 0;
    let (mut n, mut a) = (3usize, 0u32);
    let mut idx = 0usize;
    let total = pixel_count.saturating_mul(4);
    while idx < total {
        let count = read_gamma(data, &mut pos, &mut bit) as usize;
        if zero {
            for _ in 0..count {
                if for_first {
                    for c in 0..4 {
                        if let Some(v) = buf.get_mut(idx + c) {
                            *v = 0;
                        }
                    }
                } else if let Some(v) = buf.get_mut(idx) {
                    *v = 0;
                }
                idx = idx.saturating_add(4);
            }
            zero = false;
        } else {
            for _ in 0..count {
                let k = table[n][a.min(1023) as usize] as u32;
                let (value, v) = read_value(data, &mut pos, &mut bit, k);
                a = a.wrapping_add(v);
                if let Some(slot) = buf.get_mut(idx) {
                    *slot = value;
                }
                if for_first {
                    for c in 1..4 {
                        if let Some(slot) = buf.get_mut(idx + c) {
                            *slot = 0;
                        }
                    }
                }
                idx = idx.saturating_add(4);
                if n == 0 {
                    a >>= 1;
                    n = 3;
                } else {
                    n -= 1;
                }
            }
            zero = true;
        }
    }
    Ok(())
}

#[target_feature(enable = "simd128")]
unsafe fn predict_simd(p: [u8; 4], u: [u8; 4], up: [u8; 4], v: [u8; 4], avg: bool) -> [u8; 4] {
    use core::arch::wasm32::*;
    let mut aa = [0u8; 16];
    let mut bb = [0u8; 16];
    let mut cc = [0u8; 16];
    let mut dd = [0u8; 16];
    aa[..4].copy_from_slice(&p);
    bb[..4].copy_from_slice(&u);
    cc[..4].copy_from_slice(&up);
    dd[..4].copy_from_slice(&v);
    let a = v128_load(aa.as_ptr() as *const v128);
    let b = v128_load(bb.as_ptr() as *const v128);
    let c = v128_load(cc.as_ptr() as *const v128);
    let d = v128_load(dd.as_ptr() as *const v128);
    let pred = if avg {
        // TLG6_AVG_PACKED rounds up: (a + b + 1) >> 1 per byte.
        u8x16_avgr(a, b)
    } else {
        let min = u8x16_min(a, b);
        let max = u8x16_max(a, b);
        let delta = i8x16_sub(i8x16_add(a, b), c);
        let clipped_low = v128_bitselect(max, delta, u8x16_lt(c, min));
        v128_bitselect(min, clipped_low, u8x16_gt(c, max))
    };
    let mut out = [0u8; 16];
    // packed_bytes_add: byte-wise addition that discards carries between
    // channels, so a channel wraps instead of spilling into its neighbour.
    v128_store(out.as_mut_ptr() as *mut v128, i8x16_add(pred, d));
    [out[0], out[1], out[2], out[3]]
}
fn residual(method: usize, b: u8, g: u8, r: u8, a: u8) -> [u8; 4] {
    let (b, g, r) = (b as u32, g as u32, r as u32);
    let (bb, gg, rr) = match method {
        0 => (b, g, r),
        1 => (b + g, g, r + g),
        2 => (b, g + b, r + b + g),
        3 => (b + r + g, g + r, r),
        4 => (b + r, g + b + r, r + b + r + g),
        5 => (b + r, g + b + r, r),
        6 => (b + g, g, r),
        7 => (b, g + b, r),
        8 => (b, g, r + g),
        9 => (b + g + r + b, g + r + b, r + b),
        10 => (b + r, g + r, r),
        11 => (b, g + b, r + b),
        12 => (b, g + r + b, r + b),
        13 => (b + g, g + r + b + g, r + b + g),
        14 => (b + g + r, g + r, r + b + g + r),
        15 => (b, g + (b << 1), r + (b << 1)),
        _ => (b, g, r),
    };
    [a, rr as u8, gg as u8, bb as u8]
}
fn decode_line(
    row: &mut [u8],
    upper: &[u8],
    width: usize,
    filters: &[u8],
    ft_base: usize,
    skip: usize,
    pixelbuf: &[u8],
    initial: u8,
    oddskip: usize,
    dir: usize,
    local_row: usize,
) {
    let (mut p, mut up) = ([initial, 0, 0, 0], [initial, 0, 0, 0]);
    let blocks = (width + 7) / 8;
    for block in 0..blocks {
        let w = (width - block * 8).min(8);
        let ft = filters.get(ft_base + block).copied().unwrap_or(0);
        let method = (ft >> 1) as usize;
        let post = ft & 1 != 0;
        let step = if dir & 1 != 0 { 1isize } else { -1isize };
        let mut off = (skip * block
            + w * local_row
            + (if step < 0 { w - 1 } else { 0 })
            + (if block & 1 != 0 { oddskip * w } else { 0 }))
            * 4;
        for k in 0..w {
            let idx = block * 8 + k;
            let px = idx * 4;
            let b = pixelbuf.get(off).copied().unwrap_or(0);
            let g = pixelbuf.get(off + 1).copied().unwrap_or(0);
            let r = pixelbuf.get(off + 2).copied().unwrap_or(0);
            let a = pixelbuf.get(off + 3).copied().unwrap_or(0);
            let v = residual(method, b, g, r, a);
            let u = [upper[px + 3], upper[px], upper[px + 1], upper[px + 2]];
            let next = simd_predict(p, u, up, v, post);
            p = next;
            up = u;
            row[px] = p[1];
            row[px + 1] = p[2];
            row[px + 2] = p[3];
            row[px + 3] = p[0];
            off = (off as isize + step * 4) as usize;
        }
    }
}
#[inline]
fn simd_predict(p: [u8; 4], u: [u8; 4], up: [u8; 4], v: [u8; 4], avg: bool) -> [u8; 4] {
    unsafe {
        predict_simd(p, u, up, v, avg)
    }
}
fn decode_tlg6(data: &[u8], pixels: &mut [u8]) -> Result<(u32, u32), DecodeError> {
    let mut p = 11usize;
    let colors = *data.get(p).ok_or(DecodeError::Invalid)? as usize;
    if colors != 1 && colors != 3 && colors != 4 {
        return Err(DecodeError::Unsupported);
    }
    if data.get(p + 1..p + 4) != Some(&[0, 0, 0]) {
        return Err(DecodeError::Unsupported);
    }
    p += 4;
    let width = le32(data, p)?;
    p += 4;
    let height = le32(data, p)?;
    p += 4;
    let _max = le32(data, p)?;
    p += 4;
    let w = width as usize;
    let h = height as usize;
    let pixels_len = checked_len(width, height, 4)?;
    if pixels.len() != pixels_len {
        return Err(DecodeError::Output);
    }
    let xb = (w + 7) / 8;
    let yb = (h + 7) / 8;
    let mut filters = vec![
        0u8;
        xb.checked_mul(yb)
            .and_then(|x| x.checked_add(16))
            .ok_or(DecodeError::Invalid)?
    ];
    let fsize = le32(data, p)? as usize;
    p += 4;
    let fend = p.checked_add(fsize).ok_or(DecodeError::Invalid)?;
    let fdata = data.get(p..fend).ok_or(DecodeError::Invalid)?;
    let mut text = [0u8; 4096];
    let mut off = 0;
    for i in 0..32 {
        for j in 0..16 {
            text[off..off + 4].fill(i);
            text[off + 4..off + 8].fill(j);
            off += 8;
        }
    }
    lzss(fdata, &mut filters, &mut text, 0)?;
    p = fend;
    let mut pixelbuf = vec![
        0u8;
        w.checked_mul(32)
            .and_then(|x| x.checked_add(4))
            .ok_or(DecodeError::Invalid)?
    ];
    let mut zero_line = vec![0u8; w * 4];
    if colors == 3 {
        for x in 0..w {
            zero_line[x * 4 + 3] = 255;
        }
    }
    for y in (0..h).step_by(8) {
        let ylim = (y + 8).min(h);
        let count = (ylim - y) * w;
        for c in 0..colors {
            let raw = le32(data, p)?;
            p += 4;
            let method = raw >> 30;
            let bits = (raw & 0x3fff_ffff) as usize;
            if method != 0 {
                return Err(DecodeError::Unsupported);
            }
            let bytes = bits.checked_add(7).ok_or(DecodeError::Invalid)? / 8;
            let end = p.checked_add(bytes).ok_or(DecodeError::Invalid)?;
            if end > data.len() {
                return Err(DecodeError::Invalid);
            }
            decode_golomb(&mut pixelbuf[c..], count, data, p, c == 0 && colors != 1)?;
            p = end;
        }
        let ftbase = (y / 8) * xb;
        let skip = (ylim - y) * 8;
        for yy in y..ylim {
            let start = yy * w * 4;
            let (previous, current) = pixels.split_at_mut(start);
            let (row, _) = current.split_at_mut(w * 4);
            let upper = if yy == 0 {
                &zero_line[..]
            } else {
                &previous[previous.len() - w * 4..]
            };
            let dir = (yy & 1) ^ 1;
            let odd = (ylim - yy - 1) - (yy - y);
            decode_line(
                row,
                upper,
                w,
                &filters,
                ftbase,
                skip,
                &pixelbuf,
                if colors == 3 { 255 } else { 0 },
                odd,
                dir,
                yy - y,
            );
        }
    }
    Ok((width, height))
}
pub fn decode_tlg_into(data: &[u8], pixels: &mut [u8]) -> Result<(u32, u32), DecodeError> {
    if data.starts_with(b"TLG5.0") {
        decode_tlg5(data, pixels)
    } else if data.starts_with(b"TLG6.0") {
        decode_tlg6(data, pixels)
    } else {
        Err(DecodeError::Invalid)
    }
}
pub fn decode_tlg(data: &[u8]) -> Result<(u32, u32, Vec<u8>), DecodeError> {
    let (width, height) = dimensions(data)?;
    let mut pixels = vec![0u8; checked_len(width, height, 4)?];
    decode_tlg_into(data, &mut pixels)?;
    Ok((width, height, pixels))
}

fn decode_png_indexed(data: &[u8], output: &mut [u8], province: bool, key: u32) -> Result<(), i32> {
    let mut decoder = png::Decoder::new(Cursor::new(data));
    decoder.set_transformations(png::Transformations::IDENTITY);
    decoder.set_ignore_iccp_chunk(true);
    decoder.set_ignore_text_chunk(true);
    let mut reader = decoder.read_info().map_err(|_| 1)?;
    let (width, height, color_type, bit_depth, is_animated, palette, transparency) = {
        let info = reader.info();
        (
            info.width,
            info.height,
            info.color_type,
            info.bit_depth,
            info.animation_control.is_some(),
            info.palette.as_deref().map(<[u8]>::to_vec),
            info.trns.as_deref().map(<[u8]>::to_vec),
        )
    };
    if is_animated {
        return Err(2);
    }
    if !matches!(
        color_type,
        png::ColorType::Indexed | png::ColorType::Grayscale
    ) || bit_depth as usize > 8
    {
        return Err(2);
    }
    let channels = if province { 1 } else { 4 };
    let output_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|length| length.checked_mul(channels))
        .ok_or(1)?;
    if output.len() != output_len {
        return Err(3);
    }

    let mut raw = vec![0; reader.output_buffer_size().ok_or(1)?];
    let frame = reader.next_frame(&mut raw).map_err(|_| 1)?;
    let width = frame.width as usize;
    let height = frame.height as usize;
    let bits = bit_depth as usize;
    let mask = (1usize << bits) - 1;
    if color_type == png::ColorType::Indexed && palette.is_none() {
        return Err(1);
    }
    for y in 0..height {
        let row = y.checked_mul(frame.line_size).ok_or(1)?;
        for x in 0..width {
            let bit = x.checked_mul(bits).ok_or(1)?;
            let byte = *raw.get(row + bit / 8).ok_or(1)? as usize;
            let sample = (byte >> (8 - bits - bit % 8)) & mask;
            if province {
                output[y * width + x] = if color_type == png::ColorType::Indexed {
                    sample as u8
                } else {
                    (sample * 255 / mask) as u8
                };
                continue;
            }

            let destination = (y * width + x) * 4;
            if color_type == png::ColorType::Indexed {
                let base = sample * 3;
                let palette = palette.as_deref().ok_or(1)?;
                let rgb = palette.get(base..base + 3).ok_or(1)?;
                let alpha = if key >> 24 == 3 && sample == (key as usize & 0xff) {
                    0
                } else {
                    transparency
                        .as_deref()
                        .and_then(|values| values.get(sample))
                        .copied()
                        .unwrap_or(255)
                };
                output[destination..destination + 4]
                    .copy_from_slice(&[rgb[0], rgb[1], rgb[2], alpha]);
            } else {
                let gray = (sample * 255 / mask) as u8;
                // png normalizes low-bit grayscale tRNS samples to one byte.
                let transparent_sample = transparency
                    .as_deref()
                    .and_then(|values| values.first())
                    .copied()
                    .map(usize::from);
                let alpha = if transparent_sample == Some(sample) {
                    0
                } else {
                    255
                };
                output[destination..destination + 4].copy_from_slice(&[gray, gray, gray, alpha]);
            }
        }
    }
    Ok(())
}

pub fn decode_rl8(src: &[u8], out: &mut [u8], simd: bool) -> usize {
    let (mut ip, mut op) = (0usize, 0usize);
    while ip < src.len() && op < out.len() {
        let marker = src[ip];
        ip += 1;
        if marker & 0x80 != 0 {
            let count = ((marker & 0x7f) as usize) + 3;
            let value = src.get(ip).copied().unwrap_or(0);
            ip += 1;
            let end = (op + count).min(out.len());
            if simd {
                fill_byte_simd(&mut out[op..end], value);
            } else {
                out[op..end].fill(value);
            }
            op = end;
        } else {
            let count = marker as usize + 1;
            for _ in 0..count {
                if op >= out.len() {
                    break;
                }
                out[op] = src.get(ip).copied().unwrap_or(0);
                op += 1;
                ip += 1;
            }
        }
    }
    op
}
pub fn decode_rl32(src: &[u8], out: &mut [u8], simd: bool) -> usize {
    let (mut ip, mut op) = (0usize, 0usize);
    let limit = out.len() / 4;
    while ip < src.len() && op < limit {
        let marker = src[ip];
        ip += 1;
        if marker & 0x80 != 0 {
            let count = (marker as usize & 0x7f) + 3;
            let color = rgba_word(src, ip);
            ip += 4;
            let end = (op + count).min(limit);
            if simd {
                fill_pixel_simd(&mut out[op * 4..end * 4], color);
            } else {
                for i in op..end {
                    out[i * 4..i * 4 + 4].copy_from_slice(&color);
                }
            }
            op = end;
        } else {
            let count = marker as usize + 1;
            for _ in 0..count {
                if op >= limit {
                    break;
                }
                let color = rgba_word(src, ip);
                ip += 4;
                out[op * 4..op * 4 + 4].copy_from_slice(&color);
                op += 1;
            }
        }
    }
    op
}
fn rgba_word(src: &[u8], i: usize) -> [u8; 4] {
    [
        src.get(i + 2).copied().unwrap_or(0),
        src.get(i + 1).copied().unwrap_or(0),
        src.get(i).copied().unwrap_or(0),
        src.get(i + 3).copied().unwrap_or(0),
    ]
}
fn fill_byte_simd(dst: &mut [u8], value: u8) {
    unsafe {
        use core::arch::wasm32::*;
        let v = i8x16_splat(value as i8);
        let mut i = 0;
        while i + 16 <= dst.len() {
            v128_store(dst.as_mut_ptr().add(i) as *mut v128, v);
            i += 16;
        }
        dst[i..].fill(value);
    }
}
fn fill_pixel_simd(dst: &mut [u8], pixel: [u8; 4]) {
    unsafe {
        use core::arch::wasm32::*;
        let block = [
            pixel[0], pixel[1], pixel[2], pixel[3], pixel[0], pixel[1], pixel[2], pixel[3],
            pixel[0], pixel[1], pixel[2], pixel[3], pixel[0], pixel[1], pixel[2], pixel[3],
        ];
        let v = v128_load(block.as_ptr() as *const v128);
        let mut i = 0;
        while i + 16 <= dst.len() {
            v128_store(dst.as_mut_ptr().add(i) as *mut v128, v);
            i += 16;
        }
        let rem = dst.len() - i;
        for j in 0..rem {
            dst[i + j] = pixel[j & 3];
        }
    }
}
pub fn expand_palette(
    indexes: &[u8],
    pixel_count: usize,
    palette: &[u8],
    out: &mut [u8],
    simd: bool,
) -> usize {
    let n = pixel_count.min(out.len() / 4);
    let mut i = 0;
    if simd {
        unsafe {
            use core::arch::wasm32::*;
            while i + 4 <= n {
                let mut block = [0u8; 16];
                for lane in 0..4 {
                    if let Some(&index) = indexes.get(i + lane) {
                        let p = index as usize * 4;
                        block[lane * 4..lane * 4 + 4].copy_from_slice(&[
                            palette.get(p + 2).copied().unwrap_or(0),
                            palette.get(p + 1).copied().unwrap_or(0),
                            palette.get(p).copied().unwrap_or(0),
                            palette.get(p + 3).copied().unwrap_or(0),
                        ]);
                    }
                }
                v128_store(
                    out.as_mut_ptr().add(i * 4) as *mut v128,
                    v128_load(block.as_ptr() as *const v128),
                );
                i += 4;
            }
        }
    }
    for j in i..n {
        let Some(&index) = indexes.get(j) else {
            out[j * 4..j * 4 + 4].fill(0);
            continue;
        };
        let p = index as usize * 4;
        let b = palette.get(p).copied().unwrap_or(0);
        let g = palette.get(p + 1).copied().unwrap_or(0);
        let r = palette.get(p + 2).copied().unwrap_or(0);
        let a = palette.get(p + 3).copied().unwrap_or(0);
        out[j * 4..j * 4 + 4].copy_from_slice(&[r, g, b, a]);
    }
    n
}
pub fn bgra_to_rgba(src: &[u8], out: &mut [u8], simd: bool) -> usize {
    let n = (src.len() / 4).min(out.len() / 4);
    if simd {
        unsafe {
            use core::arch::wasm32::*;
            let lanes = [2u8, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15];
            let mask = v128_load(lanes.as_ptr() as *const v128);
            let mut i = 0;
            while i + 4 <= n {
                let v = v128_load(src.as_ptr().add(i * 4) as *const v128);
                v128_store(
                    out.as_mut_ptr().add(i * 4) as *mut v128,
                    i8x16_swizzle(v, mask),
                );
                i += 4;
            }
            for j in i..n {
                let p = j * 4;
                out[p..p + 4].copy_from_slice(&[src[p + 2], src[p + 1], src[p], src[p + 3]]);
            }
            return n;
        }
    }
    for i in 0..n {
        let p = i * 4;
        out[p..p + 4].copy_from_slice(&[src[p + 2], src[p + 1], src[p], src[p + 3]]);
    }
    n
}
pub fn bgra_to_rgba_in_place(bytes: &mut [u8], simd: bool) -> usize {
    let n = bytes.len() / 4;
    if simd {
        unsafe {
            use core::arch::wasm32::*;
            let lanes = [2u8, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15];
            let mask = v128_load(lanes.as_ptr() as *const v128);
            let ptr = bytes.as_mut_ptr();
            let mut i = 0;
            while i + 16 <= n * 4 {
                let value = v128_load(ptr.add(i) as *const v128);
                v128_store(ptr.add(i) as *mut v128, i8x16_swizzle(value, mask));
                i += 16;
            }
            for pixel in bytes[i..n * 4].chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            return n;
        }
    }
    for pixel in bytes[..n * 4].chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    n
}

#[unsafe(no_mangle)]
pub extern "C" fn image_codecs_alloc(len: usize) -> *mut u8 {
    let boxed = vec![0u8; len.max(1)].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        let s = core::ptr::slice_from_raw_parts_mut(ptr, len.max(1));
        drop(Box::from_raw(s));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_dimensions(ptr: *const u8, len: usize) -> u64 {
    let data = core::slice::from_raw_parts(ptr, len);
    match dimensions(data) {
        Ok((w, h)) => (h as u64) << 32 | w as u64,
        Err(_) => 0,
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_decode_png_indexed(
    ptr: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
    province: u32,
    key: u32,
) -> i32 {
    let data = core::slice::from_raw_parts(ptr, len);
    let output = core::slice::from_raw_parts_mut(out, out_len);
    decode_png_indexed(data, output, province != 0, key)
        .err()
        .unwrap_or(0)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_decode_tlg(
    ptr: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    let data = core::slice::from_raw_parts(ptr, len);
    match decode_tlg_into(data, core::slice::from_raw_parts_mut(out, out_len)) {
        Ok(_) => 0,
        Err(DecodeError::Output) => 2,
        Err(DecodeError::Invalid) => 1,
        Err(DecodeError::Unsupported) => 3,
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_decode_rl8(
    src: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
    simd: u32,
) -> usize {
    decode_rl8(
        core::slice::from_raw_parts(src, len),
        core::slice::from_raw_parts_mut(out, out_len),
        simd != 0,
    )
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_decode_rl32(
    src: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
    simd: u32,
) -> usize {
    decode_rl32(
        core::slice::from_raw_parts(src, len),
        core::slice::from_raw_parts_mut(out, out_len),
        simd != 0,
    )
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn image_codecs_bgra_to_rgba_in_place(
    ptr: *mut u8,
    len: usize,
    simd: u32,
) -> usize {
    bgra_to_rgba_in_place(core::slice::from_raw_parts_mut(ptr, len), simd != 0)
}
