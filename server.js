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

// ── Database (JSON file) ────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'question_sets.json');

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]', 'utf8');
}

function readDb() {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch { return []; }
}

function writeDb(data) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── REST API: Question Sets ─────────────────────────────────────────────────
app.get('/api/sets', (req, res) => {
  const sets = readDb();
  // Return list without full question data for efficiency
  res.json(sets.map(s => ({
    id: s.id,
    name: s.name,
    questionCount: s.questions.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  })));
});

app.get('/api/sets/:id', (req, res) => {
  const sets = readDb();
  const set = sets.find(s => s.id === req.params.id);
  if (!set) return res.status(404).json({ error: '문제 세트를 찾을 수 없습니다' });
  res.json(set);
});

app.post('/api/sets', (req, res) => {
  const { name, questions } = req.body;
  if (!name || !questions || !Array.isArray(questions)) {
    return res.status(400).json({ error: '이름과 문제 목록이 필요합니다' });
  }
  const sets = readDb();
  const newSet = {
    id: `set_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    questions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
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
let state = {
  phase: 'setup',
  questions: [],
  participants: {},
  askedIds: [],
  currentQId: null,
  questionAnswers: {},
  votes: {},
  winner: null,
  timers: {}
};

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
  for (let r = 0; r < 4; r++) {
    if ([0,1,2,3].every(c => active(board[r*4+c]))) bingos++;
  }
  for (let c = 0; c < 4; c++) {
    if ([0,1,2,3].every(r => active(board[r*4+c]))) bingos++;
  }
  if ([0,5,10,15].every(i => active(board[i]))) bingos++;
  if ([3,6,9,12].every(i => active(board[i]))) bingos++;
  return bingos;
}

function getPublicState() {
  return {
    phase: state.phase,
    questions: state.questions.map(q => ({ id: q.id, keyword: q.keyword })),
    participants: Object.fromEntries(
      Object.entries(state.participants).map(([sid, p]) => [sid, {
        nickname: p.nickname,
        emoji: p.emoji,
        board: p.board,
        cellStatus: p.cellStatus,
        bingos: p.bingos,
        boardReady: p.boardReady
      }])
    ),
    askedIds: state.askedIds,
    currentQId: state.currentQId,
    winner: state.winner
  };
}

function broadcastState() {
  io.emit('game:state', getPublicState());
}

// ── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  const isAdmin = socket.handshake.query.role === 'admin';

  socket.emit('game:state', getPublicState());
  if (isAdmin && state.phase !== 'setup') {
    socket.emit('admin:questions', state.questions);
  }

  // ── ADMIN EVENTS ──────────────────────────────────────────────────────────
  socket.on('admin:setQuestions', (questions) => {
    if (!isAdmin) return;
    state.questions = questions.map((q, i) => ({ ...q, id: `q${i}` }));
    socket.emit('admin:questions', state.questions);
  });

  socket.on('admin:openLobby', () => {
    if (!isAdmin) return;
    if (state.questions.length < 16) {
      socket.emit('error', '16개의 문제가 필요합니다.');
      return;
    }
    state.phase = 'lobby';
    broadcastState();
  });

  socket.on('admin:startArrangement', () => {
    if (!isAdmin) return;
    if (Object.keys(state.participants).length === 0) {
      socket.emit('error', '참가자가 없습니다.');
      return;
    }
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

  // ── PARTICIPANT EVENTS ────────────────────────────────────────────────────
  socket.on('participant:join', ({ nickname, emoji }) => {
    if (state.phase !== 'lobby' && state.phase !== 'arrangement') return;
    if (Object.values(state.participants).some(p => p.nickname === nickname)) {
      socket.emit('error', '이미 사용 중인 닉네임입니다.');
      return;
    }
    state.participants[socket.id] = {
      nickname,
      emoji,
      board: null,
      cellStatus: {},
      bingos: 0,
      boardReady: false
    };
    state.questions.forEach(q => {
      state.participants[socket.id].cellStatus[q.id] = null;
    });
    socket.emit('participant:joined', { nickname, emoji });
    broadcastState();
    io.to('admin').emit('admin:participantList', Object.values(state.participants).map(p => ({
      nickname: p.nickname, emoji: p.emoji, boardReady: p.boardReady
    })));
  });

  socket.on('participant:submitBoard', (board) => {
    const p = state.participants[socket.id];
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
    if (!state.participants[socket.id]) return;
    state.questionAnswers[socket.id] = answer;
  });

  socket.on('participant:vote', (qId) => {
    if (state.phase !== 'voting') return;
    if (!state.participants[socket.id]) return;
    state.votes[socket.id] = qId;
    broadcastVotes();
  });

  socket.on('disconnect', () => {
    if (state.participants[socket.id]) {
      delete state.participants[socket.id];
      broadcastState();
    }
  });

  if (isAdmin) {
    socket.join('admin');
    socket.emit('admin:questions', state.questions);
  }
});

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
    state.questions.forEach(q => {
      if (p.cellStatus[q.id] === undefined) p.cellStatus[q.id] = null;
    });
  });
}

function startQuestion(qId) {
  state.currentQId = qId;
  state.questionAnswers = {};
  state.phase = 'game';
  const q = state.questions.find(q => q.id === qId);
  io.emit('game:question', { qId, question: q.question, answer: null });
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
  Object.entries(state.participants).forEach(([sid, p]) => {
    const ans = state.questionAnswers[sid];
    if (ans === q.answer) {
      p.cellStatus[qId] = 'correct';
      correctNicknames.push(p.nickname);
    } else if (ans) {
      p.cellStatus[qId] = 'wrong';
    }
    if (p.board) {
      p.bingos = countBingos(p.board, p.cellStatus);
    }
  });

  broadcastState();
  io.emit('game:questionResult', {
    qId,
    correctAnswer: q.answer,
    question: q.question,
    correctNicknames
  });

  const winner = Object.values(state.participants).find(p => p.bingos >= 3);
  if (winner) {
    state.winner = winner.nickname;
    state.phase = 'ended';
    broadcastState();
    io.emit('game:ended', {
      winner: winner.nickname,
      emoji: winner.emoji,
      board: winner.board,
      cellStatus: winner.cellStatus
    });
    return;
  }

  const remaining = state.questions.filter(q => !state.askedIds.includes(q.id));
  if (remaining.length === 0) {
    state.phase = 'ended';
    broadcastState();
    io.emit('game:ended', { winner: null });
    return;
  }

  state.timers.resultDelay = setTimeout(() => {
    startVoting(remaining);
  }, 3000);
}

function startVoting(remaining) {
  state.phase = 'voting';
  state.votes = {};
  broadcastState();
  io.emit('game:voting', { candidates: remaining.map(q => ({ id: q.id, keyword: q.keyword })) });

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
  Object.values(state.votes).forEach(id => {
    tally[id] = (tally[id] || 0) + 1;
  });
  io.emit('game:voteTally', tally);
}

function resolveVotes(remaining) {
  const tally = {};
  Object.values(state.votes).forEach(id => {
    tally[id] = (tally[id] || 0) + 1;
  });

  let maxVotes = 0;
  Object.values(tally).forEach(v => { if (v > maxVotes) maxVotes = v; });

  let winners;
  if (maxVotes === 0) {
    winners = remaining;
  } else {
    winners = remaining.filter(q => (tally[q.id] || 0) === maxVotes);
  }

  const chosen = winners[Math.floor(Math.random() * winners.length)];
  startQuestion(chosen.id);
}

// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  // Show local IPs
  const os = require('os');
  const nets = os.networkInterfaces();
  const localIPs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIPs.push(net.address);
      }
    }
  }

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           🎯 빙고 퀴즈 서버 실행 중!                    ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  로컬:     http://localhost:${PORT}`);
  localIPs.forEach(ip => {
    console.log(`║  네트워크: http://${ip}:${PORT}`);
  });
  console.log(`║  관리자:   http://localhost:${PORT}/admin.html`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // Try to open a public tunnel with localtunnel
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port: PORT });
    console.log('');
    console.log('🌐 외부 접속 URL (공유용):');
    console.log(`   참가자: ${tunnel.url}`);
    console.log(`   관리자: ${tunnel.url}/admin.html`);
    console.log('');
    tunnel.on('close', () => console.log('⚠️  터널 연결이 종료되었습니다.'));
  } catch (e) {
    console.log('');
    console.log('💡 외부 접속을 위해: npm install localtunnel 후 재시작');
    console.log('   또는 같은 Wi-Fi에서 위 네트워크 IP로 접속 가능합니다.');
  }
});
