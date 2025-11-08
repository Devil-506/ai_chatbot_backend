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

// ==================== ENHANCED SECURITY & RENDER COMPATIBILITY ====================

// Security: Helmet with Render-compatible CSP
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Security: Enhanced CORS for Render
const allowedOrigins = [
  "https://ai-chatbot-frontend-1vx1.onrender.com",
  "http://localhost:3000", 
  "http://localhost:5173",
  "https://ai-chatbot-backend-1vx1.onrender.com" // Add your backend URL
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
  max: 200,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use('/api/', generalLimiter);
app.use('/api/admin/', authLimiter);

// Security: Body parsing with reasonable limit for Render
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO configuration for Render with enhanced security
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';

// Admin Configuration
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'iamtheserver2024';

console.log('🔧 Enhanced Configuration loaded for Render');
console.log('🔗 Ollama URL:', OLLAMA_BASE_URL);
console.log('🤖 Model:', OLLAMA_MODEL);

// Store blocked IPs and users persistently
const blockedIPs = new Map();
const blockedUsers = new Map();

// Security: Rate limiting for socket messages
const socketRateLimits = new Map();
const SOCKET_RATE_LIMIT = {
  windowMs: 60000,
  maxMessages: 30,
  maxConnections: 10
};

const checkSocketRateLimit = (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
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

// Enhanced Medical Context
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
        
        // Test connection first
        const isOllamaAvailable = await this.testOllamaConnection();
        
        if (!isOllamaAvailable) {
          throw new Error('Ollama service unavailable');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

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
        
        // Enhanced fallback responses based on error type
        let fallbackResponse = this.getFallbackResponse(error, userMessage);
        
        if (socket && socket.connected) {
          socket.emit('streaming_response', {
            text: fallbackResponse,
            partial: false,
            complete: true,
            isFallback: true
          });
        }
        
        resolve(fallbackResponse);
      }
    });
  }

  async testOllamaConnection() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      return response.ok;
    } catch (error) {
      console.error('🔌 Ollama connection test failed:', error.message);
      return false;
    }
  }

  getFallbackResponse(error, userMessage) {
    const fallbacks = [
      "عذرًا، الخدمة الطبية غير متاحة حاليًا. يرجى المحاولة لاحقًا أو الاتصال بطبيبك مباشرة. للطوارئ اتصل على 190.",
      
      "نظام الاستشارات الطبية غير متوفر الآن. نوصي بالاتصال بمستشفى شارل نيكول على 71 286 100 أو مستشفى الرابطة على 71 785 000 لتلقي المساعدة الفورية.",
      
      "نعتذر عن عدم تمكننا من تقديم استشارة طبية في الوقت الحالي. للرعاية العاجلة، يرجى التوجه إلى أقرب مركز صحي أو الاتصال برقم الطوارئ 190.",
      
      `بناءً على طلبك، نوصي باستشارة طبيب متخصص. يمكنك التواصل مع:
      - مستشفى شارل نيكول: 71 286 100
      - مستشفى الرابطة: 71 785 000  
      - مستشفى المنجي سليم: 71 430 000
      - رقم الطوارئ: 190`
    ];
    
    // Return a random fallback response
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  async healthCheck() {
    try {
      const isConnected = await this.testOllamaConnection();
      
      if (isConnected) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (response.ok) {
          const data = await response.json();
          return {
            healthy: true,
            models: data.models?.map(m => m.name) || [],
            message: 'Ollama is connected and responsive'
          };
        }
      }
      
      return {
        healthy: false,
        message: 'Ollama service is unavailable - using fallback mode'
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
const MAX_HISTORY_SIZE = 1000;

// ENHANCED: Complete Block Management System
const adminControls = {
  getConnectedUsers() {
    const users = Array.from(activeConnections.entries()).map(([id, info]) => ({
      socketId: id,
      ...info,
      connectionTime: Math.floor((new Date() - info.connectedAt) / 1000) + 's',
      isBlocked: blockedIPs.has(info.ip) || blockedUsers.has(id)
    }));
    console.log('👥 Admin: Current connected users:', users.length);
    return users;
  },

  kickUser(socketId, adminSocket) {
    console.log(`🚫 Admin: Attempting to kick user: ${socketId}`);
    
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      console.log(`🔍 Found target socket: ${socketId}`);
      
      // Send chat message to user before disconnecting
      targetSocket.emit('chat_message', {
        text: "🚫 تم فصل اتصالك من قبل المسؤول. إذا كنت بحاجة إلى مساعدة، يرجى الاتصال بالدعم.",
        isUser: false,
        timestamp: new Date().toISOString(),
        type: 'admin_action'
      });
      
      targetSocket.emit('streaming_response', {
        text: "🚫 تم فصل اتصالك من قبل المسؤول. إذا كنت بحاجة إلى مساعدة، يرجى الاتصال بالدعم.",
        partial: false,
        complete: true,
        type: 'admin_action'
      });
      
      // Disconnect the user
      setTimeout(() => {
        targetSocket.disconnect(true);
        activeConnections.delete(socketId);
      }, 1000);
      
      addToHistory(socketId, 'admin_action', `User ${socketId} was kicked by admin`);
      
      console.log(`🔴 Admin: SUCCESS - Kicked user: ${socketId}`);
      return true;
    }
    console.log(`❌ Admin: User not found: ${socketId}`);
    return false;
  },

  blockUser(socketId, adminSocket, reason = "Blocked by admin") {
    console.log(`⛔ Admin: Attempting to block user: ${socketId}`);
    
    const targetSocket = io.sockets.sockets.get(socketId);
    let userInfo = null;
    
    if (targetSocket) {
      userInfo = activeConnections.get(socketId);
    } else {
      // User is not currently connected, but we can still block the socket ID
      console.log(`ℹ️ User ${socketId} is not connected, but blocking socket ID anyway`);
    }
    
    // Block by socket ID with timestamp and reason
    blockedUsers.set(socketId, {
      timestamp: new Date().toISOString(),
      reason: reason,
      blockedBy: adminSocket?.id || 'admin'
    });
    
    console.log(`⛔ Blocked socket ID: ${socketId}`);
    
    // If user is connected, disconnect them
    if (targetSocket && userInfo) {
      // Also block by IP for extra protection
      blockedIPs.set(userInfo.ip, {
        timestamp: new Date().toISOString(),
        reason: reason,
        blockedBy: adminSocket?.id || 'admin',
        socketId: socketId
      });
      
      console.log(`⛔ Also blocked IP: ${userInfo.ip}`);
      
      // Send chat message to user
      targetSocket.emit('chat_message', {
        text: "⛔ تم حظر اتصالك من قبل المسؤول. لا يمكنك إعادة الاتصال.",
        isUser: false,
        timestamp: new Date().toISOString(),
        type: 'admin_action'
      });
      
      targetSocket.emit('streaming_response', {
        text: "⛔ تم حظر اتصالك من قبل المسؤول. لا يمكنك إعادة الاتصال.",
        partial: false,
        complete: true,
        type: 'admin_action'
      });
      
      // Disconnect the user
      setTimeout(() => {
        targetSocket.disconnect(true);
        activeConnections.delete(socketId);
      }, 1000);
      
      addToHistory(socketId, 'admin_action', `User ${socketId} (IP: ${userInfo.ip}) was blocked by admin: ${reason}`);
    } else {
      addToHistory(socketId, 'admin_action', `Socket ID ${socketId} was blocked by admin: ${reason}`);
    }
    
    console.log(`⛔ Admin: SUCCESS - Blocked user: ${socketId}`);
    return true;
  },

  unblockUser(socketIdOrIP, adminSocket) {
    console.log(`🔓 Admin: Attempting to unblock: ${socketIdOrIP}`);
    
    let unblocked = false;
    
    // Try to unblock by socket ID
    if (blockedUsers.has(socketIdOrIP)) {
      blockedUsers.delete(socketIdOrIP);
      console.log(`🔓 Unblocked socket ID: ${socketIdOrIP}`);
      unblocked = true;
    }
    
    // Try to unblock by IP
    if (blockedIPs.has(socketIdOrIP)) {
      blockedIPs.delete(socketIdOrIP);
      console.log(`🔓 Unblocked IP: ${socketIdOrIP}`);
      unblocked = true;
    }
    
    if (unblocked) {
      addToHistory('admin', 'admin_action', `Admin unblocked: ${socketIdOrIP}`);
      console.log(`🔓 Admin: SUCCESS - Unblocked: ${socketIdOrIP}`);
      return true;
    } else {
      console.log(`❌ Admin: Not found in blocked lists: ${socketIdOrIP}`);
      return false;
    }
  },

  getBlockedList() {
    const blockedList = {
      ips: Array.from(blockedIPs.entries()).map(([ip, info]) => ({
        ip,
        ...info
      })),
      users: Array.from(blockedUsers.entries()).map(([socketId, info]) => ({
        socketId,
        ...info
      }))
    };
    
    console.log(`📋 Admin: Blocked list requested - IPs: ${blockedList.ips.length}, Users: ${blockedList.users.length}`);
    return blockedList;
  },

  broadcastToAll(message, adminSocket) {
    console.log(`📢 Admin: Broadcasting to ${activeConnections.size} users:`, message);
    
    const adminMessage = {
      text: `📢 إشعار من المسؤول: ${message}`,
      isUser: false,
      timestamp: new Date().toISOString(),
      type: 'admin_broadcast',
      from: 'المسؤول'
    };
    
    activeConnections.forEach((info, socketId) => {
      const userSocket = io.sockets.sockets.get(socketId);
      if (userSocket && userSocket.connected) {
        userSocket.emit('chat_message', adminMessage);
        userSocket.emit('streaming_response', {
          text: adminMessage.text,
          partial: false,
          complete: true,
          type: 'admin_broadcast'
        });
        
        console.log(`📢 Sent admin message to user: ${socketId}`);
      }
    });
    
    io.emit('admin_announcement', {
      message: message,
      timestamp: new Date().toISOString(),
      from: 'System Admin'
    });
    
    addToHistory('admin', 'broadcast', `Admin broadcast: ${message}`);
    
    console.log(`📢 Admin: SUCCESS - Broadcast sent to ${activeConnections.size} users`);
    return activeConnections.size;
  },

  getServerStats() {
    const stats = {
      totalConnections: activeConnections.size,
      chatHistorySize: chatHistory.length,
      blockedIPs: blockedIPs.size,
      blockedUsers: blockedUsers.size,
      serverUptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    console.log('📊 Admin: Server stats requested');
    return stats;
  },

  // Check if user is blocked
  isUserBlocked(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return blockedIPs.has(ip) || blockedUsers.has(socket.id);
  }
};

// Function to add message to history
function addToHistory(socketId, type, content, timestamp = new Date()) {
  const entry = {
    id: `${socketId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    socketId,
    type,
    content,
    timestamp: timestamp.toISOString(),
    timestampReadable: timestamp.toLocaleString('en-US', { 
      timeZone: 'Africa/Tunis',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  };
  
  chatHistory.push(entry);
  
  if (chatHistory.length > MAX_HISTORY_SIZE) {
    chatHistory.splice(0, chatHistory.length - MAX_HISTORY_SIZE);
  }
  
  return entry;
}

// ==================== FIXED ROUTES ====================

// Debug route
app.get('/debug-static', (req, res) => {
  const publicPath = path.join(__dirname, 'public');
  let files = [];
  
  try {
    if (fs.existsSync(publicPath)) {
      files = fs.readdirSync(publicPath);
    }
  } catch (error) {
    console.error('Error reading public directory:', error);
  }
  
  res.json({
    message: 'Static files debug information',
    publicPath: publicPath,
    publicExists: fs.existsSync(publicPath),
    files: files,
    adminHtmlExists: fs.existsSync(path.join(publicPath, 'admin.html')),
    currentDir: __dirname
  });
});

// Health check endpoint - FIXED ROUTE
app.get('/api/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: ollamaHealth.healthy ? 'OK' : 'DEGRADED',
      service: 'Tunisian Medical Chatbot - Enhanced Render Edition',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: activeConnections.size,
      blocked: {
        ips: blockedIPs.size,
        users: blockedUsers.size
      },
      ollama: ollamaHealth,
      environment: process.env.NODE_ENV || 'development',
      fallbackMode: !ollamaHealth.healthy
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

// ADD THIS: Health check at root path for easier testing
app.get('/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: ollamaHealth.healthy ? 'OK' : 'DEGRADED',
      service: 'Tunisian Medical Chatbot - Health Check',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: activeConnections.size,
      ollama: ollamaHealth.healthy ? 'Connected' : 'Unavailable',
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

// Admin endpoints for block management
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
    message: success ? `User ${socketId} blocked successfully` : `Failed to block user ${socketId}`
  });
});

app.post('/api/admin/unblock', (req, res) => {
  const { target } = req.body; // Can be socket ID or IP
  
  if (!target) {
    return res.status(400).json({ error: 'Target (socket ID or IP) is required' });
  }
  
  const success = adminControls.unblockUser(target, null);
  
  res.json({
    success: success,
    message: success ? `${target} unblocked successfully` : `${target} not found in blocked list`
  });
});

// Simple admin stats endpoint
app.get('/api/admin/stats', (req, res) => {
  const stats = adminControls.getServerStats();
  res.json(stats);
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: '🚀 Medical chatbot server is running on Render!',
    timestamp: new Date().toISOString(),
    version: '2.0.0-render'
  });
});

// ADD THIS: Chat interface route
app.get('/chat', (req, res) => {
  const chatHtmlPath = path.join(__dirname, 'public', 'index.html');
  
  if (fs.existsSync(chatHtmlPath)) {
    res.sendFile(chatHtmlPath);
  } else {
    // If file doesn't exist, serve a basic chat interface
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Medical Chatbot - Chat Interface</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .chat-container { max-width: 800px; margin: 0 auto; }
          .message { padding: 10px; margin: 10px 0; border-radius: 5px; }
          .user { background: #007bff; color: white; text-align: right; }
          .bot { background: #f8f9fa; border: 1px solid #dee2e6; }
        </style>
      </head>
      <body>
        <div class="chat-container">
          <h1>🏥 المساعد الطبي التونسي</h1>
          <div id="chat"></div>
          <input type="text" id="messageInput" placeholder="اكتب رسالتك هنا..." style="width: 100%; padding: 10px; margin: 10px 0;">
          <button onclick="sendMessage()" style="padding: 10px 20px;">إرسال</button>
        </div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('connect', () => console.log('Connected'));
          socket.on('chat_message', (data) => addMessage(data.text, false));
          socket.on('streaming_response', (data) => updateMessage(data.text, false));
          
          function addMessage(text, isUser) {
            const chat = document.getElementById('chat');
            const msg = document.createElement('div');
            msg.className = 'message ' + (isUser ? 'user' : 'bot');
            msg.textContent = text;
            chat.appendChild(msg);
          }
          
          function updateMessage(text, isUser) {
            const chat = document.getElementById('chat');
            const lastMsg = chat.lastChild;
            if (lastMsg && !lastMsg.classList.contains('user')) {
              lastMsg.textContent = text;
            } else {
              addMessage(text, isUser);
            }
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

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root route - redirect to chat
app.get('/', (req, res) => {
  res.redirect('/chat');
});

// ==================== SOCKET.IO FOR RENDER ====================

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  
  // Get real IP behind proxy (Render compatibility)
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log('📡 Client IP:', clientIP);
  
  // Security: Rate limiting check
  if (!checkSocketRateLimit(socket)) {
    socket.emit('error', { 
      message: 'Rate limit exceeded. Please try again later.' 
    });
    socket.disconnect();
    return;
  }
  
  // CHECK IF USER IS BLOCKED BEFORE ALLOWING CONNECTION
  if (adminControls.isUserBlocked(socket)) {
    console.log(`⛔ Blocked user attempted to connect: ${socket.id}`);
    
    // Send block message
    socket.emit('chat_message', {
      text: "⛔ تم حظر اتصالك من قبل المسؤول. لا يمكنك استخدام الخدمة.",
      isUser: false,
      timestamp: new Date().toISOString(),
      type: 'blocked'
    });
    
    // Disconnect immediately
    setTimeout(() => {
      socket.disconnect(true);
    }, 2000);
    
    return;
  }
  
  const userInfo = {
    connectedAt: new Date(),
    ip: clientIP,
    userAgent: socket.handshake.headers['user-agent'],
    isAdmin: false
  };
  
  activeConnections.set(socket.id, userInfo);
  
  addToHistory(socket.id, 'user_connected', `User connected from ${userInfo.ip}`);

  // Send welcome message
  socket.emit('welcome', {
    message: 'أهلاً وسهلاً! أنا مساعدك الطبي التونسي. كيف يمكنني مساعدتك اليوم؟',
    id: socket.id,
    timestamp: new Date().toISOString()
  });

  // Handle admin announcements as chat messages
  socket.on('admin_announcement', (data) => {
    console.log(`📢 User ${socket.id} received admin announcement:`, data.message);
    
    socket.emit('chat_message', {
      text: `📢 إشعار من المسؤول: ${data.message}`,
      isUser: false,
      timestamp: data.timestamp,
      type: 'admin_broadcast'
    });
  });

  // Handle admin messages (warnings, kicks)
  socket.on('admin_message', (data) => {
    console.log(`⚠️ User ${socket.id} received admin message:`, data.message);
    
    socket.emit('chat_message', {
      text: `⚠️ ${data.message}`,
      isUser: false,
      timestamp: new Date().toISOString(),
      type: 'admin_action'
    });
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
      
      // Add user message to chat
      socket.emit('chat_message', {
        text: data.message,
        isUser: true,
        timestamp: new Date().toISOString()
      });
      
      addToHistory(socket.id, 'user_message', data.message.trim());
      
      // Get AI response
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
    
    addToHistory(socket.id, 'user_disconnected', `User disconnected: ${reason}`);
    
    activeConnections.delete(socket.id);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('💥 Socket error:', error);
  });

  // ==================== COMPLETE ADMIN SYSTEM ====================
  
  if (socket.handshake.auth && socket.handshake.auth.secret === ADMIN_SECRET) {
    console.log('🔓 Admin connected via WebSocket:', socket.id);
    
    userInfo.isAdmin = true;
    activeConnections.set(socket.id, userInfo);

    socket.emit('admin_welcome', { 
      message: '🔓 أنت متصل كمسؤول',
      users: adminControls.getConnectedUsers(),
      stats: adminControls.getServerStats(),
      socketId: socket.id,
      blockedCount: {
        ips: blockedIPs.size,
        users: blockedUsers.size
      }
    });

    // Admin event handlers
    socket.on('admin_kick_user', (data) => {
      console.log(`🔧 Admin kick_user event:`, data);
      const success = adminControls.kickUser(data.socketId, socket);
      socket.emit('admin_action_result', {
        action: 'kick_user',
        success: success,
        message: success ? `تم فصل المستخدم ${data.socketId}` : `لم يتم العثور على المستخدم ${data.socketId}`
      });
    });

    socket.on('admin_block_user', (data) => {
      console.log(`🔧 Admin block_user event:`, data);
      const success = adminControls.blockUser(data.socketId, socket, data.reason);
      socket.emit('admin_action_result', {
        action: 'block_user',
        success: success,
        message: success ? `تم حظر المستخدم ${data.socketId}` : `فشل في حظر المستخدم ${data.socketId}`
      });
    });

    socket.on('admin_unblock', (data) => {
      console.log(`🔧 Admin unblock event:`, data);
      const success = adminControls.unblockUser(data.target, socket);
      socket.emit('admin_action_result', {
        action: 'unblock',
        success: success,
        message: success ? `تم إلغاء حظر ${data.target}` : `لم يتم العثور على ${data.target} في القائمة المحظورة`
      });
    });

    socket.on('admin_manual_block', (data) => {
      console.log(`🔧 Admin manual_block event:`, data);
      const success = adminControls.blockUser(data.socketId, socket, data.reason || "Manual block by admin");
      socket.emit('admin_action_result', {
        action: 'manual_block',
        success: success,
        message: success ? `تم حظر السوكيت ${data.socketId} يدوياً` : `فشل في حظر السوكيت ${data.socketId}`
      });
    });

    socket.on('admin_broadcast', (data) => {
      console.log(`🔧 Admin broadcast event:`, data);
      const recipients = adminControls.broadcastToAll(data.message, socket);
      socket.emit('admin_action_result', {
        action: 'broadcast',
        success: true,
        message: `تم إرسال الإشعار إلى ${recipients} مستخدم`
      });
    });

    socket.on('admin_get_stats', () => {
      console.log(`🔧 Admin get_stats event`);
      socket.emit('admin_stats', adminControls.getServerStats());
    });

    socket.on('admin_get_history', () => {
      console.log(`🔧 Admin get_history event`);
      socket.emit('admin_chat_history', chatHistory.slice(-50));
    });

    socket.on('admin_get_blocked', () => {
      console.log(`🔧 Admin get_blocked event`);
      const blockedList = adminControls.getBlockedList();
      socket.emit('admin_blocked_list', blockedList);
    });

    // Send user updates to admin in real-time every 3 seconds
    const adminUpdateInterval = setInterval(() => {
      socket.emit('admin_users_update', {
        users: adminControls.getConnectedUsers(),
        stats: adminControls.getServerStats(),
        blockedCount: {
          ips: blockedIPs.size,
          users: blockedUsers.size
        }
      });
    }, 3000);

    socket.on('disconnect', () => {
      clearInterval(adminUpdateInterval);
      console.log('🔒 Admin disconnected:', socket.id);
    });
  }
});

// 404 handler - MUST BE LAST
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'عذرًا، المسار غير موجود.',
    requestedUrl: req.originalUrl,
    availableEndpoints: [
      '/',
      '/chat', 
      '/admin',
      '/health',
      '/api/health',
      '/api/test',
      '/api/admin/stats',
      '/debug-static'
    ]
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
🏥 Tunisian Medical Chatbot Server - ENHANCED RENDER EDITION
📍 Port: ${PORT}
🎯 Environment: ${process.env.NODE_ENV || 'development'}
🔗 Ollama: ${OLLAMA_BASE_URL}
🤖 Model: ${OLLAMA_MODEL}
🔒 Admin Secret: ${ADMIN_SECRET}

📁 Static Files: Enabled
🌐 Available Routes:
   - /                 -> Chat interface
   - /chat             -> Chat interface  
   - /admin            -> Admin panel
   - /health           -> Health check
   - /api/health       -> Detailed health check
   - /api/test         -> Test endpoint
   - /debug-static     -> Debug static files

✨ Server is running and ready for medical consultations!
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
  });
});

module.exports = app;
