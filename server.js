// server.js - Full Ollama Cloud HTTP Streaming Version
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch'); // make sure node-fetch is installed

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

// Hardcoded Ollama Cloud API key
const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const OLLAMA_BASE_URL = 'https://api.ollama.ai';
const MODEL_NAME = 'deepseek-v3.1:671b-cloud';

// Full Tunisian Medical Context
const MEDICAL_CONTEXT = `
You are a medical assistant chatbot specifically designed for Tunisian patients. Your role is to:

1. Provide general medical information and symptom analysis
2. Offer health advice and preventive care information
3. Help understand medical conditions and treatments
4. Guide patients to appropriate healthcare resources in Tunisia

IMPORTANT DISCLAIMERS:
- You are not a replacement for professional medical advice
- Always consult with healthcare professionals for serious conditions
- For emergencies, contact Tunisian emergency services (190)
- You provide information only, not diagnoses

Tunisia-specific information:
- Healthcare system: Public and private sectors
- Emergency: 190
- Common languages: Arabic, French, English
- Major hospitals: Charles Nicolle, La Rabta, Mongi Slim

When responding:
- Always put proper spaces between words
- Use Tunisian Arabic dialect
- Be empathetic and clear
- Use simple language
- Focus on patient safety
- Be helpful and supportive
- Keep responses concise
- Maintain confidentiality
- Never ask for personal data
- Never provide prescriptions or specific treatments
- Cater to local healthcare context
- Consider Tunisian cultural context
- Suggest local resources when appropriate
- Always emphasize consulting real doctors

Now, respond to the patient's query in natural Tunisian Arabic:
`;

class MedicalOllamaService {
  async generateResponse(userMessage, socket) {
    try {
      console.log('Medical query from patient:', userMessage);

      const medicalPrompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";

      // Call Ollama Cloud HTTP API with streaming
      const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OLLAMA_API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [{ role: "user", content: medicalPrompt }],
          stream: true,
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          if (line === 'data: [DONE]') {
            socket.emit('streaming_response', {
              text: fullResponse,
              partial: false,
              complete: true
            });
            return fullResponse;
          }

          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                const content = data.choices[0].delta.content;
                fullResponse += content;

                socket.emit('streaming_response', {
                  text: fullResponse,
                  partial: true
                });
              }
            } catch (e) {
              // Skip JSON parse errors for incomplete chunks
            }
          }
        }
      }

      return fullResponse;

    } catch (error) {
      console.error('Error generating medical response:', error);
      if (socket) {
        socket.emit('error', { message: 'عذرًا، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' });
      }
      throw error;
    }
  }
}

const medicalService = new MedicalOllamaService();

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Medical Chatbot Backend is running',
    service: 'Tunisian Patient Assistant',
    timestamp: new Date().toISOString()
  });
});

// Test Ollama API connectivity
app.get('/api/test-ollama', async (req, res) => {
  try {
    const testResponse = await fetch(`${OLLAMA_BASE_URL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${OLLAMA_API_KEY}` }
    });

    if (testResponse.ok) {
      res.json({ success: true, message: 'Ollama Cloud API is reachable' });
    } else {
      res.json({ success: false, message: 'Ollama API error' });
    }
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  clients.add(socket);

  socket.on('send_message', async (data) => {
    try {
      await medicalService.generateResponse(data.message, socket);
    } catch (error) {
      console.error('Error:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    clients.delete(socket);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🏥 Medical Chatbot Server running on port ${PORT}`);
  console.log(`🤖 Using Ollama Cloud API with key: ${OLLAMA_API_KEY.substring(0, 10)}...`);
});
