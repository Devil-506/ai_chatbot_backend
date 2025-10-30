const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configure CORS for your Render frontend
const io = socketIo(server, {
  cors: {
    origin: [
      "https://ai-chatbot-frontend-1vx1.onrender.com",  // Your actual frontend URL
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configuration - Update these with your ngrok URL
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';

// Enhanced Medical Context for Tunisian Patients
const MEDICAL_CONTEXT ='
 You are a medical assistant chatbot specifically designed for Tunisian patients. Your role is to:

1. Provide general medical information and symptom analysis
2. Offer health advice and preventive care information
3. Help understand medical conditions and treatments
4. Guide patients to appropriate healthcare resources in Tunisia
IMPORTANT DISCLAIMERS:
- You are not a replacement for professional medical advice
- Always consult with healthcare professionals for serious conditions
- For emergencies, contact Tunisian emergency services (198)
- You provide information only, not diagnoses

Tunisia-specific information:
- Healthcare system: Public and private sectors
- Emergency: 198
- Common languages: Arabic, French, English
- Major hospitals: Charles Nicolle, La Rabta, Mongi Slim
- 
When responding:
- let space between each word
- use same language used for questioning
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
Now, respond to the patient's query:
  ';

class RemoteOllamaService {
  async generateResponse(userMessage, socket) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log('💬 Medical query received:', userMessage.substring(0, 100));
        
        const medicalPrompt = MEDICAL_CONTEXT + "\n\nالمريض: " + userMessage + "\n\nالمساعد:";
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 1 minute timeout

        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: medicalPrompt,
            stream: true,
            options: {
              temperature: 0.7,
              top_p: 0.9,
              top_k: 40
            }
          }),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim() === '') continue;
            
            try {
              const data = JSON.parse(line);
              
              if (data.response) {
                fullResponse += data.response;
                
                // Stream to frontend
                if (socket && socket.connected) {
                  socket.emit('streaming_response', {
                    text: fullResponse,
                    partial: !data.done
                  });
                }
              }
              
              if (data.done) {
                if (socket && socket.connected) {
                  socket.emit('streaming_response', {
                    text: fullResponse,
                    partial: false,
                    complete: true
                  });
                }
                resolve(fullResponse);
                return;
              }
              
            } catch (e) {
              console.warn('⚠️ JSON parse error:', e.message);
            }
          }
        }

        resolve(fullResponse);
        
      } catch (error) {
        console.error('❌ Ollama service error:', error);
        
        const fallbackResponse = "عذرًا، الخدمة الطبية غير متاحة حاليًا. يرجى المحاولة لاحقًا أو الاتصال بطبيبك مباشرة.";
        
        if (socket && socket.connected) {
          socket.emit('streaming_response', {
            text: fallbackResponse,
            partial: false,
            complete: true
          });
        }
        
        resolve(fallbackResponse);
      }
    });
  }

  async healthCheck() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        return {
          healthy: true,
          models: data.models?.map(m => m.name) || [],
          message: 'Ollama is connected'
        };
      }
      return {
        healthy: false,
        message: `Ollama responded with status: ${response.status}`
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Cannot connect to Ollama: ${error.message}`
      };
    }
  }
}

const medicalService = new RemoteOllamaService();

// Store active connections
const activeConnections = new Map();

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: 'OK',
      service: 'Tunisian Medical Chatbot',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: activeConnections.size,
      ollama: ollamaHealth
    };
    
    res.json(healthStatus);
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: 'Health check failed',
      error: error.message
    });
  }
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'Medical chatbot server is running!',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  
  activeConnections.set(socket.id, {
    connectedAt: new Date(),
    ip: socket.handshake.address
  });

  // Send welcome message
  socket.emit('welcome', {
    message: 'أهلاً وسهلاً! أنا مساعدك الطبي التونسي. كيف يمكنني مساعدتك اليوم؟',
    id: socket.id,
    timestamp: new Date().toISOString()
  });

  // Handle incoming messages
  socket.on('send_message', async (data) => {
    if (!data.message || data.message.trim().length === 0) {
      socket.emit('error', { message: 'الرجاء كتابة رسالة.' });
      return;
    }

    if (data.message.length > 2000) {
      socket.emit('error', { message: 'الرسالة طويلة جدًا. الرجاء الاختصار.' });
      return;
    }

    try {
      console.log(`📝 Processing message from ${socket.id}`);
      await medicalService.generateResponse(data.message.trim(), socket);
    } catch (error) {
      console.error('💥 Message processing error:', error);
      socket.emit('error', { 
        message: 'عذرًا، حدث خطأ في المعالجة. يرجى المحاولة مرة أخرى.' 
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('🔌 User disconnected:', socket.id, 'Reason:', reason);
    activeConnections.delete(socket.id);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('💥 Socket error:', error);
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'عذرًا، المسار غير موجود.'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🔥 Server error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: 'عذرًا، حدث خطأ في الخادم.'
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🏥 Tunisian Medical Chatbot Server
📍 Port: ${PORT}
🎯 Environment: ${process.env.NODE_ENV || 'development'}
🔗 Ollama: ${OLLAMA_BASE_URL}
🤖 Model: ${OLLAMA_MODEL}
✨ Server is running and ready!
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔻 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('🔻 Process terminated');
  });
});

module.exports = app;


