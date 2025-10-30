const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)); // ✅ dynamic import fix for Render

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: [
      "https://ai-chatbot-frontend-1vx1.onrender.com",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ✅ Single declaration only
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || "deepseek-v3.1:671b-cloud";

‎// Enhanced Medical Context for Tunisian Patients
‎const MEDICAL_CONTEXT = `أنت مساعد طبي مخصص للمرضى التونسيين. دورك هو:
‎
‎1. تقديم معلومات طبية عامة وتحليل أولي للأعراض
‎2. تقديم نصائح صحية ومعلومات وقائية
‎3. مساعدة المرضى على فهم الحالات الطبية
‎4. توجيه المرضى للموارد الصحية في تونس
‎
‎*تحذيرات مهمة:*
‎- أنت لست بديلاً عن الطبيب
‎- استشر المتخصصين للحالات الخطيرة
‎-للطوارئ اتصل على 198
‎- تقدم معلومات فقط وليس تشخيصات
‎
‎*معلومات عن تونس:*
‎- نظام الصحة: عمومي وخاص
‎- رقم الطوارئ: 198
‎- مستشفيات رئيسية: شارل نيكول، الرابطة، المنجي سليم
‎
‎*عند الرد:*
‎- استخدم نفس لغة المستخدم! 
‎- أجب باللغة التي تم السؤال بها !! 
‎- استخدم اللهجة المستخدمة عند السؤال
‎- استخدم نفس اللغة التي تم السؤال بها
‎- استخدم نفس اللغة المستخدمة في السؤال من أجل الجواب 
‎- كن واضحًا ومتعاطفًا
‎- ركز على سلامة المريض
‎- لا تطلب معلومات شخصية
‎- لا تعطي وصفات طبية
‎- شجع على استشارة الطبيب
‎- استخدم الفرنسية كلغة افتراضية 
‎- استخدم لغة بسيطة
‎
‎الآن جاوب على سؤال المريض:`;
‎

class RemoteOllamaService {
  async generateResponse(userMessage, socket) {
    try {
      console.log("💬 Medical query received:", userMessage.substring(0, 100));

      const medicalPrompt =
        MEDICAL_CONTEXT + "\n\nالمريض: " + userMessage + "\n\nالمساعد:";

      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: medicalPrompt,
          stream: true,
          options: { temperature: 0.7, top_p: 0.9, top_k: 40 },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "") continue;

          try {
            const data = JSON.parse(line);
            if (data.response) {
              fullResponse += data.response;
              if (socket && socket.connected) {
                socket.emit("streaming_response", {
                  text: fullResponse,
                  partial: !data.done,
                });
              }
            }
            if (data.done) {
              socket.emit("streaming_response", {
                text: fullResponse,
                partial: false,
                complete: true,
              });
              return fullResponse;
            }
          } catch {
            continue;
          }
        }
      }

      return fullResponse;
    } catch (error) {
      console.error("❌ Ollama service error:", error);
      const fallbackResponse =
        "عذرًا، الخدمة الطبية غير متاحة حاليًا. يرجى المحاولة لاحقًا أو الاتصال بطبيبك مباشرة.";
      if (socket && socket.connected) {
        socket.emit("streaming_response", {
          text: fallbackResponse,
          partial: false,
          complete: true,
        });
      }
      return fallbackResponse;
    }
  }

  async healthCheck() {
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      if (response.ok) {
        const data = await response.json();
        return {
          healthy: true,
          models: data.models?.map((m) => m.name) || [],
          message: "Ollama connected successfully",
        };
      }
      return { healthy: false, message: `Bad response: ${response.status}` };
    } catch (error) {
      return { healthy: false, message: `Error: ${error.message}` };
    }
  }
}

const medicalService = new RemoteOllamaService();
const activeConnections = new Map();

// ✅ Health check
app.get("/api/health", async (req, res) => {
  const health = await medicalService.healthCheck();
  res.json({
    status: "OK",
    ollama: health,
    uptime: process.uptime(),
    connections: activeConnections.size,
  });
});

app.get("/api/test", (req, res) => {
  res.json({ message: "Server OK", time: new Date().toISOString() });
});

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);
  activeConnections.set(socket.id, new Date());

  socket.emit("welcome", {
    message: "أهلاً وسهلاً! أنا مساعدك الطبي التونسي. كيف يمكنني مساعدتك اليوم؟",
  });

  socket.on("send_message", async (data) => {
    if (!data?.message) return;
    await medicalService.generateResponse(data.message, socket);
  });

  socket.on("disconnect", () => {
    activeConnections.delete(socket.id);
    console.log("❌ Disconnected:", socket.id);
  });
});

app.use("*", (_, res) =>
  res.status(404).json({ error: "Endpoint not found" })
);

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`
🏥 Medical Chatbot Running
🌍 Port: ${PORT}
🔗 Ollama: ${OLLAMA_BASE_URL}
🤖 Model: ${OLLAMA_MODEL}
✅ Ready for Render Deployment!
`)
);
