const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Configure CORS for your Render frontend
const io = socketIo(server, {
  cors: {
    origin: [
      "https://ai-chatbot-frontend-1vx1.onrender.com",
      "https://ai-chatbot-frontend-bay.vercel.app/"
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Configuration - Updated for Ngrok setup
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';

// Admin Configuration
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'iamtheserver2024';

// Store blocked IPs and users persistently
const blockedIPs = new Map();
const blockedUsers = new Map();

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
        console.log('🔗 Connecting to Ollama at:', OLLAMA_BASE_URL);
        
        const medicalPrompt = MEDICAL_CONTEXT + "\n\nالمريض: " + userMessage + "\n\nالمساعد:";
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        // Enhanced headers for Ngrok compatibility
        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': 'Medical-Chatbot-Server/1.0',
          'Accept': 'application/json'
        };

        // Add Ngrok authentication if available
        if (process.env.NGROK_AUTH_TOKEN) {
          headers['Authorization'] = `Bearer ${process.env.NGROK_AUTH_TOKEN}`;
        }

        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: headers,
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
          let errorDetails = '';
          try {
            errorDetails = await response.text();
          } catch (e) {
            errorDetails = 'Could not read error response';
          }
          
          console.error(`❌ Ollama API error ${response.status}:`, errorDetails);
          
          if (response.status === 403) {
            throw new Error(`Ngrok/Ollama access forbidden (403). This is usually a Ngrok security restriction. Check your Ngrok configuration.`);
          } else if (response.status === 404) {
            throw new Error(`Ollama endpoint not found. Check if Ollama is running and the URL is correct.`);
          } else {
            throw new Error(`HTTP ${response.status}: ${errorDetails}`);
          }
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
              console.warn('⚠️ JSON parse error:', e.message);
            }
          }
        }

        resolve(fullResponse);
        
      } catch (error) {
        console.error('❌ Ollama service error:', error);
        
        let fallbackResponse = "عذرًا، الخدمة الطبية غير متاحة حاليًا. يرجى المحاولة لاحقًا أو الاتصال بطبيبك مباشرة.";
        
        if (error.name === 'AbortError') {
          fallbackResponse = "عذرًا، تجاوزت الاستجابة المهلة المسموحة. يرجى المحاولة مرة أخرى.";
        } else if (error.message.includes('403') || error.message.includes('forbidden')) {
          fallbackResponse = "عذرًا، الخدمة الطبية غير متاحة حاليًا بسبب قيود الأمان. يرجى الاتصال بالدعم الفني.";
        } else if (error.message.includes('404') || error.message.includes('not found')) {
          fallbackResponse = "عذرًا، خدمة الذكاء الاصطناعي غير متوفرة حاليًا. يرجى الاتصال بالدعم الفني.";
        }
        
        if (socket && socket.connected) {
          socket.emit('streaming_response', {
            text: fallbackResponse,
            partial: false,
            complete: true,
            error: true
          });
        }
        
        resolve(fallbackResponse);
      }
    });
  }

  async healthCheck() {
    try {
      console.log('🔧 Health check connecting to:', OLLAMA_BASE_URL);
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const headers = {
        'User-Agent': 'Medical-Chatbot-Server/1.0'
      };
      
      if (process.env.NGROK_AUTH_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.NGROK_AUTH_TOKEN}`;
      }
      
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        headers: headers,
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (response.ok) {
        const data = await response.json();
        return {
          healthy: true,
          models: data.models?.map(m => m.name) || [],
          message: `Ollama is connected to ${OLLAMA_BASE_URL}`
        };
      } else {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch (e) {
          errorBody = 'Could not read error response';
        }
        
        return {
          healthy: false,
          message: `Ollama responded with status: ${response.status} - ${response.statusText}`,
          details: errorBody,
          url: OLLAMA_BASE_URL
        };
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Cannot connect to Ollama at ${OLLAMA_BASE_URL}: ${error.message}`,
        errorType: error.name,
        url: OLLAMA_BASE_URL
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

// Enhanced Ngrok Debug Endpoint
app.get('/api/debug-ngrok', async (req, res) => {
  try {
    console.log('🔧 Testing Ngrok connection to:', OLLAMA_BASE_URL);
    
    const headers = {
      'User-Agent': 'Medical-Chatbot-Server/1.0'
    };
    
    if (process.env.NGROK_AUTH_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.NGROK_AUTH_TOKEN}`;
    }
    
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      headers: headers,
      timeout: 10000
    });
    
    let responseBody = '';
    try {
      responseBody = await response.text();
    } catch (e) {
      responseBody = 'Could not read response body';
    }
    
    res.json({
      status: response.status,
      statusText: response.statusText,
      url: OLLAMA_BASE_URL,
      ngrokUrl: OLLAMA_BASE_URL,
      headers: response.headers,
      body: responseBody,
      environment: {
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
        OLLAMA_MODEL: process.env.OLLAMA_MODEL,
        NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN ? '***' : 'Not set'
      }
    });
    
  } catch (error) {
    console.error('🔧 Debug Ngrok error:', error);
    res.status(500).json({
      error: error.message,
      url: OLLAMA_BASE_URL,
      stack: error.stack,
      environment: {
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
        OLLAMA_MODEL: process.env.OLLAMA_MODEL,
        NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN ? '***' : 'Not set'
      }
    });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const ollamaHealth = await medicalService.healthCheck();
    
    const healthStatus = {
      status: ollamaHealth.healthy ? 'OK' : 'ERROR',
      service: 'Tunisian Medical Chatbot - Render',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      connections: activeConnections.size,
      ollama: ollamaHealth,
      environment: process.env.NODE_ENV || 'development',
      ngrok: {
        url: OLLAMA_BASE_URL,
        hasAuthToken: !!process.env.NGROK_AUTH_TOKEN
      }
    };
    
    res.json(healthStatus);
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: 'Health check failed',
      error: error.message,
      url: OLLAMA_BASE_URL
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
    message: 'Medical chatbot server is running!',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    ollamaUrl: OLLAMA_BASE_URL
  });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root route - redirect to admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  
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
    ip: socket.handshake.address,
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
    
    addToHistory(socket.id, 'user_disconnected', `User disconnected: ${reason}`);
    
    activeConnections.delete(socket.id);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('💥 Socket error:', error);
  });

  // ==================== COMPLETE ADMIN SYSTEM ====================
  
  if (socket.handshake.auth.secret === ADMIN_SECRET) {
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

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'عذرًا، المسار غير موجود.',
    requestedUrl: req.originalUrl
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
🔒 Admin Secret: ${ADMIN_SECRET}
📡 Ngrok Auth: ${process.env.NGROK_AUTH_TOKEN ? 'Configured' : 'Not set'}

📁 Static Files: Enabled
🌐 Admin Panel: http://localhost:${PORT}/admin
🔧 Debug Endpoint: http://localhost:${PORT}/api/debug-ngrok

✨ Server is running and ready!
  `);
});

process.on('SIGTERM', () => {
  console.log('🔻 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('🔻 Process terminated');
  });
});

module.exports = app;

