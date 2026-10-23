import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLimiter } from '../async';
const probe = promisify(execFile);
const probes = createLimiter(2);
const containers = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'mpeg', 'mpegts', 'asf', 'flv', 'ogg']);
/** Inspect the staged file without decoding frames or transcoding originals. */
export async function inspectVideo(filename: string, signal?: AbortSignal) {
  return probes(async () => {
    const { stdout } = await probe('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-probesize', '8388608', '-analyzeduration', '5000000', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic:stream_side_data=rotation', '-of', 'json', filename], { signal, timeout: 15_000, maxBuffer: 256 * 1024 });
    const info = JSON.parse(stdout);
    if (!String(info.format?.format_name || '').split(',').some(name => containers.has(name))) throw new Error('Unsupported video container');
    const stream = info.streams?.find((stream: any) => stream.codec_type === 'video' && stream.codec_name && !stream.disposition?.attached_pic && Number.isInteger(stream.width) && stream.width > 0 && stream.width <= 32768 && Number.isInteger(stream.height) && stream.height > 0 && stream.height <= 32768);
    if (!stream || !Number.isFinite(Number(info.format?.duration)) || Number(info.format.duration) <= 0) throw new Error('No valid video stream');
    const rotation = Number(stream.side_data_list?.find((entry: any) => Number.isFinite(entry.rotation))?.rotation || 0);
    return Math.abs(rotation) % 180 === 90 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
  });
}
