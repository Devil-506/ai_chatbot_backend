// server.js - Node 22 CommonJS, Ollama HTTP API streaming
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

// Dynamic fetch import for Node 22 CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5173"],
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const clients = new Set();

// ===== Ollama HTTP API Config =====
const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const OLLAMA_BASE_URL = 'https://api.ollama.ai';
const MODEL_NAME = 'deepseek-v3.1:671b-cloud';

// ===== Tunisian Medical Context =====
const MEDICAL_CONTEXT = `
You are a medical assistant chatbot specifically designed for Tunisian patients. Your role:
- Provide general medical information and symptom analysis
- Offer health advice and preventive care
- Guide patients to Tunisian healthcare resources

IMPORTANT:
- Not a replacement for professional advice
- For emergencies, call 190
- Never ask personal data or give prescriptions

Respond in **Tunisian Arabic**, empathetic, concise, safe, culturally aware.
`;

class MedicalOllamaService {
  async generateResponse(userMessage, socket) {
    try {
      console.log('Medical query:', userMessage);
      const prompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";

      const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OLLAMA_API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [{ role: "user", content: prompt }],
          stream: true,
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          if (line === 'data: [DONE]') {
            socket.emit('streaming_response', { text: fullResponse, partial: false, complete: true });
            return fullResponse;
          }

          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                fullResponse += content;
                socket.emit('streaming_response', { text: fullResponse, partial: true });
              }
            } catch {}
          }
        }
      }

      return fullResponse;

    } catch (err) {
      console.error(err);
      if (socket) socket.emit('error', { message: 'عذرًا، حدث خطأ في النظام.' });
      throw err;
    }
  }
}

const medicalService = new MedicalOllamaService();

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', service: 'Tunisian Medical Assistant', timestamp: new Date() });
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  clients.add(socket);

  socket.on('send_message', async (data) => {
    await medicalService.generateResponse(data.message, socket);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    clients.delete(socket);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
