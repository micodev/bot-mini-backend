import 'dotenv/config'
import express from 'express'
import fs from 'fs/promises'
import fsSync from 'fs'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'

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
    nextSalaryClaimDate: row.LastSalaryClaimUtc,
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

app.get('/', (req, res) => {
  res.send('Bot mini app backend is running. Use /api/player or /api/player/:id')
})

const privKeyPath = '/etc/letsencrypt/live/ibrahim-api.duckdns.org/privkey.pem'
const fullChainPath = '/etc/letsencrypt/live/ibrahim-api.duckdns.org/fullchain.pem'

if (fsSync.existsSync(privKeyPath) && fsSync.existsSync(fullChainPath)) {
  const privateKey = fsSync.readFileSync(privKeyPath, 'utf8')
  const certificate = fsSync.readFileSync(fullChainPath, 'utf8')
  const credentials = { key: privateKey, cert: certificate }
  const httpsServer = https.createServer(credentials, app)
  
  httpsServer.listen(PORT, () => {
    console.log(`Bot mini app backend is running securely on https://ibrahim-api.duckdns.org`)
    console.log(`Port: ${PORT}`)
  })
} else {
  app.listen(PORT, () => {
    console.log(`Bot mini app backend is running on http://localhost:${PORT}`)
  })
}
