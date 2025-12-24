const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// サーバー起動時刻を記録
const serverStartTime = Date.now();

// 静的ファイルを提供
app.use(express.static(path.join(__dirname, 'public')));

// ルーム管理
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('新しいクライアントが接続しました:', socket.id);

    // サーバー起動時刻を送信
    socket.emit('server-info', { 
        startTime: serverStartTime 
    });

    // ルーム作成
    socket.on('create-room', (data) => {
        const roomId = data.roomId;
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                id: roomId,
                operators: [],
                queue: [],
                displayConnection: null,
                settings: {}
            });
            console.log(`ルーム作成: ${roomId}`);
        }
        
        socket.emit('room-created', { roomId: roomId });
        updateRoomList();
    });

    // ルーム削除
    socket.on('delete-room', (data) => {
        const roomId = data.roomId;
        
        if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            
            // 接続中のクライアントに通知
            room.operators.forEach(op => {
                io.to(op.socketId).emit('room-deleted', { roomId });
            });
            
            if (room.displayConnection) {
                io.to(room.displayConnection).emit('room-deleted', { roomId });
            }
            
            rooms.delete(roomId);
            console.log(`ルーム削除: ${roomId}`);
            updateRoomList();
        }
    });

    // オペレーターがルームに参加
    socket.on('join-room', (data) => {
        const { roomId, operatorName } = data;
        
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: 'ルームが存在しません' });
            return;
        }
        
        const room = rooms.get(roomId);
        
        // 既に参加しているか確認
        const existingOperator = room.operators.find(op => op.socketId === socket.id);
        if (existingOperator) {
            socket.emit('error', { message: '既に参加しています' });
            return;
        }
        
        const operator = {
            socketId: socket.id,
            name: operatorName,
            joinedAt: Date.now()
        };
        
        room.operators.push(operator);
        socket.join(roomId);
        
        socket.emit('joined-room', { 
            roomId, 
            operatorName,
            operators: room.operators 
        });
        
        // 他のオペレーターに通知
        socket.to(roomId).emit('operator-joined', { 
            operators: room.operators 
        });
        
        console.log(`${operatorName} がルーム ${roomId} に参加`);
    });

    // ディスプレイがルームに接続
    socket.on('join-display', (data) => {
        const { roomId } = data;
        
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: 'ルームが存在しません' });
            return;
        }
        
        const room = rooms.get(roomId);
        room.displayConnection = socket.id;
        socket.join(roomId);
        
        socket.emit('display-connected', { roomId });
        console.log(`ディスプレイがルーム ${roomId} に接続`);
    });

    // 字幕送信
    socket.on('send-subtitle', (data) => {
        const { roomId, text, operatorName } = data;
        
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: 'ルームが存在しません' });
            return;
        }
        
        const room = rooms.get(roomId);
        
        // ディスプレイに送信
        if (room.displayConnection) {
            io.to(room.displayConnection).emit('subtitle', {
                text,
                operatorName,
                timestamp: Date.now()
            });
        }
        
        console.log(`[${roomId}] ${operatorName}: ${text}`);
    });

    // キューに追加
    socket.on('add-to-queue', (data) => {
        const { roomId, text, operatorName } = data;
        
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: 'ルームが存在しません' });
            return;
        }
        
        const room = rooms.get(roomId);
        const queueItem = {
            id: Date.now(),
            text,
            operatorName,
            timestamp: Date.now()
        };
        
        room.queue.push(queueItem);
        
        // 全オペレーターにキュー更新を通知
        io.to(roomId).emit('queue-updated', { queue: room.queue });
    });

    // キューから送信
    socket.on('send-from-queue', (data) => {
        const { roomId, queueId } = data;
        
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: 'ルームが存在しません' });
            return;
        }
        
        const room = rooms.get(roomId);
        const queueIndex = room.queue.findIndex(item => item.id === queueId);
        
        if (queueIndex === -1) {
            socket.emit('error', { message: 'キューアイテムが見つかりません' });
            return;
        }
        
        const queueItem = room.queue[queueIndex];
        
        // ディスプレイに送信
        if (room.displayConnection) {
            io.to(room.displayConnection).emit('subtitle', {
                text: queueItem.text,
                operatorName: queueItem.operatorName,
                timestamp: Date.now()
            });
        }
        
        // キューから削除
        room.queue.splice(queueIndex, 1);
        
        // 全オペレーターにキュー更新を通知
        io.to(roomId).emit('queue-updated', { queue: room.queue });
    });

    // キューから削除
    socket.on('remove-from-queue', (data) => {
        const { roomId, queueId } = data;
        
        if (!rooms.has(roomId)) {
            socket.emit('error', { message: 'ルームが存在しません' });
            return;
        }
        
        const room = rooms.get(roomId);
        const queueIndex = room.queue.findIndex(item => item.id === queueId);
        
        if (queueIndex !== -1) {
            room.queue.splice(queueIndex, 1);
            io.to(roomId).emit('queue-updated', { queue: room.queue });
        }
    });

    // 管理者による再起動
    socket.on('restart-server', (data) => {
        const { authToken } = data;
        
        // 簡易的な認証（環境変数で管理）
        const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'default-admin-token';
        
        if (authToken !== ADMIN_TOKEN) {
            socket.emit('restart-error', { message: '権限がありません' });
            console.log('不正な再起動試行:', socket.id);
            return;
        }
        
        console.log('管理者による再起動要求を受信');
        
        // 全クライアントに通知
        io.emit('server-restarting', { 
            message: 'サーバーを再起動します。30秒ほどお待ちください',
            countdown: 30
        });
        
        // 5秒後にプロセスを終了（Herokuが自動的に再起動）
        setTimeout(() => {
            console.log('サーバーを再起動します...');
            process.exit(0);
        }, 5000);
    });

    // 切断処理
    socket.on('disconnect', () => {
        console.log('クライアントが切断しました:', socket.id);
        
        // 全ルームをチェックしてオペレーターを削除
        rooms.forEach((room, roomId) => {
            const operatorIndex = room.operators.findIndex(op => op.socketId === socket.id);
            
            if (operatorIndex !== -1) {
                room.operators.splice(operatorIndex, 1);
                console.log(`オペレーターがルーム ${roomId} から退出`);
                
                // 他のオペレーターに通知
                io.to(roomId).emit('operator-left', { 
                    operators: room.operators 
                });
            }
            
            // ディスプレイの切断
            if (room.displayConnection === socket.id) {
                room.displayConnection = null;
                console.log(`ディスプレイがルーム ${roomId} から切断`);
            }
        });
    });

    // ルームリスト更新を全管理画面に送信
    function updateRoomList() {
        const roomList = Array.from(rooms.values()).map(room => ({
            id: room.id,
            operatorCount: room.operators.length,
            hasDisplay: !!room.displayConnection,
            queueLength: room.queue.length
        }));
        
        io.emit('room-list-updated', { rooms: roomList });
    }
});

// グレースフルシャットダウン（SIGTERM対応）
process.on('SIGTERM', () => {
    console.log('SIGTERM受信、サーバーをシャットダウンします...');
    
    // 全クライアントに通知
    io.emit('server-restarting', { 
        message: 'サーバーがメンテナンスのため再起動します',
        countdown: 10
    });
    
    setTimeout(() => {
        server.close(() => {
            console.log('サーバーが正常に終了しました');
            process.exit(0);
        });
    }, 2000);
});

server.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
    console.log(`起動時刻: ${new Date(serverStartTime).toLocaleString('ja-JP')}`);
});
