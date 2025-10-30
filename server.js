const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5173", "https://ungenerous-ropy-yuk.ngrok-free.dev"],
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Remote Ollama configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';

// Enhanced Medical context for Tunisian patients
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

class RemoteOllamaService {
  async generateResponse(userMessage, socket) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log('📝 Medical query from patient:', userMessage);
        
        const medicalPrompt = MEDICAL_CONTEXT + "\n\nالمريض: " + userMessage + "\n\nالمساعد:";
        
        console.log('🔗 Connecting to Ollama at:', OLLAMA_BASE_URL);
        
        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: medicalPrompt,
            stream: true,
            options: {
              temperature: 0.7,
              top_p: 0.9,
              top_k: 40
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let buffer = '';

        const processChunk = (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim() === '') continue;
            
            try {
              const data = JSON.parse(line);
              
              if (data.response) {
                fullResponse += data.response;
                
                // Stream to frontend in real-time
                if (socket) {
                  socket.emit('streaming_response', {
                    text: fullResponse,
                    partial: !data.done,
                    complete: data.done
                  });
                }
              }
              
              if (data.done) {
                console.log('✅ Response completed, total tokens:', data.total_duration);
                resolve(fullResponse);
                return true; // Signal completion
              }
              
            } catch (e) {
              console.warn('⚠️ Failed to parse JSON line:', line, 'Error:', e.message);
            }
          }
          return false;
        };

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            // Process any remaining buffer
            if (buffer.trim()) processChunk('');
            break;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          const completed = processChunk(chunk);
          
          if (completed) break;
        }
        
        // If we exit without completion, resolve with what we have
        if (fullResponse) {
          resolve(fullResponse);
        } else {
          throw new Error('No response generated from Ollama');
        }
        
      } catch (error) {
        console.error('❌ Remote Ollama error:', error);
        
        // Fallback responses in Tunisian Arabic
        const fallbackResponses = [
          "عذرًا، خدمة المساعدة الطبية مش متاحة حالياً. يرجى المحاولة مرة أخرى بعد قليل أو الاتصال بطبيبك مباشرة.",
          "النظام الطبي مشغول حالياً. يرجى المحاولة لاحقاً أو الاتصال برقم الطوارئ 190 إذا كانت حالة مستعجلة.",
          "عذرًا، فيه مشكلة تقنية مؤقتة. يرجى استشارة طبيب مباشرة للحصول على المساعدة."
        ];
        
        const fallbackResponse = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
        
        if (socket) {
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

  // Health check for remote Ollama
  async healthCheck() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        return {
          healthy: true,
          models: data.models || [],
          message: 'Ollama is connected and responding'
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

// Store active connections for monitoring
const activeConnections = new Map();

// Enhanced health check endpoint
app.get('/api/health', async (req, res) => {
  const ollamaHealth = await medicalService.healthCheck();
  
  const healthStatus = {
    status: ollamaHealth.healthy ? 'OK' : 'DEGRADED',
    message: ollamaHealth.healthy ? 'Medical Chatbot Backend is running' : 'Backend running but Ollama unavailable',
    service: 'Tunisian Patient Assistant',
    timestamp: new Date().toISOString(),
    ollama: ollamaHealth,
    connections: {
      active: activeConnections.size,
      total: Array.from(activeConnections.values()).length
    },
    environment: {
      node: process.version,
      platform: process.platform,
      ollama_url: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL
    }
  };
  
  if (ollamaHealth.healthy) {
    res.json(healthStatus);
  } else {
    res.status(503).json(healthStatus);
  }
});

// Test endpoint for quick Ollama check
app.get('/api/test-ollama', async (req, res) => {
  try {
    const testPrompt = "Hello, are you working? Respond in Tunisian Arabic.";
    
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: testPrompt,
        stream: false
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      res.json({ 
        success: true, 
        response: data.response,
        model: OLLAMA_MODEL
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: `Ollama responded with status: ${response.status}` 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Socket.io for real-time communication
io.on('connection', (socket) => {
  console.log('🔌 Medical chatbot user connected:', socket.id);
  activeConnections.set(socket.id, {
    connectedAt: new Date(),
    ip: socket.handshake.address
  });

  // Send welcome message
  socket.emit('connected', {
    message: 'مرحبًا! أنا مساعدك الطبي. كيف يمكنني مساعدتك اليوم؟',
    timestamp: new Date().toISOString()
  });

  socket.on('send_message', async (data) => {
    try {
      console.log('💬 Received medical query from', socket.id, ':', data.message.substring(0, 100) + '...');
      
      // Validate message
      if (!data.message || data.message.trim().length === 0) {
        socket.emit('error', { 
          message: 'عذرًا، يرجى كتابة رسالة.' 
        });
        return;
      }
      
      if (data.message.length > 1000) {
        socket.emit('error', { 
          message: 'عذرًا، الرسالة طويلة جدًا. يرجى اختصار استفسارك.' 
        });
        return;
      }
      
      await medicalService.generateResponse(data.message, socket);
      
    } catch (error) {
      console.error('❌ Error processing medical query:', error);
      socket.emit('error', { 
        message: 'عذرًا، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' 
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔌 User disconnected:', socket.id, 'Reason:', reason);
    activeConnections.delete(socket.id);
  });

  socket.on('error', (error) => {
    console.error('💥 Socket error for', socket.id, ':', error);
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

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'عذرًا، الصفحة المطلوبة غير موجودة.'
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
🏥 Medical Chatbot Server Started!
📍 Port: ${PORT}
🎯 Service: Tunisian Patient Assistant
🔗 Ollama URL: ${OLLAMA_BASE_URL}
🤖 Model: ${OLLAMA_MODEL}
📊 Health Check: http://localhost:${PORT}/api/health
🔧 Test Ollama: http://localhost:${PORT}/api/test-ollama
✨ Server is ready and waiting for connections...
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔻 Shutting down gracefully...');
  console.log(`🔻 Closing ${activeConnections.size} active connections`);
  
  server.close(() => {
    console.log('🔻 Server closed');
    process.exit(0);
  });
  
  // Force close after 5 seconds
  setTimeout(() => {
    console.log('🔻 Forcing shutdown');
    process.exit(1);
  }, 5000);
});

module.exports = { app, server, medicalService };
