#![allow(clippy::needless_range_loop)]
mod amv;
mod ffi;
mod pixels;
mod png;
mod tlg;
#[derive(Debug)]
pub enum DecodeError {
    Invalid,
    Unsupported,
    Output,
}

pub(crate) fn le32(data: &[u8], at: usize) -> Result<u32, DecodeError> {
    let b = data.get(at..at + 4).ok_or(DecodeError::Invalid)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}
pub(crate) fn checked_len(w: u32, h: u32, channels: usize) -> Result<usize, DecodeError> {
    (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(channels))
        .ok_or(DecodeError::Invalid)
}
