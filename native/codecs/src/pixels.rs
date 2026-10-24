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
