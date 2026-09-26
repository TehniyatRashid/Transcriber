import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

console.log('--- Environment Check ---');
console.log('DEEPGRAM_API_KEY present?:', Boolean(process.env.DEEPGRAM_API_KEY));
console.log('GEMINI_API_KEY present?:', Boolean(process.env.GEMINI_API_KEY));
console.log('-------------------------');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const translationModel = genAI.getGenerativeModel({
  model: "gemini-3.8-flash",
  systemInstruction: "You are an expert courtroom translator. Translate the given multi-speaker conversation naturally and accurately into the requested target language. Maintain speaker labels (e.g. Speaker 1, Speaker 2) and legal context."
});

wss.on('connection', (clientWs, req) => {
  console.log('Browser client connected');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const inputLanguage = url.searchParams.get('language') || 'ur';
  const targetLanguage = url.searchParams.get('targetLanguage') || 'English';
  const sampleRate = url.searchParams.get('sample_rate') || '48000';

  // Array to collect entire conversation during recording session
  const sessionDialogues = [];

  const dgParams = new URLSearchParams({
    model: 'nova-3',
    language: inputLanguage,
    smart_format: 'true',
    diarize_model: 'latest',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: sampleRate,
    endpointing: '10'
  });

  const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;
  const deepgramWs = new WebSocket(dgUrl, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  });

  deepgramWs.on('open', () => {
    console.log('✅ Deepgram connected for live session!');
    clientWs.send(JSON.stringify({
      type: 'NOTIFICATION',
      status: 'READY',
      message: '🎙️ System ready: Recording live speech...'
    }));
  });

  deepgramWs.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== 'Results') return;

      const alt = parsed.channel?.alternatives?.[0];
      const transcript = alt?.transcript;
      const isFinal = parsed.is_final;

      if (!transcript || transcript.trim().length === 0) return;

      let rawSpeaker = 0;
      if (alt.words && alt.words.length > 0) {
        rawSpeaker = alt.words[0].speaker ?? 0;
      }
      const speakerId = rawSpeaker + 1;

      // 1. Send live transcription to UI
      clientWs.send(JSON.stringify({
        type: 'TRANSCRIPTION',
        speaker: speakerId,
        speakerLabel: `Speaker ${speakerId}`,
        text: transcript,
        isFinal: isFinal
      }));

      // 2. Accumulate finalized speech in session history
      if (isFinal) {
        sessionDialogues.push({
          speaker: speakerId,
          speakerLabel: `Speaker ${speakerId}`,
          text: transcript.trim()
        });
      }
    } catch (e) {
      console.error('Data parse error:', e);
    }
  });

  deepgramWs.on('error', (err) => {
    console.error('❌ Deepgram Error:', err.message || err);
  });

  // Client messages handler (Audio buffer & JSON commands)
  clientWs.on('message', async (message) => {
    // Check if client sent JSON command (STOP_AND_TRANSLATE)
    let isCommand = false;
    let cmd = null;

    try {
      const text = message.toString('utf8');
      if (text.startsWith('{') && text.endsWith('}')) {
        cmd = JSON.parse(text);
        if (cmd && cmd.type) {
          isCommand = true;
        }
      }
    } catch (e) {
      isCommand = false;
    }

    if (isCommand && cmd.type === 'STOP_AND_TRANSLATE') {
      console.log(`📥 STOP_AND_TRANSLATE received. Total dialogues collected: ${sessionDialogues.length}`);

      if (sessionDialogues.length === 0) {
        clientWs.send(JSON.stringify({
          type: 'FULL_SESSION_TRANSLATION',
          translatedText: 'No speech was recorded to translate.',
          entriesCount: 0
        }));
        return;
      }

      clientWs.send(JSON.stringify({
        type: 'NOTIFICATION',
        status: 'TRANSLATING',
        message: '⏳ Translating full courtroom session with context...'
      }));

      // Format entire session conversation
      const fullScript = sessionDialogues
        .map(d => `${d.speakerLabel}: "${d.text}"`)
        .join('\n');

      console.log('Sending full courtroom script to Gemini for translation:\n', fullScript);

      const prompt = `Context: Courtroom hearing transcript.
Translate the following entire multi-speaker conversation into ${targetLanguage}.
Keep the exact speaker labels and natural conversational flow.

Conversation:
${fullScript}

Format your response as:
Speaker X: [Translated text]`;

      try {
        const result = await translationModel.generateContent(prompt);
        const fullTranslatedText = result.response.text().trim();
        console.log('✅ Gemini Translation Completed:\n', fullTranslatedText);

        // Send full translated conversation back to frontend
        clientWs.send(JSON.stringify({
          type: 'FULL_SESSION_TRANSLATION',
          translatedText: fullTranslatedText,
          entriesCount: sessionDialogues.length
        }));

        clientWs.send(JSON.stringify({
          type: 'NOTIFICATION',
          status: 'COMPLETED',
          message: '✅ Full session translation completed!'
        }));

      } catch (tErr) {
        console.error('❌ Full translation error:', tErr.message);
        clientWs.send(JSON.stringify({
          type: 'NOTIFICATION',
          status: 'ERROR',
          message: '⚠️ Translation error: ' + tErr.message
        }));
      }
      return;
    }

    // Forward raw audio buffers to Deepgram
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.send(message);
    }
  });

  clientWs.on('close', () => {
    console.log('Browser client disconnected');
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
