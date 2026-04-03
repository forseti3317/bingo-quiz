const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'question_sets.json');
function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]', 'utf8');
}
function readDb() { ensureDb(); try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return []; } }
function writeDb(data) { ensureDb(); fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8'); }

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/sets', (req, res) => {
  const sets = readDb();
  res.json(sets.map(s => ({ id: s.id, name: s.name, questionCount: s.questions.length, createdAt: s.createdAt, updatedAt: s.updatedAt })));
});
app.get('/api/sets/:id', (req, res) => {
  const set = readDb().find(s => s.id === req.params.id);
  if (!set) return res.status(404).json({ error: '문제 세트를 찾을 수 없습니다' });
  res.json(set);
});
app.post('/api/sets', (req, res) => {
  const { name, questions } = req.body;
  if (!name || !questions || !Array.isArray(questions)) return res.status(400).json({ error: '이름과 문제 목록이 필요합니다' });
  const sets = readDb();
  const newSet = { id: `set_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, questions, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  sets.push(newSet);
  writeDb(sets);
  res.status(201).json(newSet);
});
app.put('/api/sets/:id', (req, res) => {
  const { name, questions } = req.body;
  const sets = readDb();
  const idx = sets.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '문제 세트를 찾을 수 없습니다' });
  if (name) sets[idx].name = name;
  if (questions) sets[idx].questions = questions;
  sets[idx].updatedAt = new Date().toISOString();
  writeDb(sets);
  res.json(sets[idx]);
});
app.delete('/api/sets/:id', (req, res) => {
  let sets = readDb();
  const idx = sets.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '문제 세트를 찾을 수 없습니다' });
  sets.splice(idx, 1);
  writeDb(sets);
  res.json({ success: true });
});

// ── Game State ──────────────────────────────────────────────────────────────
// participants: { [nickname]: { nickname, emoji, board, cellStatus, bingos, boardReady, socketId, disconnected } }
let state = {
  phase: 'setup',
  questions: [],
  participants: {},       // keyed by nickname
  askedIds: [],
  currentQId: null,
  questionAnswers: {},    // keyed by nickname
  votes: {},              // keyed by nickname
  lastCorrectNicknames: [], // nicknames who answered last question correctly
  winner: null,
  timers: {}
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function getParticipantBySid(sid) {
  return Object.values(state.participants).find(p => p.socketId === sid);
}

function resetGame() {
  clearAllTimers();
  state = {
    phase: 'setup',
    questions: [],
    participants: {},
    askedIds: [],
    currentQId: null,
    questionAnswers: {},
    votes: {},
    lastCorrectNicknames: [],
    winner: null,
    timers: {}
  };
}

function clearAllTimers() {
  Object.values(state.timers).forEach(t => { clearTimeout(t); clearInterval(t); });
  state.timers = {};
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function countBingos(board, cellStatus) {
  const active = id => cellStatus[id] === 'correct';
  let bingos = 0;
  for (let r = 0; r < 4; r++) { if ([0,1,2,3].every(c => active(board[r*4+c]))) bingos++; }
  for (let c = 0; c < 4; c++) { if ([0,1,2,3].every(r => active(board[r*4+c]))) bingos++; }
  if ([0,5,10,15].every(i => active(board[i]))) bingos++;
  if ([3,6,9,12].every(i => active(board[i]))) bingos++;
  return bingos;
}

// Public state: participants keyed by socketId (for client lookup by mySocketId)
function getPublicState() {
  const bySocketId = {};
  Object.values(state.participants).forEach(p => {
    bySocketId[p.socketId] = {
      nickname: p.nickname,
      emoji: p.emoji,
      board: p.board,
      cellStatus: p.cellStatus,
      bingos: p.bingos,
      boardReady: p.boardReady,
      disconnected: p.disconnected || false
    };
  });
  return {
    phase: state.phase,
    questions: state.questions.map(q => ({ id: q.id, keyword: q.keyword })),
    participants: bySocketId,
    askedIds: state.askedIds,
    currentQId: state.currentQId,
    winner: state.winner
  };
}

function broadcastState() { io.emit('game:state', getPublicState()); }

// ── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  const isAdmin = socket.handshake.query.role === 'admin';

  socket.emit('game:state', getPublicState());
  if (isAdmin) {
    socket.join('admin');
    socket.emit('admin:questions', state.questions);
  }

  // ── ADMIN ──────────────────────────────────────────────────────────────────
  socket.on('admin:setQuestions', (questions) => {
    if (!isAdmin) return;
    state.questions = questions.map((q, i) => ({ ...q, id: `q${i}` }));
    socket.emit('admin:questions', state.questions);
  });

  socket.on('admin:openLobby', () => {
    if (!isAdmin) return;
    if (state.questions.length < 16) { socket.emit('error', '16개의 문제가 필요합니다.'); return; }
    state.phase = 'lobby';
    broadcastState();
  });

  socket.on('admin:startArrangement', () => {
    if (!isAdmin) return;
    const connected = Object.values(state.participants).filter(p => !p.disconnected).length;
    if (connected === 0) { socket.emit('error', '참가자가 없습니다.'); return; }
    state.phase = 'arrangement';
    broadcastState();
    state.timers.arrangement = setTimeout(() => {
      finalizeArrangements();
      state.phase = 'waiting';
      broadcastState();
    }, 90000);
  });

  socket.on('admin:startGame', () => {
    if (!isAdmin) return;
    clearTimeout(state.timers.arrangement);
    finalizeArrangements();
    state.phase = 'game';
    broadcastState();
    io.emit('game:waitForAdmin');
  });

  socket.on('admin:selectKeyword', (qId) => {
    if (!isAdmin) return;
    if (state.askedIds.includes(qId)) return;
    startQuestion(qId);
  });

  socket.on('admin:reset', () => {
    if (!isAdmin) return;
    resetGame();
    broadcastState();
  });

  socket.on('admin:newGame', () => {
    if (!isAdmin) return;
    clearAllTimers();
    Object.values(state.participants).forEach(p => {
      p.board = null;
      p.cellStatus = {};
      p.bingos = 0;
      p.boardReady = false;
      state.questions.forEach(q => { p.cellStatus[q.id] = null; });
    });
    state.phase = 'lobby';
    state.askedIds = [];
    state.currentQId = null;
    state.questionAnswers = {};
    state.votes = {};
    state.lastCorrectNicknames = [];
    state.winner = null;
    broadcastState();
    io.emit('game:newGame');
  });

  // ── PARTICIPANT ──────────────────────────────────────────────────────────────
  socket.on('participant:join', ({ nickname, emoji }) => {
    // ── Reconnection check ──
    const existing = state.participants[nickname];
    if (existing && (existing.disconnected || existing.socketId !== socket.id)) {
      // Disconnect old socket if still connected
      if (!existing.disconnected && existing.socketId !== socket.id) {
        try { io.sockets.sockets.get(existing.socketId)?.disconnect(true); } catch(e) {}
      }
      // Restore under new socketId
      existing.socketId = socket.id;
      existing.disconnected = false;
      // Mark questions missed while disconnected as wrong
      state.askedIds.forEach(qId => {
        if (existing.cellStatus[qId] === null || existing.cellStatus[qId] === undefined) {
          existing.cellStatus[qId] = 'wrong';
        }
      });
      if (existing.board) existing.bingos = countBingos(existing.board, existing.cellStatus);

      socket.emit('participant:rejoined', {
        nickname: existing.nickname,
        emoji: existing.emoji,
        board: existing.board,
        cellStatus: existing.cellStatus,
        bingos: existing.bingos,
        boardReady: existing.boardReady,
        phase: state.phase,
        currentQId: state.currentQId,
        askedIds: [...state.askedIds]
      });

      // Re-send current game event if needed
      if (state.phase === 'game' && state.currentQId) {
        const q = state.questions.find(q => q.id === state.currentQId);
        if (q) socket.emit('game:question', { qId: state.currentQId, question: q.question });
      } else if (state.phase === 'voting') {
        const remaining = state.questions.filter(q => !state.askedIds.includes(q.id));
        const candidates = remaining.map(q => ({ id: q.id, keyword: q.keyword }));
        const hasCorrect = state.lastCorrectNicknames.length > 0;
        const canVote = !hasCorrect || state.lastCorrectNicknames.includes(nickname);
        socket.emit('game:voting', { candidates, canVote });
      } else if (state.phase === 'ended') {
        // Re-send ended data on reconnect
        const allResults = Object.values(state.participants)
          .map(p => ({ nickname: p.nickname, emoji: p.emoji, bingos: p.bingos, board: p.board, cellStatus: p.cellStatus }))
          .sort((a, b) => b.bingos - a.bingos);
        const w = state.winner ? state.participants[state.winner] : null;
        socket.emit('game:ended', w
          ? { winner: w.nickname, emoji: w.emoji, board: w.board, cellStatus: w.cellStatus, bingos: w.bingos, allResults }
          : { winner: null, allResults });
      }

      broadcastState();
      io.to('admin').emit('admin:participantList', Object.values(state.participants).map(p => ({
        nickname: p.nickname, emoji: p.emoji, boardReady: p.boardReady, disconnected: p.disconnected
      })));
      return;
    }

    // ── New participant ──
    if (state.phase !== 'lobby' && state.phase !== 'arrangement') {
      socket.emit('error', '게임이 이미 진행 중입니다.');
      return;
    }
    if (existing && !existing.disconnected) {
      socket.emit('error', '이미 사용 중인 닉네임입니다.');
      return;
    }

    state.participants[nickname] = {
      nickname, emoji,
      board: null, cellStatus: {},
      bingos: 0, boardReady: false,
      socketId: socket.id, disconnected: false
    };
    state.questions.forEach(q => { state.participants[nickname].cellStatus[q.id] = null; });
    socket.emit('participant:joined', { nickname, emoji });
    broadcastState();
    io.to('admin').emit('admin:participantList', Object.values(state.participants).map(p => ({
      nickname: p.nickname, emoji: p.emoji, boardReady: p.boardReady
    })));
  });

  socket.on('participant:submitBoard', (board) => {
    const p = getParticipantBySid(socket.id);
    if (!p) return;
    p.board = board;
    p.boardReady = true;
    socket.emit('participant:boardConfirmed');
    broadcastState();
    io.to('admin').emit('admin:participantList', Object.values(state.participants).map(p => ({
      nickname: p.nickname, emoji: p.emoji, boardReady: p.boardReady
    })));
  });

  socket.on('participant:answer', (answer) => {
    if (state.phase !== 'game') return;
    const p = getParticipantBySid(socket.id);
    if (!p) return;
    state.questionAnswers[p.nickname] = answer;
  });

  socket.on('participant:vote', (qId) => {
    if (state.phase !== 'voting') return;
    const p = getParticipantBySid(socket.id);
    if (!p) return;
    // Validate eligibility
    const hasCorrect = state.lastCorrectNicknames.length > 0;
    if (hasCorrect && !state.lastCorrectNicknames.includes(p.nickname)) return;
    state.votes[p.nickname] = qId;
    broadcastVotes();
  });

  socket.on('disconnect', () => {
    const p = getParticipantBySid(socket.id);
    if (p) {
      if (['setup', 'lobby'].includes(state.phase)) {
        // Before game starts: remove entirely
        delete state.participants[p.nickname];
      } else {
        // Game in progress: keep data, mark disconnected
        p.disconnected = true;
      }
      broadcastState();
    }
  });
});

// ── Game Logic ──────────────────────────────────────────────────────────────
function finalizeArrangements() {
  const ids = state.questions.map(q => q.id);
  Object.values(state.participants).forEach(p => {
    if (!p.board || p.board.length !== 16) {
      const placed = p.board || [];
      const remaining = shuffle(ids.filter(id => !placed.includes(id)));
      const full = [...placed];
      while (full.length < 16) full.push(remaining.shift());
      p.board = full.slice(0, 16);
    }
    p.boardReady = true;
    state.questions.forEach(q => { if (p.cellStatus[q.id] === undefined) p.cellStatus[q.id] = null; });
  });
}

function startQuestion(qId) {
  state.currentQId = qId;
  state.questionAnswers = {};
  state.phase = 'game';
  const q = state.questions.find(q => q.id === qId);
  io.emit('game:question', { qId, question: q.question });
  broadcastState();

  let timeLeft = 10;
  io.emit('game:timer', timeLeft);
  state.timers.questionTick = setInterval(() => {
    timeLeft--;
    io.emit('game:timer', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(state.timers.questionTick);
      endQuestion(qId);
    }
  }, 1000);
}

function endQuestion(qId) {
  const q = state.questions.find(q => q.id === qId);
  state.askedIds.push(qId);

  const correctNicknames = [];
  Object.values(state.participants).forEach(p => {
    const ans = state.questionAnswers[p.nickname];
    if (ans === q.answer) {
      p.cellStatus[qId] = 'correct';
      correctNicknames.push(p.nickname);
    } else {
      // Wrong answer OR no answer (timeout/disconnect) = wrong
      p.cellStatus[qId] = 'wrong';
    }
    if (p.board) p.bingos = countBingos(p.board, p.cellStatus);
  });

  state.lastCorrectNicknames = correctNicknames;
  broadcastState();
  io.emit('game:questionResult', { qId, correctAnswer: q.answer, question: q.question, correctNicknames });

  // Build allResults for end screen
  function buildAllResults() {
    return Object.values(state.participants)
      .map(p => ({ nickname: p.nickname, emoji: p.emoji, bingos: p.bingos, board: p.board, cellStatus: p.cellStatus }))
      .sort((a, b) => b.bingos - a.bingos);
  }

  // Check 3-bingo winner
  const winner = Object.values(state.participants).find(p => p.bingos >= 3);
  if (winner) {
    state.winner = winner.nickname;
    state.phase = 'ended';
    broadcastState();
    io.emit('game:ended', {
      winner: winner.nickname,
      emoji: winner.emoji,
      board: winner.board,
      cellStatus: winner.cellStatus,
      bingos: winner.bingos,
      allResults: buildAllResults()
    });
    return;
  }

  const remaining = state.questions.filter(q => !state.askedIds.includes(q.id));
  if (remaining.length === 0) {
    // All questions done — find max bingo player
    let maxBingos = 0;
    Object.values(state.participants).forEach(p => { if (p.bingos > maxBingos) maxBingos = p.bingos; });
    const topPlayers = Object.values(state.participants).filter(p => p.bingos === maxBingos);
    const best = topPlayers.length > 0 && maxBingos > 0 ? topPlayers[0] : null;
    state.winner = best ? best.nickname : null;
    state.phase = 'ended';
    broadcastState();
    const endData = best
      ? { winner: best.nickname, emoji: best.emoji, board: best.board, cellStatus: best.cellStatus, bingos: best.bingos, allResults: buildAllResults() }
      : { winner: null, allResults: buildAllResults() };
    io.emit('game:ended', endData);
    return;
  }

  state.timers.resultDelay = setTimeout(() => { startVoting(remaining); }, 3000);
}

function startVoting(remaining) {
  state.phase = 'voting';
  state.votes = {};
  broadcastState();

  const candidates = remaining.map(q => ({ id: q.id, keyword: q.keyword }));
  const hasCorrect = state.lastCorrectNicknames.length > 0;

  // Send personalized canVote flag to each participant
  Object.values(state.participants).filter(p => !p.disconnected).forEach(p => {
    const canVote = !hasCorrect || state.lastCorrectNicknames.includes(p.nickname);
    io.to(p.socketId).emit('game:voting', { candidates, canVote });
  });

  let timeLeft = 5;
  io.emit('game:voteTimer', timeLeft);
  state.timers.voteTick = setInterval(() => {
    timeLeft--;
    io.emit('game:voteTimer', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(state.timers.voteTick);
      resolveVotes(remaining);
    }
  }, 1000);
}

function broadcastVotes() {
  const tally = {};
  Object.values(state.votes).forEach(qId => { tally[qId] = (tally[qId] || 0) + 1; });
  io.emit('game:voteTally', tally);
}

function resolveVotes(remaining) {
  const tally = {};
  Object.values(state.votes).forEach(qId => { tally[qId] = (tally[qId] || 0) + 1; });
  let maxVotes = 0;
  Object.values(tally).forEach(v => { if (v > maxVotes) maxVotes = v; });
  const winners = maxVotes === 0 ? remaining : remaining.filter(q => (tally[q.id] || 0) === maxVotes);
  startQuestion(winners[Math.floor(Math.random() * winners.length)].id);
}

// ── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const localIPs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) localIPs.push(net.address);
    }
  }
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      🎯 빙고 퀴즈 서버 실행 중!             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  로컬:     http://localhost:${PORT}`);
  localIPs.forEach(ip => console.log(`║  네트워크: http://${ip}:${PORT}`));
  console.log(`║  관리자:   http://localhost:${PORT}/admin.html`);
  console.log('╚══════════════════════════════════════════════╝\n');

  if (process.env.NODE_ENV !== 'production') {
    try {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: PORT });
      console.log('🌐 외부 URL:', tunnel.url);
      tunnel.on('close', () => console.log('⚠️  터널 종료'));
    } catch (e) {}
  }
});
