/**
 * Call Recordings Transcription Service — UniComm Pro
 * ─────────────────────────────────────────────────────────────────────────────
 * This service transcribes PBX audio recordings to structured timelines + text.
 * It supports:
 *   1. Multilingual input (Hindi, Marathi, English, Hinglish, etc.)
 *   2. Timeline segment formatting (HH:MM:SS.mmm -> Text)
 *   3. Dual-mode execution:
 *      - Local whisper.cpp CLI (offline execution) if configured
 *      - High-performance Groq Whisper API (online execution) fallback
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const nodeFetch = require('node-fetch');
const fetch = global.fetch || nodeFetch;
const { exec } = require('child_process');
const pool = require('../db/pool');

// Config from .env
const WHISPER_CLI = process.env.WHISPER_CLI_PATH || ''; // Path to main.exe (whisper.cpp)
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH || ''; // Path to ggml model (.bin)
const GROQ_API_KEY = process.env.AI_API_KEY || '';
const GROQ_MODEL = process.env.WHISPER_API_MODEL || 'whisper-large-v3';

// G.711 Mu-law decoding table
const MuLawTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let sign = (i & 0x80) ? -1 : 1;
  let exponent = (~i >> 4) & 0x07;
  let mantissa = ~i & 0x0f;
  let sample = (mantissa << 3) + 132;
  sample <<= exponent;
  sample -= 132;
  MuLawTable[i] = sign * sample;
}

function parseWav(buffer) {
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      fmtOffset = offset + 8;
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize;
  }
  
  if (fmtOffset === -1 || dataOffset === -1) {
    throw new Error('Invalid WAV file structure');
  }
  
  const formatCode = buffer.readUInt16LE(fmtOffset);
  const channels = buffer.readUInt16LE(fmtOffset + 2);
  const sampleRate = buffer.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = buffer.readUInt16LE(fmtOffset + 14);
  
  return {
    formatCode,
    channels,
    sampleRate,
    bitsPerSample,
    dataOffset,
    dataSize
  };
}

function decodeAndUpsampleWav(inputPath, outputPath) {
  const inputBuffer = fs.readFileSync(inputPath);
  const info = parseWav(inputBuffer);
  
  const rawAudio = inputBuffer.slice(info.dataOffset, info.dataOffset + info.dataSize);
  let pcm16Samples;
  
  if (info.formatCode === 7) {
    // 8-bit Mu-law
    pcm16Samples = new Int16Array(rawAudio.length);
    for (let i = 0; i < rawAudio.length; i++) {
      pcm16Samples[i] = MuLawTable[rawAudio[i]];
    }
  } else if (info.formatCode === 1 && info.bitsPerSample === 16) {
    // 16-bit PCM
    pcm16Samples = new Int16Array(rawAudio.buffer, rawAudio.byteOffset, rawAudio.length / 2);
  } else {
    throw new Error('Unsupported format code: ' + info.formatCode);
  }
  
  // Upsample from 8000 to 16000
  let upsampledSamples;
  if (info.sampleRate === 8000) {
    upsampledSamples = new Int16Array(pcm16Samples.length * 2);
    for (let i = 0; i < pcm16Samples.length; i++) {
      const s = pcm16Samples[i];
      upsampledSamples[i * 2] = s;
      upsampledSamples[i * 2 + 1] = s;
    }
  } else {
    upsampledSamples = pcm16Samples;
  }
  
  // Apply block-based Automatic Gain Control (AGC) to boost quiet voices
  const blockSize = 8000; // 0.5 seconds at 16kHz
  const targetPeak = 24000;
  const noiseFloor = 300;
  
  for (let i = 0; i < upsampledSamples.length; i += blockSize) {
    const blockEnd = Math.min(i + blockSize, upsampledSamples.length);
    let blockPeak = 0;
    
    for (let j = i; j < blockEnd; j++) {
      const absVal = Math.abs(upsampledSamples[j]);
      if (absVal > blockPeak) blockPeak = absVal;
    }
    
    if (blockPeak > noiseFloor) {
      const gain = targetPeak / blockPeak;
      const appliedGain = Math.min(gain, 5.0); // max 5x gain boost
      for (let j = i; j < blockEnd; j++) {
        let sample = upsampledSamples[j] * appliedGain;
        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;
        upsampledSamples[j] = sample;
      }
    }
  }
  
  // Create output buffer
  const outDataLength = upsampledSamples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + outDataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(16000, 24); // 16kHz
  header.writeUInt32LE(32000, 28); // 32000 bytes/sec
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // 16-bit
  header.write('data', 36);
  header.writeUInt32LE(outDataLength, 40);
  
  const outAudioBuffer = Buffer.from(upsampledSamples.buffer, upsampledSamples.byteOffset, outDataLength);
  const outBuffer = Buffer.concat([header, outAudioBuffer]);
  
  fs.writeFileSync(outputPath, outBuffer);
}

// Helper: Convert seconds to HH:MM:SS.mmm format
function formatSecondsToTimeline(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Helper: Convert timeline HH:MM:SS.mmm back to seconds (if needed)
function parseTimelineToSeconds(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length !== 3) return 0;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const sParts = parts[2].split('.');
  const s = parseFloat(sParts[0]);
  const ms = sParts[1] ? parseFloat(sParts[1]) / 1000 : 0;
  return h * 3600 + m * 60 + s + ms;
}

// Helper: Run CLI commands (exec wrapped in a Promise)
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Local whisper.cpp Execution (Offline Mode) ───────────────────────────────
async function transcribeLocally(filePath, tempWavPath) {
  // whisper.cpp main.exe expects 16kHz mono WAV
  console.log(`[Transcription] Converting ${filePath} to 16kHz mono WAV...`);
  const convertCmd = `ffmpeg -y -i "${filePath}" -ar 16000 -ac 1 "${tempWavPath}"`;
  await runCommand(convertCmd);

  const outputJsonPrefix = tempWavPath.replace(/\.wav$/i, '');
  console.log(`[Transcription] Running whisper.cpp on: ${tempWavPath}`);
  
  // Output JSON format using main.exe (-oj parameter)
  const whisperCmd = `"${WHISPER_CLI}" -m "${WHISPER_MODEL}" -f "${tempWavPath}" -oj -of "${outputJsonPrefix}"`;
  await runCommand(whisperCmd);

  // Read resulting JSON file
  const jsonPath = `${outputJsonPrefix}.json`;
  const rawData = await fsp.readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(rawData);

  // Clean up temporary files
  await fsp.unlink(tempWavPath).catch(() => {});
  await fsp.unlink(jsonPath).catch(() => {});

  // Standardize output segments
  return (parsed.transcription || []).map(seg => ({
    start: formatSecondsToTimeline(seg.offsets.from / 1000),
    end: formatSecondsToTimeline(seg.offsets.to / 1000),
    text: seg.text.trim()
  }));
}

// ── Groq Whisper API Execution (Online Cloud Mode) ───────────────────────────
async function transcribeViaGroq(filePath) {
  console.log(`[Transcription] Uploading to Groq Whisper API: ${path.basename(filePath)}`);
  
  if (!GROQ_API_KEY) {
    throw new Error('Groq API Key is not configured (AI_API_KEY).');
  }

  // Pre-convert to 16kHz mono WAV first to ensure high Whisper accuracy
  const tempWavPath = filePath.replace(/\.(wav|mp3|ogg|m4a)$/i, '_temp16k_groq.wav');
  let uploadPath = filePath;
  let hasTempFile = false;

  try {
    console.log(`[Transcription] Pre-converting to 16kHz mono WAV for Groq Whisper: ${tempWavPath}`);
    const convertCmd = `ffmpeg -y -i "${filePath}" -ar 16000 -ac 1 "${tempWavPath}"`;
    await runCommand(convertCmd);
    uploadPath = tempWavPath;
    hasTempFile = true;
  } catch (err) {
    console.warn(`[Transcription] ffmpeg pre-conversion failed: ${err.message}. Falling back to pure JS WAV decoder...`);
    try {
      decodeAndUpsampleWav(filePath, tempWavPath);
      uploadPath = tempWavPath;
      hasTempFile = true;
    } catch (jsDecErr) {
      console.warn(`[Transcription] Pure JS WAV decoder failed: ${jsDecErr.message}. Uploading raw file.`);
    }
  }

  try {
    const fileBuffer = await fsp.readFile(uploadPath);
    const fileBlob = new Blob([fileBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', fileBlob, path.basename(uploadPath));
    formData.append('model', GROQ_MODEL);
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', '0.0');
    formData.append('language', 'hi'); // Force Hindi detection to ensure no speech segment is skipped
    formData.append('prompt', 'Hello, welcome to Unicircuit. Sangshil sir ko connect karna hai. Haan, main check karke batata hoon. Yes sir, quotation ready hai. Sangshil, Shiva Shish, Nirisha, Kaushal Gupta, Pawan, Adani, lead active, lead closed, WhatsApp broadcast, extension, caller, recording, details, connect, discuss.');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: formData
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Groq API Error: HTTP ${response.status}`);
    }

    const data = await response.json();
    
    // Clean up temporary pre-conversion file
    if (hasTempFile) {
      await fsp.unlink(tempWavPath).catch(() => {});
    }

    // Standardize output segments
    return (data.segments || []).map(seg => ({
      start: formatSecondsToTimeline(seg.start),
      end: formatSecondsToTimeline(seg.end),
      text: seg.text.trim()
    }));
  } catch (err) {
    if (hasTempFile) {
      await fsp.unlink(tempWavPath).catch(() => {});
    }
    throw err;
  }
}

// ── Transliterate Devanagari Hindi Text to Hinglish/English (Latin Alphabet) ──
async function transliterateToHinglish(segments) {
  if (!segments || segments.length === 0) return segments;

  // Only run transliteration if there is Devanagari Hindi text to save API tokens and time
  const hasHindi = segments.some(seg => /[\u0900-\u097F]/.test(seg.text));
  if (!hasHindi) {
    return segments;
  }

  console.log('[Transcription] Converting Devanagari Hindi text to Romanized Hinglish/English...');
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: `You are a strict Devanagari-to-Roman phonetic transliterator. Convert Devanagari Hindi text to Romanized Hinglish (Hindi written phonetically using the Latin/English alphabet).

CRITICAL RULES:
1. Do NOT translate Hindi words into English words (e.g. do NOT convert "बात" to "talk" or "conversation"; it must be transliterated as "baat". Do NOT convert "नंबर बता सकते हैं" to "can you tell me the number"; it must be transliterated as "number bata sakte hain"). Every single Hindi word must keep its original Hindi meaning and sound, just written in English alphabet.
2. Transliterate every single Hindi word phonetically word-for-word (e.g. "एक" -> "ek", "कीजिए" -> "kijiye", "हाँ" -> "haan", "मेरा" -> "mera", "देख" -> "dekh", "सकते" -> "sakte", "हैं" -> "hain", "थी" -> "thi", "अपने" -> "apne", "वगैरह" -> "vagera", "उड़" -> "ud", "गया" -> "gaya").
3. Convert "वाटसप" or "व्हाट्सएप" directly to "whatsapp".
4. Keep English words (e.g. TV, CCTV, voltage, motherboard, team, holiday, Kaushal Gupta, sir) exactly as they are in their correct English spelling.
5. Ensure 100% accuracy and precision. The output must have the exact same meaning, flow, and words as the input, just converted to the Roman alphabet. Do not summarize, translate, rephrase, add, or skip any words.
6. Output must be a valid JSON object matching the input structure: { "segments": [ { "start": "HH:MM:SS.mmm", "end": "HH:MM:SS.mmm", "text": "transliterated text" } ] }
7. Do not include any explanations, notes, markdown formatting, or conversational text. Return only the valid JSON object.`
          },
          {
            role: 'user',
            content: JSON.stringify({ segments })
          }
        ]
      })
    });

    if (!response.ok) {
      console.warn(`[Transcription] Transliteration failed with HTTP status ${response.status}. Using original segments.`);
      return segments;
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content;
    if (resultText) {
      const parsed = JSON.parse(resultText);
      if (parsed && Array.isArray(parsed.segments)) {
        return parsed.segments;
      }
    }
  } catch (err) {
    console.error('[Transcription] Error transliterating to Hinglish:', err.message);
  }

  return segments;
}

// ── Main Transcription Function ──────────────────────────────────────────────
async function transcribeRecording(filePath, forceRefresh = false) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recording file not found: ${filePath}`);
  }

  const transcriptPath = filePath.replace(/\.(wav|mp3|ogg|m4a)$/i, '_transcript.json');

  // Check if transcript file already exists
  if (!forceRefresh) {
    try {
      await fsp.access(transcriptPath);
      console.log(`[Transcription] Cache hit! Reading existing transcript: ${transcriptPath}`);
      const raw = await fsp.readFile(transcriptPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      // File doesn't exist, proceed to transcribe
    }
  }

  let segments = [];
  const useLocal = WHISPER_CLI && WHISPER_MODEL && fs.existsSync(WHISPER_CLI) && fs.existsSync(WHISPER_MODEL);

  if (useLocal) {
    const tempWavPath = filePath.replace(/\.(wav|mp3|ogg|m4a)$/i, '_temp16k.wav');
    try {
      segments = await transcribeLocally(filePath, tempWavPath);
    } catch (localErr) {
      console.warn(`[Transcription] Local whisper.cpp failed: ${localErr.message}. Falling back to Groq...`);
      segments = await transcribeViaGroq(filePath);
    }
  } else {
    segments = await transcribeViaGroq(filePath);
  }

  // Transliterate Devanagari text to Romanized Hinglish/English
  try {
    segments = await transliterateToHinglish(segments);
  } catch (transErr) {
    console.error('[Transcription] Transliteration wrapper error:', transErr.message);
  }

  // Save the result next to the audio file
  await fsp.writeFile(transcriptPath, JSON.stringify(segments, null, 2), 'utf8');
  console.log(`[Transcription] Saved transcript: ${transcriptPath}`);

  return segments;
}

module.exports = {
  transcribeRecording,
  formatSecondsToTimeline,
  parseTimelineToSeconds
};
