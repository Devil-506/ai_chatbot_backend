91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo

// server.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5173", "https://ai-chatbot-frontend-1vx1.onrender.com"],
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const clients = new Set();

// Ollama Cloud config
const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const OLLAMA_BASE_URL = 'https://api.ollama.ai';
const MODEL_NAME = 'deepseek-v3.1:671b-cloud';

// Tunisian medical context and prompts
const MEDICAL_CONTEXT = `
You are a medical assistant chatbot for Tunisian patients. 
Your goal is to:
- Provide general medical info, symptom analysis, and preventive care
- Use Tunisian Arabic, French, or English depending on patient
- Suggest local Tunisian resources (hospitals, clinics)
- Always be empathetic, safe, concise, and culturally aware
- Never give personal prescriptions
- Emphasize consulting real doctors for serious conditions
- Emergency number in Tunisia: 190

Old Tunisian medical prompts examples:
- "عندي صداع مستمر، شنو نعمل؟"
- "شنو الأدوية المناسبة للبرد والرشح؟"
- "وين نلقا أقرب مستشفى في تونس؟"
- "نصائح للوقاية من الإنفلونزا في الشتاء"
`;

class MedicalOllamaService {
  async generateResponse(userMessage, socket) {
    try {
      console.log('Medical query:', userMessage);

      const prompt = MEDICAL_CONTEXT + `\n\nPatient: ${userMessage}\n\nAssistant:`;

      const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
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

      if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(l => l.trim());

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

    } catch (error) {
      console.error('Error:', error);
      socket.emit('error', { message: 'عذرًا، حدث خطأ. حاول مرة أخرى.' });
      throw error;
    }
  }
}

const medicalService = new MedicalOllamaService();

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Medical Chatbot Backend running',
    timestamp: new Date().toISOString()
  });
});

// Test Ollama API
app.get('/api/test-ollama', async (req, res) => {
  try {
    const testResp = await fetch(`${OLLAMA_BASE_URL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}` }
    });
    res.json({ success: testResp.ok, status: testResp.status });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  clients.add(socket);

  socket.on('send_message', async (data) => {
    try {
      await medicalService.generateResponse(data.message, socket);
    } catch {}
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    clients.delete(socket);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🏥 Server running on port ${PORT}`);
});
