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

// ==================== RENDER FIXES ====================

// Security: Helmet with Render-compatible CSP
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Render compatibility
  crossOriginEmbedderPolicy: false
}));

// Security: CORS for Render
const allowedOrigins = [
  "https://ai-chatbot-frontend-1vx1.onrender.com",
  "http://localhost:3000", 
  "http://localhost:5173"
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `CORS policy: Origin ${origin} not allowed`;
      console.warn('🚫 CORS violation attempt from:', origin);
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

// Security: Rate limiting (Render-compatible)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // Increased for Render
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Increased for Render
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use(generalLimiter);
app.use('/api/admin/', authLimiter);

// Security: Body parsing with reasonable limit for Render
app.use(express.json({ limit: '50kb' })); // Increased for medical queries

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Configuration with Render defaults
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'render-default-secret-2024';

console.log('🔧 Configuration loaded for Render');
console.log('🔗 Ollama URL:', OLLAMA_BASE_URL);
console.log('🤖 Model:', OLLAMA_MODEL);

// Security: Socket.IO configuration for Render
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'] // Added for Render compatibility
});

// Store blocked IPs and users
const blockedIPs = new Map();
const blockedUsers = new Map();

// Security: Rate limiting for socket messages
const socketRateLimits = new Map();
const SOCKET_RATE_LIMIT = {
  windowMs: 60000,
  maxMessages: 15, // Increased for Render
  maxConnections: 5 // Increased for Render
};

const checkSocketRateLimit = (socket) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  
  if (!socketRateLimits.has(ip)) {
    socketRateLimits.set(ip, {
      messageCount: 0,
      connectionCount: 1,
      lastReset: now,
      sockets: new Set([socket.id])
    });
    return true;
  }

  const limit = socketRateLimits.get(ip);
  
  // Reset counter if window has passed
  if (now - limit.lastReset > SOCKET_RATE_LIMIT.windowMs) {
    limit.messageCount = 0;
    limit.lastReset = now;
  }
  
  // Track socket connections
  if (!limit.sockets.has(socket.id)) {
    limit.sockets.add(socket.id);
    limit.connectionCount++;
  }

  // Check connection limit
  if (limit.connectionCount > SOCKET_RATE_LIMIT.maxConnections) {
    console.warn(`🚫 IP ${ip} exceeded connection limit`);
    return false;
  }
  
  // Check message limit
  if (limit.messageCount >= SOCKET_RATE_LIMIT.maxMessages) {
    console.warn(`🚫 IP ${ip} exceeded message rate limit`);
    return false;
  }
  
  limit.messageCount++;
  return true;
};

// ==================== ORIGINAL MEDICAL CONTEXT ====================

const MEDICAL_CONTEXT = `أنت مساعد طبي مخصص للمرضى التونسيين. دورك هو:

1. تقديم معلومات طبية عامة وتحليل أولي للأعراض
2. تقديم نصائح صحية ومعلومات وقائية
3. مساعدة المرضى على فهم الحالات الطبية
4. توجيه المرضى للموارد الصحية في تونس

**تحذيرات مهمة:**
- أنت لست بديلاً عن الطبيب
- استشر المتخصصين للحالات الخطيرة
-للطوارئ اتصل على 190
- تقدم معلومات فقط و تشخيصات

**معلومات عن تونس:**
- نظام الصحة: عمومي وخاص
- رقم الطوارئ: 190
- مستشفيات رئيسية: شارل نيكول، الرابطة، المنجي سليم

**عند الرد:**
- استخدم اللغة المستعملة عند السؤال 
- كن واضحًا ومتعاطفًا
- ركز على سلامة المريض
- لا تطلب معلومات شخصية
- لا تعطي وصفات طبية
- شجع على استشارة الطبيب
- استخدم لغة بسيطة
- استعمل اللغة الفرنسية كاللغة الافتراضية 

الآن جاوب على سؤال المريض:`;

class RemoteOllamaService {
  async generateResponse(userMessage, socket) {
    return new Promise(async (resolve, reject) => {
      try {
        console.log('💬 Medical query received:', userMessage.substring(0, 100));
        
        const medicalPrompt = MEDICAL_CONTEXT + "\n\nالمريض: " + userMessage + "\n\nالمساعد:";
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000); // Increased timeout for Render

        console.log('🔗 Calling Ollama API...');
        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
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
          }),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
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
                console.log('✅ Response completed, length:', fullResponse.length);
                resolve(fullResponse);
                return;
              }
              
            } catch (e) {
              console.warn('⚠️ JSON parse error:', e.message, 'Line:', line);
            }
          }
        }

        resolve(fullResponse);
        
      } catch (error) {
        console.error('❌ Ollama service error:', error);
        
        const fallbackResponse = "عذرًا، الخدمة الطبية غير متاحة حاليًا. يرجى المحاولة لاحقًا أو الاتصال بطبيبك مباشرة. للطوارئ اتصل على 190.";
        
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
      const timeout = setTimeout(() => controller.abort(), 15000); // Increased for Render
      
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

// Store chat history for admin monitoring
const chatHistory = [];
const MAX_HISTORY_SIZE = 500; // Reduced for Render

// Security logging
const securityLogger = {
  logAbuseAttempt(socket, type, details) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ip: socket.handshake.address,
      socketId: socket.id,
      type,
      details
    };
    
    console.warn('🚨 Security alert:', logEntry);
    addToHistory(socket.id, 'security_alert', `${type}: ${JSON.stringify(details)}`);
  }
};

// Admin Controls (simplified for Render)
const adminControls = {
  getConnectedUsers() {
    const users = Array.from(activeConnections.entries()).map(([id, info]) => ({
      socketId: id,
      ...info,
      connectionTime: Math.floor((new Date() - info.connectedAt) / 1000) + 's',
      isBlocked: blockedIPs.has(info.ip) || blockedUsers.has(id)
    }));
    return users;
  },

  kickUser(socketId, adminSocket) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit('chat_message', {
        text: "🚫 تم فصل اتصالك من قبل المسؤول.",
        isUser: false,
        timestamp: new Date().toISOString(),
        type: 'admin_action'
      });
      
      setTimeout(() => {
        targetSocket.disconnect(true);
        activeConnections.delete(socketId);
      }, 1000);
      
      addToHistory(socketId, 'admin_action', `User kicked by admin`);
      return true;
    }
    return false;
  },

  blockUser(socketId, adminSocket, reason = "Blocked by admin") {
    const targetSocket = io.sockets.sockets.get(socketId);
    let userInfo = null;
    
    if (targetSocket) {
      userInfo = activeConnections.get(socketId);
    }
    
    blockedUsers.set(socketId, {
      timestamp: new Date().toISOString(),
      reason: reason
    });
    
    if (targetSocket && userInfo) {
      blockedIPs.set(userInfo.ip, {
        timestamp: new Date().toISOString(),
        reason: reason,
        socketId: socketId
      });
      
      targetSocket.emit('chat_message', {
        text: "⛔ تم حظر اتصالك من قبل المسؤول.",
        isUser: false,
        timestamp: new Date().toISOString(),
        type: 'admin_action'
      });
      
      setTimeout(() => {
        targetSocket.disconnect(true);
        activeConnections.delete(socketId);
      }, 1000);
    }
    
    return true;
  },

  unblockUser(socketIdOrIP, adminSocket) {
    let unblocked = false;
    
    if (blockedUsers.has(socketIdOrIP)) {
      blockedUsers.delete(socketIdOrIP);
      unblocked = true;
    }
    
    if (blockedIPs.has(socketIdOrIP)) {
      blockedIPs.delete(socketIdOrIP);
      unblocked = true;
    }
    
    return unblocked;
  },

  getBlockedList() {
    return {
      ips: Array.from(blockedIPs.entries()).map(([ip, info]) => ({ ip, ...info })),
      users: Array.from(blockedUsers.entries()).map(([socketId, info]) => ({ socketId, ...info }))
    };
  },

  broadcastToAll(message, adminSocket) {
    const adminMessage = {
      text: `📢 إشعار من المسؤول: ${message}`,
      isUser: false,
      timestamp: new Date().toISOString(),
      type: 'admin_broadcast'
    };
    
    let recipients = 0;
    activeConnections.forEach((info, socketId) => {
      const userSocket = io.sockets.sockets.get(socketId);
      if (userSocket && userSocket.connected) {
        userSocket.emit('chat_message', adminMessage);
        recipients++;
      }
    });
    
    addToHistory('admin', 'broadcast', `Admin broadcast: ${message}`);
    return recipients;
  },

  getServerStats() {
    return {
      totalConnections: activeConnections.size,
      chatHistorySize: chatHistory.length,
      blockedIPs: blockedIPs.size,
      blockedUsers: blockedUsers.size,
      serverUptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  },

  isUserBlocked(socket) {
    const ip = socket.handshake.address;
    return blockedIPs.has(ip) || blockedUsers.has(socket.id);
  }
};

// Function to add message to history
function addToHistory(socketId, type, content, timestamp = new Date()) {
  const entry = {
    id: `${socketId}-${Date.now()}`,
    socketId,
    type,
    content,
    timestamp: timestamp.toISOString()
  };
  
  chatHistory.push(entry);
  
  if (chatHistory.length > MAX_HISTORY_SIZE) {
    chatHistory.shift(); // Remove oldest entry
  }
  
  return entry;
}

// ==================== ROUTES ====================

// Health check endpoint (essential for Render)
app.get('/api/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: 'OK',
      service: 'Tunisian Medical Chatbot - Render',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: activeConnections.size,
      ollama: ollamaHealth,
      environment: process.env.NODE_ENV || 'development'
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

// Render-compatible admin endpoints
app.get('/api/admin/blocked-list', (req, res) => {
  const blockedList = adminControls.getBlockedList();
  res.json(blockedList);
});

app.post('/api/admin/block-user', (req, res) => {
  const { socketId, reason } = req.body;
  
  if (!socketId) {
    return res.status(400).json({ error: 'Socket ID is required' });
  }
  
  const success = adminControls.blockUser(socketId, null, reason || "Manual block by admin");
  
  res.json({
    success: success,
    message: success ? `User ${socketId} blocked` : `Failed to block user`
  });
});

app.post('/api/admin/unblock', (req, res) => {
  const { target } = req.body;
  
  if (!target) {
    return res.status(400).json({ error: 'Target is required' });
  }
  
  const success = adminControls.unblockUser(target, null);
  
  res.json({
    success: success,
    message: success ? `${target} unblocked` : `Target not found`
  });
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: '🚀 Medical chatbot server is running on Render!',
    timestamp: new Date().toISOString(),
    version: '2.0.0-render'
  });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: '🏥 Tunisian Medical Chatbot Server',
    status: 'Running on Render',
    endpoints: {
      health: '/api/health',
      admin: '/admin',
      test: '/api/test'
    }
  });
});

// ==================== SOCKET.IO FOR RENDER ====================

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  
  // Security: Rate limiting check
  if (!checkSocketRateLimit(socket)) {
    socket.emit('error', { 
      message: 'Rate limit exceeded. Please try again later.' 
    });
    socket.disconnect();
    return;
  }
  
  // Check if user is blocked
  if (adminControls.isUserBlocked(socket)) {
    socket.emit('chat_message', {
      text: "⛔ تم حظر اتصالك من قبل المسؤول.",
      isUser: false,
      timestamp: new Date().toISOString(),
      type: 'blocked'
    });
    
    setTimeout(() => {
      socket.disconnect(true);
    }, 2000);
    return;
  }
  
  const userInfo = {
    connectedAt: new Date(),
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent'],
    isAdmin: false
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
    // Security: Check message rate limit
    if (!checkSocketRateLimit(socket)) {
      socket.emit('error', { 
        message: 'Message rate limit exceeded. Please slow down.' 
      });
      return;
    }
    
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
      
      addToHistory(socket.id, 'user_message', data.message.trim());
      
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

  // Admin system
  if (socket.handshake.auth && socket.handshake.auth.secret === ADMIN_SECRET) {
    console.log('🔓 Admin connected:', socket.id);
    
    userInfo.isAdmin = true;
    activeConnections.set(socket.id, userInfo);

    socket.emit('admin_welcome', { 
      message: '🔓 أنت متصل كمسؤول',
      users: adminControls.getConnectedUsers(),
      stats: adminControls.getServerStats(),
      socketId: socket.id
    });

    // Admin event handlers
    socket.on('admin_kick_user', (data) => {
      const success = adminControls.kickUser(data.socketId, socket);
      socket.emit('admin_action_result', {
        action: 'kick_user',
        success: success,
        message: success ? `تم فصل المستخدم` : `لم يتم العثور على المستخدم`
      });
    });

    socket.on('admin_block_user', (data) => {
      const success = adminControls.blockUser(data.socketId, socket, data.reason);
      socket.emit('admin_action_result', {
        action: 'block_user',
        success: success,
        message: success ? `تم حظر المستخدم` : `فشل في الحظر`
      });
    });

    socket.on('admin_get_stats', () => {
      socket.emit('admin_stats', adminControls.getServerStats());
    });

    // Send periodic updates to admin
    const adminUpdateInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('admin_users_update', {
          users: adminControls.getConnectedUsers(),
          stats: adminControls.getServerStats()
        });
      }
    }, 5000);

    socket.on('disconnect', () => {
      clearInterval(adminUpdateInterval);
      console.log('🔒 Admin disconnected:', socket.id);
    });
  }
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

// Render-specific port configuration
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Tunisian Medical Chatbot - RENDER EDITION
📍 Port: ${PORT}
🌐 Environment: ${process.env.NODE_ENV || 'development'}
🔗 Ollama: ${OLLAMA_BASE_URL}
🤖 Model: ${OLLAMA_MODEL}

✅ Server is running on Render!
✅ Health check: /api/health
✅ Admin panel: /admin
✅ Socket.IO: Enabled

✨ Ready for medical consultations!
  `);
});

// Clean up rate limit records
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of socketRateLimits.entries()) {
    if (now - limit.lastReset > SOCKET_RATE_LIMIT.windowMs * 2) {
      socketRateLimits.delete(ip);
    }
  }
}, SOCKET_RATE_LIMIT.windowMs * 2);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔻 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('🔻 Process terminated');
    process.exit(0);
  });
});

module.exports = app;

