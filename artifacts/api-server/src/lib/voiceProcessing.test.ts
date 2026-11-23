import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_MAX_SOURCE_BYTES,
  VOICE_TARGET_BITRATE,
  VOICE_TARGET_SAMPLE_RATE,
  VoiceProcessingError,
  buildVoiceFfmpegArgs,
  buildVoiceFfprobeArgs,
  parseVoiceFfprobeOutput,
  transcodeVoiceToM4a,
  verifyVoiceM4aOutput,
  voiceSourceExtension,
} from './voiceProcessing';

test('source extensions cover what Safari and Chrome record', () => {
  assert.equal(voiceSourceExtension('audio/mp4'), 'm4a');
  assert.equal(voiceSourceExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(voiceSourceExtension('AUDIO/WEBM'), 'webm');
  assert.equal(voiceSourceExtension('audio/mpeg'), 'mp3');
  assert.equal(voiceSourceExtension('video/mp4'), null);
  assert.equal(voiceSourceExtension(''), null);
});

test('the ffmpeg command produces mono AAC at the target rate with faststart', () => {
  const args = buildVoiceFfmpegArgs('/tmp/in.webm', '/tmp/out.m4a');
  const joined = args.join(' ');

  assert.equal(joined.includes('-vn'), true);
  assert.equal(joined.includes('-ac 1'), true);
  assert.equal(joined.includes(`-ar ${VOICE_TARGET_SAMPLE_RATE}`), true);
  assert.equal(joined.includes('-c:a aac'), true);
  assert.equal(joined.includes(`-b:a ${VOICE_TARGET_BITRATE}`), true);
  assert.equal(joined.includes('-movflags +faststart'), true);
  // البيانات الوصفية لا تنتقل إلى الملف الناتج
  assert.equal(joined.includes('-map_metadata -1'), true);
  // المدخل والمخرج في موضعهما
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/in.webm');
  assert.equal(args[args.length - 1], '/tmp/out.m4a');
  assert.equal(VOICE_TARGET_BITRATE, '17k');
  assert.equal(VOICE_TARGET_SAMPLE_RATE, 24_000);
});

test('the probe command asks for the audio stream and the format duration', () => {
  const args = buildVoiceFfprobeArgs('/tmp/out.m4a');
  const joined = args.join(' ');
  assert.equal(joined.includes('-select_streams a:0'), true);
  assert.equal(joined.includes('codec_name'), true);
  assert.equal(joined.includes('duration'), true);
  assert.equal(joined.includes('-of json'), true);
  assert.equal(args[args.length - 1], '/tmp/out.m4a');
});

test('ffprobe JSON is parsed into real numbers', () => {
  const probe = parseVoiceFfprobeOutput(JSON.stringify({
    streams: [{ codec_name: 'aac', channels: 1, sample_rate: '24000', bit_rate: '17120' }],
    format: { duration: '4.214000', size: '9060', bit_rate: '17199' },
  }));

  assert.deepEqual(probe, {
    codec: 'aac',
    channels: 1,
    sampleRate: 24_000,
    bitRate: 17_120,
    durationSeconds: 4.214,
    sizeBytes: 9_060,
  });
});

test('a missing format size falls back to the measured file size', () => {
  const probe = parseVoiceFfprobeOutput(JSON.stringify({
    streams: [{ codec_name: 'aac', channels: 1, sample_rate: '24000' }],
    format: { duration: '1.5' },
  }), 1234);
  assert.equal(probe.sizeBytes, 1234);
});

test('broken ffprobe output is rejected instead of trusted', () => {
  assert.throws(() => parseVoiceFfprobeOutput('not json'), VoiceProcessingError);
  assert.throws(() => parseVoiceFfprobeOutput('null'), VoiceProcessingError);
  assert.throws(() => parseVoiceFfprobeOutput(JSON.stringify({ streams: [] })), VoiceProcessingError);
});

test('verification rejects anything that is not mono AAC with a duration', () => {
  const valid = { codec: 'aac', channels: 1, sampleRate: 24_000, bitRate: 17_000, durationSeconds: 3, sizeBytes: 6_000 };
  assert.doesNotThrow(() => verifyVoiceM4aOutput(valid));

  assert.throws(() => verifyVoiceM4aOutput({ ...valid, codec: 'opus' }), VoiceProcessingError);
  assert.throws(() => verifyVoiceM4aOutput({ ...valid, codec: '' }), VoiceProcessingError);
  assert.throws(() => verifyVoiceM4aOutput({ ...valid, channels: 2 }), VoiceProcessingError);
  assert.throws(() => verifyVoiceM4aOutput({ ...valid, durationSeconds: 0 }), VoiceProcessingError);
});

test('the server refuses oversized raw recordings before transcoding', async () => {
  await assert.rejects(
    () => transcodeVoiceToM4a({ bytes: Buffer.alloc(VOICE_MAX_SOURCE_BYTES + 1), sourceMimeType: 'audio/webm' }),
    (error: unknown) => error instanceof VoiceProcessingError && error.statusCode === 413,
  );
  await assert.rejects(
    () => transcodeVoiceToM4a({ bytes: Buffer.alloc(0), sourceMimeType: 'audio/webm' }),
    (error: unknown) => error instanceof VoiceProcessingError && error.statusCode === 400,
  );
  await assert.rejects(
    () => transcodeVoiceToM4a({ bytes: Buffer.alloc(10), sourceMimeType: 'video/mp4' }),
    (error: unknown) => error instanceof VoiceProcessingError && error.statusCode === 415,
  );
});
