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
    console.warn(`[Transcription] ffmpeg pre-conversion failed, uploading raw file: ${err.message}`);
  }

  try {
    const fileBuffer = await fsp.readFile(uploadPath);
    const fileBlob = new Blob([fileBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', fileBlob, path.basename(uploadPath));
    formData.append('model', GROQ_MODEL);
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', '0.0');
    formData.append('prompt', 'Hello, welcome to Unicircuit. Haan, main check karke batata hoon. Yes sir, quotation ready hai, please check. OK, please wait. Adani, lead active, lead closed, WhatsApp broadcast, extension, caller, recording, details, talk, connect, discuss.');

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
            content: `You are a professional Hindi-to-Hinglish transliterator. Your job is to convert any Devanagari Hindi text in the segments list to Romanized Hinglish (Hindi written in English/Latin script) or English.
Guidelines:
1. Transliterate Devanagari text to phonetic Romanized Hinglish (e.g. "एक मिनिट सर होल्ड कीजिए" -> "Ek minute sir hold kijiye", "हाँ" -> "Haan", "कोटेशन रेडी हो गया है" -> "Quotation ready ho gaya hai").
2. Do NOT write Devanagari Hindi characters in the output. All output text MUST be in Latin/English alphabet.
3. Keep all technical terms and proper names in proper English spelling (e.g. TV, CCTV, voltage, motherboard, team, holiday, Kaushal Gupta). Do NOT translate English words to Hindi.
4. Output must be a valid JSON object matching the input structure: { "segments": [ { "start": "HH:MM:SS.mmm", "end": "HH:MM:SS.mmm", "text": "transliterated text" } ] }
5. Do not include any explanations, notes, markdown formatting, or conversational text. Return only the valid JSON object.`
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
