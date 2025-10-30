const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Configuration
const OLLAMA_API_KEY = '91311739151c4a2581c519cf6cbdff94.yS_kBNTmJNxu9X3-mpWWUmfo';
const MODEL_NAME = 'gpt-oss:120b-cloud';
const OLLAMA_BASE_URL = 'https://api.ollama.ai';

// Medical Context
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
  async generateResponse(userMessage, socket) {
    try {
      console.log('🩺 Medical query:', userMessage);
      
      const prompt = MEDICAL_CONTEXT + "\n\nPatient: " + userMessage + "\n\nAssistant:";

      const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OLLAMA_API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: [{ role: "user", content: prompt }],
          stream: true,
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          if (line === 'data: [DONE]') {
            socket.emit('streaming_response', {
              text: fullResponse,
              partial: false,
              complete: true
            });
            return fullResponse;
          }

          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              
              if (content) {
                fullResponse += content;
                socket.emit('streaming_response', {
                  text: fullResponse,
                  partial: true
                });
              }
            } catch (e) {
              // Skip JSON parse errors
            }
          }
        }
      }

      return fullResponse;

    } catch (error) {
      console.error('❌ Ollama error:', error);
      socket.emit('error', { 
        message: 'حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' 
      });
      throw error;
    }
  }
}

const medicalService = new MedicalOllamaService();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🟢 User connected:', socket.id);

  socket.on('send_message', async (data) => {
    try {
      await medicalService.generateResponse(data.message, socket);
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected:', socket.id);
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Medical Chatbot Server is running',
    timestamp: new Date().toISOString(),
    service: 'Tunisian Medical Assistant'
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Server is working!',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('\n' + '='.repeat(50));
  console.log('🏥  TUNISIAN MEDICAL CHATBOT SERVER');
  console.log('='.repeat(50));
  console.log(`📍  Port: ${PORT}`);
  console.log(`🤖  Model: ${MODEL_NAME}`);
  console.log(`🌐  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(50));
  console.log(`✅  Server running successfully!`);
  console.log('='.repeat(50) + '\n');
});
