import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

/**
 * Render a vertical (720x1280) short video using FFmpeg.
 *
 * Pipeline:
 * 1. Create a slideshow from images (duration based on voice length / image count)
 * 2. Overlay voice audio
 * 3. Burn in subtitles (if SRT provided)
 * 4. Apply render_config settings
 * 5. Output H264 / AAC MP4
 */
export async function renderShort({ voicePath, imagePaths, srtPath, outputPath, config = {} }) {
  const {
    fps = 30,
    resolution = '720x1280',
    text_style = {},
    watermark = false,
    watermark_position = 'bottom-right',
    transitions = 'none',
  } = config;

  const [width, height] = resolution.split('x').map(Number);
  const w = width || 720;
  const h = height || 1280;

  // Get voice duration to calculate image timing
  const voiceDuration = await getAudioDuration(voicePath);
  const durationPerImage = voiceDuration / imagePaths.length;

  // Create concat list for images
  const concatFile = path.join(path.dirname(outputPath), 'images.txt');
  const concatContent = imagePaths
    .map((p, i) => {
      let line = `file '${p.replace(/'/g, "'\\''")}'`;
      line += `\nduration ${durationPerImage}`;
      return line;
    })
    .join('\n');
  // Repeat last file (FFmpeg concat demuxer requirement)
  const finalContent = concatContent + `\nfile '${imagePaths[imagePaths.length - 1].replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(concatFile, finalContent);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg()
      .input(concatFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .input(voicePath);

    // Build video filter chain
    let vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps}`;

    // Fade transition between images
    if (transitions === 'fade') {
      vf += `,fade=t=in:st=0:d=0.3`;
    }

    // Subtitle filter
    if (srtPath && fs.existsSync(srtPath)) {
      const fontSize = text_style.size || 42;
      const fontColor = text_style.color === 'white' ? '&H00FFFFFF' : '&H00FFFFFF';
      const strokeColor = text_style.stroke === 'black' ? '&H00000000' : '&H00000000';
      const fontName = (text_style.font || 'Arial').replace(/-/g, ' ');

      const esc = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      vf += `,subtitles='${esc}':force_style='FontSize=${fontSize},FontName=${fontName},PrimaryColour=${fontColor},OutlineColour=${strokeColor},Outline=2,Shadow=1,Alignment=2,MarginV=80'`;
    }

    cmd
      .outputOptions([
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', '1500k',
        '-r', String(fps),
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('start', (cmdline) => console.log('[ffmpeg] Command:', cmdline))
      .on('progress', (p) => {
        if (p.percent) console.log(`[ffmpeg] Progress: ${Math.round(p.percent)}%`);
      })
      .on('error', (err) => {
        console.error('[ffmpeg] Error:', err);
        reject(err);
      })
      .on('end', () => {
        console.log('[ffmpeg] Render complete');
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
        resolve(outputPath);
      })
      .run();
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 60);
    });
  });
}
