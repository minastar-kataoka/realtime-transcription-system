const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const os = require('os');

// DeepL API統合
const deepl = require('deepl-node');

const app = express();
const server = http.createServer(app);

// Socket.IOのCORS設定を追加
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

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

// ログ表示ページ
app.get('/logs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// 管理画面（新規追加）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 翻訳テストページ（新規追加）
app.get('/translation-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'translation-test.html'));
});

// 参加者管理
let participants = [];
let currentSenderIndex = 0; // 現在の送信権保持者のインデックス

// ログデータ管理
let sessionLog = [];
let sessionStartTime = new Date();

// テイク機能管理（新規追加）
let systemMode = 'realtime'; // 'realtime' | 'take'
let takeQueue = [];
let isEmergencyMode = false;

// 翻訳機能管理（新規追加）
let translationConfig = {
  enabled: false,
  targetLanguage: 'en-US', // 英語（アメリカ）に修正
  apiKey: process.env.DEEPL_API_KEY || null
};

// DeepL翻訳クライアント初期化
let translator = null;
function initializeTranslator() {
  if (translationConfig.apiKey) {
    try {
      // DeepL Free APIを使用（無料版の場合）
      translator = new deepl.Translator(translationConfig.apiKey);
      console.log('DeepL翻訳クライアント初期化完了');
    } catch (error) {
      console.error('DeepL翻訳クライアント初期化失敗:', error);
    }
  } else {
    console.warn('DEEPL_API_KEYが設定されていません');
  }
}

// 翻訳機能
async function translateText(text) {
  if (!translator) {
    throw new Error('翻訳クライアントが初期化されていません');
  }

  try {
    console.log(`翻訳開始: "${text}" -> ${translationConfig.targetLanguage}`);
    
    // DeepL APIで翻訳実行
    const result = await translator.translateText(
      text, 
      'ja', // 日本語から
      translationConfig.targetLanguage // 英語へ
    );
    
    console.log(`翻訳完了: "${result.text}"`);
    
    return {
      originalText: text,
      translatedText: result.text,
      sourceLang: 'ja',
      targetLang: translationConfig.targetLanguage,
      detectedSourceLang: result.detectedSourceLang || 'ja'
    };
  } catch (error) {
    console.error('翻訳エラー:', error);
    throw new Error(`翻訳に失敗しました: ${error.message}`);
  }
}

// キュー設定
const queueSettings = {
  warnThreshold: 500,
  criticalThreshold: 800,
  emergencyThreshold: 1000,
  returnMargin: 200
};

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

// テイクキューにメッセージを追加
function addToTakeQueue(message, sender) {
  const queueItem = {
    id: Date.now(),
    timestamp: new Date(),
    sender: sender,
    text: message,
    status: 'waiting'
  };
  
  takeQueue.push(queueItem);
  console.log(`テイクキューに追加: [${sender}] ${message}`);
  
  // キューの状態チェック
  checkQueueStatus();
  
  // 管理画面にキュー更新を通知
  io.to('admin').emit('take_queue_updated', {
    queue: takeQueue,
    count: takeQueue.length
  });
}

// キューの状態チェック
function checkQueueStatus() {
  const currentSize = takeQueue.length;
  
  console.log(`キュー状態チェック: ${currentSize}/${queueSettings.emergencyThreshold}件`);
  
  if (currentSize >= queueSettings.emergencyThreshold) {
    // 緊急: 強制リアルタイムモード切替
    if (systemMode === 'take') {
      console.log('🚨 緊急自動切替: キューが満杯になりました');
      systemMode = 'realtime';
      isEmergencyMode = true;
      
      // 全クライアントに通知
      io.emit('system_mode_changed', { 
        mode: 'realtime',
        reason: 'emergency_queue_full'
      });
      
      // 管理画面に緊急切替を通知
      io.to('admin').emit('emergency_realtime_switched', {
        reason: 'キュー緊急満杯',
        queueSize: currentSize,
        message: 'テイクモードを緊急停止し、リアルタイム送出に切替ました'
      });
    }
  } else if (currentSize >= queueSettings.criticalThreshold) {
    // 危険レベル警告
    io.to('admin').emit('queue_critical', {
      count: currentSize,
      threshold: queueSettings.criticalThreshold,
      message: '⚠️ 危険: まもなく自動切替されます'
    });
  } else if (currentSize >= queueSettings.warnThreshold) {
    // 注意レベル警告
    io.to('admin').emit('queue_warning', {
      count: currentSize,
      threshold: queueSettings.warnThreshold,
      message: '⚠️ 注意: キューが蓄積しています'
    });
  }
}

// 復帰可能性チェック
function checkReturnAvailability() {
  if (isEmergencyMode && systemMode === 'realtime') {
    const returnThreshold = queueSettings.emergencyThreshold - queueSettings.returnMargin;
    
    if (takeQueue.length <= returnThreshold) {
      io.to('admin').emit('take_mode_available', {
        currentQueue: takeQueue.length,
        threshold: returnThreshold,
        message: `キューが${returnThreshold}件以下になりました。テイクモードに復帰できます`
      });
    }
  }
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

// メッセージ一覧を取得するAPI
app.get('/api/messages', (req, res) => {
  console.log(`メッセージ一覧取得: ${sessionLog.length}件`);
  res.json({
    success: true,
    messages: sessionLog,
    totalMessages: sessionLog.length,
    sessionStartTime: sessionStartTime
  });
});

// システム状態取得API（新規追加）
app.get('/api/system-status', (req, res) => {
  res.json({
    success: true,
    mode: systemMode,
    takeQueue: takeQueue,
    queueCount: takeQueue.length,
    isEmergencyMode: isEmergencyMode,
    queueSettings: queueSettings,
    translation: {
      enabled: translationConfig.enabled,
      targetLanguage: translationConfig.targetLanguage,
      hasApiKey: !!translationConfig.apiKey
    }
  });
});

// 翻訳設定取得API（新規追加）
app.get('/api/translation-config', (req, res) => {
  res.json({
    success: true,
    config: {
      enabled: translationConfig.enabled,
      targetLanguage: translationConfig.targetLanguage,
      hasApiKey: !!translationConfig.apiKey
    }
  });
});

// 翻訳設定更新API（新規追加）
app.post('/api/translation-config', (req, res) => {
  try {
    const { enabled, targetLanguage } = req.body;
    
    if (typeof enabled === 'boolean') {
      translationConfig.enabled = enabled;
    }
    
    if (targetLanguage && (targetLanguage === 'en-US' || targetLanguage === 'en-GB')) {
      translationConfig.targetLanguage = targetLanguage;
    }
    
    console.log('翻訳設定更新:', translationConfig);
    
    // 管理画面に設定変更を通知
    io.to('admin').emit('translation_config_updated', {
      config: {
        enabled: translationConfig.enabled,
        targetLanguage: translationConfig.targetLanguage,
        hasApiKey: !!translationConfig.apiKey
      }
    });
    
    res.json({
      success: true,
      config: {
        enabled: translationConfig.enabled,
        targetLanguage: translationConfig.targetLanguage,
        hasApiKey: !!translationConfig.apiKey
      }
    });
  } catch (error) {
    console.error('翻訳設定更新エラー:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

// 音声認識システム状態確認API
app.get('/api/speech-integration/status', (req, res) => {
  res.json({
    success: true,
    systemMode: systemMode,
    queueCount: takeQueue.length,
    isEmergencyMode: isEmergencyMode,
    translationEnabled: translationConfig.enabled,
    timestamp: new Date()
  });
});

// 音声認識テスト用API
app.post('/api/speech-integration/test', (req, res) => {
  const { text, language } = req.body;
  
  if (!text) {
    return res.status(400).json({
      success: false,
      error: 'テキストが必要です'
    });
  }
  
  // テスト用の音声認識結果としてシステムに送信
  const testResult = {
    text: text,
    language: language || 'ja-JP',
    confidence: 0.95,
    sender: 'テスト送信',
    source: 'speech_test'
  };
  
  // 実際の音声認識結果と同じ処理を実行
  if (systemMode === 'realtime') {
    const message = {
      id: Date.now(),
      text: testResult.text,
      sender: testResult.sender,
      timestamp: new Date(),
      isFromSpeech: true,
      language: testResult.language,
      confidence: testResult.confidence,
      source: 'speech_test'
    };
    
    addMessageToLog(testResult.text, testResult.sender);
    io.emit('text_received', message);
    
  } else if (systemMode === 'take') {
    addToTakeQueue(testResult.text, testResult.sender);
  }
  
  res.json({
    success: true,
    mode: systemMode,
    message: `テスト送信完了（${systemMode}モード）`,
    result: testResult
  });
});
// === 音声認識連携API終了 ===

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
  
  // 管理画面からの接続を識別
  socket.on('join_admin', () => {
    socket.join('admin');
    console.log('管理画面が接続しました:', socket.id);
    
    // 現在のシステム状態を送信
    socket.emit('system_status', {
      mode: systemMode,
      takeQueue: takeQueue,
      queueCount: takeQueue.length,
      isEmergencyMode: isEmergencyMode
    });
    
    // 翻訳設定も送信
    socket.emit('translation_config', {
      enabled: translationConfig.enabled,
      targetLanguage: translationConfig.targetLanguage,
      hasApiKey: !!translationConfig.apiKey
    });
  });
  
  // システム状態取得要求
  socket.on('get_system_status', () => {
    socket.emit('system_status', {
      mode: systemMode,
      takeQueue: takeQueue,
      queueCount: takeQueue.length,
      isEmergencyMode: isEmergencyMode
    });
  });
  
  // 翻訳設定取得要求（新規追加）
  socket.on('get_translation_config', () => {
    socket.emit('translation_config', {
      enabled: translationConfig.enabled,
      targetLanguage: translationConfig.targetLanguage,
      hasApiKey: !!translationConfig.apiKey
    });
  });
  
  // 翻訳設定更新（APIキー含む）- テストページ専用（新規追加）
  socket.on('update_translation_config_with_key', (data) => {
    try {
      console.log('翻訳設定更新要求（APIキー含む）:', {
        enabled: data.enabled,
        hasApiKey: !!data.apiKey
      });
      
      // 翻訳機能の有効/無効を更新
      if (typeof data.enabled === 'boolean') {
        translationConfig.enabled = data.enabled;
      }
      
      // APIキーを更新（空文字列でない場合のみ）
      if (data.apiKey && data.apiKey.trim().length > 0) {
        translationConfig.apiKey = data.apiKey.trim();
        
        // 新しいAPIキーで翻訳クライアントを再初期化
        try {
          translator = new deepl.Translator(translationConfig.apiKey);
          console.log('翻訳クライアントを新しいAPIキーで再初期化しました');
        } catch (error) {
          console.error('翻訳クライアント初期化エラー:', error);
          throw new Error(`APIキーが無効です: ${error.message}`);
        }
      }
      
      console.log('翻訳設定更新完了:', {
        enabled: translationConfig.enabled,
        hasApiKey: !!translationConfig.apiKey
      });
      
      // 更新完了を通知
      socket.emit('translation_config_updated', {
        success: true,
        config: {
          enabled: translationConfig.enabled,
          targetLanguage: translationConfig.targetLanguage,
          hasApiKey: !!translationConfig.apiKey
        }
      });
      
    } catch (error) {
      console.error('翻訳設定更新エラー:', error);
      socket.emit('translation_config_updated', {
        success: false,
        error: error.message
      });
    }
  });
  
  // 翻訳実行要求（新規追加）
  socket.on('execute_translation', async (data) => {
    try {
      console.log('翻訳実行要求:', data);
      
      if (!data.text || typeof data.text !== 'string') {
        throw new Error('翻訳対象テキストが無効です');
      }
      
      if (!translationConfig.apiKey) {
        throw new Error('DeepL APIキーが設定されていません');
      }
      
      // テストページからの場合は、機能無効でも翻訳を実行
      if (!translationConfig.enabled && !data.forceTest) {
        throw new Error('翻訳機能が有効ではありません');
      }
      
      // 翻訳実行（APIキーがあれば機能無効でも実行）
      if (!translator) {
        initializeTranslator();
      }
      
      const result = await translateText(data.text);
      
      socket.emit('translation_result', {
        success: true,
        result: result
      });
      
    } catch (error) {
      console.error('翻訳実行エラー:', error);
      socket.emit('translation_result', {
        success: false,
        error: error.message
      });
    }
  });
  
  // 翻訳済みテキスト送出（新規追加）
  socket.on('send_translated_text', (data) => {
    if (systemMode === 'take') {
      const message = {
        id: Date.now(),
        text: data.translatedText,
        sender: 'テイク担当者（翻訳版）',
        timestamp: new Date(),
        isTranslated: true,
        originalText: data.originalText,
        targetLanguage: translationConfig.targetLanguage
      };
      
      console.log(`翻訳版テキスト送出: "${data.translatedText}"`);
      
      // ログに追加
      addMessageToLog(data.translatedText, 'テイク担当者（翻訳版）');
      
      // 表示画面に送信
      io.emit('text_received', message);
      
      // 送出完了を通知
      socket.emit('translated_text_sent', {
        success: true,
        message: '翻訳版テキストを送出しました'
      });
    }
  });
  
  // システムモード切り替え
  socket.on('toggle_system_mode', (data) => {
    const newMode = data.mode;
    console.log(`システムモード切り替え要求: ${systemMode} → ${newMode}`);
    
    if (newMode === 'take' && isEmergencyMode) {
      // 緊急モードからの復帰チェック
      const returnThreshold = queueSettings.emergencyThreshold - queueSettings.returnMargin;
      if (takeQueue.length > returnThreshold) {
        socket.emit('mode_change_error', {
          message: `キューが${takeQueue.length}件です。${returnThreshold}件以下にしてから復帰してください`
        });
        return;
      }
      isEmergencyMode = false;
    }
    
    systemMode = newMode;
    console.log(`システムモード変更完了: ${systemMode}`);
    
    // 全クライアントに通知
    io.emit('system_mode_changed', { 
      mode: systemMode,
      reason: 'manual_change'
    });
    
    // 管理画面に状態更新を送信
    io.to('admin').emit('system_status', {
      mode: systemMode,
      takeQueue: takeQueue,
      queueCount: takeQueue.length,
      isEmergencyMode: isEmergencyMode
    });
  });
  
  // テイクモード復帰
  socket.on('return_to_take_mode', () => {
    const returnThreshold = queueSettings.emergencyThreshold - queueSettings.returnMargin;
    
    if (takeQueue.length > returnThreshold) {
      socket.emit('return_error', {
        message: `キューが${takeQueue.length}件です。${returnThreshold}件以下にしてから復帰してください（あと${takeQueue.length - returnThreshold}件処理が必要）`
      });
      return;
    }
    
    systemMode = 'take';
    isEmergencyMode = false;
    
    io.emit('system_mode_changed', { 
      mode: 'take', 
      reason: 'manual_return' 
    });
    
    socket.emit('return_success', {
      message: `テイクモードに復帰しました（キュー: ${takeQueue.length}件）`
    });
  });
  
  // 次のテキストを呼び出し
  socket.on('take_call_next', () => {
    if (takeQueue.length > 0 && systemMode === 'take') {
      const nextItem = takeQueue.shift(); // 最古のアイテムを取得・削除
      console.log(`テキスト呼び出し: [${nextItem.sender}] ${nextItem.text}`);
      
      // 呼び出し完了を通知
      socket.emit('text_called', {
        text: nextItem.text,
        sender: nextItem.sender,
        timestamp: nextItem.timestamp
      });
      
      // キュー更新を管理画面に通知
      io.to('admin').emit('take_queue_updated', {
        queue: takeQueue,
        count: takeQueue.length
      });
      
      // 復帰可能性をチェック
      checkReturnAvailability();
    }
  });
  
  // テイクからテキスト送出
  socket.on('take_send_text', (data) => {
    if (systemMode === 'take') {
      const message = {
        id: Date.now(),
        text: data.text,
        sender: 'テイク担当者',
        timestamp: new Date()
      };
      
      console.log(`テイクからテキスト送出: "${data.text}"`);
      
      // ログに追加
      addMessageToLog(data.text, 'テイク担当者');
      
      // 表示画面に送信
      io.emit('text_received', message);
      
      // 送出完了を通知
      socket.emit('text_sent', {
        success: true,
        message: 'テキストを送出しました'
      });
    }
  });
  
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
    
    // Heroku対応: 実際のアクセスURLを取得
    let serverUrl;
    if (process.env.NODE_ENV === 'production' || process.env.PORT) {
      // 本番環境（Heroku）の場合
      serverUrl = 'https://minart-bacec6fffc57.herokuapp.com';
    } else {
      // 開発環境（ローカル）の場合
      const networkInterfaces = os.networkInterfaces();
      let serverIP = 'localhost';
      
      Object.keys(networkInterfaces).forEach((interfaceName) => {
          networkInterfaces[interfaceName].forEach((network) => {
              if (network.family === 'IPv4' && !network.internal) {
                  serverIP = network.address;
              }
          });
      });
      
      serverUrl = `http://${serverIP}:${PORT || 3000}`;
    }
    
    // 参加者本人に参加完了とサーバー情報を通知
    socket.emit('joined', { 
        success: true, 
        participant,
        serverInfo: {
            ip: serverUrl.replace(/https?:\/\//, '').split(':')[0],
            port: process.env.PORT || 3000,
            operatorUrl: serverUrl,
            displayUrl: `${serverUrl}/display`
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
    
    console.log(`${currentSender.name} がテキストを送信: "${data.text}"`);
    console.log(`現在のシステムモード: ${systemMode}`);
    
    if (systemMode === 'realtime') {
      // リアルタイムモード: 直接表示画面に送信
      const message = {
        id: Date.now(),
        text: data.text,
        sender: currentSender.name,
        timestamp: new Date()
      };
      
      // ログに追加
      addMessageToLog(data.text, currentSender.name);
      
      // 全員にメッセージを送信（表示画面含む）
      io.emit('text_received', message);
      console.log('リアルタイム送信: text_receivedイベントを送信しました');
      
    } else if (systemMode === 'take') {
      // テイクモード: キューに蓄積
      addToTakeQueue(data.text, currentSender.name);
      console.log('テイクモード: キューに蓄積しました');
    }
    
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
  
  // === 音声認識連携機能 ===
  // 音声認識結果の受信処理（Socket.ioイベントハンドラー内に追加）
  socket.on('speech_recognition_result', (data) => {
    console.log('🎤 音声認識結果受信:', {
      text: data.text.substring(0, 50) + (data.text.length > 50 ? '...' : ''),
      language: data.language,
      confidence: data.confidence,
      sender: data.sender
    });
    
    // 音声認識結果を適切な送信者として設定
    const speechSender = data.sender || 'AI音声認識';
    
    // システムモードに応じて処理
    if (systemMode === 'realtime') {
      console.log('📺 リアルタイムモード: 直接表示画面に送信');
      
      // リアルタイムモード: 直接表示画面に送信
      const message = {
        id: Date.now(),
        text: data.text,
        sender: speechSender,
        timestamp: new Date(),
        isFromSpeech: true,
        language: data.language,
        confidence: data.confidence,
        source: 'speech_recognition'
      };
      
      // ログに追加
      addMessageToLog(data.text, speechSender);
      
      // 全員にメッセージを送信（表示画面含む）
      io.emit('text_received', message);
      console.log('✅ 音声認識結果をリアルタイム送信完了');
      
    } else if (systemMode === 'take') {
      console.log('📋 テイクモード: キューに蓄積');
      
      // テイクモード: キューに蓄積
      addToTakeQueue(data.text, speechSender);
      console.log('✅ 音声認識結果をキューに追加完了');
    }
    
    // 音声認識結果受信の確認応答
    socket.emit('speech_result_received', {
      success: true,
      mode: systemMode,
      message: systemMode === 'realtime' ? '音声認識結果を表示しました' : '音声認識結果をキューに追加しました'
    });
  });
  
  // 音声認識システムの状態確認（オプション）
  socket.on('speech_system_status', () => {
    socket.emit('speech_system_status_response', {
      systemMode: systemMode,
      queueCount: takeQueue.length,
      isEmergencyMode: isEmergencyMode,
      timestamp: new Date()
    });
  });
  
  // === 音声認識連携用のAPI追加 ===
  
  // 音声認識システム状態確認API
  app.get('/api/speech-integration/status', (req, res) => {
    res.json({
      success: true,
      systemMode: systemMode,
      queueCount: takeQueue.length,
      isEmergencyMode: isEmergencyMode,
      translationEnabled: translationConfig.enabled,
      timestamp: new Date()
    });
  });
  
  // 音声認識テスト用API
  app.post('/api/speech-integration/test', (req, res) => {
    const { text, language } = req.body;
    
    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'テキストが必要です'
      });
    }
    
    // テスト用の音声認識結果としてシステムに送信
    const testResult = {
      text: text,
      language: language || 'ja-JP',
      confidence: 0.95,
      sender: 'テスト送信',
      source: 'speech_test'
    };
    
    // 実際の音声認識結果と同じ処理を実行
    if (systemMode === 'realtime') {
      const message = {
        id: Date.now(),
        text: testResult.text,
        sender: testResult.sender,
        timestamp: new Date(),
        isFromSpeech: true,
        language: testResult.language,
        confidence: testResult.confidence,
        source: 'speech_test'
      };
      
      addMessageToLog(testResult.text, testResult.sender);
      io.emit('text_received', message);
      
    } else if (systemMode === 'take') {
      addToTakeQueue(testResult.text, testResult.sender);
    }
    
    res.json({
      success: true,
      mode: systemMode,
      message: `テスト送信完了（${systemMode}モード）`,
      result: testResult
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

// DeepL翻訳クライアント初期化
initializeTranslator();

// サーバー起動
const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? undefined : '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('=================================');
  console.log(`サーバーが起動しました！`);
  console.log(`ポート: ${PORT}`);
  console.log(`システムモード: ${systemMode}`);
  console.log(`管理画面: http://localhost:${PORT}/admin`);
  console.log(`翻訳機能: ${translationConfig.enabled ? '有効' : '無効'}`);
  console.log(`DeepL APIキー: ${translationConfig.apiKey ? '設定済み' : '未設定'}`);
  console.log('=================================');
  
  // LAN内のIPアドレスを表示（開発環境のみ）
  if (process.env.NODE_ENV !== 'production') {
    const networkInterfaces = os.networkInterfaces();
    console.log('アクセス可能なURL:');
    console.log(`- ローカル: http://localhost:${PORT}`);
    
    Object.keys(networkInterfaces).forEach((interfaceName) => {
      networkInterfaces[interfaceName].forEach((network) => {
        if (network.family === 'IPv4' && !network.internal) {
          console.log(`- LAN内: http://${network.address}:${PORT}`);
          console.log(`- 管理画面: http://${network.address}:${PORT}/admin`);
        }
      });
    });
  }
  console.log('=================================');
});