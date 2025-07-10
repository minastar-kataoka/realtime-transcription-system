const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // JSON解析用ミドルウェア

// メインページ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 表示専用画面（プロジェクター用）
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// 参加者管理
let participants = [];
let currentSenderIndex = 0; // 現在の送信権保持者のインデックス

// ログデータ管理
let sessionLog = [];
let sessionStartTime = new Date();

// ログをリセット（新しいセッション開始時）
function resetSessionLog() {
  sessionLog = [];
  sessionStartTime = new Date();
  console.log('セッションログをリセットしました');
}

// メッセージをログに追加
function addMessageToLog(message, sender) {
  const logEntry = {
    id: Date.now(),
    timestamp: new Date(),
    sender: sender,
    text: message,
    sessionTime: Date.now() - sessionStartTime.getTime() // セッション開始からの経過時間（ms）
  };
  sessionLog.push(logEntry);
  console.log(`ログ追加: [${sender}] ${message}`);
}

// CSV生成関数
function generateCSV(type) {
  console.log(`CSV生成開始: ${type}, ログ件数: ${sessionLog.length}`);
  
  if (sessionLog.length === 0) {
    console.log('ログデータなし');
    return 'データがありません\n';
  }

  let csvContent = '';
  
  if (type === 'text-only') {
    // テキストのみのCSV
    csvContent = 'テキスト\n';
    sessionLog.forEach((entry, index) => {
      // CSVエスケープ処理
      const escapedText = `"${entry.text.replace(/"/g, '""')}"`;
      csvContent += `${escapedText}\n`;
      console.log(`テキスト追加 ${index + 1}: ${entry.text.substring(0, 20)}...`);
    });
  } else if (type === 'with-timecode') {
    // タイムコード付きCSV
    csvContent = '送信者,送信時刻,経過時間,テキスト\n';
    sessionLog.forEach((entry, index) => {
      const timeString = entry.timestamp.toLocaleTimeString('ja-JP');
      const elapsedSeconds = Math.floor(entry.sessionTime / 1000);
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      const remainingSeconds = elapsedSeconds % 60;
      const timecode = `${elapsedMinutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
      
      // CSVエスケープ処理
      const escapedSender = `"${entry.sender.replace(/"/g, '""')}"`;
      const escapedText = `"${entry.text.replace(/"/g, '""')}"`;
      
      csvContent += `${escapedSender},${timeString},${timecode},${escapedText}\n`;
      console.log(`タイムコード追加 ${index + 1}: [${entry.sender}] ${entry.text.substring(0, 20)}...`);
    });
  }
  
  console.log(`CSV生成完了: ${csvContent.length}文字`);
  return csvContent;
}

// ログエクスポート用エンドポイント
app.get('/api/export/:type', (req, res) => {
  const type = req.params.type;
  console.log(`エクスポートリクエスト受信: ${type}`);
  console.log(`現在のログ件数: ${sessionLog.length}`);
  
  if (type !== 'text-only' && type !== 'with-timecode') {
    console.error(`無効なエクスポートタイプ: ${type}`);
    return res.status(400).json({ error: '無効なエクスポートタイプです' });
  }
  
  try {
    const csvData = generateCSV(type);
    console.log(`CSV生成完了: ${csvData.length}文字`);
    
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const filename = type === 'text-only' 
      ? `transcription_text_${timestamp}.csv`
      : `transcription_timecode_${timestamp}.csv`;
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // UTF-8 BOM を追加（Excelでの文字化け防止）
    const bom = '\uFEFF';
    const responseData = bom + csvData;
    
    console.log(`レスポンス送信: ${filename} (${responseData.length}文字)`);
    res.send(responseData);
    
  } catch (error) {
    console.error('CSV生成エラー:', error);
    res.status(500).json({ error: 'CSV生成に失敗しました', details: error.message });
  }
});

// ログ統計情報取得
app.get('/api/log-stats', (req, res) => {
  const stats = {
    totalMessages: sessionLog.length,
    sessionStartTime: sessionStartTime,
    currentTime: new Date(),
    sessionDuration: Date.now() - sessionStartTime.getTime(),
    participants: participants.map(p => ({
      name: p.name,
      messageCount: sessionLog.filter(log => log.sender === p.name).length
    }))
  };
  
  res.json(stats);
});

// ログクリア
app.post('/api/clear-log', (req, res) => {
  resetSessionLog();
  res.json({ success: true, message: 'ログをクリアしました' });
});

// 送信権を次に移す関数
function rotateSender() {
  if (participants.length === 0) {
    currentSenderIndex = 0;
    return null;
  }
  
  currentSenderIndex = (currentSenderIndex + 1) % participants.length;
  return participants[currentSenderIndex];
}

// 現在の送信権保持者を取得
function getCurrentSender() {
  if (participants.length === 0) {
    console.log('参加者がいないため送信権者なし');
    return null;
  }
  if (currentSenderIndex >= participants.length) {
    console.log('送信権インデックスが範囲外、リセット');
    currentSenderIndex = 0;
  }
  const sender = participants[currentSenderIndex];
  console.log('現在の送信権者取得:', sender ? sender.name : 'なし', 'インデックス:', currentSenderIndex);
  return sender;
}

// 参加者が減った時の送信権調整
function adjustSenderIndex() {
  if (participants.length === 0) {
    currentSenderIndex = 0;
  } else if (currentSenderIndex >= participants.length) {
    currentSenderIndex = 0;
  }
}

// Socket.io接続処理
io.on('connection', (socket) => {
  console.log('新しいユーザーが接続しました:', socket.id);
  
  // 参加者登録
  socket.on('join', (data) => {
    const participant = {
      id: socket.id,
      name: data.name,
      joinTime: new Date()
    };
    
    participants.push(participant);
    console.log(`${data.name} が参加しました (${socket.id})`);
    console.log('現在の参加者数:', participants.length);
    
    // 最初の参加者の場合、セッションログをリセット
    if (participants.length === 1) {
      resetSessionLog();
    }
    
    // 送信権を調整（新しい参加者が入った場合）
    const currentSender = getCurrentSender();
    console.log('現在の送信権者:', currentSender ? currentSender.name : 'なし');
    console.log('送信権インデックス:', currentSenderIndex);
    
    // 実際のサーバーIPアドレスを取得
    const networkInterfaces = os.networkInterfaces();
    let serverIP = 'localhost';
    
    // LAN内IPアドレスを見つける
    Object.keys(networkInterfaces).forEach((interfaceName) => {
        networkInterfaces[interfaceName].forEach((network) => {
            if (network.family === 'IPv4' && !network.internal) {
                serverIP = network.address; // 例: 192.168.1.100
            }
        });
    });
    
    // 参加者本人に参加完了とサーバー情報を通知
    socket.emit('joined', { 
        success: true, 
        participant,
        serverInfo: {
            ip: serverIP,
            port: PORT,
            operatorUrl: `http://${serverIP}:${PORT}`,
            displayUrl: `http://${serverIP}:${PORT}/display`
        }
    });
    
    // 全員に参加者一覧と送信権情報を送信
    io.emit('participants_updated', {
      participants: participants,
      currentSender: currentSender,
      senderIndex: currentSenderIndex
    });
  });
  
  // 送信権を次に移す
  socket.on('next_sender', () => {
    const currentSender = getCurrentSender();
    console.log('next_sender呼び出し - 現在の送信権者:', currentSender ? currentSender.name : 'なし');
    console.log('リクエスト者ID:', socket.id);
    
    // 送信権を持つ人だけが次に移せる
    if (!currentSender || currentSender.id !== socket.id) {
      console.log('送信権エラー: 権限がない');
      socket.emit('error', { message: '送信権がありません' });
      return;
    }
    
    const nextSender = rotateSender();
    console.log(`送信権が ${currentSender.name} から ${nextSender?.name || '(なし)'} に移りました`);
    console.log('新しい送信権インデックス:', currentSenderIndex);
    
    // 全員に送信権更新を通知
    io.emit('sender_updated', {
      currentSender: nextSender,
      senderIndex: currentSenderIndex
    });
  });
  
  // テキスト送信
  socket.on('send_text', (data) => {
    const currentSender = getCurrentSender();
    
    // 送信権を持つ人だけが送信可能
    if (!currentSender || currentSender.id !== socket.id) {
      socket.emit('error', { message: '送信権がありません' });
      return;
    }
    
    const message = {
      id: Date.now(),
      text: data.text,
      sender: currentSender.name,
      timestamp: new Date()
    };
    
    console.log(`${currentSender.name} がテキストを送信: "${data.text}"`);
    
    // ログに追加
    addMessageToLog(data.text, currentSender.name);
    
    // 全員にメッセージを送信
    io.emit('text_received', message);
    
    // 自動で次の人に送信権を移す
    const nextSender = rotateSender();
    console.log(`送信権が ${currentSender.name} から ${nextSender?.name || '(なし)'} に移りました（送信により）`);
    
    // 全員に送信権更新を通知
    io.emit('sender_updated', {
      currentSender: nextSender,
      senderIndex: currentSenderIndex
    });
  });
  
  // リアルタイム入力
  socket.on('typing', (data) => {
    const participant = participants.find(p => p.id === socket.id);
    if (!participant) return;
    
    // 他の全員に入力内容を送信（送信者以外）
    socket.broadcast.emit('user_typing', {
      userId: socket.id,
      userName: participant.name,
      text: data.text,
      timestamp: new Date()
    });
  });
  
  // 入力クリア（送信時）
  socket.on('clear_typing', () => {
    const participant = participants.find(p => p.id === socket.id);
    if (!participant) return;
    
    // 他の全員に入力クリアを通知
    socket.broadcast.emit('user_clear_typing', {
      userId: socket.id
    });
  });
  
  // 切断処理
  socket.on('disconnect', () => {
    const participant = participants.find(p => p.id === socket.id);
    if (participant) {
      const wasCurrentSender = getCurrentSender()?.id === socket.id;
      
      participants = participants.filter(p => p.id !== socket.id);
      console.log(`${participant.name} が退出しました (${socket.id})`);
      
      // 送信権を調整
      adjustSenderIndex();
      const newCurrentSender = getCurrentSender();
      
      if (wasCurrentSender && newCurrentSender) {
        console.log(`送信権が ${newCurrentSender.name} に移りました（退出により）`);
      }
      
      // 全員に更新された参加者一覧と送信権情報を送信
      io.emit('participants_updated', {
        participants: participants,
        currentSender: newCurrentSender,
        senderIndex: currentSenderIndex
      });
    } else {
      console.log('ユーザーが切断しました:', socket.id);
    }
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? undefined : '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('=================================');
  console.log(`サーバーが起動しました！`);
  console.log(`ポート: ${PORT}`);
  console.log('=================================');
  
  // LAN内のIPアドレスを表示
  const networkInterfaces = os.networkInterfaces();
  console.log('アクセス可能なURL:');
  console.log(`- ローカル: http://localhost:${PORT}`);
  
  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName].forEach((network) => {
      if (network.family === 'IPv4' && !network.internal) {
        console.log(`- LAN内: http://${network.address}:${PORT}`);
      }
    });
  });
  console.log('=================================');
});