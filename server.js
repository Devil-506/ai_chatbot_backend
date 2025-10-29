const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const io = socketIo(server, {
  cors: {
    origin: [
      "https://ai-chatbot-frontend-1vx1.onrender.com",
      "http://localhost:3000", 
      "http://localhost:5173",
      "https://localhost:3000"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Security middleware
app.use(cors({
  origin: [
    "https://ai-chatbot-frontend-1vx1.onrender.com",
    "http://localhost:3000", 
    "http://localhost:5173",
    "https://localhost:3000"
  ],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many requests, please try again later.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Store connected clients with metadata
const clients = new Map();

// Ollama Cloud API configuration
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'https://api.ollama.ai';
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-v3.1:671b-cloud';

// Enhanced Medical context for Tunisian patients
const MEDICAL_CONTEXT = `أنت مساعد طبي ذكي مصمم خصيصًا للمرضى التونسيين. دورك هو:

1. تقديم معلومات طبية عامة وتحليل الأعراض
2. تقديم نصائح صحية ومعلومات عن الرعاية الوقائية
3. المساعدة في فهم الحالات الطبية والعلاجات
4. توجيه المرضى إلى الموارد الصحية المناسبة في تونس

تنويهات مهمة:
- أنت لست بديلاً عن الاستشارة الطبية المهنية
- استشر دائمًا المتخصصين في الرعاية الصحية للحالات الخطيرة
- للطوارئ، اتصل بخدمات الطوارئ التونسية (190)
- تقدم معلومات فقط، وليس تشخيصات

معلومات خاصة بتونس:
- نظام الرعاية الصحية: القطاعان العام والخاص
- الطوارئ: 190
- اللغات الشائعة: العربية، الفرنسية، الإنجليزية
- المستشفيات الرئيسية: شارل نيكول، الرابطة، المنجي سليم

عند الرد:
- استخدم دائماً مسافات مناسبة بين الكلمات
- استخدم اللهجة التونسية العربية
- كن متعاطفاً وواضحاً
- استخدم لغة بسيطة
- ركز على سلامة المريض
- كن مفيداً وداعماً
- حافظ على إيجاز الردود
- حافظ على السرية
- لا تطلب أبداً بيانات شخصية
- لا تقدم وصفات طبية أو علاجات محددة
- استخدم سياق الرعاية الصحية المحلي
- ضع في الاعتبار السياق الثقافي التونسي
- اقترح الموارد المحلية عند الاقتضاء
- شدد دائماً على استشارة الأطباء الحقيقيين

الآن، ارد على استفسار المريض باللهجة التونسية العربية الطبيعية:`;

class MedicalOllamaService {
  constructor() {
    this.activeRequests = new Map();
  }

  async generateResponse(userMessage, socket, requestId) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log('🩺 Medical query from patient:', userMessage);
        
        const medicalPrompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";
        
        // Create abort controller with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.log(`⏰ Request timeout for ${requestId}`);
          controller.abort();
        }, 45000); // 45 second timeout
        
        // Store the controller for potential cancellation
        if (socket && requestId) {
          this.activeRequests.set(requestId, controller);
        }

        const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OLLAMA_API_KEY}`,
            'User-Agent': 'Tunisian-Medical-Chatbot/1.0'
          },
          body: JSON.stringify({
            model: MODEL_NAME,
            messages: [
              {
                role: "user",
                content: medicalPrompt
              }
            ],
            stream: true,
            temperature: 0.7,
            max_tokens: 1200,
            top_p: 0.9,
            frequency_penalty: 0.1,
            presence_penalty: 0.1
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          const errorMsg = `Ollama API error: ${response.status} - ${errorText}`;
          console.error('❌', errorMsg);
          throw new Error(errorMsg);
        }

        if (!response.body) {
          throw new Error('No response body from Ollama API');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let fullResponse = '';
        let buffer = '';
        let isCompleted = false;

        const processStream = async () => {
          try {
            while (!isCompleted) {
              const { done, value } = await reader.read();
              
              if (done) {
                isCompleted = true;
                // Process any remaining buffer
                if (buffer.trim()) {
                  try {
                    const data = JSON.parse(buffer);
                    if (data.choices?.[0]?.delta?.content) {
                      fullResponse += data.choices[0].delta.content;
                    }
                  } catch (e) {
                    // Ignore parse errors in final buffer
                  }
                }
                
                // Send final complete response
                if (socket && !socket.disconnected) {
                  const finalText = this.cleanTextSpacing(fullResponse);
                  socket.emit('streaming_response', {
                    text: finalText,
                    partial: false,
                    complete: true,
                    requestId: requestId
                  });
                }
                break;
              }
              
              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;
              
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              
              for (const line of lines) {
                if (line.trim() === '') continue;
                
                if (line.startsWith('data: ')) {
                  const dataStr = line.slice(6);
                  
                  if (dataStr === '[DONE]') {
                    isCompleted = true;
                    if (socket && !socket.disconnected) {
                      socket.emit('streaming_response', {
                        text: this.cleanTextSpacing(fullResponse),
                        partial: false,
                        complete: true,
                        requestId: requestId
                      });
                    }
                    break;
                  }
                  
                  try {
                    const data = JSON.parse(dataStr);
                    
                    // Handle content chunks
                    if (data.choices?.[0]?.delta?.content) {
                      const content = data.choices[0].delta.content;
                      const cleanedChunk = this.cleanTextSpacing(content);
                      fullResponse += cleanedChunk;
                      
                      // Send streaming update
                      if (socket && !socket.disconnected) {
                        socket.emit('streaming_response', {
                          text: this.cleanTextSpacing(fullResponse),
                          partial: true,
                          requestId: requestId
                        });
                      }
                    }
                    
                    // Handle completion
                    if (data.choices?.[0]?.finish_reason) {
                      isCompleted = true;
                      if (socket && !socket.disconnected) {
                        socket.emit('streaming_response', {
                          text: this.cleanTextSpacing(fullResponse),
                          partial: false,
                          complete: true,
                          requestId: requestId
                        });
                      }
                      break;
                    }
                    
                  } catch (parseError) {
                    console.warn('⚠️ Parse warning for line:', line.substring(0, 100));
                    // Continue processing other lines
                  }
                }
              }
              
              // Small delay to prevent overwhelming the client
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          } catch (streamError) {
            if (streamError.name !== 'AbortError') {
              console.error('🔴 Stream processing error:', streamError);
              throw streamError;
            }
          } finally {
            reader.releaseLock();
            // Clean up active request
            if (requestId) {
              this.activeRequests.delete(requestId);
            }
          }
        };

        await processStream();
        resolve(fullResponse);
        
      } catch (error) {
        console.error('🔴 Error in generateResponse:', error);
        
        // Clean up active request
        if (requestId) {
          this.activeRequests.delete(requestId);
        }
        
        // Send appropriate error message to frontend
        if (socket && !socket.disconnected) {
          let errorMessage = 'عذرًا، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.';
          
          if (error.name === 'AbortError') {
            errorMessage = '⏰ تجاوزت الاستجابة الوقت المحدد. يرجى إعادة المحاولة.';
          } else if (error.message.includes('401') || error.message.includes('403')) {
            errorMessage = '🔑 خطأ في المصادقة. يرجى التحقق من إعدادات الخادم.';
          } else if (error.message.includes('429')) {
            errorMessage = '🔄 تجاوز الحد المسموح للطلبات. يرجى الانتظار قليلاً.';
          } else if (error.message.includes('500') || error.message.includes('502')) {
            errorMessage = '🔧 الخدمة غير متاحة حاليًا. جاري الصيانة.';
          }
          
          socket.emit('streaming_response', {
            text: errorMessage,
            partial: false,
            complete: true,
            error: true,
            requestId: requestId
          });
        }
        
        reject(error);
      }
    });
  }

  cancelRequest(requestId) {
    const controller = this.activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(requestId);
      console.log(`🗑️ Cancelled request: ${requestId}`);
      return true;
    }
    return false;
  }

  cleanTextSpacing(text) {
    if (!text || typeof text !== 'string') return '';
    
    return text
      .replace(/\s+/g, ' ')
      .replace(/([.,!?;:])([^\s])/g, '$1 $2')
      .replace(/([^\s])([.,!?;:])/g, '$1$2 ')
      .replace(/\s+$/g, '')
      .replace(/^\s+/g, '')
      .trim();
  }

  getActiveRequestsCount() {
    return this.activeRequests.size;
  }
}

// Initialize service
const medicalService = new MedicalOllamaService();

// Enhanced health check endpoint
app.get('/api/health', (req, res) => {
  const health = {
    status: 'OK',
    message: 'Medical Chatbot Backend is running optimally',
    service: 'Tunisian Patient Assistant',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeRequests: medicalService.getActiveRequestsCount(),
    environment: process.env.NODE_ENV || 'development'
  };
  
  res.json(health);
});

// Enhanced Ollama API test endpoint
app.get('/api/test-ollama', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const testResponse = await fetch(`${OLLAMA_BASE_URL}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${OLLAMA_API_KEY}`,
        'User-Agent': 'Tunisian-Medical-Chatbot/1.0'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!testResponse.ok) {
      throw new Error(`API returned ${testResponse.status}: ${await testResponse.text()}`);
    }
    
    const modelsData = await testResponse.json();
    
    res.json({
      success: true,
      message: 'Ollama Cloud API is working perfectly',
      models: modelsData.data || modelsData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({
      success: false,
      message: 'Ollama Cloud API connection failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced HTTP chat endpoint with rate limiting
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Valid message is required' 
      });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Message too long. Maximum 1000 characters allowed.'
      });
    }
    
    console.log('💬 HTTP Chat request:', message.substring(0, 100) + '...');
    
    const response = await medicalService.generateResponse(message.trim(), null, `http-${Date.now()}`);
    
    res.json({
      success: true,
      response: response,
      timestamp: new Date().toISOString(),
      model: MODEL_NAME
    });
    
  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Statistics endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    connectedClients: clients.size,
    activeRequests: medicalService.getActiveRequestsCount(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Enhanced Socket.io with connection monitoring
io.on('connection', (socket) => {
  const clientInfo = {
    id: socket.id,
    connectedAt: new Date(),
    userAgent: socket.handshake.headers['user-agent'],
    ip: socket.handshake.address
  };
  
  clients.set(socket.id, clientInfo);
  
  console.log('🟢 User connected:', socket.id, clientInfo.ip);
  
  // Send immediate connection confirmation
  socket.emit('connected', { 
    message: 'Connected to Tunisian Medical Assistant',
    timestamp: new Date().toISOString(),
    requestId: null
  });

  socket.on('send_message', async (data) => {
    const requestId = `socket-${socket.id}-${Date.now()}`;
    
    try {
      if (!data.message || typeof data.message !== 'string' || data.message.trim().length === 0) {
        socket.emit('error', {
          message: 'الرجاء إدخال رسالة صحيحة.',
          requestId: requestId
        });
        return;
      }

      if (data.message.length > 1000) {
        socket.emit('error', {
          message: 'الرسالة طويلة جداً. الحد الأقصى 1000 حرف.',
          requestId: requestId
        });
        return;
      }

      console.log('💬 Message from', socket.id, ':', data.message.substring(0, 100) + '...');
      
      // Send initial acknowledgment
      socket.emit('streaming_response', {
        text: '',
        partial: true,
        requestId: requestId
      });

      await medicalService.generateResponse(data.message.trim(), socket, requestId);
      
    } catch (error) {
      console.error('🔴 Message processing error for', socket.id, ':', error.message);
      
      if (!socket.disconnected) {
        socket.emit('error', { 
          message: 'عذرًا، حدث خطأ في معالجة رسالتك. يرجى المحاولة مرة أخرى.',
          requestId: requestId,
          code: error.name
        });
      }
    }
  });

  socket.on('cancel_message', (data) => {
    const requestId = data.requestId;
    if (requestId) {
      const cancelled = medicalService.cancelRequest(requestId);
      if (cancelled) {
        socket.emit('message_cancelled', { requestId });
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('🔴 User disconnected:', socket.id, 'Reason:', reason);
    
    // Cancel any active requests for this socket
    for (const [requestId, controller] of medicalService.activeRequests) {
      if (requestId.startsWith(`socket-${socket.id}-`)) {
        medicalService.cancelRequest(requestId);
      }
    }
    
    clients.delete(socket.id);
  });

  // Ping-pong for connection health
  socket.on('ping', (data) => {
    socket.emit('pong', { 
      timestamp: new Date().toISOString(),
      ...data 
    });
  });
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('🔥 Uncaught Exception:', error);
  // Don't exit in production, log and continue
  if (process.env.NODE_ENV === 'production') {
    // Could send to monitoring service here
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, starting graceful shutdown');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, starting graceful shutdown');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🏥  TUNISIAN MEDICAL CHATBOT SERVER');
  console.log('='.repeat(60));
  console.log(`📍  Port: ${PORT}`);
  console.log(`🌐  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🤖  Model: ${MODEL_NAME}`);
  console.log(`☁️   API: ${OLLAMA_BASE_URL}`);
  console.log(`⏰  Timeout: 45 seconds`);
  console.log(`🔒  Rate Limit: 10 requests/minute`);
  console.log('='.repeat(60));
  console.log(`✅  Server running: http://localhost:${PORT}`);
  console.log(`🔍  Health check: http://localhost:${PORT}/api/health`);
  console.log(`🧪  API test: http://localhost:${PORT}/api/test-ollama`);
  console.log(`📊  Stats: http://localhost:${PORT}/api/stats`);
  console.log('='.repeat(60) + '\n');
});

module.exports = { app, server, medicalService };
