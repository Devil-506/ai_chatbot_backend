// server.js - Stable Tunisian Medical Chatbot Backend
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://ai-chatbot-frontend-1vx1.onrender.com", "http://localhost:3000", "http://localhost:5173"],
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Node-fetch dynamic import for Node 22+
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Hardcoded API key and model
const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const OLLAMA_BASE_URL = 'https://api.ollama.ai';
const MODEL_NAME = 'deepseek-v3.1:671b-cloud';

// Tunisian Medical Context + Old Prompts
const MEDICAL_CONTEXT = `
You are a medical assistant chatbot specifically for Tunisian patients. You provide general medical info, advice, and guide patients safely. Always respond in Tunisian Arabic dialect. 

IMPORTANT:
- Not a replacement for a doctor
- Do not give prescriptions
- Suggest local resources when relevant
- Emergency: 190

Old prompts / quick actions include:
- Cold symptoms: "لدي أعراض البرد والإنفلونزا، ما النصائح؟"
- Medication advice: "أريد استشارة حول الأدوية المناسبة"
- Routine checkups: "ما الفحوصات الطبية الروتينية المطلوبة؟"
- Preventive tips: "ما هي النصائح للوقاية من الأمراض؟"
- Local hospital info: "أريد معلومات عن المستشفيات الكبرى في تونس"
- Vaccines: "ما هي التطعيمات المهمة للأطفال والكبار؟"
- Diet & nutrition: "ما هي النصائح الغذائية الصحية؟"
- Emergency steps: "ماذا أفعل في حالة طارئة صحية؟"
`;

// Simple Ollama HTTP call (non-streaming)
async function getOllamaResponse(userMessage) {
  const prompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "🤖 خطأ في الرد من المساعد";
  } catch (err) {
    console.error("Ollama call failed:", err);
    return "🤖 حدث خطأ. حاول مرة أخرى.";
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Medical Chatbot Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Test Ollama connectivity
app.get('/api/test-ollama', async (req, res) => {
  try {
    const testResponse = await fetch(`${OLLAMA_BASE_URL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}` }
    });
    if (testResponse.ok) res.json({ success: true, message: 'Ollama API is reachable' });
    else res.json({ success: false, message: 'Ollama API error' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Socket.io chat
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('send_message', async (data) => {
    try {
      const answer = await getOllamaResponse(data.message);
      socket.emit('streaming_response', { text: answer, partial: false, complete: true });
    } catch (error) {
      console.error('Error in send_message:', error);
      socket.emit('streaming_response', { text: '🤖 حدث خطأ. حاول مرة أخرى.', partial: false, complete: true });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🏥 Server running on port ${PORT}`);
  console.log(`🤖 Using Ollama Cloud API key: ${OLLAMA_API_KEY.substring(0, 10)}...`);
});
