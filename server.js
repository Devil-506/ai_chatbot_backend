const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const http = require('http');
const socketIo = require('socket.io');

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

// Store connected clients
const clients = new Set();

// Medical context for Tunisian patients
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
- 
When responding:
- let space between each word
- use arabic tunisien dialect
- Be empathetic and clear
- Use simple language
- focus on patient safety
-helpful and supportive
- keep responses consise
- maintain confidentiality
- never ask for personal data
- never provide prescriptions or specific treatments
- cater to local healthcare context
- Consider Tunisian cultural context
- Suggest local resources when appropriate
- Always emphasize consulting real doctors
- Use arabic tunisien dialect for responses
Now, respond to the patient's query:
`;

class MedicalOllamaService {
  async generateResponse(userMessage, socket) {
    return new Promise((resolve, reject) => {
      console.log('Medical query from patient:', userMessage);
      
      // Enhanced prompt with medical context
      const medicalPrompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";
      
      const ollama = spawn('ollama', ['run', 'deepseek-v3.1:671b-cloud']);

      let response = '';

      ollama.stdin.write(medicalPrompt + '\n');
      ollama.stdin.end();

      let leftover = ''; // store half words between chunks

ollama.stdout.on('data', (data) => {
  let chunk = data.toString();

  // combine with leftover from previous chunk
  chunk = leftover + chunk;

  // if chunk ends mid-word, keep last partial word for next round
  const match = chunk.match(/^(.*\b)(\S*)$/);
  if (match) {
    const [_, complete, partial] = match;
    leftover = partial;
    chunk = complete;
  }

  // normalize basic spacing
  chunk = chunk
    .replace(/\s+/g, ' ')           // collapse multiple spaces
    .replace(/ ([.,!?;:])/g, '$1')  // remove space before punctuation
    .replace(/([.,!?;:])(?!\s)/g, '$1 '); // ensure space after punctuation

  response += chunk;

  if (socket) {
    socket.emit('streaming_response', {
      text: response.trim(),
      partial: true
    });
  }
});

ollama.on('close', (code) => {
  // flush any leftover partial word
  if (leftover) response += leftover;
  if (socket) {
    socket.emit('streaming_response', {
      text: response.trim(),
      partial: false,
      complete: true
    });
  }
  resolve(response.trim());
});

      ollama.on('close', (code) => {
        console.log('Ollama process closed with code:', code);
        if (socket) {
          socket.emit('streaming_response', {
            text: response,
            partial: false,
            complete: true
          });
        }
        resolve(response);
      });

      ollama.on('error', (error) => {
        console.error('Ollama process error:', error);
        reject(error);
      });
    });
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

// Socket.io for real-time communication
io.on('connection', (socket) => {
  console.log('Medical chatbot user connected:', socket.id);
  clients.add(socket);

  socket.on('send_message', async (data) => {
    try {
      console.log('Received medical query:', data.message);
      await medicalService.generateResponse(data.message, socket);
    } catch (error) {
      console.error('Error processing medical query:', error);
      socket.emit('error', { 
        message: 'عذرًا، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' 
      });
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
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🎯 Service: Tunisian Patient Assistant`);
  console.log(`🤖 Using model: deepseek-v3.1:671b-cloud`);
});
