const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// 配置 CORS（允许跨域访问）
app.use(cors());
app.use(express.json());

// 配置 Socket.IO（允许跨域）
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ==================== 数据存储 ====================
let onlineUsers = new Map(); // 在线用户
let allBubbles = []; // 所有气泡
let chatrooms = new Map(); // 聊天室
let privateChats = new Map(); // 私聊消息

// ==================== HTTP 路由 ====================
app.get('/', (req, res) => {
  res.json({
    message: '此刻地图服务器运行中',
    online: onlineUsers.size,
    bubbles: allBubbles.length
  });
});

// 获取所有气泡
app.get('/api/bubbles', (req, res) => {
  const now = Date.now();
  const activeBubbles = allBubbles.filter(b => {
    if (b.isPrivate) return false;
    const expireTime = b.createdAt + (b.duration * 1000);
    return now < expireTime;
  });
  res.json(activeBubbles);
});

// ==================== Socket.IO 事件 ====================
io.on('connection', (socket) => {
  console.log('✅ 新用户连接:', socket.id);

  // 用户加入
  socket.on('userJoin', (userData) => {
    onlineUsers.set(socket.id, {
      ...userData,
      socketId: socket.id,
      joinTime: Date.now()
    });
    
    // 广播在线人数
    io.emit('onlineCount', onlineUsers.size);
    
    // 发送现有气泡给新用户
    const now = Date.now();
    const activeBubbles = allBubbles.filter(b => {
      if (b.isPrivate) return false;
      const expireTime = b.createdAt + (b.duration * 1000);
      return now < expireTime;
    });
    socket.emit('initialBubbles', activeBubbles);
    
    console.log('👤 用户加入:', userData.nickname, '在线人数:', onlineUsers.size);
  });

  // 发布气泡
  socket.on('publishBubble', (bubbleData) => {
    const bubble = {
      ...bubbleData,
      id: 'bubble_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      createdAt: Date.now()
    };
    
    allBubbles.push(bubble);
    
    // 广播给所有人（包括发布者）
    io.emit('newBubble', bubble);
    
    console.log('📍 新气泡发布:', bubble.title, 'by', bubbleData.author);
    
    // 自动删除过期气泡
    if (!bubble.isPrivate) {
      setTimeout(() => {
        const index = allBubbles.findIndex(b => b.id === bubble.id);
        if (index > -1) {
          allBubbles.splice(index, 1);
          io.emit('bubbleExpired', bubble.id);
          console.log('⏰ 气泡过期:', bubble.title);
        }
      }, bubble.duration * 1000);
    }
  });

  // 加入聊天室
  socket.on('joinChatroom', (chatroomId) => {
    socket.join(chatroomId);
    
    if (!chatrooms.has(chatroomId)) {
      chatrooms.set(chatroomId, {
        id: chatroomId,
        users: new Set(),
        messages: []
      });
    }
    
    const room = chatrooms.get(chatroomId);
    room.users.add(socket.id);
    
    // 发送历史消息
    socket.emit('chatroomHistory', room.messages);
    
    // 通知房间内所有人
    io.to(chatroomId).emit('chatroomUserCount', room.users.size);
    
    console.log('💬 用户加入聊天室:', chatroomId, '在线:', room.users.size);
  });

  // 聊天室消息
  socket.on('chatroomMessage', ({ chatroomId, message, nickname }) => {
    const room = chatrooms.get(chatroomId);
    if (!room) return;
    
    const msg = {
      nickname,
      content: message,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    };
    
    room.messages.push(msg);
    
    // 只保留最近100条消息
    if (room.messages.length > 100) {
      room.messages.shift();
    }
    
    // 广播给聊天室所有人
    io.to(chatroomId).emit('chatroomMessage', msg);
    
    console.log('💬 聊天室消息:', chatroomId, nickname, ':', message);
  });

  // 离开聊天室
  socket.on('leaveChatroom', (chatroomId) => {
    socket.leave(chatroomId);
    
    const room = chatrooms.get(chatroomId);
    if (room) {
      room.users.delete(socket.id);
      io.to(chatroomId).emit('chatroomUserCount', room.users.size);
      console.log('👋 用户离开聊天室:', chatroomId, '剩余:', room.users.size);
    }
  });

  // 私聊消息
  socket.on('privateMessage', ({ targetUserId, message, nickname }) => {
    const msg = {
      from: socket.id,
      nickname,
      content: message,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    };
    
    // 发送给目标用户
    io.to(targetUserId).emit('privateMessage', msg);
    
    // 也发送给自己（显示在聊天界面）
    socket.emit('privateMessage', msg);
    
    console.log('💌 私聊消息:', nickname, '->', targetUserId);
  });

  // 用户断开连接
  socket.on('disconnect', () => {
    // 从所有聊天室移除
    chatrooms.forEach((room, chatroomId) => {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        io.to(chatroomId).emit('chatroomUserCount', room.users.size);
      }
    });
    
    onlineUsers.delete(socket.id);
    io.emit('onlineCount', onlineUsers.size);
    
    console.log('❌ 用户断开:', socket.id, '剩余在线:', onlineUsers.size);
  });
});

// ==================== 启动服务器 ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📡 WebSocket 已启动`);
});

// 定期清理过期气泡
setInterval(() => {
  const now = Date.now();
  const before = allBubbles.length;
  allBubbles = allBubbles.filter(b => {
    if (b.isPrivate) return true;
    const expireTime = b.createdAt + (b.duration * 1000);
    return now < expireTime;
  });
  const removed = before - allBubbles.length;
  if (removed > 0) {
    console.log('🧹 清理过期气泡:', removed, '个');
  }
}, 60000); // 每分钟清理一次
