// server.js - Ollama CLI local version
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { exec } from 'child_process';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5173"],
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const MODEL_NAME = 'llama2:latest'; // replace with your local model name

const MEDICAL_CONTEXT = `
You are a medical assistant chatbot for Tunisian patients.
Respond in **Tunisian Arabic**, clear, concise, empathetic.
Never give prescriptions. Always suggest consulting a real doctor.
Provide preventive advice and local healthcare info.
`;

class MedicalOllamaService {
  generateResponse(userMessage, socket) {
    return new Promise((resolve, reject) => {
      const prompt = `${MEDICAL_CONTEXT}\n\nPatient: ${userMessage}\nAssistant:`;
      
      // Run Ollama CLI command
      const cmd = `ollama generate "${MODEL_NAME}" "${prompt}" --stream`;

      const child = exec(cmd);

      let fullResponse = '';

      child.stdout.on('data', (chunk) => {
        fullResponse += chunk;
        socket.emit('streaming_response', { text: fullResponse, partial: true });
      });

      child.stderr.on('data', (err) => {
        console.error('Ollama CLI error:', err.toString());
      });

      child.on('exit', (code) => {
        socket.emit('streaming_response', { text: fullResponse, partial: false, complete: true });
        resolve(fullResponse);
      });

      child.on('error', (err) => reject(err));
    });
  }
}

const medicalService = new MedicalOllamaService();

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Medical Chatbot Backend running locally' });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('send_message', async (data) => {
    try {
      await medicalService.generateResponse(data.message, socket);
    } catch (err) {
      console.error(err);
      socket.emit('error', { message: 'حدث خطأ، حاول مرة أخرى.' });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using local Ollama model: ${MODEL_NAME}`);
});
