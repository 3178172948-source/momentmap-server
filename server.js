const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// 配置CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// 配置Socket.IO（允许跨域）
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// ==================== 数据存储 ====================
let onlineUsers = new Map(); // userId -> {nickname, avatar, socketId, status}
let allBubbles = []; // 所有气泡
let chatrooms = new Map(); // chatroomId -> {messages: [], members: []}
let friendChats = new Map(); // chatKey -> messages[]

// ==================== HTTP路由 ====================
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '此刻地图服务器运行中',
    onlineUsers: onlineUsers.size,
    totalBubbles: allBubbles.length
  });
});

// 获取所有气泡
app.get('/api/bubbles', (req, res) => {
  const now = Date.now();
  // 过滤掉已过期的气泡
  const validBubbles = allBubbles.filter(b => {
    if (b.isPrivate) return true;
    return (b.createdAt + b.duration * 1000) > now;
  });
  res.json({ bubbles: validBubbles });
});

// 地点搜索代理（解决跨域问题）
app.get('/api/search', async (req, res) => {
  const keyword = req.query.keyword;
  if (!keyword) {
    return res.json({ status: -1, message: '缺少关键词' });
  }
  
  try {
    const url = `https://apis.map.qq.com/ws/place/v1/suggestion?keyword=${encodeURIComponent(keyword)}&region=全国&key=OB4BZ-D4W3U-JSP5Z-4SFQE-O5CWRQ-CFB47&output=json`;
    
    const https = require('https');
    https.get(url, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        res.json(JSON.parse(data));
      });
    }).on('error', (err) => {
      res.json({ status: -1, message: err.message });
    });
  } catch (error) {
    res.json({ status: -1, message: error.message });
  }
});

// ==================== Socket.IO 事件处理 ====================
io.on('connection', (socket) => {
  console.log('✅ 新用户连接:', socket.id);
  
  // 用户加入
  socket.on('userJoin', (userData) => {
    onlineUsers.set(userData.id, {
      ...userData,
      socketId: socket.id
    });
    socket.userId = userData.id;
    
    console.log(`👤 用户加入: ${userData.nickname} (${userData.id})`);
    
    // 广播在线人数
    io.emit('onlineCount', onlineUsers.size);
    
    // 发送所有气泡给新用户
    socket.emit('allBubbles', allBubbles);
  });
  
  // 发布气泡
  socket.on('publishBubble', (bubbleData) => {
    allBubbles.push(bubbleData);
    console.log(`💬 新气泡发布: ${bubbleData.title}`);
    
    // 广播给所有人
    io.emit('newBubble', bubbleData);
    
    // 如果不是私密气泡，设置自动删除
    if (!bubbleData.isPrivate) {
      setTimeout(() => {
        const index = allBubbles.findIndex(b => b.id === bubbleData.id);
        if (index > -1) {
          allBubbles.splice(index, 1);
          io.emit('bubbleExpired', bubbleData.id);
          console.log(`⏰ 气泡过期: ${bubbleData.title}`);
        }
      }, bubbleData.duration * 1000);
    }
  });
  
  // 加入聊天室
  socket.on('joinChatroom', (chatroomId) => {
    socket.join(chatroomId);
    
    if (!chatrooms.has(chatroomId)) {
      chatrooms.set(chatroomId, { messages: [], members: [] });
    }
    
    const chatroom = chatrooms.get(chatroomId);
    const user = onlineUsers.get(socket.userId);
    
    if (user && !chatroom.members.includes(socket.userId)) {
      chatroom.members.push(socket.userId);
    }
    
    // 发送历史消息
    socket.emit('chatroomHistory', chatroom.messages);
    
    // 通知聊天室人数
    io.to(chatroomId).emit('chatroomOnline', chatroom.members.length);
    
    console.log(`🚪 用户加入聊天室: ${chatroomId}`);
  });
  
  // 聊天室消息
  socket.on('chatroomMessage', ({ chatroomId, message }) => {
    const user = onlineUsers.get(socket.userId);
    if (!user) return;
    
    const msgData = {
      nickname: user.nickname,
      avatar: user.avatar,
      content: message,
      timestamp: Date.now()
    };
    
    const chatroom = chatrooms.get(chatroomId);
    if (chatroom) {
      chatroom.messages.push(msgData);
    }
    
    // 广播给聊天室所有人
    io.to(chatroomId).emit('chatroomMessage', msgData);
    console.log(`💬 聊天室消息 [${chatroomId}]: ${user.nickname}: ${message}`);
  });
  
  // 离开聊天室
  socket.on('leaveChatroom', (chatroomId) => {
    socket.leave(chatroomId);
    
    const chatroom = chatrooms.get(chatroomId);
    if (chatroom) {
      const index = chatroom.members.indexOf(socket.userId);
      if (index > -1) {
        chatroom.members.splice(index, 1);
      }
      io.to(chatroomId).emit('chatroomOnline', chatroom.members.length);
    }
    
    console.log(`🚪 用户离开聊天室: ${chatroomId}`);
  });
  
  // 好友聊天
  socket.on('friendMessage', ({ friendId, message }) => {
    const user = onlineUsers.get(socket.userId);
    if (!user) return;
    
    const chatKey = [socket.userId, friendId].sort().join('_');
    if (!friendChats.has(chatKey)) {
      friendChats.set(chatKey, []);
    }
    
    const msgData = {
      from: socket.userId,
      to: friendId,
      nickname: user.nickname,
      avatar: user.avatar,
      content: message,
      timestamp: Date.now()
    };
    
    friendChats.get(chatKey).push(msgData);
    
    // 发送给好友
    const friend = onlineUsers.get(friendId);
    if (friend) {
      io.to(friend.socketId).emit('friendMessage', msgData);
    }
    
    console.log(`💌 好友消息: ${user.nickname} -> ${friendId}: ${message}`);
  });
  
  // 用户断开
  socket.on('disconnect', () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      console.log(`👋 用户断开: ${socket.userId}`);
    }
    io.emit('onlineCount', onlineUsers.size);
  });
});

// ==================== 启动服务器 ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📡 Socket.IO 已启用`);
});
