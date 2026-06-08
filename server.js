import 'dotenv/config'
import express from 'express'
import fs from 'fs/promises'
import fsSync from 'fs'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'
import http from 'http'
import { Server } from 'socket.io'
import { createClient } from 'redis'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = process.env.PORT || 3000
const dbDir = process.env.DB_DIR || path.join(__dirname, 'db')
const jsonDir = process.env.JSON_DIR || (process.env.DB_DIR ? path.join(dbDir, 'Data') : dbDir)
const usersDbPath = path.join(dbDir, 'users.db')
const usersDb = new sqlite3.Database(usersDbPath, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    console.error('Unable to open users.db:', err)
  } else {
    console.log('Connected to users.db')
  }
})

function querySqlite(sql, params = []) {
  return new Promise((resolve, reject) => {
    usersDb.get(sql, params, (err, row) => {
      if (err) return reject(err)
      resolve(row)
    })
  })
}

function querySqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    usersDb.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

function querySqliteRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    usersDb.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve(this)
    })
  })
}

app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

async function loadDbFile(filename) {
  const filePath = path.join(jsonDir, filename)
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

function getJobByLevel(jobs, level) {
  return jobs.find(job => job.level === level) || jobs[0]
}

function getTierDisplay(tier) {
  switch(tier) {
    case 0: return "👑 Emperor";
    case 1: return "💎 King";
    case 2: return "🥈 Prince";
    case 3: return "🥉 Duke";
    case 4: return "🎖️ Baron";
    case 5: return "🔰 Commoner";
    default: return "🔰 Commoner";
  }
}

async function getPlayerRankAndTier(userId) {
  if (String(userId) === '622676944') {
    return { tier: 0, rank: 1 };
  }

  const sql = `
    WITH UserNetWorths AS (
        SELECT a.UserId, 
               a.Balance + COALESCE((
                   SELECT SUM(CAST(ROUND(i.Price * COALESCE(mp.Multiplier, 1.0) / 1000.0) AS INTEGER) * 1000)
                   FROM AccountItems ai 
                   JOIN Items i ON ai.ItemId = i.Id 
                   LEFT JOIN MarketPrices mp ON i.Category = mp.Category 
                   WHERE ai.AccountId = a.AccountId
               ), 0) as NetWorth
        FROM Accounts a
        WHERE a.UserId != 622676944
    )
    SELECT 
        (SELECT COUNT(*) FROM UserNetWorths) AS total,
        (SELECT COUNT(*) FROM UserNetWorths WHERE NetWorth < (SELECT NetWorth FROM UserNetWorths WHERE UserId = ?)) AS strictLess,
        (SELECT COUNT(*) FROM UserNetWorths WHERE NetWorth = (SELECT NetWorth FROM UserNetWorths WHERE UserId = ?)) AS equal,
        (SELECT COUNT(*) FROM UserNetWorths WHERE NetWorth > (SELECT NetWorth FROM UserNetWorths WHERE UserId = ?)) AS strictGreater
  `;

  try {
    const row = await querySqlite(sql, [userId, userId, userId]);
    if (!row || row.total === 0) {
      return { tier: 5, rank: 1 };
    }
    
    const total = row.total;
    const strictLess = row.strictLess;
    const equal = row.equal;
    const strictGreater = row.strictGreater;

    // Tie-breaking logic: rank the users with same balance in the middle of their group
    const percentile = (strictLess + 0.5 * equal) / total;
    
    let tier = 5;
    if (percentile >= 0.95) tier = 1;
    else if (percentile >= 0.85) tier = 2;
    else if (percentile >= 0.70) tier = 3;
    else if (percentile >= 0.50) tier = 4;

    const rank = strictGreater + 1; // 1-based rank

    return { tier, rank };
  } catch (err) {
    console.error("Failed to get rank and tier:", err);
    return { tier: 5, rank: -1 };
  }
}

function buildPlayerInfo(jobs, treasures, playerData = null) {
  const defaultPlayer = {
    id: 'demo-player-1',
    name: 'Demo Player',
    username: 'guest',
    balance: 1000,
    accountNumber: null,
    thief: false,
    cardTypeId: null,
    cardTypeName: null,
    jobLevel: 1,
    shieldEndTimeUtc: null,
    nextSalaryClaimDate: new Date(Date.now() - 1000).toISOString(),
    lastSalaryClaimUtc: null,
    lastTreasureHuntUtc: null,
    lastWheelSpinUtc: null,
    lastInvestUtc: null,
    lastCoinFlipUtc: null,
    lastStealUtc: null,
    lastRaidUtc: null,
    lastBribeUtc: null,
    lastBurgerUtc: null,
    lastRentUpdateUtc: null,
    unclaimedRent: 0,
    lastWealthTaxUtc: null,
    createdAt: null,
    lastSeen: null,
    inventory: [],
  }

  const source = playerData ?? defaultPlayer
  const job = getJobByLevel(jobs, source.jobLevel)
  const inventory = Array.isArray(source.inventory) ? source.inventory : []
  const treasureValue = inventory.reduce((sum, item) => sum + (item.value || 0), 0)
  const shields = source.shieldEndTimeUtc
    ? (new Date(source.shieldEndTimeUtc) > new Date() ? 1 : 0)
    : 0

  return {
    id: source.id,
    name: source.name,
    username: source.username,
    balance: source.balance,
    accountNumber: source.accountNumber,
    thief: source.thief,
    cardTypeId: source.cardTypeId,
    cardTypeName: source.cardTypeName,
    jobLevel: job.level,
    jobTitle: job.title,
    jobSalary: job.salary,
    tier: source.tier ?? 5,
    tierName: source.tierName ?? "🔰 Commoner",
    rank: source.rank ?? -1,
    shields,
    shieldEndTimeUtc: source.shieldEndTimeUtc,
    nextSalaryClaimDate: source.nextSalaryClaimDate,
    lastSalaryClaimUtc: source.lastSalaryClaimUtc,
    lastTreasureHuntUtc: source.lastTreasureHuntUtc,
    lastWheelSpinUtc: source.lastWheelSpinUtc,
    lastInvestUtc: source.lastInvestUtc,
    lastCoinFlipUtc: source.lastCoinFlipUtc,
    lastStealUtc: source.lastStealUtc,
    lastRaidUtc: source.lastRaidUtc,
    lastBribeUtc: source.lastBribeUtc,
    lastBurgerUtc: source.lastBurgerUtc,
    lastRentUpdateUtc: source.lastRentUpdateUtc,
    unclaimedRent: source.unclaimedRent,
    lastWealthTaxUtc: source.lastWealthTaxUtc,
    createdAt: source.createdAt,
    lastSeen: source.lastSeen,
    inventory,
    treasureValue,
  }
}

async function getUserProfileFromDb(userId) {
  const sql = `
    SELECT
      Accounts.AccountId,
      Accounts.UserId,
      Accounts.Balance,
      Accounts.AccountNumber,
      Accounts.Thief,
      Accounts.CardTypeId,
      CardTypes.Name AS CardTypeName,
      Accounts.JobLevel,
      Accounts.LastSalaryClaimUtc,
      Accounts.LastTreasureHuntUtc,
      Accounts.LastWheelSpinUtc,
      Accounts.LastInvestUtc,
      Accounts.LastCoinFlipUtc,
      Accounts.LastStealUtc,
      Accounts.LastRaidUtc,
      Accounts.LastBribeUtc,
      Accounts.ShieldEndTimeUtc,
      Accounts.LastBurgerUtc,
      Accounts.LastRentUpdateUtc,
      Accounts.UnclaimedRent,
      Accounts.LastWealthTaxUtc,
      Users.FirstName,
      Users.LastName,
      Users.Username,
      Users.AccessHash,
      Users.CreatedAt,
      Users.LastSeen
    FROM Accounts
    JOIN Users ON Accounts.UserId = Users.UserId
    LEFT JOIN CardTypes ON Accounts.CardTypeId = CardTypes.Id
    WHERE Accounts.UserId = ?
  `
  const row = await querySqlite(sql, [userId])
  if (!row) return null

  const salaryCooldownMs = 0.50 * 60 * 60 * 1000
  let nextSalaryClaimDate = new Date(Date.now() - 1000).toISOString()
  if (row.LastSalaryClaimUtc) {
    const lastClaimStr = row.LastSalaryClaimUtc.endsWith('Z') 
      ? row.LastSalaryClaimUtc 
      : row.LastSalaryClaimUtc + 'Z'
    nextSalaryClaimDate = new Date(new Date(lastClaimStr).getTime() + salaryCooldownMs).toISOString()
  }

  return {
    accountId: row.AccountId,
    id: String(row.UserId),
    username: row.Username || `user-${row.UserId}`,
    name: [row.FirstName, row.LastName].filter(Boolean).join(' ') || row.Username || `user-${row.UserId}`,
    accessHash: row.AccessHash,
    accountNumber: row.AccountNumber,
    balance: row.Balance,
    thief: Boolean(row.Thief),
    cardTypeId: row.CardTypeId,
    cardTypeName: row.CardTypeName,
    jobLevel: row.JobLevel,
    shieldEndTimeUtc: row.ShieldEndTimeUtc,
    nextSalaryClaimDate: nextSalaryClaimDate,
    lastSalaryClaimUtc: row.LastSalaryClaimUtc,
    lastTreasureHuntUtc: row.LastTreasureHuntUtc,
    lastWheelSpinUtc: row.LastWheelSpinUtc,
    lastInvestUtc: row.LastInvestUtc,
    lastCoinFlipUtc: row.LastCoinFlipUtc,
    lastStealUtc: row.LastStealUtc,
    lastRaidUtc: row.LastRaidUtc,
    lastBribeUtc: row.LastBribeUtc,
    lastBurgerUtc: row.LastBurgerUtc,
    lastRentUpdateUtc: row.LastRentUpdateUtc,
    unclaimedRent: row.UnclaimedRent,
    lastWealthTaxUtc: row.LastWealthTaxUtc,
    createdAt: row.CreatedAt,
    lastSeen: row.LastSeen,
    inventory: [],
  }
}

async function getInventoryForAccount(accountId) {
  const sql = `
    SELECT
      AccountItems.Id AS accountItemId,
      AccountItems.PurchasePrice,
      AccountItems.PurchaseDate,
      Items.Id AS itemId,
      Items.ItemName,
      Items.Price,
      Items.Rarity,
      Items.Category
    FROM AccountItems
    JOIN Items ON AccountItems.ItemId = Items.Id
    WHERE AccountItems.AccountId = ?
  `
  const rows = await querySqliteAll(sql, [accountId])
  return rows.map(row => ({
    accountItemId: row.accountItemId,
    itemId: row.itemId,
    name: row.ItemName,
    price: row.Price,
    purchasePrice: row.PurchasePrice,
    purchaseDate: row.PurchaseDate,
    rarity: row.Rarity,
    category: row.Category,
    value: row.Price,
  }))
}

app.get('/api/player', async (req, res) => {
  try {
    const jobsData = await loadDbFile('jobs.json')
    const treasuresData = await loadDbFile('treasures.json')
    const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info:', error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/api/player/:id', async (req, res) => {
  try {
    const jobsData = await loadDbFile('jobs.json')
    const treasuresData = await loadDbFile('treasures.json')
    const playerData = await getUserProfileFromDb(req.params.id)
    if (!playerData) {
      return res.status(404).json({ error: 'Player not found' })
    }
    const inventory = await getInventoryForAccount(playerData.accountId)
    playerData.inventory = inventory
    
    const rankTierInfo = await getPlayerRankAndTier(req.params.id)
    playerData.tier = rankTierInfo.tier
    playerData.tierName = getTierDisplay(rankTierInfo.tier)
    playerData.rank = rankTierInfo.rank

    const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
    return res.json(playerInfo)
  } catch (error) {
    console.error('Failed to load player info for id', req.params.id, error)
    return res.status(500).json({ error: 'Failed to load player info' })
  }
})

app.get('/api/jobs', async (req, res) => {
  try {
    const jobsData = await loadDbFile('jobs.json')
    return res.json(jobsData.jobs)
  } catch (error) {
    console.error('Failed to load jobs:', error)
    return res.status(500).json({ error: 'Failed to load jobs' })
  }
})

app.post('/api/player/:id/salary', async (req, res) => {
  try {
    const userId = req.params.id
    const playerData = await getUserProfileFromDb(userId)
    if (!playerData) return res.status(404).json({ error: 'Player not found' })

    const jobsData = await loadDbFile('jobs.json')
    const job = getJobByLevel(jobsData.jobs, playerData.jobLevel)
    
    // Cooldown check (30 minutes)
    const cooldownMs = 0.50 * 60 * 60 * 1000
    const now = new Date()
    if (playerData.lastSalaryClaimUtc) {
      // The DB date is typically stored as UTC without 'Z' at the end, so we might need to append it for proper parsing
      const lastClaimStr = playerData.lastSalaryClaimUtc.endsWith('Z') 
        ? playerData.lastSalaryClaimUtc 
        : playerData.lastSalaryClaimUtc + 'Z'
      const lastClaim = new Date(lastClaimStr)
      
      if (now - lastClaim < cooldownMs) {
        return res.status(400).json({ 
          error: 'Salary on cooldown', 
          nextClaimDate: new Date(lastClaim.getTime() + cooldownMs).toISOString() 
        })
      }
    }

    const newBalance = (playerData.balance || 0) + job.salary
    const newClaimUtc = now.toISOString().replace('T', ' ').substring(0, 19)

    await querySqliteRun(
      'UPDATE Accounts SET Balance = ?, LastSalaryClaimUtc = ? WHERE UserId = ?',
      [newBalance, newClaimUtc, userId]
    )

    return res.json({ 
      success: true, 
      balance: newBalance, 
      amountClaimed: job.salary,
      nextClaimDate: new Date(now.getTime() + cooldownMs).toISOString(),
      lastSalaryClaimUtc: newClaimUtc
    })
  } catch (error) {
    console.error('Failed to claim salary:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.post('/api/player/:id/upgrade', async (req, res) => {
  try {
    const userId = req.params.id
    const playerData = await getUserProfileFromDb(userId)
    if (!playerData) return res.status(404).json({ error: 'Player not found' })

    const jobsData = await loadDbFile('jobs.json')
    const currentJobLevel = playerData.jobLevel || 1
    const maxLevel = Math.max(...jobsData.jobs.map(j => j.level))

    if (currentJobLevel >= maxLevel) {
      return res.status(400).json({ error: 'Already at max job level' })
    }

    const nextJob = getJobByLevel(jobsData.jobs, currentJobLevel + 1)
    if (!nextJob) return res.status(400).json({ error: 'Next job not found' })

    const currentBalance = playerData.balance || 0
    if (currentBalance < nextJob.upgradeCost) {
      return res.status(400).json({ 
        error: 'Insufficient funds', 
        balance: currentBalance, 
        upgradeCost: nextJob.upgradeCost 
      })
    }

    const newBalance = currentBalance - nextJob.upgradeCost
    const newJobLevel = nextJob.level

    await querySqliteRun(
      'UPDATE Accounts SET Balance = ?, JobLevel = ? WHERE UserId = ?',
      [newBalance, newJobLevel, userId]
    )

    return res.json({ 
      success: true, 
      balance: newBalance, 
      jobLevel: newJobLevel,
      jobTitle: nextJob.title,
      jobSalary: nextJob.salary
    })
  } catch (error) {
    console.error('Failed to upgrade job:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.post('/api/player/:id/wheel/spin', async (req, res) => {
  try {
    const userId = req.params.id
    const playerData = await getUserProfileFromDb(userId)
    if (!playerData) return res.status(404).json({ error: 'Player not found' })

    const cooldownHours = 0.10 // matches appsettings.json
    const cooldownMs = cooldownHours * 60 * 60 * 1000
    const now = new Date()

    if (playerData.lastWheelSpinUtc) {
      const lastSpinStr = playerData.lastWheelSpinUtc.endsWith('Z') 
        ? playerData.lastWheelSpinUtc 
        : playerData.lastWheelSpinUtc + 'Z'
      const lastSpin = new Date(lastSpinStr)
      
      if (now - lastSpin < cooldownMs) {
        return res.status(400).json({ 
          error: 'Wheel on cooldown', 
          nextSpinDate: new Date(lastSpin.getTime() + cooldownMs).toISOString() 
        })
      }
    }

    const currentBalance = playerData.balance || 0
    const spinFee = Math.max(500, Math.floor(currentBalance * 0.02))

    if (currentBalance < spinFee) {
      return res.status(400).json({ 
        error: 'Insufficient balance to spin', 
        balance: currentBalance, 
        spinFee: spinFee 
      })
    }

    const wheelSegments = [
      { emoji: "💎", name: "Jackpot", multiplier: 10, weight: 5 },
      { emoji: "🤑", name: "Big Win", multiplier: 5, weight: 10 },
      { emoji: "💰", name: "Nice Win", multiplier: 2, weight: 20 },
      { emoji: "💵", name: "Small Win", multiplier: 1, weight: 30 },
      { emoji: "🍀", name: "Lucky", multiplier: 0.5, weight: 25 },
      { emoji: "💔", name: "Nothing", multiplier: 0, weight: 10 }
    ];

    const totalWeight = wheelSegments.reduce((sum, seg) => sum + seg.weight, 0);
    let rand = Math.floor(Math.random() * totalWeight);
    let resultSegment = wheelSegments[wheelSegments.length - 1];

    for (const segment of wheelSegments) {
      if (rand < segment.weight) {
        resultSegment = segment;
        break;
      }
      rand -= segment.weight;
    }

    const payout = Math.floor(spinFee * resultSegment.multiplier);
    const newBalance = currentBalance - spinFee + payout;
    const newSpinUtc = now.toISOString().replace('T', ' ').substring(0, 19)

    await querySqliteRun(
      'UPDATE Accounts SET Balance = ?, LastWheelSpinUtc = ? WHERE UserId = ?',
      [newBalance, newSpinUtc, userId]
    )

    return res.json({ 
      success: true, 
      balance: newBalance,
      spinFee: spinFee,
      payout: payout,
      segmentName: resultSegment.name,
      segmentEmoji: resultSegment.emoji,
      lastWheelSpinUtc: newSpinUtc,
      nextSpinDate: new Date(now.getTime() + cooldownMs).toISOString()
    })
  } catch (error) {
    console.error('Failed to spin wheel:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

app.get('/', (req, res) => {
  res.send('Bot mini app backend is running. Use /api/player or /api/player/:id')
})

const privKeyPath = '/etc/letsencrypt/live/ibrahim-api.duckdns.org/privkey.pem'
const fullChainPath = '/etc/letsencrypt/live/ibrahim-api.duckdns.org/fullchain.pem'

let server;
if (fsSync.existsSync(privKeyPath) && fsSync.existsSync(fullChainPath)) {
  const privateKey = fsSync.readFileSync(privKeyPath, 'utf8')
  const certificate = fsSync.readFileSync(fullChainPath, 'utf8')
  const credentials = { key: privateKey, cert: certificate }
  server = https.createServer(credentials, app)
} else {
  server = http.createServer(app)
}

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Redis setup for receiving updates from C# bot
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
    
    // Create a subscriber client for pub/sub
    const subscriber = redisClient.duplicate();
    await subscriber.connect();
    
    await subscriber.subscribe('economy_events', async (message) => {
      try {
        const data = JSON.parse(message);
        const { userId, type, ...payload } = data;
        if (userId && type) {
          if (type === 'force_profile_update') {
            // Fetch latest profile and push to user
            try {
              const jobsData = await loadDbFile('jobs.json')
              const treasuresData = await loadDbFile('treasures.json')
              const playerData = await getUserProfileFromDb(userId)
              if (playerData) {
                const inventory = await getInventoryForAccount(playerData.accountId)
                playerData.inventory = inventory
                
                const rankTierInfo = await getPlayerRankAndTier(userId)
                playerData.tier = rankTierInfo.tier
                playerData.tierName = getTierDisplay(rankTierInfo.tier)
                playerData.rank = rankTierInfo.rank

                const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
                io.to(`user_${userId}`).emit('profile_update', playerInfo);
              }
            } catch (err) {
              console.error('Failed to fetch profile on force_update:', err);
            }
          } else {
            io.to(`user_${userId}`).emit(type, payload);
          }
        }
      } catch (err) {
        console.error('Failed to parse redis message:', err);
      }
    });
    console.log('Subscribed to Redis channel: economy_events');
  } catch (err) {
    console.error('Redis connection failed:', err);
  }
})();

const connectedUsers = new Map(); // socket.id -> userId

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  socket.on('join', (userId) => {
    if (userId) {
      socket.join(`user_${userId}`);
      connectedUsers.set(socket.id, userId);
      console.log(`Socket ${socket.id} joined room user_${userId}`);
    }
  });

  socket.on('get_jobs', async (_, callback) => {
    if (!callback) return;
    try {
      const jobsData = await loadDbFile('jobs.json')
      callback({ success: true, data: jobsData.jobs })
    } catch (error) {
      console.error('Failed to load jobs via socket:', error)
      callback({ error: 'Failed to load jobs' })
    }
  });

  socket.on('request_profile', async (userId, callback) => {
    if (!callback) return;
    try {
      const jobsData = await loadDbFile('jobs.json')
      const treasuresData = await loadDbFile('treasures.json')
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) {
        return callback({ error: 'Player not found' })
      }
      const inventory = await getInventoryForAccount(playerData.accountId)
      playerData.inventory = inventory
      
      const rankTierInfo = await getPlayerRankAndTier(userId)
      playerData.tier = rankTierInfo.tier
      playerData.tierName = getTierDisplay(rankTierInfo.tier)
      playerData.rank = rankTierInfo.rank

      const playerInfo = buildPlayerInfo(jobsData.jobs, treasuresData.treasures, playerData)
      callback({ success: true, data: playerInfo })
    } catch (error) {
      console.error('Failed to load player info via socket:', error)
      callback({ error: 'Failed to load player info' })
    }
  });

  socket.on('claim_salary', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) return callback({ error: 'Player not found' })

      const jobsData = await loadDbFile('jobs.json')
      const job = getJobByLevel(jobsData.jobs, playerData.jobLevel)
      
      const cooldownMs = 0.50 * 60 * 60 * 1000
      const now = new Date()
      if (playerData.lastSalaryClaimUtc) {
        const lastClaimStr = playerData.lastSalaryClaimUtc.endsWith('Z') 
          ? playerData.lastSalaryClaimUtc 
          : playerData.lastSalaryClaimUtc + 'Z'
        const lastClaim = new Date(lastClaimStr)
        
        if (now - lastClaim < cooldownMs) {
          return callback({ 
            error: 'Salary on cooldown', 
            nextClaimDate: new Date(lastClaim.getTime() + cooldownMs).toISOString() 
          })
        }
      }

      const newBalance = (playerData.balance || 0) + job.salary
      const newClaimUtc = now.toISOString().replace('T', ' ').substring(0, 19)

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, LastSalaryClaimUtc = ? WHERE UserId = ?',
        [newBalance, newClaimUtc, userId]
      )

      const payload = { 
        success: true, 
        balance: newBalance, 
        amountClaimed: job.salary,
        nextClaimDate: new Date(now.getTime() + cooldownMs).toISOString(),
        lastSalaryClaimUtc: newClaimUtc
      };
      
      // Emit to room as well
      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, nextSalaryClaimDate: payload.nextClaimDate });
      
      callback(payload);
    } catch (error) {
      console.error('Failed to claim salary:', error)
      callback({ error: 'Internal Server Error' })
    }
  });

  socket.on('upgrade_job', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) return callback({ error: 'Player not found' })

      const jobsData = await loadDbFile('jobs.json')
      const currentJobLevel = playerData.jobLevel || 1
      const maxLevel = Math.max(...jobsData.jobs.map(j => j.level))

      if (currentJobLevel >= maxLevel) {
        return callback({ error: 'Already at max job level' })
      }

      const nextJob = getJobByLevel(jobsData.jobs, currentJobLevel + 1)
      if (!nextJob) return callback({ error: 'Next job not found' })

      const currentBalance = playerData.balance || 0
      if (currentBalance < nextJob.upgradeCost) {
        return callback({ 
          error: 'Insufficient funds', 
          balance: currentBalance, 
          upgradeCost: nextJob.upgradeCost 
        })
      }

      const newBalance = currentBalance - nextJob.upgradeCost
      const newJobLevel = nextJob.level

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, JobLevel = ? WHERE UserId = ?',
        [newBalance, newJobLevel, userId]
      )

      const payload = { 
        success: true, 
        balance: newBalance, 
        jobLevel: newJobLevel,
        jobTitle: nextJob.title,
        jobSalary: nextJob.salary
      };
      
      io.to(`user_${userId}`).emit('profile_update', payload);
      
      callback(payload)
    } catch (error) {
      console.error('Failed to upgrade job:', error)
      callback({ error: 'Internal Server Error' })
    }
  });

  socket.on('spin_wheel', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId)
      if (!playerData) return callback({ error: 'Player not found' })

      const cooldownHours = 0.10
      const cooldownMs = cooldownHours * 60 * 60 * 1000
      const now = new Date()

      if (playerData.lastWheelSpinUtc) {
        const lastSpinStr = playerData.lastWheelSpinUtc.endsWith('Z') 
          ? playerData.lastWheelSpinUtc 
          : playerData.lastWheelSpinUtc + 'Z'
        const lastSpin = new Date(lastSpinStr)
        
        if (now - lastSpin < cooldownMs) {
          return callback({ 
            error: 'Wheel on cooldown', 
            nextSpinDate: new Date(lastSpin.getTime() + cooldownMs).toISOString() 
          })
        }
      }

      const currentBalance = playerData.balance || 0
      const spinFee = Math.max(500, Math.floor(currentBalance * 0.02))

      if (currentBalance < spinFee) {
        return callback({ 
          error: 'Insufficient balance to spin', 
          balance: currentBalance, 
          spinFee: spinFee 
        })
      }

      const wheelSegments = [
        { emoji: "💎", name: "Jackpot", multiplier: 10, weight: 5 },
        { emoji: "🤑", name: "Big Win", multiplier: 5, weight: 10 },
        { emoji: "💰", name: "Nice Win", multiplier: 2, weight: 20 },
        { emoji: "💵", name: "Small Win", multiplier: 1, weight: 30 },
        { emoji: "🍀", name: "Lucky", multiplier: 0.5, weight: 25 },
        { emoji: "💔", name: "Nothing", multiplier: 0, weight: 10 }
      ];

      const totalWeight = wheelSegments.reduce((sum, seg) => sum + seg.weight, 0);
      let rand = Math.floor(Math.random() * totalWeight);
      let resultSegment = wheelSegments[wheelSegments.length - 1];

      for (const segment of wheelSegments) {
        if (rand < segment.weight) {
          resultSegment = segment;
          break;
        }
        rand -= segment.weight;
      }

      const payout = Math.floor(spinFee * resultSegment.multiplier);
      const newBalance = currentBalance - spinFee + payout;
      const newSpinUtc = now.toISOString().replace('T', ' ').substring(0, 19)

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, LastWheelSpinUtc = ? WHERE UserId = ?',
        [newBalance, newSpinUtc, userId]
      )

      const payload = { 
        success: true, 
        balance: newBalance,
        spinFee: spinFee,
        payout: payout,
        segmentName: resultSegment.name,
        segmentEmoji: resultSegment.emoji,
        lastWheelSpinUtc: newSpinUtc,
        nextSpinDate: new Date(now.getTime() + cooldownMs).toISOString()
      };
      
      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, lastWheelSpinUtc: newSpinUtc });
      
      callback(payload)
    } catch (error) {
      console.error('Failed to spin wheel:', error)
      callback({ error: 'Internal Server Error' })
    }
  });

  socket.on('buy_burger', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const burgerCost = 10;
      if ((playerData.balance || 0) < burgerCost) {
        return callback({ error: 'Insufficient funds for a cheeseburger' });
      }

      const newBalance = playerData.balance - burgerCost;
      const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 19);

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, LastBurgerUtc = ? WHERE UserId = ?',
        [newBalance, nowUtc, userId]
      );

      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, lastBurgerUtc: nowUtc });
      callback({ success: true, balance: newBalance });
    } catch (error) {
      console.error('Failed to buy burger:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('claim_rent', async (userId, callback) => {
    if (!callback) return;
    try {
      const playerData = await getUserProfileFromDb(userId);
      if (!playerData) return callback({ error: 'Player not found' });
      
      const row = await querySqlite('SELECT UnclaimedRent, LastRentUpdateUtc FROM Accounts WHERE UserId = ?', [userId]);
      let rentToClaim = 0;
      if (row) {
        const lastUpdateStr = row.LastRentUpdateUtc ? (row.LastRentUpdateUtc.endsWith('Z') ? row.LastRentUpdateUtc : row.LastRentUpdateUtc + 'Z') : new Date().toISOString();
        const lastUpdate = new Date(lastUpdateStr).getTime();
        const secondsPassed = Math.floor((Date.now() - lastUpdate) / 1000);
        const rentRatePerSecond = 1; // $1 per second base rate for demo
        rentToClaim = (row.UnclaimedRent || 0) + (secondsPassed > 0 ? secondsPassed * rentRatePerSecond : 0);
      } else {
        rentToClaim = playerData.unclaimedRent || 0;
      }

      if (rentToClaim <= 0) {
        return callback({ error: 'No rent to claim' });
      }

      const newBalance = (playerData.balance || 0) + rentToClaim;
      const nowUtc = new Date().toISOString().replace('T', ' ').substring(0, 19);

      await querySqliteRun(
        'UPDATE Accounts SET Balance = ?, UnclaimedRent = 0, LastRentUpdateUtc = ? WHERE UserId = ?',
        [newBalance, nowUtc, userId]
      );

      io.to(`user_${userId}`).emit('profile_update', { balance: newBalance, unclaimedRent: 0, lastRentUpdateUtc: nowUtc });
      callback({ success: true, balance: newBalance, claimedAmount: rentToClaim });
    } catch (error) {
      console.error('Failed to claim rent:', error);
      callback({ error: 'Internal Server Error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    connectedUsers.delete(socket.id);
  });
});

setInterval(async () => {
  const uniqueUsers = [...new Set(connectedUsers.values())];
  for (const userId of uniqueUsers) {
    try {
      const row = await querySqlite('SELECT UnclaimedRent, LastRentUpdateUtc FROM Accounts WHERE UserId = ?', [userId]);
      if (row) {
        const lastUpdateStr = row.LastRentUpdateUtc ? (row.LastRentUpdateUtc.endsWith('Z') ? row.LastRentUpdateUtc : row.LastRentUpdateUtc + 'Z') : new Date().toISOString();
        const lastUpdate = new Date(lastUpdateStr).getTime();
        const secondsPassed = Math.floor((Date.now() - lastUpdate) / 1000);
        const rentRatePerSecond = 1; // $1 per second base rate for demo
        let newRent = (row.UnclaimedRent || 0) + (secondsPassed > 0 ? secondsPassed * rentRatePerSecond : 0);
        
        io.to(`user_${userId}`).emit('rent_update', { unclaimedRent: newRent });
      }
    } catch (err) { }
  }
}, 3000);

server.listen(PORT, () => {
  console.log(`Bot mini app backend socket/http server is running on port ${PORT}`)
})
