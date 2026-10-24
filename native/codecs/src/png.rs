use std::io::Cursor;
pub(crate) fn decode_png_indexed(
    data: &[u8],
    output: &mut [u8],
    province: bool,
    key: u32,
) -> Result<(), i32> {
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
