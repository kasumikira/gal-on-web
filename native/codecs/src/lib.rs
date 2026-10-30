#![allow(clippy::needless_range_loop)]
mod amv;
mod ffi;
#[derive(Debug)]
pub enum DecodeError {
    Invalid,
    Unsupported,
    Output,
}
