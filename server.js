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

// Configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';

// Admin Configuration
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'iamtheserver2024';

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
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

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

// Store chat history for admin monitoring
const chatHistory = [];
const MAX_HISTORY_SIZE = 1000;

// FIXED: Enhanced Admin Controls with REAL effects
const adminControls = {
  getConnectedUsers() {
    const users = Array.from(activeConnections.entries()).map(([id, info]) => ({
      socketId: id,
      ...info,
      connectionTime: Math.floor((new Date() - info.connectedAt) / 1000) + 's'
    }));
    console.log('👥 Admin: Current connected users:', users.length);
    return users;
  },

  kickUser(socketId, adminSocket) {
    console.log(`🚫 Admin: Attempting to kick user: ${socketId}`);
    
    // Get the target socket
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      console.log(`🔍 Found target socket: ${socketId}`);
      
      // Send warning message to the user
      targetSocket.emit('admin_message', {
        type: 'warning',
        message: 'تم فصل اتصالك من قبل المسؤول'
      });
      
      // Actually disconnect the user
      targetSocket.disconnect(true);
      
      // Remove from active connections
      activeConnections.delete(socketId);
      
      // Add to chat history
      addToHistory(socketId, 'admin_action', `User ${socketId} was kicked by admin`);
      
      console.log(`🔴 Admin: SUCCESS - Kicked user: ${socketId}`);
      return true;
    }
    console.log(`❌ Admin: User not found: ${socketId}`);
    return false;
  },

  blockUser(socketId, adminSocket) {
    return this.kickUser(socketId, adminSocket);
  },

  broadcastToAll(message, adminSocket) {
    console.log(`📢 Admin: Broadcasting to ${activeConnections.size} users:`, message);
    
    // Create broadcast data
    const broadcastData = {
      message: message,
      timestamp: new Date().toISOString(),
      from: 'System Admin'
    };
    
    // Broadcast to ALL connected sockets (both users and admin)
    io.emit('admin_announcement', broadcastData);
    
    // Also send to individual users for redundancy
    activeConnections.forEach((info, socketId) => {
      const userSocket = io.sockets.sockets.get(socketId);
      if (userSocket && userSocket.connected) {
        userSocket.emit('admin_announcement', broadcastData);
      }
    });
    
    // Add to chat history
    addToHistory('admin', 'broadcast', `Admin broadcast: ${message}`);
    
    console.log(`📢 Admin: SUCCESS - Broadcast sent to ${activeConnections.size} users`);
    return activeConnections.size;
  },

  getServerStats() {
    const stats = {
      totalConnections: activeConnections.size,
      chatHistorySize: chatHistory.length,
      serverUptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    console.log('📊 Admin: Server stats requested');
    return stats;
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
    version: '1.0.0'
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

  // Handle admin announcements for regular users
  socket.on('admin_announcement', (data) => {
    console.log(`📢 User ${socket.id} received admin announcement:`, data.message);
    // This will be handled by the frontend to show the message
  });

  // Handle admin messages (warnings, kicks)
  socket.on('admin_message', (data) => {
    console.log(`⚠️ User ${socket.id} received admin message:`, data.message);
    // This will be handled by the frontend to show warnings
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

  // ==================== FIXED REAL-TIME ADMIN ====================
  
  if (socket.handshake.auth.secret === ADMIN_SECRET) {
    console.log('🔓 Admin connected via WebSocket:', socket.id);
    console.log('🔓 Admin authentication successful');
    
    // Mark as admin
    userInfo.isAdmin = true;
    activeConnections.set(socket.id, userInfo);

    socket.emit('admin_welcome', { 
      message: '🔓 أنت متصل كمسؤول',
      users: adminControls.getConnectedUsers(),
      stats: adminControls.getServerStats(),
      socketId: socket.id
    });

    // FIXED: Admin event handlers with REAL effects
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
      const success = adminControls.blockUser(data.socketId, socket);
      socket.emit('admin_action_result', {
        action: 'block_user',
        success: success,
        message: success ? `تم حظر المستخدم ${data.socketId}` : `لم يتم العثور على المستخدم ${data.socketId}`
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

    // Send user updates to admin in real-time every 3 seconds
    const adminUpdateInterval = setInterval(() => {
      socket.emit('admin_users_update', {
        users: adminControls.getConnectedUsers(),
        stats: adminControls.getServerStats()
      });
    }, 3000);

    // Clear interval when admin disconnects
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

📁 Static Files: Enabled
🌐 Admin Panel: http://localhost:${PORT}/admin

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
