require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();

// index.html ko serve karne ke liye
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/listen' });

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

wss.on('connection', (clientWs, req) => {
    // Frontend se jo parameters aayenge (language, sample_rate, wagera)
    const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const lang = urlParams.get('language') || 'en';
    const sampleRate = urlParams.get('sample_rate') || '16000';
    const smartFormat = urlParams.get('smart_format') || 'true';
    const punctuate = urlParams.get('punctuate') || 'true';
    const model = urlParams.get('model') || 'nova-3';

    // Backend se Deepgram ka connection banayein
    const deepgramParams = new URLSearchParams({
        model: model,
        encoding: 'linear16',
        sample_rate: sampleRate,
        channels: '1',
        interim_results: 'true',
        smart_format: smartFormat,
        punctuate: punctuate,
        endpointing: '300',
        language: lang
    });

    const deepgramUrl = `wss://api.deepgram.com/v1/listen?${deepgramParams.toString()}`;
    const deepgramWs = new WebSocket(deepgramUrl, {
        headers: {
            Authorization: `Token ${DEEPGRAM_KEY}` // API Key yahan backend par secure hai
        }
    });

    // 1. Mic se audio data aaye toh Deepgram ko forward karo
    clientWs.on('message', (audioChunk) => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(audioChunk);
        }
    });

    // 2. Deepgram se transcript aaye toh wapis client ko bhejo
    deepgramWs.on('message', (transcriptData) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(transcriptData.toString());
        }
    });

    // Disconnect handling
    clientWs.on('close', () => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
            deepgramWs.close();
        }
    });

    deepgramWs.on('close', () => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close();
        }
    });

    deepgramWs.on('error', (err) => console.error('Deepgram Error:', err.message));
    clientWs.on('error', (err) => console.error('Client Error:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at: http://localhost:${PORT}`);
});