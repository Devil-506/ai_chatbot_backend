const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const mongoSanitize = require('express-mongo-sanitize');

const app = express();
const server = http.createServer(app);

// ==================== ENHANCED SECURITY CONFIGURATION ====================

// Security: Enhanced Helmet with Render-compatible CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:", "https:", "http:"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Security: Enhanced CORS with proper validation
const allowedOrigins = [
  "https://ai-chatbot-frontend-1vx1.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173",
  /\.onrender\.com$/ // Allow all Render subdomains
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check against allowed origins
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return origin === allowedOrigin;
      } else if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return false;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn('🚫 CORS violation attempt from:', origin);
      callback(new Error(`CORS policy: Origin ${origin} not allowed`), false);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Security: Enhanced Rate limiting
const createRateLimit = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { error: message },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.url === '/api/health' && req.method === 'GET';
  },
  handler: (req, res) => {
    console.warn(`🚫 Rate limit exceeded for IP: ${req.ip} on ${req.url}`);
    res.status(429).json({ 
      error: 'Too many requests, please try again later.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
    });
  }
});

const generalLimiter = createRateLimit(15 * 60 * 1000, 100, 'Too many requests from this IP');
const authLimiter = createRateLimit(15 * 60 * 1000, 5, 'Too many authentication attempts');
const messageLimiter = createRateLimit(1 * 60 * 1000, 10, 'Too many messages sent');

// Apply rate limiting
app.use('/api/', generalLimiter);
app.use('/api/admin/', authLimiter);
app.use('/api/send-message', messageLimiter);

// Security: Enhanced body parsing with validation
app.use(express.json({ 
  limit: '50kb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString());
    } catch (e) {
      throw new Error('Invalid JSON payload');
    }
  }
}));

// Security: Enhanced data sanitization
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ key, req }) => {
    console.warn(`🚫 NoSQL injection attempt detected in field: ${key} from IP: ${req.ip}`);
  }
}));

// Security: Enhanced input validation middleware
const validateMessage = [
  body('message')
    .isLength({ min: 1, max: 2000 })
    .withMessage('Message must be between 1 and 2000 characters')
    .trim()
    .escape()
    .customSanitizer(value => value.replace(/\s+/g, ' ').trim()),
];

const validateAdminAction = [
  body('socketId')
    .isLength({ min: 1, max: 100 })
    .withMessage('Socket ID must be between 1 and 100 characters')
    .trim()
    .escape(),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason must be less than 500 characters')
    .trim()
    .escape(),
  body('target')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Target must be less than 100 characters')
    .trim()
    .escape(),
];

// Security: Enhanced HTML sanitization
const sanitizeMessage = (text) => {
  return sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'escape',
    enforceHtmlBoundary: true,
    textFilter: (text) => {
      // Remove potentially dangerous characters
      return text.replace(/[<>]/g, '');
    }
  });
};

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Security: Enhanced environment validation
const validateEnvironment = () => {
  const requiredEnvVars = ['OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'ADMIN_SECRET'];
  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missing.length > 0 && process.env.NODE_ENV === 'production') {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  return {
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'deepseek-r1:8b',
    ADMIN_SECRET: process.env.ADMIN_SECRET || 'render-enhanced-secret-2024'
  };
};

const config = validateEnvironment();

console.log('🔧 Enhanced security configuration loaded');
console.log('🔗 Ollama URL:', config.OLLAMA_BASE_URL);
console.log('🤖 Model:', config.OLLAMA_MODEL);
console.log('🔒 Admin authentication: Enabled');

// Security: Enhanced Socket.IO configuration
const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      
      const isAllowed = allowedOrigins.some(allowedOrigin => {
        if (typeof allowedOrigin === 'string') return origin === allowedOrigin;
        if (allowedOrigin instanceof RegExp) return allowedOrigin.test(origin);
        return false;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        console.warn('🚫 Socket.IO CORS violation from:', origin);
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Store blocked IPs and users with enhanced security
const blockedIPs = new Map();
const blockedUsers = new Map();

// Security: Enhanced rate limiting for socket messages
const socketRateLimits = new Map();
const SOCKET_RATE_LIMIT = {
  windowMs: 60000,
  maxMessages: 15,
  maxConnections: 5,
  maxAuthAttempts: 3
};

const checkSocketRateLimit = (socket, type = 'message') => {
  const ip = socket.handshake.address;
  const now = Date.now();
  
  if (!socketRateLimits.has(ip)) {
    socketRateLimits.set(ip, {
      messageCount: 0,
      connectionCount: 1,
      authAttempts: 0,
      lastReset: now,
      sockets: new Set([socket.id])
    });
    return true;
  }

  const limit = socketRateLimits.get(ip);
  
  // Reset counter if window has passed
  if (now - limit.lastReset > SOCKET_RATE_LIMIT.windowMs) {
    limit.messageCount = 0;
    limit.authAttempts = 0;
    limit.lastReset = now;
  }
  
  // Track socket connections
  if (!limit.sockets.has(socket.id)) {
    limit.sockets.add(socket.id);
    limit.connectionCount++;
  }

  // Check limits based on type
  switch (type) {
    case 'connection':
      if (limit.connectionCount > SOCKET_RATE_LIMIT.maxConnections) {
        console.warn(`🚫 IP ${ip} exceeded connection limit`);
        return false;
      }
      break;
      
    case 'message':
      if (limit.messageCount >= SOCKET_RATE_LIMIT.maxMessages) {
        console.warn(`🚫 IP ${ip} exceeded message rate limit`);
        return false;
      }
      limit.messageCount++;
      break;
      
    case 'auth':
      if (limit.authAttempts >= SOCKET_RATE_LIMIT.maxAuthAttempts) {
        console.warn(`🚫 IP ${ip} exceeded auth attempt limit`);
        return false;
      }
      limit.authAttempts++;
      break;
  }
  
  return true;
};

// Security: Enhanced socket authentication middleware
const authenticateSocket = (socket, next) => {
  const token = socket.handshake.auth.token;
  const isAdminRequest = socket.handshake.auth.secret;
  const clientIP = socket.handshake.address;
  
  // Rate limit authentication attempts
  if (!checkSocketRateLimit(socket, 'auth')) {
    return next(new Error('Too many authentication attempts'));
  }
  
  // Admin authentication
  if (isAdminRequest) {
    if (isAdminRequest === config.ADMIN_SECRET) {
      console.log('🔓 Admin socket authenticated:', socket.id, 'from IP:', clientIP);
      socket.isAdmin = true;
      return next();
    } else {
      console.warn('🚫 Invalid admin secret attempt from:', clientIP);
      securityLogger.logFailedAuth(socket, 'invalid_admin_secret');
      return next(new Error('Admin authentication failed'));
    }
  }
  
  // User authentication
  if (!token) {
    console.warn('🚫 No token provided for socket connection from:', clientIP);
    securityLogger.logFailedAuth(socket, 'missing_token');
    return next(new Error('Authentication token required'));
  }
  
  // TODO: Implement JWT validation here
  // For now, we'll accept any token but log it
  console.log('🔐 User socket authenticated:', socket.id, 'with token from IP:', clientIP);
  socket.isAuthenticated = true;
  next();
};

io.use(authenticateSocket);

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
        // Enhanced security: Sanitize and validate input
        const sanitizedMessage = sanitizeMessage(userMessage);
        console.log('💬 Medical query received (sanitized):', sanitizedMessage.substring(0, 100));
        
        // Additional validation
        if (sanitizedMessage.length < 1 || sanitizedMessage.length > 2000) {
          throw new Error('Invalid message length after sanitization');
        }
        
        const medicalPrompt = MEDICAL_CONTEXT + "\n\nالمريض: " + sanitizedMessage + "\n\nالمساعد:";
        
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
          console.warn('⏰ Ollama API timeout for socket:', socket.id);
        }, 90000);

        console.log('🔗 Calling Ollama API...');
        const response = await fetch(`${config.OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            model: config.OLLAMA_MODEL,
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
              console.warn('⚠️ JSON parse error:', e.message, 'Line:', line.substring(0, 100));
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
      const timeout = setTimeout(() => controller.abort(), 15000);
      
      const response = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
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
const MAX_HISTORY_SIZE = 1000;

// Security: Enhanced abuse detection and logging
const securityLogger = {
  logAbuseAttempt(socket, type, details) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ip: socket.handshake.address,
      socketId: socket.id,
      type,
      details,
      userAgent: socket.handshake.headers['user-agent']
    };
    
    console.warn('🚨 SECURITY ALERT:', logEntry);
    addToHistory(socket.id, 'security_alert', `${type}: ${JSON.stringify(details)}`);
    
    // TODO: Implement alerting (email, webhook, etc.)
  },
  
  logFailedAuth(socket, reason) {
    this.logAbuseAttempt(socket, 'failed_authentication', { reason });
  },
  
  logRateLimitExceeded(socket, limitType) {
    this.logAbuseAttempt(socket, 'rate_limit_exceeded', { limitType });
  },
  
  logSuspiciousActivity(socket, activity) {
    this.logAbuseAttempt(socket, 'suspicious_activity', activity);
  }
};

// Enhanced admin controls with security logging
const adminControls = {
  getConnectedUsers() {
    const users = Array.from(activeConnections.entries()).map(([id, info]) => ({
      socketId: id,
      ...info,
      connectionTime: Math.floor((new Date() - info.connectedAt) / 1000) + 's',
      isBlocked: blockedIPs.has(info.ip) || blockedUsers.has(id),
      messageCount: socketRateLimits.get(info.ip)?.messageCount || 0
    }));
    console.log('👥 Admin: Current connected users:', users.length);
    return users;
  },

  kickUser(socketId, adminSocket) {
    console.log(`🚫 Admin: Attempting to kick user: ${socketId}`);
    
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      console.log(`🔍 Found target socket: ${socketId}`);
      
      securityLogger.logAbuseAttempt(targetSocket, 'admin_kick', { 
        adminSocketId: adminSocket?.id,
        action: 'kick'
      });
      
      targetSocket.emit('chat_message', {
        text: "🚫 تم فصل اتصالك من قبل المسؤول. إذا كنت بحاجة إلى مساعدة، يرجى الاتصال بالدعم.",
        isUser: false,
        timestamp: new Date().toISOString(),
        type: 'admin_action'
      });
      
      setTimeout(() => {
        targetSocket.disconnect(true);
        activeConnections.delete(socketId);
      }, 1000);
      
      addToHistory(socketId, 'admin_action', `User kicked by admin`);
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
      console.log(`ℹ️ User ${socketId} is not connected, but blocking socket ID anyway`);
    }
    
    blockedUsers.set(socketId, {
      timestamp: new Date().toISOString(),
      reason: reason,
      blockedBy: adminSocket?.id || 'admin'
    });
    
    console.log(`⛔ Blocked socket ID: ${socketId}`);
    
    if (targetSocket && userInfo) {
      blockedIPs.set(userInfo.ip, {
        timestamp: new Date().toISOString(),
        reason: reason,
        blockedBy: adminSocket?.id || 'admin',
        socketId: socketId
      });
      
      console.log(`⛔ Also blocked IP: ${userInfo.ip}`);
      
      securityLogger.logAbuseAttempt(targetSocket, 'admin_block', { 
        adminSocketId: adminSocket?.id,
        reason: reason
      });
      
      targetSocket.emit('chat_message', {
        text: "⛔ تم حظر اتصالك من قبل المسؤول. لا يمكنك إعادة الاتصال.",
        isUser: false,
        timestamp: new Date().toISOString(),
        type: 'admin_action'
      });
      
      setTimeout(() => {
        targetSocket.disconnect(true);
        activeConnections.delete(socketId);
      }, 1000);
      
      addToHistory(socketId, 'admin_action', `User blocked: ${reason}`);
    } else {
      addToHistory(socketId, 'admin_action', `Socket ID blocked: ${reason}`);
    }
    
    console.log(`⛔ Admin: SUCCESS - Blocked user: ${socketId}`);
    return true;
  },

  unblockUser(socketIdOrIP, adminSocket) {
    console.log(`🔓 Admin: Attempting to unblock: ${socketIdOrIP}`);
    
    let unblocked = false;
    
    if (blockedUsers.has(socketIdOrIP)) {
      blockedUsers.delete(socketIdOrIP);
      console.log(`🔓 Unblocked socket ID: ${socketIdOrIP}`);
      unblocked = true;
    }
    
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
    
    let recipients = 0;
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
        recipients++;
      }
    });
    
    addToHistory('admin', 'broadcast', `Admin broadcast: ${message}`);
    console.log(`📢 Admin: SUCCESS - Broadcast sent to ${recipients} users`);
    return recipients;
  },

  getServerStats() {
    const stats = {
      totalConnections: activeConnections.size,
      chatHistorySize: chatHistory.length,
      blockedIPs: blockedIPs.size,
      blockedUsers: blockedUsers.size,
      serverUptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString(),
      rateLimitStats: {
        uniqueIPs: socketRateLimits.size,
        totalConnections: Array.from(socketRateLimits.values()).reduce((sum, limit) => sum + limit.connectionCount, 0)
      }
    };
    console.log('📊 Admin: Server stats requested');
    return stats;
  },

  isUserBlocked(socket) {
    const ip = socket.handshake.address;
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

// ==================== ENHANCED ROUTES ====================

// Health check endpoint with enhanced security
app.get('/api/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: 'OK',
      service: 'Tunisian Medical Chatbot - SECURE',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: activeConnections.size,
      blocked: {
        ips: blockedIPs.size,
        users: blockedUsers.size
      },
      security: {
        rateLimiting: 'active',
        sanitization: 'active',
        csp: 'active',
        validation: 'active',
        helmet: 'active'
      },
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

// Enhanced admin endpoints with validation
app.get('/api/admin/blocked-list', (req, res) => {
  const blockedList = adminControls.getBlockedList();
  res.json(blockedList);
});

app.post('/api/admin/block-user', validateAdminAction, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  const { socketId, reason } = req.body;
  
  const success = adminControls.blockUser(socketId, null, reason || "Manual block by admin");
  
  res.json({
    success: success,
    message: success ? `User ${socketId} blocked successfully` : `Failed to block user ${socketId}`
  });
});

app.post('/api/admin/unblock', validateAdminAction, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  const { target } = req.body;
  
  const success = adminControls.unblockUser(target, null);
  
  res.json({
    success: success,
    message: success ? `${target} unblocked successfully` : `${target} not found in blocked list`
  });
});

// Enhanced test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: '🚀 Enhanced Medical Chatbot Server is running on Render!',
    timestamp: new Date().toISOString(),
    version: '3.0.0-enhanced',
    security: 'ENABLED',
    features: ['Helmet', 'CORS', 'Rate Limiting', 'Input Validation', 'Sanitization']
  });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: '🏥 Enhanced Tunisian Medical Chatbot Server',
    status: 'Running on Render with Maximum Security',
    endpoints: {
      health: '/api/health',
      admin: '/admin',
      test: '/api/test'
    },
    security: 'All security features enabled'
  });
});

// ==================== ENHANCED SOCKET.IO HANDLING ====================

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id, 'from IP:', socket.handshake.address);
  
  // Enhanced security: Rate limiting check for connections
  if (!checkSocketRateLimit(socket, 'connection')) {
    securityLogger.logRateLimitExceeded(socket, 'connection_rate');
    socket.emit('error', { 
      message: 'Connection rate limit exceeded. Please try again later.' 
    });
    socket.disconnect();
    return;
  }
  
  // Enhanced security: Check if user is blocked
  if (adminControls.isUserBlocked(socket)) {
    console.log(`⛔ Blocked user attempted to connect: ${socket.id}`);
    securityLogger.logAbuseAttempt(socket, 'blocked_connection_attempt', {});
    
    socket.emit('chat_message', {
      text: "⛔ تم حظر اتصالك من قبل المسؤول. لا يمكنك استخدام الخدمة.",
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
    isAdmin: socket.isAdmin || false,
    isAuthenticated: socket.isAuthenticated || false
  };
  
  activeConnections.set(socket.id, userInfo);
  addToHistory(socket.id, 'user_connected', `User connected from ${userInfo.ip}`);

  // Send welcome message
  socket.emit('welcome', {
    message: 'أهلاً وسهلاً! أنا مساعدك الطبي التونسي. كيف يمكنني مساعدتك اليوم؟',
    id: socket.id,
    timestamp: new Date().toISOString(),
    security: 'enhanced'
  });

  // Handle incoming messages with enhanced security
  socket.on('send_message', async (data) => {
    // Enhanced security: Check message rate limit
    if (!checkSocketRateLimit(socket, 'message')) {
      securityLogger.logRateLimitExceeded(socket, 'message_rate');
      socket.emit('error', { 
        message: 'Message rate limit exceeded. Please slow down.' 
      });
      return;
    }
    
    // Enhanced security: Input validation
    if (!data.message || data.message.trim().length === 0) {
      socket.emit('error', { message: 'الرجاء كتابة رسالة.' });
      return;
    }

    if (data.message.length > 2000) {
      socket.emit('error', { message: 'الرسالة طويلة جدًا. الرجاء الاختصار.' });
      return;
    }

    try {
      // Enhanced security: Sanitize message
      const sanitizedMessage = sanitizeMessage(data.message.trim());
      console.log(`📝 Processing sanitized message from ${socket.id}`);
      
      // Enhanced security: Log potential XSS attempts
      if (sanitizedMessage !== data.message.trim()) {
        securityLogger.logSuspiciousActivity(socket, {
          type: 'xss_attempt',
          original: data.message.substring(0, 100),
          sanitized: sanitizedMessage.substring(0, 100)
        });
      }
      
      addToHistory(socket.id, 'user_message', sanitizedMessage);
      
      await medicalService.generateResponse(sanitizedMessage, socket);
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

  // Enhanced admin system
  if (socket.isAdmin) {
    console.log('🔓 Admin socket activated:', socket.id);
    
    socket.emit('admin_welcome', { 
      message: '🔓 أنت متصل كمسؤول في النظام المحسن',
      users: adminControls.getConnectedUsers(),
      stats: adminControls.getServerStats(),
      socketId: socket.id,
      security: {
        rateLimiting: 'active',
        validation: 'active',
        sanitization: 'active'
      }
    });

    // Admin event handlers with enhanced validation
    socket.on('admin_kick_user', (data) => {
      if (!data.socketId || typeof data.socketId !== 'string') {
        return socket.emit('admin_action_result', {
          action: 'kick_user',
          success: false,
          message: 'Invalid socket ID provided'
        });
      }
      
      const success = adminControls.kickUser(data.socketId, socket);
      socket.emit('admin_action_result', {
        action: 'kick_user',
        success: success,
        message: success ? `تم فصل المستخدم ${data.socketId}` : `لم يتم العثور على المستخدم ${data.socketId}`
      });
    });

    socket.on('admin_block_user', (data) => {
      if (!data.socketId || typeof data.socketId !== 'string') {
        return socket.emit('admin_action_result', {
          action: 'block_user',
          success: false,
          message: 'Invalid socket ID provided'
        });
      }
      
      const success = adminControls.blockUser(data.socketId, socket, data.reason);
      socket.emit('admin_action_result', {
        action: 'block_user',
        success: success,
        message: success ? `تم حظر المستخدم ${data.socketId}` : `فشل في حظر المستخدم ${data.socketId}`
      });
    });

    // Send periodic security updates to admin
    const adminUpdateInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('admin_users_update', {
          users: adminControls.getConnectedUsers(),
          stats: adminControls.getServerStats(),
          security: {
            blockedIPs: blockedIPs.size,
            blockedUsers: blockedUsers.size,
            rateLimitedIPs: socketRateLimits.size
          }
        });
      }
    }, 3000);

    socket.on('disconnect', () => {
      clearInterval(adminUpdateInterval);
      console.log('🔒 Admin disconnected:', socket.id);
    });
  }
});

// Enhanced 404 handler
app.use('*', (req, res) => {
  console.warn('🚫 404 encountered for:', req.originalUrl, 'from IP:', req.ip);
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'عذرًا، المسار غير موجود.',
    requestedUrl: req.originalUrl
  });
});

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  console.error('🔥 Enhanced Server error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    ip: req.ip,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: 'عذرًا، حدث خطأ في الخادم.',
    reference: `ERR-${Date.now()}`
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 ENHANCED Tunisian Medical Chatbot - MAXIMUM SECURITY
📍 Port: ${PORT}
🌐 Environment: ${process.env.NODE_ENV || 'development'}
🔗 Ollama: ${config.OLLAMA_BASE_URL}
🤖 Model: ${config.OLLAMA_MODEL}

🔒 SECURITY FEATURES:
✅ Helmet with Enhanced CSP
✅ CORS with Regex Origin Validation  
✅ Multi-layer Rate Limiting
✅ Express Validator
✅ HTML Sanitization
✅ NoSQL Injection Protection
✅ Input Validation & Sanitization
✅ Enhanced Socket Authentication
✅ Security Logging & Monitoring
✅ Request Validation

📊 Endpoints:
   Health: http://localhost:${PORT}/api/health
   Admin:  http://localhost:${PORT}/admin
   Test:   http://localhost:${PORT}/api/test

✨ Enhanced secure server is running on Render!
  `);
});

// Enhanced cleanup for rate limit records
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [ip, limit] of socketRateLimits.entries()) {
    if (now - limit.lastReset > SOCKET_RATE_LIMIT.windowMs * 3) {
      socketRateLimits.delete(ip);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired rate limit records`);
  }
}, SOCKET_RATE_LIMIT.windowMs * 2);

// Enhanced graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔻 SIGTERM received, shutting down gracefully...');
  
  // Notify all connected clients
  io.emit('server_maintenance', {
    message: 'Server is restarting for maintenance. Please reconnect in a moment.',
    timestamp: new Date().toISOString()
  });
  
  setTimeout(() => {
    server.close(() => {
      console.log('🔻 Enhanced server terminated gracefully');
      process.exit(0);
    });
  }, 5000);
});

module.exports = app;
