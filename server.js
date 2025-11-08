const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ==================== SECURITY & RENDER COMPATIBILITY ====================

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const allowedOrigins = [
  "https://ai-chatbot-frontend-1vx1.onrender.com",
  "http://localhost:3000", 
  "http://localhost:5173"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      console.warn('🚫 CORS violation attempt from:', origin);
      return callback(new Error('CORS policy violation'), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', generalLimiter);

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO configuration
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// ==================== CONFIGURATION ====================

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:8b';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'render-default-secret-2024';

console.log('🔧 Server Configuration:');
console.log('🔗 Ollama URL:', OLLAMA_BASE_URL);
console.log('🤖 Model:', OLLAMA_MODEL);

// ==================== MEDICAL RESPONSE SYSTEM ====================

const MEDICAL_RESPONSES = {
  general: [
    "أهلاً بك! أنا مساعدك الطبي التونسي. كيف يمكنني مساعدتك اليوم؟",
    "مرحباً! أنا هنا لتقديم معلومات طبية عامة ونصائح صحية.",
    "أهلاً وسهلاً! يسرني مساعدتك في استفساراتك الطبية."
  ],
  
  symptoms: [
    "بناءً على الأعراض التي ذكرتها، أنصحك باستشارة طبيب مختص للتشخيص الدقيق.",
    "هذه الأعراض تتطلب تقييم طبي. يرجى التوجه إلى أقرب مركز صحي.",
    "للحصول على تشخيص دقيق، أنصح بمراجعة طبيب للفحص السريري."
  ],
  
  emergency: [
    "⛑️ هذه حالة طارئة! يرجى الاتصال فوراً برقم الطوارئ 190 أو التوجه إلى أقرب مستشفى.",
    "🚨 هذه حالة تستدعي عناية عاجلة. اتصل بالطوارئ على 190 أو اذهب إلى المستشفى الآن.",
    "⚠️ للحالات الطارئة: اتصل بـ 190 أو اذهب إلى مستشفى شارل نيكول (71 286 100)"
  ],
  
  hospitals: [
    "🏥 مستشفيات تونس الرئيسية:\n- شارل نيكول: 71 286 100\n- الرابطة: 71 785 000\n- المنجي سليم: 71 430 000\n- الطوارئ: 190",
    "📞 جهات اتصال طبية:\n- الإسعاف: 190\n- مستشفى شارل نيكول: 71 286 100\n- مستشفى الرابطة: 71 785 000",
    "🔔 للرعاية الطبية العاجلة:\n- رقم الطوارئ: 190\n- مستشفى شارل نيكول: 71 286 100\n- مستشفى الرابطة: 71 785 000"
  ],
  
  fallback: [
    "عذراً، الخدمة الطبية غير متاحة حالياً. يرجى الاتصال بطبيبك مباشرة أو التوجه إلى مركز صحي.",
    "نظام الاستشارات غير متوفر الآن. للرعاية العاجلة اتصل بالطوارئ على 190.",
    "نعتذر عن عدم تمكننا من تقديم استشارة طبية في الوقت الحالي. يرجى التواصل مع طبيب مختص."
  ]
};

class MedicalResponseService {
  async generateResponse(userMessage, socket) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log('💬 Medical query received:', userMessage.substring(0, 100));
        
        // Try Ollama service first
        const ollamaResponse = await this.tryOllamaService(userMessage, socket);
        if (ollamaResponse) {
          resolve(ollamaResponse);
          return;
        }
        
        // If Ollama fails, use local medical responses
        const localResponse = this.generateLocalResponse(userMessage);
        
        if (socket && socket.connected) {
          // Simulate streaming for consistent UX
          this.simulateStreaming(localResponse, socket);
        }
        
        resolve(localResponse);
        
      } catch (error) {
        console.error('❌ Medical service error:', error);
        const fallback = this.getFallbackResponse();
        
        if (socket && socket.connected) {
          socket.emit('streaming_response', {
            text: fallback,
            partial: false,
            complete: true,
            isFallback: true
          });
        }
        
        resolve(fallback);
      }
    });
  }

  async tryOllamaService(userMessage, socket) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: userMessage,
          stream: true,
          options: {
            temperature: 0.7,
            top_p: 0.9
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
              return fullResponse;
            }
            
          } catch (e) {
            console.warn('⚠️ JSON parse error:', e.message);
          }
        }
      }

      return fullResponse;
      
    } catch (error) {
      console.log('🔌 Ollama service unavailable, using local responses');
      return null;
    }
  }

  generateLocalResponse(userMessage) {
    const message = userMessage.toLowerCase();
    
    // Emergency keywords
    const emergencyWords = ['طارئ', 'طارئة', 'اسعاف', 'نزيف', 'قلب', 'تنفس', 'فقدان', 'إغماء', 'حروق', 'حادث'];
    if (emergencyWords.some(word => message.includes(word))) {
      return this.getRandomResponse('emergency');
    }
    
    // Hospital keywords
    const hospitalWords = ['مستشفى', 'مستوصف', 'عيادة', 'دكتور', 'طبيب', 'جراحة', 'عمليه', 'عملية'];
    if (hospitalWords.some(word => message.includes(word))) {
      return this.getRandomResponse('hospitals');
    }
    
    // Symptom keywords
    const symptomWords = ['ألم', 'صداع', 'حمى', 'سخونة', 'برد', 'سعال', 'كحة', 'غثيان', 'تقيؤ', 'إسهال', 'إمساك'];
    if (symptomWords.some(word => message.includes(word))) {
      return this.getRandomResponse('symptoms');
    }
    
    // General response
    return this.getRandomResponse('general');
  }

  getRandomResponse(type) {
    const responses = MEDICAL_RESPONSES[type] || MEDICAL_RESPONSES.fallback;
    return responses[Math.floor(Math.random() * responses.length)];
  }

  getFallbackResponse() {
    return this.getRandomResponse('fallback');
  }

  simulateStreaming(response, socket) {
    // Simulate typing effect
    let displayedText = '';
    const words = response.split(' ');
    let index = 0;
    
    const interval = setInterval(() => {
      if (index < words.length) {
        displayedText += words[index] + ' ';
        socket.emit('streaming_response', {
          text: displayedText,
          partial: true
        });
        index++;
      } else {
        clearInterval(interval);
        socket.emit('streaming_response', {
          text: response,
          partial: false,
          complete: true,
          isLocal: true
        });
      }
    }, 100);
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
        return {
          healthy: true,
          message: 'Ollama service is connected'
        };
      }
      return {
        healthy: false,
        message: 'Ollama service responded with error'
      };
    } catch (error) {
      return {
        healthy: false,
        message: 'Ollama service unavailable - using local medical responses'
      };
    }
  }
}

const medicalService = new MedicalResponseService();

// ==================== SERVER STATE MANAGEMENT ====================

const activeConnections = new Map();
const blockedIPs = new Map();
const blockedUsers = new Map();
const chatHistory = [];
const MAX_HISTORY_SIZE = 500;

function addToHistory(socketId, type, content) {
  const entry = {
    id: `${socketId}-${Date.now()}`,
    socketId,
    type,
    content,
    timestamp: new Date().toISOString(),
    timestampReadable: new Date().toLocaleString()
  };
  
  chatHistory.push(entry);
  
  if (chatHistory.length > MAX_HISTORY_SIZE) {
    chatHistory.shift();
  }
  
  return entry;
}

// ==================== ROUTES ====================

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: 'OK',
      service: 'Tunisian Medical Chatbot',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: activeConnections.size,
      ollama: ollamaHealth,
      environment: process.env.NODE_ENV || 'development',
      features: {
        chat: true,
        admin: true,
        streaming: true,
        localResponses: true
      }
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

// Simple health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Medical Chatbot',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    connections: activeConnections.size
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: '🚀 Medical chatbot server is running!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Serve chat interface
app.get('/chat', (req, res) => {
  const chatPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(chatPath)) {
    res.sendFile(chatPath);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Medical Chatbot</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; }
          .chat-container { height: 400px; overflow-y: auto; border: 1px solid #ddd; padding: 20px; margin: 20px 0; }
          .message { margin: 10px 0; padding: 10px; border-radius: 5px; }
          .user { background: #007bff; color: white; text-align: right; }
          .bot { background: #f8f9fa; border: 1px solid #dee2e6; }
          input { width: 100%; padding: 10px; margin: 10px 0; }
          button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🏥 المساعد الطبي التونسي</h1>
          <div class="chat-container" id="chat"></div>
          <input type="text" id="messageInput" placeholder="اكتب سؤالك الطبي هنا...">
          <button onclick="sendMessage()">إرسال</button>
        </div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('connect', () => console.log('Connected'));
          socket.on('chat_message', (data) => addMessage(data.text, false));
          socket.on('streaming_response', (data) => {
            if (data.partial) {
              updateMessage(data.text, false);
            } else {
              updateMessage(data.text, false);
            }
          });
          
          function addMessage(text, isUser) {
            const chat = document.getElementById('chat');
            const msg = document.createElement('div');
            msg.className = 'message ' + (isUser ? 'user' : 'bot');
            msg.textContent = text;
            chat.appendChild(msg);
            chat.scrollTop = chat.scrollHeight;
          }
          
          function updateMessage(text, isUser) {
            const chat = document.getElementById('chat');
            const lastMsg = chat.lastChild;
            if (lastMsg && !lastMsg.classList.contains('user')) {
              lastMsg.textContent = text;
            } else {
              addMessage(text, isUser);
            }
            chat.scrollTop = chat.scrollHeight;
          }
          
          function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            if (message) {
              addMessage(message, true);
              socket.emit('send_message', { message });
              input.value = '';
            }
          }
          
          document.getElementById('messageInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
          });
        </script>
      </body>
      </html>
    `);
  }
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root route
app.get('/', (req, res) => {
  res.redirect('/chat');
});

// ==================== SOCKET.IO HANDLING ====================

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  
  const userInfo = {
    connectedAt: new Date(),
    ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']
  };
  
  activeConnections.set(socket.id, userInfo);
  addToHistory(socket.id, 'user_connected', `User connected`);

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

    try {
      console.log(`📝 Processing message from ${socket.id}`);
      
      // Add user message to chat
      socket.emit('chat_message', {
        text: data.message,
        isUser: true,
        timestamp: new Date().toISOString()
      });
      
      addToHistory(socket.id, 'user_message', data.message.trim());
      
      // Get response
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
    addToHistory(socket.id, 'user_disconnected', `User disconnected`);
  });

  // Admin authentication
  if (socket.handshake.auth && socket.handshake.auth.secret === ADMIN_SECRET) {
    console.log('🔓 Admin connected:', socket.id);
    
    userInfo.isAdmin = true;
    activeConnections.set(socket.id, userInfo);

    socket.emit('admin_welcome', { 
      message: '🔓 أنت متصل كمسؤول',
      users: Array.from(activeConnections.entries()).map(([id, info]) => ({
        socketId: id,
        ...info,
        connectionTime: Math.floor((new Date() - info.connectedAt) / 1000) + 's'
      })),
      stats: {
        totalConnections: activeConnections.size,
        chatHistorySize: chatHistory.length,
        serverUptime: process.uptime(),
        timestamp: new Date().toISOString()
      }
    });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'عذرًا، المسار غير موجود.',
    availableEndpoints: ['/', '/chat', '/admin', '/health', '/api/health', '/api/test']
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('🔥 Server error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: 'عذرًا، حدث خطأ في الخادم.'
  });
});

// ==================== SERVER STARTUP ====================

const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🏥 Tunisian Medical Chatbot Server
📍 Port: ${PORT}
🌐 Environment: ${process.env.NODE_ENV || 'development'}
🔗 Ollama: ${OLLAMA_BASE_URL}
🤖 Model: ${OLLAMA_MODEL}

✅ Server is running!
✅ Health check: /health
✅ Chat interface: /chat  
✅ Admin panel: /admin

✨ Ready to serve medical consultations!
  `);
});

module.exports = app;
