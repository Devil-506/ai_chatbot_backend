const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" } // Accept all origins for Render
});

app.use(cors());
app.use(express.json());

// Hardcoded API key
const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const MODEL_NAME = 'deepseek-v3.1:671b-cloud';
const OLLAMA_BASE_URL = 'https://api.ollama.ai';

// Full Tunisian medical assistant context
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
      const prompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";

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

        const chunk = decoder.decode(value, { stream: true });
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
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                fullResponse += content;
                socket.emit('streaming_response', {
                  text: fullResponse,
                  partial: true
                });
              }
            } catch (e) {
              // Skip JSON parse errors
            }
          }
        }
      }

      return fullResponse;

    } catch (error) {
      console.error('Ollama error:', error);
      socket.emit('error', { message: 'حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' });
      return '';
    }
  }
}

const medicalService = new MedicalOllamaService();

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('send_message', async data => {
    await medicalService.generateResponse(data.message, socket);
  });

  socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Medical Chatbot running', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🏥 Server running on port ${PORT}`));
